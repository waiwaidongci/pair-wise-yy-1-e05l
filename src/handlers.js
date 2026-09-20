/**
 * 请求入口层：HTTP 解析与路由编排，业务判定一律调用 rules.js，
 * 读写一律通过 store（JsonFileStore）。本文件不直接操作文件。
 */
const rules = require("./rules");

const {
  ApiError,
  required,
  nonEmpty,
  parseAt,
  readMeasurements,
  evaluateMeasurements,
  activeReview,
  reviewStateView,
  reviewMeasurements,
  decideRestore,
  findClock
} = rules;

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const PARTS = ["balance", "hairspring"];
const PART_LABELS = { balance: "摆轮", hairspring: "游丝" };

function createHandlers(store) {
  // ---------- HTTP 辅助 ----------
  function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
  }

  async function parseBody(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new ApiError(400, "请求体必须是合法JSON");
    }
  }

  // ---------- 视图组装（列表 / 历史 / 最新状态共用） ----------
  function clockReviewState(db, clock) {
    const open = activeReview(db, clock.id);
    if (open) return reviewStateView(db, open);
    const latest = db.reviews
      .filter((review) => review.clockId === clock.id)
      .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt))[0];
    return latest ? reviewStateView(db, latest) : null;
  }

  function clockSummary(db, clock) {
    const retest = db.retests
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
    const adjustment = db.adjustments
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
    const reviewState = clockReviewState(db, clock);
    return {
      ...clock,
      latestAdjustment: adjustment,
      latestRetest: retest,
      qualified: retest ? retest.qualified : false,
      reviewState,
      reviewStatus: reviewState ? reviewState.state : null,
      reviewStatusLabel: reviewState ? reviewState.stateLabel : null,
      hasActiveReview: Boolean(activeReview(db, clock.id))
    };
  }

  function buildMeasurement(db, review, body) {
    const values = readMeasurements(body);
    const inspector = nonEmpty(body.inspector, "复测人(inspector)");
    const verdict = evaluateMeasurements(values);
    // 校正后必须换人：复测人不得是最近一次校正的操作人
    const corrections = db.corrections
      .filter((item) => item.reviewId === review.id)
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    const lastCorrection = corrections[corrections.length - 1];
    if (lastCorrection && lastCorrection.operator === inspector) {
      throw new ApiError(
        409,
        `校正后必须换人复测：最近一次校正由${inspector}完成，须由其他技师复测`
      );
    }
    const prior = reviewMeasurements(db, review.id);
    const at = parseAt(body.at);
    if (prior.length && new Date(at) < new Date(prior[prior.length - 1].at)) {
      throw new ApiError(400, "测量时间不能早于该复核已有的最后一次测量");
    }
    return {
      measurement: {
        id: makeId("rvmeas"),
        reviewId: review.id,
        clockId: review.clockId,
        componentGeneration: review.componentGeneration,
        at,
        inspector,
        ...values,
        concentricityPass: verdict.concentricityPass,
        staticBalancePass: verdict.staticBalancePass,
        pass: verdict.pass,
        failReasons: verdict.reasons,
        note: body.note ? String(body.note) : ""
      },
      verdict,
      corrections
    };
  }

  // ---------- 路由处理 ----------
  async function health(req, res, url) {
    send(res, 200, { ok: true, service: "balance-hairspring-review-bench-api", routes: routeList() });
  }

  async function listClocks(req, res, url) {
    const db = await store.read();
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    const qualified = url.searchParams.get("qualified");
    if (qualified !== null) {
      data = data.filter((clock) => clock.qualified === (qualified === "true"));
    }
    const reviewStatus = url.searchParams.get("reviewStatus");
    if (reviewStatus !== null) {
      data = data.filter((clock) => clock.reviewStatus === reviewStatus);
    }
    send(res, 200, { data });
  }

  async function createClock(req, res) {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = await store.mutate((db) => {
      if (db.clocks.some((item) => item.code === body.code)) {
        throw new ApiError(409, "钟表编号已存在");
      }
      const clock = {
        id: makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        componentGeneration: 0,
        note: body.note ? String(body.note) : "",
        createdAt: new Date().toISOString()
      };
      db.clocks.push(clock);
      return clock;
    });
    const db = await store.read();
    send(res, 201, { data: clockSummary(db, db.clocks.find((item) => item.id === clock.id)) });
  }

  async function listNotQualified(req, res) {
    const db = await store.read();
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    send(res, 200, { data });
  }

  async function clockHistory(req, res, _url, id) {
    const db = await store.read();
    const clock = findClock(db, id);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    const reviews = db.reviews
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
    const reviewStates = reviews.map((review) => reviewStateView(db, review));
    const partReplacements = db.partReplacements
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(b.at) - new Date(a.at));
    send(res, 200, {
      data: {
        clock,
        adjustments,
        retests,
        reviews: reviewStates,
        partReplacements,
        latestRetest: retests.sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null,
        latestReviewState: reviewStates[0] || null
      }
    });
  }

  async function createAdjustment(req, res, _url, id) {
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = await store.mutate((db) => {
      const clock = findClock(db, id);
      const adjustment = {
        id: makeId("adjustment"),
        clockId: clock.id,
        currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.adjustments.push(adjustment);
      return adjustment;
    });
    send(res, 201, { data: adjustment });
  }

  async function createRetest(req, res, _url, id) {
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const result = await store.mutate((db) => {
      const clock = findClock(db, id);
      const adjustmentId = body.adjustmentId ||
        db.adjustments
          .filter((item) => item.clockId === clock.id)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]?.id || null;
      const qualified = body.qualified !== undefined
        ? Boolean(body.qualified)
        : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
      const retest = {
        id: makeId("retest"),
        clockId: clock.id,
        adjustmentId,
        testedAt: body.testedAt || new Date().toISOString(),
        dailyRateSeconds: Number(body.dailyRateSeconds),
        amplitude: Number(body.amplitude),
        qualified,
        note: body.note || ""
      };
      db.retests.push(retest);
      return { retest, clockId: clock.id };
    });
    const db = await store.read();
    send(res, 201, {
      data: result.retest,
      clock: clockSummary(db, db.clocks.find((item) => item.id === result.clockId))
    });
  }

  async function latestRetest(req, res, _url, id) {
    const db = await store.read();
    findClock(db, id);
    const retest = db.retests
      .filter((item) => item.clockId === id)
      .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
    send(res, 200, { data: retest, reviewState: clockReviewState(db, db.clocks.find((item) => item.id === id)) });
  }

  async function listAdjustments(req, res, url) {
    const db = await store.read();
    const clockId = url.searchParams.get("clockId");
    send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  async function listRetests(req, res, url) {
    const db = await store.read();
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    send(res, 200, { data });
  }

  // ---------- 复核台 ----------

  /** 登记复核：每表仅一条进行中的复核，重复/并发提交 409 且不落库（mutate 串行化） */
  async function openReview(req, res, _url, id) {
    const body = await parseBody(req);
    const result = await store.mutate((db) => {
      const clock = findClock(db, id);
      const existing = activeReview(db, clock.id);
      if (existing) {
        const error = new ApiError(409, "该表已有一条待复核记录，重复或并发提交已拒绝（未写入）");
        error.details = {
          existingReviewId: existing.id,
          state: reviewStateView(db, existing).state
        };
        throw error;
      }
      const inspector = nonEmpty(body.inspector, "登记人/复测人(inspector)");
      const values = readMeasurements(body);
      const verdict = evaluateMeasurements(values);
      const at = parseAt(body.at);
      const review = {
        id: makeId("review"),
        clockId: clock.id,
        componentGeneration: clock.componentGeneration || 0,
        status: "open",
        openedAt: at,
        openedBy: inspector,
        createdAt: new Date().toISOString()
      };
      const measurement = {
        id: makeId("rvmeas"),
        reviewId: review.id,
        clockId: clock.id,
        componentGeneration: review.componentGeneration,
        at,
        inspector,
        ...values,
        concentricityPass: verdict.concentricityPass,
        staticBalancePass: verdict.staticBalancePass,
        pass: verdict.pass,
        failReasons: verdict.reasons,
        note: body.note ? String(body.note) : ""
      };
      db.reviews.push(review);
      db.reviewMeasurements.push(measurement);
      return { reviewId: review.id, clockId: clock.id };
    });
    const db = await store.read();
    const review = db.reviews.find((item) => item.id === result.reviewId);
    send(res, 201, {
      data: reviewStateView(db, review),
      clock: clockSummary(db, db.clocks.find((item) => item.id === result.clockId))
    });
  }

  /** 追加一次复测登记；超差自动进入“只准转校正”，满足恢复条件则自动恢复排队 */
  async function addMeasurement(req, res, _url, reviewId) {
    const body = await parseBody(req);
    const result = await store.mutate((db) => {
      const review = db.reviews.find((item) => item.id === reviewId);
      if (!review) throw new ApiError(404, "复核记录不存在");
      if (review.status !== "open") {
        throw new ApiError(
          409,
          review.status === "invalidated"
            ? "该复核已因更换摆轮/游丝失效，请重新登记复核"
            : "该复核已恢复排队，不能继续登记"
        );
      }
      const currentState = reviewStateView(db, review);
      if (!currentState.allowedActions.includes("measure")) {
        throw new ApiError(409, "同心度或静平衡超差，只准转校正，不能直接复测");
      }
      const { measurement, corrections } = buildMeasurement(db, review, body);
      db.reviewMeasurements.push(measurement);

      let decision;
      if (!measurement.pass) {
        decision = { restored: false, code: "NEEDS_CORRECTION" };
      } else {
        const measurements = reviewMeasurements(db, review.id); // 含刚插入的本条
        decision = decideRestore(measurements.slice(0, -1), measurement, corrections);
      }

      // pass：达标但尚未满足恢复条件（首次达标或间隔不足）；fail：只准转校正
      if (decision.restored) {
        review.status = "restored";
        review.restoredAt = measurement.at;
        review.restoreAt = measurement.at;
        review.restoreReason =
          `连续两次达标（${measurement.id} / ${decision.priorMeasurementId}），间隔满4小时，校正后已换人复测`;
        review.restoredBy = measurement.inspector;
      }
      return {
        reviewId: review.id,
        clockId: review.clockId,
        measurement,
        decision
      };
    });
    const db = await store.read();
    const review = db.reviews.find((item) => item.id === result.reviewId);
    const state = reviewStateView(db, review);
    const payload = {
      data: state,
      measurement: result.measurement,
      decision: result.decision
    };
    if (!result.measurement.pass) {
      payload.decision.message = "同心度或静平衡超差，只准转校正";
    } else if (!result.decision.restored && result.decision.code === "INTERVAL_TOO_SHORT") {
      payload.decision.message = `两次达标复测间隔不足4小时，约还需${result.decision.waitHours}小时`;
    } else if (!result.decision.restored && result.decision.code === "NEED_SECOND_PASS") {
      payload.decision.message = "首次达标，需在4小时后再由一次达标复测确认";
    } else if (result.decision.restored) {
      payload.decision.message = "连续两次达标且间隔满4小时，已恢复排队";
    }
    send(res, 201, payload);
  }

  /** 转校正：登记校正操作与校正人，之后进入“校正待换人复测” */
  async function addCorrection(req, res, _url, reviewId) {
    const body = await parseBody(req);
    const result = await store.mutate((db) => {
      const review = db.reviews.find((item) => item.id === reviewId);
      if (!review) throw new ApiError(404, "复核记录不存在");
      if (review.status !== "open") {
        throw new ApiError(409, review.status === "invalidated" ? "该复核已失效，不能校正" : "该复核已恢复排队");
      }
      const state = reviewStateView(db, review);
      if (!state.allowedActions.includes("correct")) {
        throw new ApiError(409, "当前测量仍达标，不允许转校正");
      }
      required(body, ["operator", "action"]);
      const operator = nonEmpty(body.operator, "校正人(operator)");
      const action = nonEmpty(body.action, "校正措施(action)");
      const at = parseAt(body.at);
      const correction = {
        id: makeId("correction"),
        reviewId: review.id,
        clockId: review.clockId,
        componentGeneration: review.componentGeneration,
        operator,
        action,
        at,
        note: body.note ? String(body.note) : ""
      };
      db.corrections.push(correction);
      return { correction, clockId: review.clockId, reviewId: review.id };
    });
    const db = await store.read();
    send(res, 201, {
      data: reviewStateView(db, db.reviews.find((item) => item.id === result.reviewId)),
      correction: result.correction
    });
  }

  /** 更换摆轮或游丝：进行中的复核立即失效（旧记录保留可查），部件代次+1 */
  async function replacePart(req, res, _url, id) {
    const body = await parseBody(req);
    required(body, ["parts", "operator"]);
    const partsRaw = Array.isArray(body.parts) ? body.parts : String(body.parts).split(",");
    const parts = partsRaw.map((part) => String(part).trim()).filter(Boolean);
    if (!parts.length) throw new ApiError(400, "parts 至少包含 balance 或 hairspring");
    const invalid = parts.filter((part) => !PARTS.includes(part));
    if (invalid.length) throw new ApiError(400, `不支持的部件：${invalid.join(", ")}（仅 balance/hairspring）`);
    const uniqueParts = [...new Set(parts)];

    const result = await store.mutate((db) => {
      const clock = findClock(db, id);
      const operator = nonEmpty(body.operator, "操作人(operator)");
      const at = parseAt(body.at);
      const review = activeReview(db, clock.id);
      const generation = (clock.componentGeneration || 0) + 1;
      const replacement = {
        id: makeId("replace"),
        clockId: clock.id,
        parts: uniqueParts,
        partLabels: uniqueParts.map((part) => PART_LABELS[part]),
        operator,
        at,
        previousGeneration: clock.componentGeneration || 0,
        generation,
        invalidatedReviewId: review ? review.id : null,
        note: body.note ? String(body.note) : ""
      };
      db.partReplacements.push(replacement);
      clock.componentGeneration = generation;
      if (review) {
        review.status = "invalidated";
        review.invalidatedAt = at;
        review.invalidatedBy = operator;
        review.invalidatedReason = `更换${replacement.partLabels.join("、")}，旧复核失效`;
        review.invalidateReason = review.invalidatedReason;
        review.invalidatedByReplacementId = replacement.id;
      }
      return { replacement, reviewId: review ? review.id : null, clockId: clock.id };
    });
    const db = await store.read();
    send(res, 201, {
      data: result.replacement,
      review: result.reviewId
        ? reviewStateView(db, db.reviews.find((item) => item.id === result.reviewId))
        : null,
      clock: clockSummary(db, db.clocks.find((item) => item.id === result.clockId))
    });
  }

  /** 复核列表：可按 clockId / state（派生状态）/ status（open|restored|invalidated）筛选 */
  async function listReviews(req, res, url) {
    const db = await store.read();
    const clockId = url.searchParams.get("clockId");
    const state = url.searchParams.get("state");
    const status = url.searchParams.get("status");
    let views = db.reviews
      .slice()
      .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt))
      .map((review) => reviewStateView(db, review));
    if (clockId) views = views.filter((view) => view.clockId === clockId);
    if (state) views = views.filter((view) => view.state === state);
    if (status) views = views.filter((view) => view.status === status);
    send(res, 200, { data: views });
  }

  /** 单表复核历史：失效与已恢复的旧记录全部可查，最新在前，含最新复测状态 */
  async function clockReviews(req, res, _url, id) {
    const db = await store.read();
    findClock(db, id);
    const views = db.reviews
      .filter((review) => review.clockId === id)
      .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt))
      .map((review) => reviewStateView(db, review));
    const partReplacements = db.partReplacements
      .filter((item) => item.clockId === id)
      .sort((a, b) => new Date(b.at) - new Date(a.at));
    send(res, 200, { data: views, latestReviewState: views[0] || null, partReplacements });
  }

  /** 最新复测状态（复核台口径） */
  async function reviewStatus(req, res, _url, id) {
    const db = await store.read();
    const clock = findClock(db, id);
    send(res, 200, { data: clockReviewState(db, clock) });
  }

  // ---------- 路由 ----------
  const routes = [
    [/^GET \/health$/, health],
    [/^GET \/clocks$/, listClocks],
    [/^POST \/clocks$/, createClock],
    [/^GET \/clocks\/not-qualified$/, listNotQualified],
    [/^GET \/adjustments$/, listAdjustments],
    [/^GET \/retests$/, listRetests],
    [/^GET \/reviews$/, listReviews],
    [/^GET \/clocks\/([^/]+)\/history$/, clockHistory],
    [/^GET \/clocks\/([^/]+)\/latest-retest$/, latestRetest],
    [/^GET \/clocks\/([^/]+)\/reviews$/, clockReviews],
    [/^GET \/clocks\/([^/]+)\/review-status$/, reviewStatus],
    [/^POST \/clocks\/([^/]+)\/reviews$/, openReview],
    [/^POST \/clocks\/([^/]+)\/adjustments$/, createAdjustment],
    [/^POST \/clocks\/([^/]+)\/retests$/, createRetest],
    [/^POST \/clocks\/([^/]+)\/part-replacements$/, replacePart],
    [/^POST \/reviews\/([^/]+)\/measurements$/, addMeasurement],
    [/^POST \/reviews\/([^/]+)\/corrections$/, addCorrection]
  ];

  function routeList() {
    return [
      "GET /health",
      "GET /clocks",
      "POST /clocks",
      "GET /clocks/not-qualified",
      "GET /clocks/:id/history",
      "POST /clocks/:id/adjustments",
      "POST /clocks/:id/retests",
      "GET /clocks/:id/latest-retest",
      "GET /adjustments",
      "GET /retests",
      "POST /clocks/:id/reviews",
      "GET /clocks/:id/reviews",
      "GET /clocks/:id/review-status",
      "POST /clocks/:id/part-replacements",
      "GET /reviews?clockId=&state=&status=",
      "POST /reviews/:id/measurements",
      "POST /reviews/:id/corrections"
    ];
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = `${req.method} ${url.pathname}`;
    for (const [pattern, handler] of routes) {
      const match = key.match(pattern);
      if (match) return handler(req, res, url, ...match.slice(1));
    }
    send(res, 404, { error: "接口不存在", routes: routeList() });
  }

  return (req, res) =>
    handle(req, res).catch((error) => {
      const status = error.status || 500;
      const body = { error: error.message || "服务器错误" };
      if (error.details) body.details = error.details;
      send(res, status, body);
    });
}

module.exports = { createHandlers };
