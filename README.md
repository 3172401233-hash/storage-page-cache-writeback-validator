# storage-page-cache-writeback-validator

验证页缓存按脏页年龄回写时，WAL 提交点与设备 barrier 顺序不一致所导致的
“数据页已落盘、WAL 尾部却在崩溃后丢失”问题。

输入脏页、页 LSN、WAL 持久化点、设备 barrier、checkpoint、页刷新竞争和崩溃事件，
引擎计算：

- 按脏页年龄排序的回写顺序，以及每页的可回写性 / 阻塞原因；
- 每页缺失的 WAL 依赖 LSN；
- 部分 barrier 成功后的重新确认状态；
- checkpoint 在该时刻必须记录的安全页；
- 崩溃后每页状态与恢复范围（WAL redo / 尾部丢失 / 需介质恢复）。

## 存储模型声明

**本项目所有存储均为本地模型（local in-process model）。**

- 不连接任何数据库、对象存储、云盘或外部存储服务，也没有网络请求；
- “页缓存、数据页、WAL、设备 barrier、checkpoint、崩溃”全部是
  Node.js 进程内的纯数据结构与确定性计算；
- 唯一的真实 I/O 是从本地 JSON 文件读取场景（CLI）和向标准输出打印报告；
- 不依赖任何 npm 第三方包，仅使用 Node.js 内置模块（`node:test`、`node:assert`、
  `node:fs`、`node:child_process` 等）。

## 运行环境

已在 **Node.js v24.16.0** 下验证（`node -v` 应为 `v24.16.0`）。
代码使用 ESM 与内置测试运行器，无第三方依赖，无需 `npm install`。

## 运行测试

```bash
node --test
# 或
npm test
```

当前包含 28 个测试，覆盖：

- 脏页年龄排序、`dirtyAt` 排序、WAL LSN 门控与依赖 LSN 枚举；
- **barrier 失败 / 部分成功 / 重新确认**，以及重新确认的时间点效力；
- WAL barrier 晚于数据落地的顺序违规；
- **页刷新竞争**：同页重叠刷新识别、竞争中提前落地违反 WAL 先行；
- 同页串行刷新不误报、失败刷新不判定为持久化；
- checkpoint 安全页计算、漏记警告、记录不安全页报错；
- **WAL 尾部丢失**：丢失区间、已提交事务恢复/丢失、`ahead-of-wal` 页、
  撕裂页、恢复范围收敛为介质恢复；
- CLI 的 JSON / 文本输出与 `--strict` 退出码。

## CLI

```bash
node src/cli.js examples/writeback-order.json
node src/cli.js examples/barrier-reconfirm.json
node src/cli.js examples/flush-race.json
node src/cli.js examples/tail-loss.json

node src/cli.js examples/tail-loss.json --json     # 完整机器可读报告
node src/cli.js examples/tail-loss.json --strict   # 有 error 违规时退出码 1
npm run demo                                       # 等价于跑 tail-loss 示例
```

也可以作为库使用：

```js
import { analyzeScenario, planWriteback } from './src/index.js';

const report = analyzeScenario(scenario);
console.log(report.writeback.eligibleOrder, report.recovery);
```

## 输入格式（本地 JSON 模型）

所有时间字段 `at` / `startAt` / `endAt` 都是单调逻辑时间（数字越小越早），
不给定时按数组顺序补默认值。LSN 为单调递增数字。

```jsonc
{
  "name": "可选场景名",
  "dirtyPages": [
    {
      "id": "P1",          // 页 ID
      "pageLsn": 200,      // 页头 LSN：该页最新脏变更对应的日志 LSN
      "age": 120,          // 脏页年龄（越大越老，优先回写）；也可用 dirtyAt
      "device": "dev0",    // 可选，默认 dev0
      "diskLsn": 100,      // 可选，崩溃前磁盘上旧镜像的 LSN
      "flushedAt": 4       // 可选，该页刷新落地的逻辑时刻（checkpoint 用）
    }
  ],

  "wal": {
    "durableLsn": 200,           // 日志层已确认的 WAL 持久化点
    "initialDurableLsn": 0,      // 可选，逻辑时刻 0 的持久化点
    "records": [                 // 可选：WAL 记录，数字或对象均可
      { "lsn": 180, "tx": "T2", "type": "commit" }
    ]
  },
  "walPersistencePoints": [      // 可选：持久化点随时间的推进（竞争判定用）
    { "lsn": 120, "at": 1 },
    { "lsn": 200, "at": 5 }
  ],

  "barriers": [
    {
      "id": "BW",
      "at": 2,
      "scope": "wal",            // wal | data | 省略（位置决定作用）
      "targets": ["dev0", "dev1"],
      "acks": ["dev0"],          // 首次确认的 target；省略=全部成功，[]=完全失败
      "reconfirm": [             // 可选：重新确认尝试，必须确认全部 target
        { "at": 3, "acks": ["dev0", "dev1"] }
      ]
    }
  ],

  "flushAttempts": [             // 可选：真实/竞争性的页刷新区间
    { "id": "F1", "page": "P1", "startAt": 2, "endAt": 4, "landed": true }
  ],

  "checkpoints": [
    { "id": "CP1", "at": 7, "pages": ["P1"], "redoStartLsn": 100 }
  ],

  "crash": {
    "at": 10,
    "walTailLsn": 140,           // 崩溃后实际存活的 WAL 尾部（尾部丢失时 < durableLsn）
    "acknowledgedLsn": 200,      // 可选，默认 wal.durableLsn
    "landedPages": ["P9"],       // 简写：这些页最新版本已落地，diskLsn=pageLsn
    "tornPages": ["P8"],         // 撕裂写页
    "diskPages": {               // 精确指定崩溃后磁盘页头 LSN / 撕裂状态
      "PA": { "diskLsn": 200, "torn": false }
    }
  },

  "options": {
    "requireWalBarrier": true,   // 默认：提供了 barriers 就要求 WAL barrier
    "requireDataBarrier": true   // 默认：提供了 barriers 就要求数据 barrier
  }
}
```

## 验证的不变量

1. **WAL 先行（WAL rule）**：只有 `pageLsn <= walPersistedLsn` 时页才可回写；
   若刷新落地时刻的 WAL 持久化点小于 `pageLsn`，记
   `DATA_PERSISTED_BEFORE_WAL`。
2. **barrier 顺序**：安全顺序为
   `WAL 持久化点 -> 已完全确认的 WAL barrier -> 数据页落地 -> 已确认的数据 barrier -> checkpoint`。
   WAL barrier 缺失/未确认/LSN 落后分别给出对应原因码；数据先于合格 barrier
   落地记 `WAL_BARRIER_ORDER_VIOLATION`。
3. **部分 barrier 成功必须重新确认**：只要某次 barrier 尝试没有被全部 target
   确认，状态就是 `partial` 或 `failed`，`needsReconfirmation=true`；
   后续 `reconfirm` 中首次全部确认的时刻才是 `confirmedAt`。checkpoint 只看
   checkpoint 时刻之前的确认，之后的补确认不能追溯修复旧 checkpoint。
4. **checkpoint 必须记录安全页**：安全页必须同时满足
   “已刷新落地 + WAL 到 pageLsn 已持久化 + WAL barrier 已确认 +
   落地后数据 barrier 已确认”。引擎在 `checkpoints[].safePages` /
   `record.safePages` 给出必须记录的集合；输入的 `pages` 若包含不安全页会报
   `CHECKPOINT_RECORDS_UNSAFE_PAGE`，漏记安全页给 warning。
5. **崩溃恢复判定**（以崩溃后的物理事实 `walTailLsn` 与 `diskLsn` 为准）：
   - `consistent`：磁盘页与 WAL 前缀一致；
   - `redo-pending`：磁盘页较旧，但所需变更都在存活 WAL 中，可 redo；
   - `recoverable-to-tail`：最新变更随尾部丢失，页只能恢复到 WAL 尾部；
   - `ahead-of-wal`：`diskLsn > walTailLsn`，数据页新于 WAL，列出缺失依赖，
     自动 WAL 恢复不可判定，需要 checkpoint 镜像/基线备份做介质恢复；
   - `torn`：撕裂写，同样需要先介质恢复。

## 主要输出字段

- `writeback.ageOrder` / `writeback.eligibleOrder` / `writeback.deferred`
- `writeback.pages[]`：`eligible`、`walReady`、`barrierReady`、`blockers`、
  `missingLsns`、`missingDependencies`
- `barriers[]`：`state`（`confirmed|partial|failed|missing`）、
  `needsReconfirmation`、`missingTargets`、`confirmedAt`
- `flushes.races[]` 与 `flushes.attempts[].walOrderOk`
- `checkpoints[].safePages`、`unsafePages`、`unsafeClaimedPages`
- `crash.lostWalInterval`、`crash.diskPages[].status/missingLsns`
- `recovery.scope`（`wal-redo-to-tail` | `media-recovery-required`）、
  `redoFromLsn/redoToLsn`、事务与页分类列表、`recoverySteps`
- `violations[]` 与 `summary.errors/warnings`、顶层 `ok`

违规码：`WAL_NOT_DURABLE`（计划阻塞原因）、`WAL_BARRIER_MISSING`、
`WAL_BARRIER_UNCONFIRMED`、`WAL_BARRIER_LSN_BEHIND`、
`DATA_PERSISTED_BEFORE_WAL`、`WAL_BARRIER_ORDER_VIOLATION`、`FLUSH_RACE`、
`BARRIER_RECONFIRMATION_PENDING`、`CHECKPOINT_RECORDS_UNSAFE_PAGE`、
`CHECKPOINT_SAFE_PAGES_OMITTED`、`WAL_TAIL_LOSS`、
`COMMITTED_TX_IN_LOST_TAIL`、`DATA_PAGE_AHEAD_OF_WAL`、`PAGE_TORN`。

## 目录结构

```text
src/
  model.js     # 场景归一化、LSN/时间/barrier 状态、缺失依赖
  analyze.js   # 回写计划、竞争、checkpoint、崩溃恢复分析
  report.js    # 中文文本报告
  cli.js       # 本地 JSON 文件 CLI
  index.js     # 库导出
test/          # node:test 测试（28 个）
examples/      # 可直接运行的本地场景 JSON
```
