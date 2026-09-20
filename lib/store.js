// 持久化层：只负责 data/db.json 的读写，不包含任何判定规则。
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "db.json");

// 单进程内的写互斥：保证「读-检查-写」整体原子，并发提交不会互相穿透。
let writeChain = Promise.resolve();

async function ensureDb(seed) {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(seed(), null, 2));
  }
}

// 兼容旧版 db.json：缺少复核台集合时补齐（下次写盘会持久化新结构）。
function normalize(db) {
  if (!Array.isArray(db.clocks)) db.clocks = [];
  if (!Array.isArray(db.adjustments)) db.adjustments = [];
  if (!Array.isArray(db.retests)) db.retests = [];
  if (!Array.isArray(db.reviewCases)) db.reviewCases = [];
  return db;
}

async function readDb(seed) {
  await ensureDb(seed);
  return normalize(JSON.parse(await readFile(DB_FILE, "utf8")));
}

// mutate 必须在内存数据上同步完成全部判定并返回结果；
// 抛错则不写盘（409 等冲突绝不落库）。
function update(seed, mutate) {
  const run = writeChain.then(async () => {
    const db = await readDb(seed);
    const result = await mutate(db);
    await writeFile(DB_FILE, JSON.stringify(db, null, 2));
    return result;
  });
  // 锁只串行化写操作，不让单个失败打断后续请求。
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

module.exports = { readDb, update };
