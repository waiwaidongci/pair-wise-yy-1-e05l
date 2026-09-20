// 首次启动且 data/db.json 缺失时写入的演示数据。
module.exports = function seed() {
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  const HOUR = 3600000;
  const DAY = 24 * HOUR;

  return {
    clocks: [
      {
        id: "clock_demo",
        code: "CLK-1890-07",
        escapementType: "瑞士杠杆式",
        balanceFrequency: "18000vph",
        targetDailyRateSeconds: 20,
        note: "怀表机芯，走时偏快",
        createdAt: iso(-31 * DAY)
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
        createdAt: iso(-30 * DAY)
      }
    ],
    retests: [
      {
        id: "retest_demo",
        clockId: "clock_demo",
        adjustmentId: "adjustment_demo",
        testedAt: iso(-30 * DAY),
        dailyRateSeconds: 31,
        amplitude: 248,
        qualified: false,
        note: "仍偏快，振幅尚可"
      }
    ],
    reviewCases: [
      {
        id: "review_old_demo",
        clockId: "clock_demo",
        status: "voided",
        openedAt: iso(-29 * DAY),
        initialMeasurement: {
          id: "measurement_old_initial",
          kind: "initial",
          measuredAt: iso(-29 * DAY),
          operator: "张师傅",
          hairspringConcentricityMm: 0.06,
          staticBalanceMgCm: 3.1,
          amplitudeDegrees: 212,
          concentricityPass: false,
          staticBalancePass: true,
          qualified: false,
          note: "游丝外桩偏移，同心度超标"
        },
        retests: [],
        corrections: [
          {
            id: "correction_old_demo",
            correctedAt: iso(-28 * DAY),
            operator: "张师傅",
            actions: "拨动外桩微调游丝同心度",
            note: "尝试校正未根治"
          }
        ],
        consecutivePasses: 0,
        queuedAt: null,
        replacement: {
          part: "hairspring",
          replacedAt: iso(-26 * DAY),
          operator: "李师傅",
          note: "游丝变形无法校正，整体更换，旧复核作废"
        }
      },
      {
        id: "review_active_demo",
        clockId: "clock_demo",
        status: "correcting",
        openedAt: iso(-2 * DAY),
        initialMeasurement: {
          id: "measurement_active_initial",
          kind: "initial",
          measuredAt: iso(-2 * DAY),
          operator: "李师傅",
          hairspringConcentricityMm: 0.05,
          staticBalanceMgCm: 3.2,
          amplitudeDegrees: 210,
          concentricityPass: false,
          staticBalancePass: true,
          qualified: false,
          note: "更换游丝后同心度仍超标"
        },
        retests: [
          {
            id: "measurement_active_retest_1",
            kind: "retest",
            measuredAt: iso(-2 * HOUR),
            operator: "王师傅",
            hairspringConcentricityMm: 0.02,
            staticBalanceMgCm: 2.8,
            amplitudeDegrees: 231,
            concentricityPass: true,
            staticBalancePass: true,
            qualified: true,
            correctionId: "correction_active_demo",
            note: "首次复测达标，等待满4小时后第二次复测"
          }
        ],
        corrections: [
          {
            id: "correction_active_demo",
            correctedAt: iso(-1 * DAY),
            operator: "李师傅",
            actions: "重新拨动外桩并检查游丝平面",
            note: ""
          }
        ],
        consecutivePasses: 1,
        queuedAt: null,
        replacement: null
      }
    ]
  };
};
