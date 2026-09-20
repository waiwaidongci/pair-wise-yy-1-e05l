# 机械钟表复核台 API（游丝同心度 / 摆轮静平衡）

纯后端零依赖 Node 服务。在原日差调校闭环上扩展出**游丝同心度与摆轮静平衡复核台**，
使用 `data/db.json` 持久化钟表档案、调校/复测记录和复核单。

## 启动

```bash
PORT=3021 node server.js
```

## 分层结构

| 文件 | 职责 |
| --- | --- |
| `server.js` | 请求入口：路由、JSON 报文解析、HTTP 状态码 |
| `lib/rules.js` | 判定规则：纯函数，不碰 HTTP 与文件系统 |
| `lib/store.js` | 持久化：`data/db.json` 读写，写操作经互斥锁串行化 |
| `lib/seed.js` | 首次启动（库文件缺失）时的演示数据 |

## 业务规则

- **每表仅一条在途复核单**。状态为 `awaiting_transfer`（超标待转校正）或 `correcting`（校正复测中）时，
  重复或并发提交登记一律返回 `409 REVIEW_ALREADY_OPEN`，**不落库**。
- 登记三项测量值：`hairspringConcentricityMm`（游丝同心度）、`staticBalanceMgCm`（摆轮静平衡）、
  `amplitudeDegrees`（摆幅）。
- 判定阈值（等于阈值算达标，严格大于才超标）：
  - 同心度 **> 0.03 毫米** 不达标；
  - 静平衡 **> 5 毫克·厘米** 不达标。
- 任一项超标，复核单只能停留在「待转校正」→ 调用转校正接口；不能直接复测、不能直接排队。
- 校正后必须**换人复测**（复测人不得是最近一次校正人，否则 `409 OPERATOR_MUST_CHANGE`）。
- **连续两次达标、且两次间隔 ≥ 4 小时**才恢复排队（`queued`）；
  间隔不足的第二次复测返回 `409 RETEST_INTERVAL_NOT_MET` 且不落库；
  中途任一复测超标，连续计数清零，退回待转校正。
- **更换摆轮（balance）或游丝（hairspring）**后，在途复核单立即作废（`voided`），
  旧记录（初始测量、各次复测、校正、更换信息）全部保留可查；之后可重新登记。
- 列表 `GET /clocks`、单表历史 `GET /clocks/:id/history`、
  最新复测状态 `GET /clocks/:id/review/latest` 三处状态由 `rules.reviewState()` 同一派生逻辑生成。

复核单状态机：

```
登记 ─达标─▶ queued（恢复排队）
  │
  └超标─▶ awaiting_transfer ──转校正──▶ correcting
                        ▲                  │
                        └──复测超标(计数清零)┘
                                           │ 连续2次达标且间隔≥4h
                                           ▼
                                         queued

在途任意时刻 ─更换摆轮/游丝─▶ voided（旧记录可查，可重新登记）
```

## 复核台接口

| 方法与路径 | 说明 |
| --- | --- |
| `POST /clocks/:id/review` | 登记复核（同心度、静平衡、摆幅、operator、可选 measuredAt） |
| `POST /clocks/:id/review/transfer` | 超标单转校正（operator、actions、可选 correctedAt） |
| `POST /clocks/:id/review/retests` | 换人复测；间隔不足/未换人/状态不对均 409 不落库 |
| `POST /clocks/:id/review/replacement` | 更换 balance / hairspring，在途复核作废 |
| `GET /clocks/:id/review/latest` | 最新复核状态（含 nextAction、nextAllowedRetestAt） |
| `GET /clocks/:id/reviews` | 单表全部复核单（含已作废旧记录）+ 最新状态 |
| `GET /reviews?clockId=&status=` | 复核单全集查询 |

错误响应统一为 `{ "error": "...", "code": "..." }`，409 类 code：
`REVIEW_ALREADY_OPEN` / `NOT_IN_CORRECTION` / `OPERATOR_MUST_CHANGE` /
`RETEST_INTERVAL_NOT_MET` / `ALREADY_CORRECTING` / `REVIEW_ALREADY_QUEUED` /
`REVIEW_VOIDED` / `NO_OPEN_REVIEW` / `NO_ACTIVE_REVIEW`。

## 其他接口（原有，保留兼容）

- `GET /health`（响应中含判定阈值）
- `GET /clocks`（新增 `?reviewStatus=` 过滤，每项含 `review` 派生状态）
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（同时返回旧调校记录与全部复核单）
- `POST /clocks/:id/adjustments`、`POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`、`GET /retests?clockId=&qualified=`

## 闭环示例

```bash
# 1. 登记（同心度超标）-> awaiting_transfer
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/review \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张师傅","hairspringConcentricityMm":0.05,"staticBalanceMgCm":3.0,"amplitudeDegrees":220}'

# 2. 只准转校正
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/review/transfer \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张师傅","actions":"重拨外桩校正同心度"}'

# 3. 换人首次复测达标（consecutivePasses=1，仍 correcting）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/review/retests \
  -H 'Content-Type: application/json' \
  -d '{"operator":"王师傅","hairspringConcentricityMm":0.02,"staticBalanceMgCm":2.5,"amplitudeDegrees":250}'

# 4. 间隔满4小时后第二次复测达标 -> queued 恢复排队
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/review/retests \
  -H 'Content-Type: application/json' \
  -d '{"operator":"王师傅","hairspringConcentricityMm":0.02,"staticBalanceMgCm":2.4,"amplitudeDegrees":252}'
```

## 测试

```bash
node test-e2e.js
```

在临时端口和临时库上端到端验证：409 不落库、并发去重、阈值边界、换人复测、
4 小时间隔、计数中断、部件更换作废与旧记录可查、三处状态一致性、旧接口兼容（80 项断言）。
