// 判定规则层：复核登记、转校正、换人复测、部件更换的全部业务规则。
// 纯函数操作内存数据，不接触 HTTP 与文件系统。

const CONCENTRICITY_LIMIT_MM = 0.03; // 游丝同心度阈值：超过 0.03 毫米即不达标
const STATIC_BALANCE_LIMIT_MG_CM = 5; // 摆轮静平衡阈值：超过 5 毫克·厘米即不达标
const REQUALIFY_INTERVAL_MS = 4 * 60 * 60 * 1000; // 两次达标复测最小间隔 4 小时
const REQUIRED_PASSES = 2; // 恢复排队所需连续达标次数

const PARTS = new Set(["balance", "hairspring"]);

class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  return new DomainError(status, code, message);
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw fail(400, "VALIDATION_ERROR", `缺少字段：${missing.join(", ")}`);
}

function toNumber(body, field, label) {
  const value = Number(body[field]);
  if (!Number.isFinite(value) || value < 0) {
    throw fail(400, "VALIDATION_ERROR", `${label}必须是不小于0的数字`);
  }
  return value;
}

function resolveTime(value, fallback = new Date()) {
  if (value === undefined || value === "") return fallback.toISOString();
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    throw fail(400, "VALIDATION_ERROR", "时间字段必须是合法ISO时间");
  }
  return time.toISOString();
}

// 单项判定：严格大于阈值才算超标（等于阈值视为达标）。
function evaluateMeasurement(input) {
  const hairspringConcentricityMm = toNumber(input, "hairspringConcentricityMm", "游丝同心度");
  const staticBalanceMgCm = toNumber(input, "staticBalanceMgCm", "静平衡");
  const amplitudeDegrees = toNumber(input, "amplitudeDegrees", "摆幅");
  const concentricityPass = hairspringConcentricityMm <= CONCENTRICITY_LIMIT_MM;
  const staticBalancePass = staticBalanceMgCm <= STATIC_BALANCE_LIMIT_MG_CM;
  return {
    hairspringConcentricityMm,
    staticBalanceMgCm,
    amplitudeDegrees,
    concentricityPass,
    staticBalancePass,
    qualified: concentricityPass && staticBalancePass
  };
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw fail(404, "CLOCK_NOT_FOUND", "钟表不存在");
  return clock;
}

function casesOf(db, clockId) {
  return (db.reviewCases || [])
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
}

function latestCase(db, clockId) {
  const list = casesOf(db, clockId);
  return list.length ? list[list.length - 1] : null;
}

function isActive(reviewCase) {
  return reviewCase && (reviewCase.status === "awaiting_transfer" || reviewCase.status === "correcting");
}

function allMeasurements(reviewCase) {
  if (!reviewCase) return [];
  return [reviewCase.initialMeasurement, ...reviewCase.retests];
}

function latestMeasurement(reviewCase) {
  const list = allMeasurements(reviewCase);
  return list.length ? list[list.length - 1] : null;
}

// 登记复核：每表只允许一条在途复核，重复或并发提交 409 且不落库。
function startReview(db, clockId, body) {
  findClock(db, clockId);
  required(body, ["operator", "hairspringConcentricityMm", "staticBalanceMgCm", "amplitudeDegrees"]);

  const existing = latestCase(db, clockId);
  if (isActive(existing)) {
    throw fail(409, "REVIEW_ALREADY_OPEN", "该表已有待复核记录，禁止重复提交");
  }

  const measuredAt = resolveTime(body.measuredAt);
  const result = evaluateMeasurement(body);
  const measurement = {
    id: makeId("measurement"),
    kind: "initial",
    measuredAt,
    operator: String(body.operator),
    ...result,
    note: body.note || ""
  };

  const reviewCase = {
    id: makeId("review"),
    clockId,
    status: result.qualified ? "queued" : "awaiting_transfer",
    openedAt: measuredAt,
    initialMeasurement: measurement,
    retests: [],
    corrections: [],
    consecutivePasses: 0,
    queuedAt: result.qualified ? measuredAt : null,
    replacement: null
  };
  db.reviewCases.push(reviewCase);
  return reviewCase;
}

// 不达标只准转校正。
function transferToCorrection(db, clockId, body) {
  findClock(db, clockId);
  required(body, ["operator", "actions"]);
  const reviewCase = latestCase(db, clockId);
  if (!reviewCase) throw fail(409, "NO_OPEN_REVIEW", "该表没有可转校正的复核记录");
  if (reviewCase.status === "queued") {
    throw fail(409, "REVIEW_ALREADY_QUEUED", "该复核已达标恢复排队，无需校正");
  }
  if (reviewCase.status === "voided") {
    throw fail(409, "REVIEW_VOIDED", "该复核已随部件更换作废，请重新登记");
  }
  if (reviewCase.status === "correcting") {
    throw fail(409, "ALREADY_CORRECTING", "已在校正中，请提交复测");
  }

  const correctedAt = resolveTime(body.correctedAt);
  if (new Date(correctedAt) < new Date(latestMeasurement(reviewCase).measuredAt)) {
    throw fail(400, "VALIDATION_ERROR", "校正时间不得早于最近一次测量时间");
  }

  reviewCase.corrections.push({
    id: makeId("correction"),
    correctedAt,
    operator: String(body.operator),
    actions: String(body.actions),
    note: body.note || ""
  });
  reviewCase.status = "correcting";
  return reviewCase;
}

// 校正后换人复测；连续两次达标、间隔满 4 小时才恢复排队。
function submitRetest(db, clockId, body) {
  findClock(db, clockId);
  required(body, ["operator", "hairspringConcentricityMm", "staticBalanceMgCm", "amplitudeDegrees"]);
  const reviewCase = latestCase(db, clockId);
  if (!reviewCase || reviewCase.status !== "correcting") {
    throw fail(409, "NOT_IN_CORRECTION", "只有校正中的复核记录可以提交复测");
  }

  const operator = String(body.operator);
  const lastCorrection = reviewCase.corrections[reviewCase.corrections.length - 1];
  if (operator === lastCorrection.operator) {
    throw fail(409, "OPERATOR_MUST_CHANGE", "复测必须由校正人之外的其他人员执行");
  }

  const measuredAt = resolveTime(body.measuredAt);
  if (new Date(measuredAt) < new Date(lastCorrection.correctedAt)) {
    throw fail(400, "VALIDATION_ERROR", "复测时间不得早于校正时间");
  }

  const result = evaluateMeasurement(body);

  // 间隔要求只约束「连续两次达标」的第二次：
  // - 第二次本身不达标：照常落库，连续计数清零退回待转校正；
  // - 第二次达标但距首次不足4小时：拒绝，该次复测不落库。
  if (result.qualified && reviewCase.consecutivePasses === 1) {
    const firstPass = reviewCase.retests[reviewCase.retests.length - 1];
    const elapsed = new Date(measuredAt) - new Date(firstPass.measuredAt);
    if (elapsed < REQUALIFY_INTERVAL_MS) {
      const waitHours = ((REQUALIFY_INTERVAL_MS - elapsed) / 3600000).toFixed(2);
      throw fail(409, "RETEST_INTERVAL_NOT_MET", `两次达标复测间隔不足4小时，还需等待约${waitHours}小时`);
    }
  }

  reviewCase.retests.push({
    id: makeId("measurement"),
    kind: "retest",
    measuredAt,
    operator,
    ...result,
    correctionId: lastCorrection.id,
    note: body.note || ""
  });

  if (!result.qualified) {
    // 复测不达标：连续计数中断，退回「只准转校正」。
    reviewCase.consecutivePasses = 0;
    reviewCase.status = "awaiting_transfer";
  } else if (reviewCase.consecutivePasses + 1 >= REQUIRED_PASSES) {
    reviewCase.consecutivePasses = REQUIRED_PASSES;
    reviewCase.status = "queued";
    reviewCase.queuedAt = measuredAt;
  } else {
    reviewCase.consecutivePasses += 1;
  }
  return reviewCase;
}

// 更换摆轮或游丝：在途复核立即作废，历史记录保留可查。
function replacePart(db, clockId, body) {
  findClock(db, clockId);
  required(body, ["operator", "part"]);
  const part = String(body.part);
  if (!PARTS.has(part)) {
    throw fail(400, "VALIDATION_ERROR", "部件只支持 balance（摆轮）或 hairspring（游丝）");
  }
  const reviewCase = latestCase(db, clockId);
  if (!isActive(reviewCase)) {
    throw fail(409, "NO_ACTIVE_REVIEW", "没有在途复核记录可供作废；旧记录仍可在历史中查询");
  }

  const replacedAt = resolveTime(body.replacedAt);
  reviewCase.status = "voided";
  reviewCase.consecutivePasses = 0;
  reviewCase.replacement = {
    part,
    replacedAt,
    operator: String(body.operator),
    note: body.note || ""
  };
  return reviewCase;
}

const STATUS_TEXT = {
  awaiting_transfer: "超标待转校正",
  correcting: "校正复测中",
  queued: "已恢复排队",
  voided: "旧复核已作废",
  none: "未登记复核"
};

const NEXT_ACTION = {
  awaiting_transfer: "只准转校正：POST /clocks/:id/review/transfer",
  correcting_first: "安排换人复测（复测人不得与最近一次校正人相同）",
  correcting_second: "安排第二次达标复测，距首次达标复测需满4小时",
  queued: "无需操作，已恢复排队",
  voided: "旧复核已失效，可重新登记复核",
  none: "可登记复核：POST /clocks/:id/review"
};

// 列表、单表历史、最新复测状态共用同一份派生逻辑，保证三处一致。
function reviewState(db, clockId) {
  const reviewCase = latestCase(db, clockId);
  if (!reviewCase) {
    return {
      status: "none",
      statusText: STATUS_TEXT.none,
      nextAction: NEXT_ACTION.none,
      reviewCaseId: null,
      active: false,
      latestMeasurement: null,
      consecutivePasses: 0,
      nextAllowedRetestAt: null
    };
  }

  const measurement = latestMeasurement(reviewCase);
  let nextAction;
  let nextAllowedRetestAt = null;
  if (reviewCase.status === "awaiting_transfer") {
    nextAction = NEXT_ACTION.awaiting_transfer;
  } else if (reviewCase.status === "correcting") {
    if (reviewCase.consecutivePasses === 1) {
      const firstPass = reviewCase.retests[reviewCase.retests.length - 1];
      nextAllowedRetestAt = new Date(
        new Date(firstPass.measuredAt).getTime() + REQUALIFY_INTERVAL_MS
      ).toISOString();
      nextAction = NEXT_ACTION.correcting_second;
    } else {
      nextAction = NEXT_ACTION.correcting_first;
    }
  } else if (reviewCase.status === "queued") {
    nextAction = NEXT_ACTION.queued;
  } else {
    nextAction = NEXT_ACTION.voided;
  }

  return {
    status: reviewCase.status,
    statusText: STATUS_TEXT[reviewCase.status],
    nextAction,
    reviewCaseId: reviewCase.id,
    active: isActive(reviewCase),
    openedAt: reviewCase.openedAt,
    queuedAt: reviewCase.queuedAt,
    replacement: reviewCase.replacement,
    latestMeasurement: measurement,
    consecutivePasses: reviewCase.consecutivePasses,
    nextAllowedRetestAt
  };
}

// 旧接口（日差调校）仍沿用原判定。
function latestLegacyRetest(db, clockId) {
  return (db.retests || [])
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return (db.adjustments || [])
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  return {
    ...clock,
    latestAdjustment: latestAdjustment(db, clock.id),
    latestRetest: latestLegacyRetest(db, clock.id),
    review: reviewState(db, clock.id)
  };
}

module.exports = {
  CONCENTRICITY_LIMIT_MM,
  STATIC_BALANCE_LIMIT_MG_CM,
  REQUALIFY_INTERVAL_MS,
  DomainError,
  fail,
  makeId,
  required,
  findClock,
  casesOf,
  latestCase,
  startReview,
  transferToCorrection,
  submitRetest,
  replacePart,
  reviewState,
  clockSummary,
  latestLegacyRetest
};
