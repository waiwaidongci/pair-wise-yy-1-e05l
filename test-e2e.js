// 端到端流程验证：启动临时端口/临时库，覆盖全部判定规则。
const { spawn } = require("child_process");
const { once } = require("events");
const { mkdtemp, rm } = require("fs/promises");
const os = require("os");
const path = require("path");

const BASE = "http://127.0.0.1:3099";
let tmpDir;
let server;
let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
}

async function req(method, url, body, expectedStatus = 200) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  check(`${method} ${url} -> ${expectedStatus}`, res.status === expectedStatus, `实际 ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return { status: res.status, json };
}

const H = 3600000;
const t = (offsetH) => new Date(Date.now() + offsetH * H).toISOString();

async function main() {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "review-test-"));
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: "3099", DB_FILE: path.join(tmpDir, "db.json") },
    stdio: "inherit"
  });
  await new Promise((resolve) => setTimeout(resolve, 800));

  // 0. 健康检查暴露阈值
  const health = await req("GET", "/health", null, 200);
  check("同心度阈值0.03", health.json.limits.hairspringConcentricityMm === 0.03);
  check("静平衡阈值5", health.json.limits.staticBalanceMgCm === 5);
  check("间隔4小时", health.json.limits.requalifyIntervalHours === 4);

  // 1. 建档
  const clock = await req("POST", "/clocks", {
    code: "T-E2E-01", escapementType: "同轴擒纵", balanceFrequency: "28800vph"
  }, 201);
  const cid = clock.json.data.id;

  // 2. 超标登记 -> awaiting_transfer
  const r1 = await req("POST", `/clocks/${cid}/review`, {
    operator: "张师傅", hairspringConcentricityMm: 0.05, staticBalanceMgCm: 3, amplitudeDegrees: 220, measuredAt: t(-10)
  }, 201);
  check("同心度超标状态 awaiting_transfer", r1.json.data.status === "awaiting_transfer");

  // 3. 重复提交 -> 409 不落库
  const beforeCount = (await req("GET", `/clocks/${cid}/reviews`, null, 200)).json.data.length;
  await req("POST", `/clocks/${cid}/review`, {
    operator: "李师傅", hairspringConcentricityMm: 0.01, staticBalanceMgCm: 1, amplitudeDegrees: 260
  }, 409).then((x) => check("重复提交错误码 REVIEW_ALREADY_OPEN", x.json.code === "REVIEW_ALREADY_OPEN"));
  const afterCount = (await req("GET", `/clocks/${cid}/reviews`, null, 200)).json.data.length;
  check("409 不落库", beforeCount === afterCount, `${beforeCount} vs ${afterCount}`);

  // 4. 并发提交 -> 只有一个成功，另一个 409
  const c2 = (await req("POST", "/clocks", { code: "T-CONC", escapementType: "x", balanceFrequency: "21600vph" }, 201)).json.data.id;
  const body = { operator: "赵师傅", hairspringConcentricityMm: 0.04, staticBalanceMgCm: 2, amplitudeDegrees: 200 };
  const [a, b] = await Promise.all([
    fetch(BASE + `/clocks/${c2}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    fetch(BASE + `/clocks/${c2}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  ]);
  const statuses = [a.status, b.status].sort();
  check("并发提交 201+409", JSON.stringify(statuses) === JSON.stringify([201, 409]), JSON.stringify(statuses));
  const concReviews = (await req("GET", `/clocks/${c2}/reviews`, null, 200)).json.data.length;
  check("并发只落一条", concReviews === 1, `实际 ${concReviews}`);

  // 5. 静平衡超标且阈值边界：等于阈值算达标
  const c3 = (await req("POST", "/clocks", { code: "T-EDGE", escapementType: "x", balanceFrequency: "21600vph" }, 201)).json.data.id;
  const edge = await req("POST", `/clocks/${c3}/review`, {
    operator: "钱师傅", hairspringConcentricityMm: 0.03, staticBalanceMgCm: 5, amplitudeDegrees: 250
  }, 201);
  check("等于阈值即达标->queued", edge.json.data.status === "queued");

  // 6. awaiting_transfer 直接复测 -> 409；只准转校正
  await req("POST", `/clocks/${cid}/review/retests`, {
    operator: "王师傅", hairspringConcentricityMm: 0.01, staticBalanceMgCm: 1, amplitudeDegrees: 260
  }, 409).then((x) => check("未转校正禁止复测", x.json.code === "NOT_IN_CORRECTION"));

  const tr = await req("POST", `/clocks/${cid}/review/transfer`, {
    operator: "张师傅", actions: "重拨外桩，校正游丝同心度", correctedAt: t(-9)
  }, 201);
  check("转校正状态 correcting", tr.json.data.status === "correcting");

  // 7. 复测人必须换人
  await req("POST", `/clocks/${cid}/review/retests`, {
    operator: "张师傅", hairspringConcentricityMm: 0.01, staticBalanceMgCm: 1, amplitudeDegrees: 260, measuredAt: t(-8)
  }, 409).then((x) => check("校正人复测被拒", x.json.code === "OPERATOR_MUST_CHANGE"));

  // 8. 第一次复测达标（间隔规则此时不适用）
  const rt1 = await req("POST", `/clocks/${cid}/review/retests`, {
    operator: "王师傅", hairspringConcentricityMm: 0.02, staticBalanceMgCm: 2, amplitudeDegrees: 255, measuredAt: t(-6)
  }, 201);
  check("首次复测达标后仍 correcting", rt1.json.data.status === "correcting");
  check("连续计数=1", rt1.json.data.consecutivePasses === 1);

  // 9. 间隔不足4小时的第二次达标复测 -> 409 不落库
  const retestsBefore = rt1.json.data.retests.length;
  await req("POST", `/clocks/${cid}/review/retests`, {
    operator: "王师傅", hairspringConcentricityMm: 0.01, staticBalanceMgCm: 1, amplitudeDegrees: 260, measuredAt: t(-3)
  }, 409).then((x) => check("间隔不足4h拒绝", x.json.code === "RETEST_INTERVAL_NOT_MET"));
  const between = (await req("GET", `/clocks/${cid}/reviews`, null, 200)).json.data[0].retests.length;
  check("间隔不足的复测不落库", between === retestsBefore);
  const latestEarly = (await req("GET", `/clocks/${cid}/review/latest`, null, 200)).json.data;
  check("latest 给出可复测时间", !!latestEarly.nextAllowedRetestAt);

  // 9b. 间隔内复测本身不达标：不被间隔规则拦截，正常落库并清零退回待转校正
  const c5 = (await req("POST", "/clocks", { code: "T-BRK", escapementType: "x", balanceFrequency: "21600vph" }, 201)).json.data.id;
  await req("POST", `/clocks/${c5}/review`, { operator: "A", hairspringConcentricityMm: 0.09, staticBalanceMgCm: 1, amplitudeDegrees: 200, measuredAt: t(-20) }, 201);
  await req("POST", `/clocks/${c5}/review/transfer`, { operator: "A", actions: "拨外桩", correctedAt: t(-19) }, 201);
  const b1 = await req("POST", `/clocks/${c5}/review/retests`, { operator: "B", hairspringConcentricityMm: 0.02, staticBalanceMgCm: 1, amplitudeDegrees: 240, measuredAt: t(-3) }, 201);
  check("新表首次达标计数1", b1.json.data.consecutivePasses === 1);
  const b2 = await req("POST", `/clocks/${c5}/review/retests`, { operator: "B", hairspringConcentricityMm: 0.07, staticBalanceMgCm: 1, amplitudeDegrees: 240, measuredAt: t(-1) }, 201);
  check("间隔内超标复测正常落库", b2.json.data.retests.length === 2);
  check("超标清零并退回待转校正", b2.json.data.consecutivePasses === 0 && b2.json.data.status === "awaiting_transfer");
  // 清零后再次转校正-首次达标，重新计时（t(-1) 为基准）
  await req("POST", `/clocks/${c5}/review/transfer`, { operator: "A", actions: "再次拨外桩", correctedAt: t(-0.5) }, 201);
  const b3 = await req("POST", `/clocks/${c5}/review/retests`, { operator: "C", hairspringConcentricityMm: 0.02, staticBalanceMgCm: 1, amplitudeDegrees: 245, measuredAt: t(0) }, 201);
  check("重新校正后首次达标", b3.json.data.consecutivePasses === 1);

  // 10. 满4小时第二次达标 -> queued 恢复排队
  const rt2 = await req("POST", `/clocks/${cid}/review/retests`, {
    operator: "王师傅", hairspringConcentricityMm: 0.01, staticBalanceMgCm: 1, amplitudeDegrees: 262, measuredAt: t(-1)
  }, 201);
  check("两次达标恢复排队", rt2.json.data.status === "queued");
  check("queuedAt 已记录", !!rt2.json.data.queuedAt);

  // 已恢复后再提交复测 -> 409
  await req("POST", `/clocks/${cid}/review/retests`, {
    operator: "王师傅", hairspringConcentricityMm: 0.01, staticBalanceMgCm: 1, amplitudeDegrees: 262
  }, 409).then((x) => check("排队后复测被拒", x.json.code === "NOT_IN_CORRECTION"));

  // 11. 复测不达标会打断连续计数：新表走一遍失败分支
  const c4 = (await req("POST", "/clocks", { code: "T-FAIL", escapementType: "x", balanceFrequency: "21600vph" }, 201)).json.data.id;
  await req("POST", `/clocks/${c4}/review`, { operator: "A", hairspringConcentricityMm: 0.09, staticBalanceMgCm: 9, amplitudeDegrees: 200, measuredAt: t(-20) }, 201);
  await req("POST", `/clocks/${c4}/review/transfer`, { operator: "A", actions: "锉摆轮配重并拨外桩", correctedAt: t(-19) }, 201);
  const f1 = await req("POST", `/clocks/${c4}/review/retests`, { operator: "B", hairspringConcentricityMm: 0.02, staticBalanceMgCm: 2, amplitudeDegrees: 240, measuredAt: t(-18) }, 201);
  check("首次达标计数1", f1.json.data.consecutivePasses === 1 && f1.json.data.status === "correcting");
  const f2 = await req("POST", `/clocks/${c4}/review/retests`, { operator: "B", hairspringConcentricityMm: 0.08, staticBalanceMgCm: 2, amplitudeDegrees: 240, measuredAt: t(-13) }, 201);
  check("第二次超标：计数清零退回待转校正", f2.json.data.consecutivePasses === 0 && f2.json.data.status === "awaiting_transfer");

  // 12. 更换部件：旧复核作废且可查；作废后允许重新登记
  await req("POST", `/clocks/${c4}/review/replacement`, { operator: "C", part: "balance", note: "摆轮轮缘磕碰，整体更换", replacedAt: t(-12) }, 201);
  const oldList = await req("GET", `/clocks/${c4}/reviews`, null, 200);
  check("旧复核仍在历史中且状态voided", oldList.json.data[0].status === "voided");
  check("旧测量数据保留", oldList.json.data[0].initialMeasurement.hairspringConcentricityMm === 0.09);
  const latestVoid = (await req("GET", `/clocks/${c4}/review/latest`, null, 200)).json.data;
  check("最新状态为voided且可重新登记", latestVoid.status === "voided" && latestVoid.active === false);
  await req("POST", `/clocks/${c4}/review/retests`, {
    operator: "D", hairspringConcentricityMm: 0.01, staticBalanceMgCm: 1, amplitudeDegrees: 260
  }, 409);
  const renewed = await req("POST", `/clocks/${c4}/review`, {
    operator: "D", hairspringConcentricityMm: 0.01, staticBalanceMgCm: 1, amplitudeDegrees: 260
  }, 201);
  check("作废后可重新登记", renewed.json.data.status === "queued");
  check("新复核不覆盖旧记录", (await req("GET", `/clocks/${c4}/reviews`, null, 200)).json.data.length === 2);

  // 非法部件
  await req("POST", `/clocks/${c2}/review/replacement`, { operator: "X", part: "dial" }, 400);

  // 13. 三处状态一致：列表 / 历史 / latest
  const listItem = (await req("GET", "/clocks", null, 200)).json.data.find((x) => x.id === c4);
  const hist = (await req("GET", `/clocks/${c4}/history`, null, 200)).json.data;
  const latestOne = (await req("GET", `/clocks/${c4}/review/latest`, null, 200)).json.data;
  check("列表与历史一致", JSON.stringify(listItem.review) === JSON.stringify(hist.review));
  check("历史与latest一致", JSON.stringify(hist.review) === JSON.stringify(latestOne));
  check("列表中复核单ID正确", listItem.review.reviewCaseId === renewed.json.data.id);

  // 14. 列表过滤 & 全集接口
  const correctingList = (await req("GET", "/clocks?reviewStatus=correcting", null, 200)).json.data;
  check("按 correcting 过滤", correctingList.every((x) => x.review.status === "correcting"));
  const demo = correctingList.find((x) => x.code === "CLK-1890-07");
  check("种子演示表处于 correcting", !!demo);
  const allReviews = (await req("GET", "/reviews", null, 200)).json.data;
  check("GET /reviews 含全部复核", allReviews.length >= 4);
  const voidedOnly = (await req("GET", "/reviews?status=voided", null, 200)).json.data;
  check("按状态过滤复核", voidedOnly.every((x) => x.status === "voided") && voidedOnly.length >= 2);

  // 15. 旧版日差调校接口仍可用
  await req("POST", `/clocks/${c4}/adjustments`, { currentDailyRateSeconds: 40, direction: "慢针方向", amount: "微调0.2格" }, 201);
  const legacy = await req("POST", `/clocks/${c4}/retests`, { dailyRateSeconds: 10, amplitude: 270 }, 201);
  check("旧复测落库合格", legacy.json.data.qualified === true);
  const latestLegacy = (await req("GET", `/clocks/${c4}/latest-retest`, null, 200)).json.data;
  check("旧 latest-retest 可读", latestLegacy.dailyRateSeconds === 10);
  const histAdj = (await req("GET", `/clocks/${c4}/history`, null, 200)).json.data;
  check("历史包含旧调校记录", histAdj.adjustments.length === 1 && histAdj.retests.length === 1);

  // 16. 不存在的表
  await req("GET", "/clocks/nope/history", null, 404);
  await req("POST", "/clocks/nope/review", { operator: "X", hairspringConcentricityMm: 0.01, staticBalanceMgCm: 1, amplitudeDegrees: 260 }, 404);
}

main()
  .catch((error) => {
    console.error(error);
    failed += 1;
  })
  .finally(async () => {
    server?.kill();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exit(failed ? 1 : 0);
  });
