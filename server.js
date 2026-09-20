// HTTP 入口层：只负责路由、报文解析与响应；判定规则在 lib/rules.js，持久化在 lib/store.js。
const http = require("http");
const rules = require("./lib/rules");
const store = require("./lib/store");
const seed = require("./lib/seed");

const PORT = Number(process.env.PORT || 3021);

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "GET /clocks/:id/reviews",
  "GET /clocks/:id/review/latest",
  "POST /clocks/:id/review",
  "POST /clocks/:id/review/transfer",
  "POST /clocks/:id/review/retests",
  "POST /clocks/:id/review/replacement",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "GET /reviews"
];

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
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    error.code = "VALIDATION_ERROR";
    throw error;
  }
}

function requiredLegacy(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    error.code = "VALIDATION_ERROR";
    throw error;
  }
}

// 所有写操作走同一把互斥锁，冲突/校验失败时 mutator 抛错，store 不会写盘。
function mutate(fn) {
  return store.update(seed, fn);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const params = url.searchParams;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, {
      ok: true,
      service: "clock-balance-review-station-api",
      limits: {
        hairspringConcentricityMm: rules.CONCENTRICITY_LIMIT_MM,
        staticBalanceMgCm: rules.STATIC_BALANCE_LIMIT_MG_CM,
        requalifyIntervalHours: rules.REQUALIFY_INTERVAL_MS / 3600000,
        requiredConsecutivePasses: 2
      },
      routes
    });
  }

  // ---------- 钟表档案 ----------
  if (req.method === "GET" && pathname === "/clocks") {
    const db = await store.readDb(seed);
    let data = db.clocks.map((clock) => rules.clockSummary(db, clock));
    const reviewStatus = params.get("reviewStatus");
    if (reviewStatus !== null) data = data.filter((clock) => clock.review.status === reviewStatus);
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    requiredLegacy(body, ["code", "escapementType", "balanceFrequency"]);
    const { data } = await mutate((db) => {
      const clock = {
        id: rules.makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.clocks.push(clock);
      return { data: rules.clockSummary(db, clock) };
    });
    return send(res, 201, { data });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const db = await store.readDb(seed);
    const data = db.clocks
      .map((clock) => rules.clockSummary(db, clock))
      .filter((clock) => !(clock.latestRetest && clock.latestRetest.qualified));
    return send(res, 200, { data });
  }

  // ---------- 游丝同心度 / 摆轮静平衡复核台 ----------
  const transferMatch = pathname.match(/^\/clocks\/([^/]+)\/review\/transfer$/);
  if (transferMatch && req.method === "POST") {
    const body = await parseBody(req);
    const clockId = transferMatch[1];
    const { data, review } = await mutate((db) => {
      const reviewCase = rules.transferToCorrection(db, clockId, body);
      return { data: reviewCase, review: rules.reviewState(db, clockId) };
    });
    return send(res, 201, { data, review });
  }

  const reviewRetestMatch = pathname.match(/^\/clocks\/([^/]+)\/review\/retests$/);
  if (reviewRetestMatch && req.method === "POST") {
    const body = await parseBody(req);
    const clockId = reviewRetestMatch[1];
    const { data, review } = await mutate((db) => {
      const reviewCase = rules.submitRetest(db, clockId, body);
      return { data: reviewCase, review: rules.reviewState(db, clockId) };
    });
    return send(res, 201, { data, review });
  }

  const replacementMatch = pathname.match(/^\/clocks\/([^/]+)\/review\/replacement$/);
  if (replacementMatch && req.method === "POST") {
    const body = await parseBody(req);
    const clockId = replacementMatch[1];
    const { data, review } = await mutate((db) => {
      const reviewCase = rules.replacePart(db, clockId, body);
      return { data: reviewCase, review: rules.reviewState(db, clockId) };
    });
    return send(res, 201, { data, review });
  }

  const reviewLatestMatch = pathname.match(/^\/clocks\/([^/]+)\/review\/latest$/);
  if (reviewLatestMatch && req.method === "GET") {
    const db = await store.readDb(seed);
    rules.findClock(db, reviewLatestMatch[1]);
    return send(res, 200, { data: rules.reviewState(db, reviewLatestMatch[1]) });
  }

  const reviewListMatch = pathname.match(/^\/clocks\/([^/]+)\/reviews$/);
  if (reviewListMatch && req.method === "GET") {
    const db = await store.readDb(seed);
    rules.findClock(db, reviewListMatch[1]);
    return send(res, 200, {
      data: rules.casesOf(db, reviewListMatch[1]),
      latest: rules.reviewState(db, reviewListMatch[1])
    });
  }

  const reviewStartMatch = pathname.match(/^\/clocks\/([^/]+)\/review$/);
  if (reviewStartMatch && req.method === "POST") {
    const body = await parseBody(req);
    const data = await mutate((db) => rules.startReview(db, reviewStartMatch[1], body));
    return send(res, 201, { data });
  }

  if (req.method === "GET" && pathname === "/reviews") {
    const db = await store.readDb(seed);
    const clockId = params.get("clockId");
    const status = params.get("status");
    const data = db.reviewCases
      .filter((item) => !clockId || item.clockId === clockId)
      .filter((item) => !status || item.status === status);
    return send(res, 200, { data });
  }

  // ---------- 单表历史（旧调校 + 复核台记录，最新状态三处同源） ----------
  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const db = await store.readDb(seed);
    const clock = rules.findClock(db, historyMatch[1]);
    return send(res, 200, {
      data: {
        clock,
        adjustments: db.adjustments.filter((item) => item.clockId === clock.id),
        retests: db.retests.filter((item) => item.clockId === clock.id),
        reviewCases: rules.casesOf(db, clock.id),
        latestRetest: rules.latestLegacyRetest(db, clock.id),
        review: rules.reviewState(db, clock.id)
      }
    });
  }

  // ---------- 旧版日差调校接口（保留兼容） ----------
  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const body = await parseBody(req);
    requiredLegacy(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const data = await mutate((db) => {
      const clock = rules.findClock(db, adjustmentMatch[1]);
      const adjustment = {
        id: rules.makeId("adjustment"),
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
    return send(res, 201, { data });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const body = await parseBody(req);
    requiredLegacy(body, ["dailyRateSeconds", "amplitude"]);
    const data = await mutate((db) => {
      const clock = rules.findClock(db, retestMatch[1]);
      const adjustmentId =
        body.adjustmentId ||
        db.adjustments
          .filter((item) => item.clockId === clock.id)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]?.id ||
        null;
      const qualified =
        body.qualified !== undefined
          ? Boolean(body.qualified)
          : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
      const retest = {
        id: rules.makeId("retest"),
        clockId: clock.id,
        adjustmentId,
        testedAt: body.testedAt || new Date().toISOString(),
        dailyRateSeconds: Number(body.dailyRateSeconds),
        amplitude: Number(body.amplitude),
        qualified,
        note: body.note || ""
      };
      db.retests.push(retest);
      return retest;
    });
    return send(res, 201, { data });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    const db = await store.readDb(seed);
    rules.findClock(db, latestMatch[1]);
    return send(res, 200, { data: rules.latestLegacyRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const db = await store.readDb(seed);
    const clockId = params.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const db = await store.readDb(seed);
    const clockId = params.get("clockId");
    const qualified = params.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, {
      error: error.message || "服务器错误",
      code: error.code || "INTERNAL_ERROR"
    })
  );
});

server.listen(PORT, () => {
  console.log(`Clock balance review station API running at http://127.0.0.1:${PORT}`);
});

module.exports = server;
