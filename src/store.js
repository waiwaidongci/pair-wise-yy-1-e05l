const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

function nowIso() {
  return new Date().toISOString();
}

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      componentGeneration: 0,
      note: "怀表机芯，走时偏快",
      createdAt: nowIso()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: nowIso()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: nowIso(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  // 游丝同心度 / 摆轮静平衡复核台
  reviews: [],
  reviewMeasurements: [],
  corrections: [],
  partReplacements: []
};

/**
 * JSON 文件持久化层。
 * 所有读-改-写都走 mutate()，由一条 Promise 链串行化，
 * 保证同一进程内并发提交时第二个请求能看到第一个请求已落库的数据，
 * 从而对“每表仅一条待复核记录”给出确定性的 409，且冲突时不写入。
 */
class JsonFileStore {
  constructor(file) {
    this.file = file;
    this._chain = Promise.resolve();
  }

  async _ensure() {
    await mkdir(path.dirname(this.file), { recursive: true });
    let data = null;
    try {
      data = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      await writeFile(this.file, JSON.stringify(initialData, null, 2));
      return;
    }
    // 旧版 db.json 结构补齐（已有的业务数据原样保留）
    const missing = Object.keys(initialData).filter((key) => !Array.isArray(data[key]));
    if (missing.length) {
      for (const key of missing) data[key] = initialData[key];
      for (const clock of data.clocks) {
        if (typeof clock.componentGeneration !== "number") clock.componentGeneration = 0;
      }
      await writeFile(this.file, JSON.stringify(data, null, 2));
    }
  }

  async read() {
    await this._ensure();
    return JSON.parse(await readFile(this.file, "utf8"));
  }

  async _write(data) {
    await writeFile(this.file, JSON.stringify(data, null, 2));
  }

  async mutate(mutator) {
    const run = this._chain.then(async () => {
      const data = await this.read();
      const result = await mutator(data);
      await this._write(data);
      return result;
    });
    // 无论本次成功与否都放行队列，但失败时不会执行 _write
    this._chain = run.catch(() => {});
    return run;
  }
}

module.exports = { JsonFileStore, initialData };
