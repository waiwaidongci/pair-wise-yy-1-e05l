/**
 * 判定规则层（纯函数，不做任何 I/O）
 * 游丝同心度与摆轮静平衡复核台的全部业务口径都集中在这里，
 * 请求入口与各列表/历史视图共用同一套计算，保证状态一致。
 */

const CONCENTRICITY_LIMIT_MM = 0.03; // 同心度合格上限：0.03 毫米
const STATIC_BALANCE_LIMIT_MGCM = 5; // 静平衡合格上限：5 毫克·厘米
const RESTORE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 两次合格复测间隔：4 小时

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new ApiError(status, message);
}

function present(value) {
  return value !== undefined && value !== null && value !== "";
}

function required(body, fields) {
  const missing = fields.filter((field) => !present(body[field]));
  if (missing.length) fail(400, `缺少字段：${missing.join(", ")}`);
}

function toFiniteNumber(value, label, { min = 0, allowNegative = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) fail(400, `${label}必须是数字`);
  if (!allowNegative && num < min) fail(400, `${label}不能小于0`);
  return num;
}

function nonEmpty(value, label) {
  const str = String(value ?? "").trim();
  if (!str) fail(400, `${label}不能为空`);
  return str;
}

function parseAt(value, fallback = new Date().toISOString()) {
  if (!present(value)) return fallback;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) fail(400, "时间格式不合法");
  return new Date(time).toISOString();
}

/** 读取一次登记/复测的三项测量值 */
function readMeasurements(body) {
  required(body, ["concentricity", "staticBalance", "amplitude"]);
  const concentricity = toFiniteNumber(body.concentricity, "同心度");
  const staticBalance = toFiniteNumber(body.staticBalance, "静平衡");
  const amplitude = toFiniteNumber(body.amplitude, "摆幅");
  return {
    concentricity: round(concentricity, 4),
    staticBalance: round(staticBalance, 4),
    amplitude: round(amplitude, 1)
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 单项是否达标：同心度 ≤ 0.03mm，静平衡 ≤ 5mg·cm。摆幅仅登记不参与判定。 */
function evaluateMeasurements(values) {
  const concentricityPass = values.concentricity <= CONCENTRICITY_LIMIT_MM + 1e-9;
  const staticBalancePass = values.staticBalance <= STATIC_BALANCE_LIMIT_MGCM + 1e-9;
  const pass = concentricityPass && staticBalancePass;
  return {
    concentricityPass,
    staticBalancePass,
    pass,
    reasons: [
      ...(concentricityPass ? [] : [`同心度${values.concentricity}毫米超过${CONCENTRICITY_LIMIT_MM}毫米`]),
      ...(staticBalancePass ? [] : [`静平衡${values.staticBalance}毫克厘米超过${STATIC_BALANCE_LIMIT_MGCM}毫克厘米`])
    ]
  };
}

const byAtDesc = (a, b) => new Date(b.at) - new Date(a.at);
const byAtAsc = (a, b) => new Date(a.at) - new Date(b.at);

function activeReview(db, clockId) {
  return db.reviews
    .filter((review) => review.clockId === clockId && review.status === "open")
    .sort(byAtDesc)[0] || null;
}

function reviewMeasurements(db, reviewId) {
  return db.reviewMeasurements
    .filter((item) => item.reviewId === reviewId)
    .slice()
    .sort(byAtAsc);
}

function reviewCorrections(db, reviewId) {
  return db.corrections
    .filter((item) => item.reviewId === reviewId)
    .slice()
    .sort(byAtAsc);
}

/** 从末尾连续合格测量数 */
function trailingPasses(measurements) {
  let count = 0;
  for (let i = measurements.length - 1; i >= 0; i -= 1) {
    if (measurements[i].pass) count += 1;
    else break;
  }
  return count;
}

function allowedActions(review, state) {
  if (review.status !== "open") return [];
  const correctionPending = state.latestCorrection &&
    (!state.latestMeasurement || state.latestMeasurement.at < state.latestCorrection.at);
  if (correctionPending) return ["measure"]; // 校正后只能换人复测
  const last = state.latestMeasurement;
  if (!last) return ["measure"];
  if (!last.pass) return ["correct"]; // 超差：只准转校正
  return ["measure"]; // 已达标：等待下一次达标复测
}

/**
 * 复核状态视图。所有接口（列表 / 单表历史 / 最新复测状态）都经过这里计算。
 *
 * 状态机：
 *   待复核登记 -> measuring/awaiting_correction（校正后 awaiting_retest）
 *   -> 校正由非校正人复测 -> 连续两次达标且间隔≥4h -> restored（恢复排队，终态）
 * 更换摆轮或游丝 -> invalidated（旧复核失效，终态，旧记录仍可查）
 */
function reviewStateView(db, review) {
  const measurements = reviewMeasurements(db, review.id);
  const corrections = reviewCorrections(db, review.id);
  const latestMeasurement = measurements[measurements.length - 1] || null;
  const latestCorrection = corrections[corrections.length - 1] || null;
  const replacement = db.partReplacements.find(
    (item) => item.invalidatedReviewId === review.id
  ) || null;

  if (review.status === "invalidated") {
    const view = {
      id: review.id,
      clockId: review.clockId,
      componentGeneration: review.componentGeneration,
      status: "invalidated",
      state: "invalidated",
      stateLabel: "已失效",
      reason: review.invalidateReason || "更换摆轮或游丝，旧复核失效",
      openedAt: review.openedAt,
      closedAt: review.invalidatedAt || null,
      passStreak: trailingPasses(measurements),
      restoreAt: null,
      reviewerChangeRequired: false,
      lastOperator: latestCorrection?.operator || null,
      latestMeasurement,
      latestCorrection,
      replacement,
      measurements,
      corrections,
      allowedActions: []
    };
    return view;
  }

  if (review.status === "restored") {
    return {
      id: review.id,
      clockId: review.clockId,
      componentGeneration: review.componentGeneration,
      status: "restored",
      state: "restored",
      stateLabel: "已恢复排队",
      reason: review.restoreReason || "连续两次达标且间隔满4小时",
      openedAt: review.openedAt,
      closedAt: review.restoredAt || null,
      passStreak: 2,
      restoreAt: review.restoreAt || null,
      intervalHours: 4,
      reviewerChangeRequired: false,
      lastOperator: latestCorrection?.operator || null,
      latestMeasurement,
      latestCorrection,
      replacement,
      measurements,
      corrections,
      allowedActions: []
    };
  }

  // open：状态由测量/校正记录实时推导
  const passStreak = trailingPasses(measurements);
  let state;
  let stateLabel;
  let reason;
  let restoreAt = null;
  let reviewerChangeRequired = false;

  if (measurements.length === 0) {
    state = "measuring";
    stateLabel = "待首次测量";
    reason = "复核已登记，等待同心度/静平衡/摆幅登记";
  } else if (latestCorrection && (!latestMeasurement || latestMeasurement.at < latestCorrection.at)) {
    state = "awaiting_retest";
    stateLabel = "校正待换人复测";
    reason = `已由${latestCorrection.operator}校正，须由其他技师复测`;
    reviewerChangeRequired = true;
  } else if (!latestMeasurement.pass) {
    state = "awaiting_correction";
    stateLabel = "只准转校正";
    reason = latestMeasurement.failReasons.join("；");
  } else {
    state = "retesting";
    stateLabel = "复测中，等待连续第二次达标";
    // 下一次达标复测至少需晚于最近一次达标测量 4 小时
    restoreAt = new Date(new Date(latestMeasurement.at).getTime() + RESTORE_INTERVAL_MS).toISOString();
    if (passStreak === 1) {
      reason = "首次达标，满4小时后再复测达标方可恢复排队";
    } else {
      reason = "已连续达标但间隔不足4小时，满4小时后再复测达标即可恢复排队";
    }
    // 若本复核周期发生过校正，后续复测必须换人（校正人与复测人不同）
    reviewerChangeRequired = Boolean(latestCorrection);
  }

  const view = {
    id: review.id,
    clockId: review.clockId,
    componentGeneration: review.componentGeneration,
    status: "open",
    state,
    stateLabel,
    reason,
    openedAt: review.openedAt,
    closedAt: null,
    passStreak,
    restoreAt,
    intervalHours: 4,
    reviewerChangeRequired,
    lastOperator: latestCorrection ? latestCorrection.operator : null,
    latestMeasurement,
    latestCorrection,
    replacement,
    measurements,
    corrections,
    allowedActions: []
  };
  view.allowedActions = allowedActions(review, view);
  return view;
}

/**
 * 判断一次新测量是否满足“恢复排队”，返回是否已恢复及原因。
 * 恢复条件（在本条测量达标的前提下同时满足）：
 *   1) 与上一条达标测量构成连续两次达标（中间无不合格测量）；
 *   2) 两次测量间隔满 4 小时；
 *   3) 若此前做过校正，复测人不得是最后一次校正的校正人（校正后换人复测）。
 */
function decideRestore(measurements, incoming, corrections) {
  const prior = measurements[measurements.length - 1] || null;
  const passStreak = trailingPasses(measurements);
  if (!incoming.pass) return { restored: false, code: "NEEDS_CORRECTION" };
  if (!prior || !prior.pass || passStreak < 1) {
    return { restored: false, code: "NEED_SECOND_PASS" };
  }
  const gapMs = new Date(incoming.at) - new Date(prior.at);
  if (gapMs < RESTORE_INTERVAL_MS) {
    const waitHours = Math.ceil((RESTORE_INTERVAL_MS - gapMs) / 3600000);
    return { restored: false, code: "INTERVAL_TOO_SHORT", gapMs, waitHours };
  }
  const lastCorrection = corrections[corrections.length - 1];
  if (lastCorrection && lastCorrection.operator === incoming.inspector) {
    return { restored: false, code: "SAME_AS_CORRECTOR" };
  }
  return { restored: true, code: "RESTORED", priorMeasurementId: prior.id };
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) fail(404, "钟表不存在");
  return clock;
}

module.exports = {
  CONCENTRICITY_LIMIT_MM,
  STATIC_BALANCE_LIMIT_MGCM,
  RESTORE_INTERVAL_MS,
  ApiError,
  fail,
  required,
  toFiniteNumber,
  nonEmpty,
  parseAt,
  readMeasurements,
  evaluateMeasurements,
  round,
  activeReview,
  reviewMeasurements,
  reviewCorrections,
  trailingPasses,
  reviewStateView,
  decideRestore,
  findClock
};
