# 机械钟表擒纵调校 · 游丝同心度与摆轮静平衡复核台

纯后端零依赖 Node 服务。三层分离：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 请求入口 | `src/handlers.js` | HTTP 解析、路由编排、入参校验，不落业务判定 |
| 判定规则 | `src/rules.js` | 纯函数：合格阈值、状态机视图、恢复排队判定 |
| 持久化 | `src/store.js` | `data/db.json` 读写；读-改-写经 Promise 链串行化，冲突不写入 |

`server.js` 只负责装配启动。旧版 `db.json` 首次启动自动补齐新表（原数据保留）。

## 启动

```bash
PORT=3021 node server.js        # 可用 DB_FILE 指定其他库文件
bash smoke.sh                   # 端到端冒烟（临时库、随机端口，28 项断言）
```

## 业务规则

1. **一表一条待复核**：每只表同时只允许一条 `open` 复核；重复或并发提交返回 `409` 且不落库。
2. **登记三项指标**：同心度（毫米）、静平衡（毫克·厘米）、摆幅（度）。摆幅仅登记留档。
3. **合格阈值**：同心度 `≤ 0.03mm` **且**静平衡 `≤ 5mg·cm` 为达标（临界值算合格）；任一超差即 `awaiting_correction`，**只准转校正**，不能直接再测。
4. **校正后换人复测**：转校正需登记校正人和措施，进入 `awaiting_retest`；复测人不得是最近一次校正人，否则 `409`。
5. **恢复排队**：连续两次达标、间隔满 **4 小时**（中间出现不合格则连续计数清零）且校正后已换人复测，复核自动置为 `restored`。
6. **换件失效**：更换摆轮（`balance`）或游丝（`hairspring`）后，进行中的复核立即 `invalidated`，钟表部件代次 +1；旧复核、测量、校正、换件记录全部保留可查，之后可按新代次重新登记。
7. **状态一致**：钟表列表、单表历史（`/clocks/:id/history`、`/clocks/:id/reviews`）与最新复测状态（`/clocks/:id/review-status`）都由 `rules.reviewStateView` 同一函数推导。

复核派生状态（`state`）：

- `measuring` 待首次测量
- `awaiting_correction` 超差，只准转校正
- `awaiting_retest` 校正待换人复测
- `retesting` 复测中（已出现达标，等待满 4 小时的连续第二次）
- `restored` 已恢复排队（终态）
- `invalidated` 因换件失效（终态，可查）

## 接口

原有调校接口：

- `GET /health`
- `GET /clocks`（可带 `qualified=`、`reviewStatus=`）
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

复核台新增：

- `POST /clocks/:id/reviews` — 登记复核并录入首次同心度/静平衡/摆幅
- `GET  /clocks/:id/reviews` — 单表全部复核记录（含已失效/已恢复，最新在前）
- `GET  /clocks/:id/review-status` — 最新复核（复测）状态
- `GET  /reviews?clockId=&state=&status=` — 复核列表
- `POST /reviews/:id/measurements` — 追加一次复测（`inspector` 复测人；可选 `at`）
- `POST /reviews/:id/corrections` — 转校正（`operator` 校正人、`action` 措施）
- `POST /clocks/:id/part-replacements` — 更换摆轮/游丝（`parts:["balance"|"hairspring"]`、`operator`）

测量请求体：

```json
{ "concentricity": 0.02, "staticBalance": 3.2, "amplitude": 268, "inspector": "王技师", "at": "2026-09-20T10:00:00.000Z", "note": "" }
```

## 闭环示例

```bash
# 登记（同心度超差）→ awaiting_correction，只准转校正
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/reviews \
  -H 'Content-Type: application/json' \
  -d '{"inspector":"赵师傅","concentricity":0.05,"staticBalance":2,"amplitude":250}'

# 校正（赵师傅）→ awaiting_retest
curl -X POST http://127.0.0.1:3021/reviews/<reviewId>/corrections \
  -H 'Content-Type: application/json' \
  -d '{"operator":"赵师傅","action":"重调游丝外桩同心"}'

# 换人复测达标：第一次 retesting；满4小时后第二次达标 → restored
curl -X POST http://127.0.0.1:3021/reviews/<reviewId>/measurements \
  -H 'Content-Type: application/json' \
  -d '{"inspector":"钱师傅","concentricity":0.01,"staticBalance":1,"amplitude":268}'

# 更换摆轮 → 进行中的复核 invalidated（旧记录仍可查）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/part-replacements \
  -H 'Content-Type: application/json' \
  -d '{"operator":"孙师傅","parts":["balance"],"note":"换新摆轮"}'
```
