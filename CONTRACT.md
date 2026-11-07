# project-flow 契约（schema 2）

`project-flow` 现在是**项目的流程台账**，面板是它的只读视图（唯一例外：「初始化」按钮
POST `/api/project-flow/init`，仍走同一 `lib/core.mjs`）：实验（含 parent 谱系）、
任务、门禁定义与门禁运行记录都写在项目自己的 `.dsh/flow/` 目录里。写入只有两个入口——
`lib/core.mjs`（Host 工具与 `bin/flow.mjs` 共用）——面板、脚本、代理都不要直接改 JSON。

- 存储根：`<root>/.dsh/flow/`（首次 `flow init` 创建）
- 契约文件：`<root>/.dsh/flow/flow.json`，`schema: 2`
- 单一写者：`lib/core.mjs`；CLI 只做参数解析与输出，校验/加锁/原子写全部在 core
- 写操作前若 `flow.json` 不存在 → `FlowError('usage', 'run flow init first ...')`
- 只依赖 `node:fs` / `node:path` / `node:child_process`，无 npm 依赖、不联网

## 1 目录布局

```
<root>/.dsh/flow/
  flow.json                 契约（schema 2）
  experiments/<id>.json     实验记录，如 E-20261028-01.json
  tasks/<id>.json           任务记录，如 T-20261028-57.json
  gates/<id>.json           门禁定义，如 precommit.json
  decisions/<id>.json       决策记录，如 D-20261031-01.json
  logs/<gateId>/<ts>.json   门禁运行记录，<ts> 为 started_at 把冒号换成连字符
  .lock                     写锁（临时文件，含 pid/host/token；30 秒未刷新可接管；不要提交、不要展示）
```

子目录可由契约覆盖（见 §2），但覆盖值必须留在项目根内；`<id>` 一律是安全路径段（不含 `/`、`\`、`.`、`..`）。

### 1.1 代码模块职责

上面是**数据**布局，这里是**代码**布局。依赖方向只有一种：上层指向下层，**无环**。

| 模块 | 职责 | 谁依赖它 |
|---|---|---|
| `index.js` | 插件入口：注册工具/技能/HTTP 路由/宿主事件监听 | 宿主 |
| `bin/flow.mjs` | CLI：只做参数解析与输出，校验/加锁/原子写全部在 core | 人、脚本、门禁 |
| `lib/core.mjs` | **唯一写者**：契约、记录 CRUD、门禁执行、心跳、决策 | 工具层、CLI、快照 |
| `lib/lock.mjs` | 写锁与 CAS 接管（30 秒过期、`takeover-claim`） | core |
| `lib/atomic.mjs` | 原子写（临时文件 + fsync + 改名 + 目录 fsync + 重试） | core、lock |
| `lib/paths.mjs` | 路径 containment（拒绝绝对路径、`..` 逃逸、真实路径越界） | core |
| `lib/proc.mjs` | **进程树杀灭的唯一实现**（POSIX 进程组 / win32 `taskkill /T /F` + grace 兜底） | core、checks |
| `lib/runner.mjs` | 门禁步骤执行（spawn、超时、输出截断、`expect` 求值） | core |
| `lib/util.mjs` | 零依赖叶子：`FlowError`、warning 通道、深拷贝、时间格式、`isPlainObject`、`pad` | 上面全部 |
| `lib/stage.mjs` | 九阶段状态机（`stage` 表/边/`stage→status` 派生）**唯一真源**；P0 只有数据，不捕获不派工 | core |
| `lib/capture.mjs` | P1 捕获流水线：`agent/pre-step` 只做内存的排除/集合差去重，`agent/turn-stopping` 才落盘（`source.key` 跨进程去重、创建即推进 `queued-analysis`）；同时产出 §9 状态块与栈顶选取。**不 import core**（core 由 `index.js` 注入，宿主无 core 时捕获自然降级） | `index.js` |
| `lib/checks.mjs` | `flow check` 的脚本类检查执行器。**不 import core**（可独立工作） | `bin/flow.mjs`（动态 import） |
| `lib/state-snapshot.mjs` | 面板只读快照装配；同时是**工具层的懒 core 网关**（`requireCore`） | `index.js`、`lib/plugin/*`、`lib/tools/*` |
| `lib/tools/*.mjs` | 模型侧工具定义（function schema + 处理函数） | `index.js` |
| `lib/plugin/*.mjs` | 子插件挂载骨架（`mount`）与共享参数（`shared`） | `tasks.js`/`gates.js`/`experiments.js` |
| `client.js` | 浏览器 bundle：**零 import、无构建步骤**，因此不能放进 `lib/` | 面板 |
| 根目录 `tasks.js`/`gates.js`/`experiments.js`/`tui-host.js` | 子插件/TUI 入口，**被 `package.json` 的 `exports` 逐条点名**，是 npm 包契约的一部分，不要移动 | 宿主 |

三条**由测试守着**的结构纪律（`test/t-20261107-module-boundaries.test.mjs`）：
`lib/checks.mjs` 不得 import `lib/core.mjs`；`lib/*` 依赖无环、`util.mjs` 是叶子；
`spawnSync('taskkill'` 全 lib 恰好一处。

**去重判据**（踩过坑，写下来防复发）：判断两个同名函数能否合并，先分四类——
**过时前提**（注释理由已失效 → 可删）、**等价但刻意自足**（如 `state-snapshot` 的
`isPlainObject`，worker 不许 import 宿主 → 不动）、**语义分叉**（如 `timeValue` 无效值
`-Infinity` 是排序哨兵 vs `util` 的 `0` → 绝不能合）、**同名不同物**（如 `bin/flow.mjs`
的 `pad` 按显示宽度补表格 vs `lib/util.mjs` 的 `pad` 是时间戳补零 → 绝不能合）。
`state-snapshot.mjs` 的路径 containment 是**算法重复但 sink 刻意分开**：它把拒绝写进
本次 payload 的 `warnings[]`，`lib/paths.mjs` 写全局通道——混用会让面板轮询偷走 core
警告，`test/warnings.test.mjs` 的《面板读路径 drain 后丢弃》用例守着这个隔离。

**已知结构债（有意欠的，不是疏忽）**：`lib/tools/*` 为了拿 `requireCore` 静态 import
`state-snapshot.mjs`（1233 行），而实际只用其中 2 个函数——约 **70% 依赖体积不可达**。
根治要把「core 网关 + `brief`/`takeCoreWarnings`/`storeContractPath`/`taskCountsOf`/
`pickInteger`」抽成约 100 行的独立模块（**不是 60 行**：少搬 `taskCountsOf`/`pickInteger`
会让三个 tools 里两个仍留快照依赖、收益归零）。**性能收益可忽略**（≈0.5 ms/进程，因为
网关仍须 top-level await 加载 core），所以这是**可理解性/风险面**问题，优先级 P3。
前置条件：`core-unavailable` 降级路径先有测试覆盖、`index.js` 空闲。
⚠ 搬的时候**不要动** `clip`/`isoLocal`/`timeValue`/`toPosix`/`isPlainObject`——它们与
`util` 同名不同契约，`index.js` 依赖的是快照变体。

## 2 `flow.json`（schema 2）

`flow init` 写入下面这份完整默认值：

```jsonc
{
  "schema": 2,
  "name": "<basename(root)>",
  "store": { "root": ".dsh/flow" },
  "experiments": { "source": "store", "dir": ".dsh/flow/experiments", "enabled": false },
  "tasks": { "source": "json", "dir": ".dsh/flow/tasks", "current": null, "recentLimit": 6,
             "archiveAfterDays": 7 },
  "gates": { "dir": ".dsh/flow/gates", "logs": ".dsh/flow/logs" },
  "heartbeats": { "source": "json", "dir": ".agents/heartbeat", "max": 20 },
  "decisions": { "dir": ".dsh/flow/decisions" }
}
```

合并规则：缺的键补默认值，对象递归补，数组整体替换；未知键**保留**（向前兼容）。
`loadContract` 返回 `{ contract, source, warnings }`，`source` 为 `.dsh/flow/flow.json`
或 `defaults`（文件不存在）；文件坏掉时回退默认值并带 `manifest-invalid` warning。
`schema` 不是 2 时只记一条 warning，仍按 schema 2 归一化。

**类型校验（容错，绝不抛）**：每个顶层 section 必须是对象，成员类型如下。某键存在但类型
不对时**回退该点的默认值**，并由 `loadContract` 记一条
`manifest-invalid: <key>: expected <object|string|number>, got <actual>`（`<key>` 是
`store` / `store.root` / `tasks.current` 这类点号路径；`got` 可能是 `array`/`null`）：

| key | 形状 | 违约处理 |
|---|---|---|
| `name` | 非空 string | `<basename(root)>` |
| `schema` | number | 归一化为 2（文案见上） |
| `store` | object，`root` 为 string | 整节默认；`store.root` 错型 → `.dsh/flow` |
| `experiments` | object：`source` / `dir` string、`enabled` boolean | 逐字段回退 |
| `experiments.enabled` | boolean（**默认 false**：面板隐藏实验区、`check experiments` skip） | 非 boolean → 回退 `false` 并记 `manifest-invalid: experiments.enabled: expected boolean, got <type>` |
| `tasks` | object：`source` / `dir` string、`current` string\|null、`recentLimit` / `archiveAfterDays` number | 逐字段回退 |
| `tasks.archiveAfterDays` | 有限 number（manifest **只校验类型**，不校验范围；`0` = 关闭自动归档） | 非 number / 非有限 → 回退默认值 7 并记 `manifest-invalid`；负数与越界不在 loadContract 报错，运行期降级（见下） |
| `gates` | object：`dir` / `logs` 为 string | 逐字段回退 |
| `heartbeats` | object：`source` / `dir` string、`max` number | 逐字段回退 |
| `decisions` | object：`dir` 为 string | 逐字段回退 |
| 其他键（含 legacy `runs`、任意未知键） | **不校验** | 原样保留、**无 warning** |

`tasks.archiveAfterDays` 是**任务自动归档阈值**（天），默认 **7**：`0` 关闭归档；缺键补默认
值 7（`flow init` 把它写进 manifest）；存在但不是 number 时回退默认值 7 并按上表记一条
`manifest-invalid: tasks.archiveAfterDays: expected number, got <type>`。运行期取值（manifest
归一值，或 `--older-than N` 的覆盖值）先 `Math.floor` 向下取整（`7.9` → `7`），再判范围：
负数 / `NaN` / 非有限值按 `0`（关闭）处理，`> 3650` 截到 `3650`，两种情况各记一次
`tasks-archive-days-invalid` warning，命令仍退出 0。取整后为 `0`（例如配置 `0.5`）即关闭
归档，且**不**记 warning。

`experiments.enabled` 是**实验面板开关**，默认 `false`（`flow init` 写入 `false`；缺键补
`false` 且**不**记 warning，只有类型不对才回退 + `manifest-invalid`）。关闭时 `GET state` 的
`experiments` 节只返回 `{enabled:false, total, counts}`（**无** items/tree，见 §9.1.3），
面板不渲染实验区、任务区单列；`check experiments` **直接 exit 0 跳过**（不阻断 CI）。它**只
影响展示与该门禁步**——`flow exp …`、`flow_exp` 工具与写路径照常可用。旧项目缺 `enabled`
且目录里已有实验记录时**仍按关闭处理**：由**面板读路径**（`state-snapshot.mjs`，`GET state`
投影时）记一次性引导 warning `experiments-disabled-legacy: N experiment(s) are hidden…`
（提示设为 `true`），`check experiments` 不读目录、为此**不**发该 warning；**绝不自动开启**。
开启就是把 `flow.json` 的 `experiments.enabled` 改成 `true`，下一次面板请求即生效。

`normalizeContract`（`storePaths` 与每个 API 都会调用）只做静默修复、**绝不 warning**——
否则一次坏契约会让每条命令重复堆积诊断。只有 `loadContract` 把 issue 转成 warning。
因此 `{"store":"x"}` 这类坏契约下 `flow status --json` 仍退出 0 并携带 warning，而不是
`TypeError`/IO 错误。

`experiments.source` 与 `tasks.source` 声明读法，store 模式固定为 `store` / `json`。
`heartbeats.source` 只有 `none` 一个真实开关（关闭整个心跳小节）；心跳只读
`contract.heartbeats.dir` 下的 `*.json`。旧 manifest 残留的 `gate` / `runs` 等键按未知键
保留，但不再被读取，也不再参与默认值或面板投影。

`decisions.dir` 是决策记录 `D-` 的目录（默认 `.dsh/flow/decisions`，缺键自动补默认值）。

`storePaths(root, contract)` 解析出的绝对目录（`store` / `experiments` / `tasks` /
`gates` / `logs` / `decisions`）。`store.root` 改成别的相对路径时，未自定义的各子目录跟随新 store 根。
解析结果永远落在项目根内；不安全的值按下述规则降级并产生 warning。

### 2.1 manifest 路径 containment

manifest 声明的所有路径（`store.root`、`experiments.dir`、`tasks.dir`、`gates.dir`、
`gates.logs`、`tasks.current`、`heartbeats.dir`、`decisions.dir`）都必须是**项目根内的相对路径**。core 的
`containedPath` 与 Host 侧的本地镜像按同一规则校验：

- 绝对路径输入（`store.root` 例外，见下）、`..` 解析后逃出根、以及符号链接逃逸
  （目标已存在时看 `realpath`；目标不存在时逐级向上检查最近已存在的祖先，例如
  `link -> /etc`）一律**拒绝**；
- 拒绝后不抛异常，也不读取根外内容，而是按该 section 的默认值降级：
  `store.root` → `.dsh/flow`，各节目录 → 该节的默认目录，`tasks.current` → `null`；
- 每个被拒绝的原值记一条概括性 warning：
  `manifest-path-rejected: <key>: <原值>: <原因>`（只回显原值，不回显文件内容）。
- 唯一例外：`store.root` 写成绝对路径时，若 `realpath` 后仍在项目根内则照常使用
  （兼容旧 manifest）；否则回退 `.dsh/flow` 并 warning。
- **面板 `tasks.current` 的派生**：manifest 声明了合法相对路径时原样作为 `current` 回显；
  未声明（`null`）时，Host 的面板投影把它派生为**队列头**——`active` 中**父不在 `active`
  集合内的根任务**（`parent` 为空或指向非 active 任务，失效即按根）里 `created_at` 最老
  的一条的 `id`（同刻按 id 升序；只读投影，不回写 `flow.json`，manifest 仍是 `null`）；
  没有根（例如 active 全部成环）时退回 `active[0]`，没有 `active` 时为 `null`。manifest
  声明了但被 containment 拒绝时 `current` 保持 `null`（记原 warning），**不回退**队列头。

合法相对路径的解析结果与旧行为完全一致。

## 3 记录格式

### 3.1 实验 `experiments/E-YYYYMMDD-NN.json`

新实验写 `schema: 2`（假设必须可判定）；`schema: 1` 的存量记录**只读兼容**，不迁移、不补字段。

```jsonc
{
  "schema": 2,
  "id": "E-20261104-01",
  "title": "短标题",                       // 必填，非空字符串
  "hypothesis": "可证伪的假设",             // 可选，默认空串
  "direction": "降低 tie 率",              // 必填：自由文本 ≤120 字符（方向是措辞，不设枚举）
  "expected": "tie_mean<=1.0",             // 必填：可判定的期望结果（含阈值）
  "primaryMetric": "tie_mean",             // 必填：唯一主指标名
  "guardrails": ["p95_ms", "error_rate"],  // 必填：护栏指标名，至少 1 项、每项非空 string
  "falsify": "tie_mean>1.05 或任一护栏恶化 >5%", // 必填：证伪条件
  "windowDays": 7,                         // 必填：观测周期（正整数，≤3650 天）
  "stopLoss": "p95 恶化 >10% 立即停止",     // 必填：止损线
  "status": "open",                        // open|confirmed|refuted|abandoned|inconclusive|pivoted
  "learned": "",                           // 终态结论（refuted/pivoted 硬性；inconclusive 建议）
  "cleanup": { "flags": [], "code": [], "data": [] },
                                           // 清理对象：开关/代码/数据，每类 ≤20 项；空数组=无
  "cleanupAt": null,                       // 只由 `flow exp cleanup` 写（ISO）；refuted 必填
  "productizedAt": null,                   // 只由 `flow exp productize` 写（ISO）
  "productizeGate": null,                  // { id, runAt, log }；只由 productize 写
  "factor": "",                            // 分组键，可为空
  "parent": null,                          // 另一实验 id 或 null（转向=新实验指向旧实验）
  "scale": "small",
  "measured": "",
  "metrics": {},
  "commits": [],
  "notes": "",
  "created_at": "...",
  "updated_at": "..."
}
```

- **七字段必填（仅 schema2）**：`direction`（≤120 字符）/ `expected` / `primaryMetric` /
  `guardrails`（数组，**至少 1 项，每项均为非空 string**；当前无独立条数上限，`cleanup` 的
  三数组才各 ≤20 项）/ `falsify` / `windowDays`（正整数，≤3650）/ `stopLoss`。缺任一或
  空值 → `FlowError('invalid')`，消息点名缺哪个键；**不再**降级为 warning。
- id：自动 `E-YYYYMMDD-NN`（本地日期，两位序号，遍历现有 id 递增）；显式指定必须匹配
  `^[A-Z]+-\d{8}-\d{2}$`，已存在 → `FlowError('conflict')`。
- `parent` 必须指向已存在实验或为 `null`/空串；指向不存在 → `FlowError('invalid')`；指向自己
  → `invalid`。历史坏数据在 `experimentTree` 里按根处理（未知 parent、成环、自引用都不会丢
  记录）。
- `created_at` 不可改；更新自动刷新 `updated_at`；`id`/`schema`/`created_at` 出现在 patch 里
  → `invalid`。`cleanup`/`cleanupAt`/`productizedAt`/`productizeGate` 是**系统维护字段**，
  只由 `cleanupExperiment`/`productizeExperiment` 写，直接 patch → `invalid`。
- **legacy schema1 只读**：读路径（list/show/tree/面板投影）同时接受 `schema: 1` 与 `2`，旧
  四态照旧显示；写路径（`updateExperiment`/`cleanupExperiment`/`productizeExperiment`）对
  `schema: 1` 记录抛 `invalid`（消息建议新建 schema2 实验并用 `parent` 指向它）。`parent` 可以
  指向 schema1 记录，谱系保持完整；未知字段保留。
- **终态规则（仅 schema2）**：`confirmed` 必须 `measured` 非空且 `metrics` 至少一项（硬）；
  `pivoted` 必须 `learned` 非空且存在 `parent` 指向它的**后继实验**（硬）；`inconclusive` /
  `refuted` 的 `learned`（以及 `refuted` 的 `cleanupAt`）在写路径只记 warning，由
  `flow exp cleanup` + `check experiments` 收口。
- **结果分流（四分支）**：
  | 判定 | 状态 | 必做动作 | 之后 |
  |---|---|---|---|
  | 成功（主指标达标、护栏未破） | `confirmed` | 写 `--measured`/`--metrics`；过 `release` 门禁（`finished_at ≥` 该实验 `updated_at`）后 `flow exp productize` | 合并/上线，`productizedAt`/`productizeGate` 已记录 |
  | 不确定（窗口内证据不足） | `inconclusive` | `--learned` 记结论（建议，不阻断） | 继续验证或调整假设；新实验可 `--parent` 指向它 |
  | 失败（证伪条件命中） | `refuted` | `--learned`，再 `flow exp cleanup …` 写 `cleanup` + `cleanupAt` | 停止并丢弃实现，保留学习与清理记录 |
  | 转向（保留部分资产换假设） | `pivoted` | `--learned`，新建后继实验 `--parent` 指向旧实验 | 旧实验不再更新，后继沿用资产 |
  `abandoned` = 主动放弃且不判定（`learned` 建议不强制；`check experiments` 只 warning）。

### 3.2 任务 `tasks/T-YYYYMMDD-NN.json`（兼容既有台账格式）

```jsonc
{
  "schema": 1,
  "id": "T-20261028-57",
  "title": "任务标题",                  // 必填
  "type": "feat",                       // 必填（add）：feat|fix|docs|style|refactor|perf|test|chore|build|ci
  "status": "draft",                    // draft | active | done | archived
  "owner": "",
  "parent": null,                        // 可选（T-13）：父任务 id；null/空串 = 根
  "experiment": null,                    // 可选：关联实验 id（可省略，新建任务默认不写该键）
  "scope": { "allow": [], "deny": [] },  // 数组元素必须为字符串
  "acceptance": [],                      // 字符串数组
  "checkpoints": [],                     // 对象或字符串数组
  "commits": [],
  "notes": "",
  "created_at": "...",
  "updated_at": "...",
  "done_at": null,                      // 可选（T-09）：进入 done 的时刻；回 active/draft 清空
  "archived_at": null                   // 可选（T-09）：进入 archived 的时刻；归档保留 done_at
}
```

- **id 分配（T-08 / D-20261105-05 timestamp）**：新任务 id = `T-<YYYYMMDDHHMMSS>`
  （**本地时间 14 位**，如 `T-20261105212130`）。同一秒创建第二张起追加 `-NN`（两位，从
  `02` 起，例 `T-20261105212130-02`）；同秒上限 **99**，超出抛
  `conflict: no free T id left for <stamp> (same-second limit 99)`。
- **天然单调、不复用**：时间戳只前进，删除记录后**不会回填旧号**；因此任务 id **不需要**
  `flow.json` 计数器（契约里没有该键）。旧 `T-YYYYMMDD-NN` 历史 id **继续可读、
  可被引用**（`parent`、`decisions.blocks`、heartbeat `task`），**不迁移、不回填**。实验 id
  仍为 `E-YYYYMMDD-NN`，本规则只适用于任务 `T-`。
- **跨分支同秒撞名 = git 合并冲突**：多个分支/worktree 在同一秒创建会生成相同 id（概率低但
  可能）；合并时**人工重编号**，**禁止** `git merge -X ours` / `-X theirs` 静默丢弃（会静默
  丢掉一条任务或实验）。重编号需同步文本引用：`decisions` 的 `blocks`、heartbeat 的 `task`、
  任务的 `parent`、实验的 `commits` 等；批量工具 `flow task renumber` 尚未提供，属后续可选卡。
- 更新时 `scope` 逐键合并（`{allow:[...]}` 不会清掉 `deny`），其余字段整体替换。
- **不可改字段（`applyTaskPatch` 单点拦截）**：`id`、`schema`、`created_at`、`title`、`type`。
  任何一条出现在 update patch 里都抛
  `FlowError('invalid', 'task <key> cannot be changed')`（CLI 映射 `exit 2`，`flow_task` 工具
  冒泡同一句，两端文案一字不差）。理由：`id` 被台账/`parent`/`decisions.blocks`/心跳 `task`
  引用；`title` 是任务身份，且面板标题是 `type: title` 的展示面；`type` 参与按类型统计，
  可改则历史漂移。**唯一例外**是 core 内部迁移函数 `normalizeTaskFormat()`（见下方「旧格式
  迁移」），`updateTask` 对外零例外。
- **可更新白名单（显式）**：`status`、`owner`、`notes`、`commits`、`scope`、`acceptance`、
  `experiment`、`parent`。白名单之外的自造键一律 `invalid`（同一条「cannot be changed」文案），
  不做静默写入。
- **系统维护键例外**：`updated_at`（每次 patch 恒刷新）、`done_at`、`archived_at`
  （`stampTaskTimes` 权威管理）**接受**写入但被写路径覆盖，**不**列入不可改清单。
  `checkpoints` 本版不动：不在白名单、无 CLI flag/工具参数，写入属未定义行为，仅供存量只读。
- **`type`（必填，T-15）**：conventional commit 类型，枚举 `feat` / `fix` / `docs` / `style` /
  `refactor` / `perf` / `test` / `chore` / `build` / `ci`。`task add` **必须**
  提供（缺 → `invalid: type is required`），非法值 → `invalid: type must be one of …`；
  `task update` **不接受** `type`（见上「不可改字段」）。
- **旧记录的 `type` 缺失有三种落盘形态，语义一律是「缺失」**：键不存在、`type: null`、
  `type: ''`。三者行为统一（T-20261106124556）：
  - **读投影不迁移**：键不存在 → 投影补 `type: null`；手写 `null`/`''` → **原字面值原样返回**。
    面板降级只显示 `title`（§9.1.4）。
  - **`update` 其它字段可用**：`status`/`owner`/`notes`/`commits`/`scope`/`acceptance`/
    `parent`/`experiment` 都能正常改；三态**都不会被 update 补写或改写** `type`
    （值原样留在盘上，"不迁移"的承诺不变）。实现上只在 `applyTaskPatch` 把缺失语义
    归一后再校验——`buildTask`（新建必填）与 `normalizeTaskFormat`（见下）的严格性不受影响。
  - **补写只走迁移**：`normalizeTaskFormat({fix:true, typeById})`。
  - **非空的非枚举字符串**（如 `"nope"`）**不是缺失**：`update` 仍抛
    `invalid: type must be one of …`，只能经上述迁移通道按 `typeById` 改正。
  > 迁移路径的约束（B7）：一条缺 `type` 的记录在**没有合法 `typeById`** 时，迁移**整条不写盘**
  > ——否则会删掉残留 `goal` 却补不上 `type`，留下半修记录。这与「update 可用」互不矛盾：
  > update 不碰 `goal`/`type`，迁移才负责删与补。
- **`title` 承载标题与目标（goal 已合并，D-1/D-2）**：`goal` **不再是任务字段**——
  `TASK_DEFAULTS` 不写、`task add`/`flow_task add` 不收（`--goal` 是未声明参数 → 用法错误
  `exit 1`；工具侧 `invalid: flow_task add does not accept "goal"`），`task update` 不能复活
  （`invalid: task goal cannot be changed`）。**旧记录磁盘上的 `goal` 键原样保留**：读路径
  （`listTasks`/`getTask`/`flow task show`）**照原样返回、不拼进 `title`、不删不清空**，
  因为它是格式门禁与 AI 的迁移素材；面板行与详情**不显示** `goal`（行形状见 §9.1.4，由 ③ 落地）。
  更新其它字段时 `goal` 既不删也不搬。迁移完成前，旧记录的「目标」文本只在 CLI/门禁可见，**这不是数据丢失**。
- **旧格式迁移（`normalizeTaskFormat`）**：`title`/`type` 不可改之后，旧记录的唯一修复通道
  是 core 内部函数（不进 CLI flag、不进 `flow_task` 参数表）：
  `normalizeTaskFormat(root, contract, {fix?, typeById?})`。
  `fix:false`（默认）**只读零写盘**（不取锁），返回
  `{ok, issues:[{id, kind:'legacy-goal'|'missing-type', title, goal, suggestion}], fixed:[]}`；
  `fix:true` 在写锁内逐条迁移并原子写，返回同样的 `issues`（本次发现的问题）与
  `fixed:[id]`，`ok` = 是否已无待迁移项。迁移规则（**幂等**，第二遍写 0 字节）：
  1. `goal` 非空且 `title` 非空且两者不同 → `title = "<旧 title> — <旧 goal>"`
     （半角破折号 + 两侧空格，单行），然后删 `goal` 键；
  2. `goal` 为空/缺失/等于 `title` → 只删 `goal` 键；
  3. `type` **仅在当前缺失**（键不存在，或手写为 `null`/`''`）且 `typeById[id]` 是上面 10 个
     枚举之一时补齐；已有 `type` 的记录**永不改动**（迁移函数不穿透 ④ 的语义）。
  4. 一条记录同时带残留 `goal` 又缺 `type`，且 `typeById` 没给它合法值时：`goal` 的合并/删除
     **应当**发生，但 `validateTaskFields` 会因缺 `type` 拒绝写盘，该条被跳过并留
     `task-normalize-skipped` 警告（`{fix:true}` 返回的 `ok:false`）。因此门禁**必须**为每条
     待迁移记录提供 `typeById`。
     实测边界（与规则 3 的「缺失」定义相关）：`type` 键**不存在**时 `validateTaskFields` 放行、
     不抛错，此时 `goal` 的合并/删除照常写盘而 `type` 仍缺，跳过分支走不到；只有 `type` 写成
     `null`/`''` 时才会抛错并被跳过。两条路径都是 `fixed` 无该条 + `ok:false`。
     **三种「缺失」形态的当前行为分叉**（P2-4，`review-panel` task-13 实测）：

     | `type` 形态 | `validateTaskFields` | 迁移动作 | 磁盘结果 |
     |---|---|---|---|
     | 键**不存在** | 放行 | `goal` 照常合并/删键 | **被改写**：`goal` 消失、`title` 合并、`type` 仍缺 |
     | `null` | 抛错 | **整条跳过** | **零改写**：`goal` 原样保留 |
     | `''` | 抛错 | **整条跳过** | **零改写**：`goal` 原样保留 |

     `null`/`''` 这条是**永久态**：该条记录**一条都不会被改写**（goal 不搬、type 不补），
     门禁会**永久**报 `missing-type`（`ok:false` 恒不收敛），除非给了 `typeById`——因此**必须**
     为该条提供 `typeById` 才能解除。给了之后同一遍既能补 `type`，`goal` 也随之正常合并
     （合并与补 type 在同一次写盘里完成，不会退化成"只补 type、goal 仍留着"）。
     （`P2-4` 的 P2-3 修复落地后，`null`/`''` 与键不存在将统一走合并路径；届时本节相应收敛。）
  **parent 等缺省键的默认化是既有行为，不属于规则 1–4**：迁移写盘前会过一遍
  `validateTaskFields`，它顺带补齐记录缺省的键——`parent: null`、`owner: ''`、`notes: ''`、
  `scope: {allow:[],deny:[]}`、`acceptance: []`、`checkpoints: []`、`commits: []`——这是所有
  写路径共有的行为，不是本次迁移引入的语义变更。P3 归一时 49 条里有 **36 条**因此多出
  `parent: null`，属正常。`done_at`/`archived_at` **不**由它默认化（归 `stampTaskTimes`
  权威管理，见上「系统维护键例外」）。
  **P3/P4 必须成对 revert**：`check tasks` 一旦接入 precommit，台账归一（P3）与门禁接入（P4）
  **必须成对 revert**——只 revert 台账归一会让 `check tasks` 立刻 exit 1，此后每次提交都被
  门禁挡住。
  迁移**不刷新** `updated_at`（格式归一不是编辑，不得重排「最近完成」），也不动 `done_at`/
  `archived_at`。
  **CLI 通道**：写盘只走 `flow task normalize [--type-map <file.json>] [--dry-run]`（§5.1），
  `--type-map` 是 `{ "<T-id>": "<type>" }` 草稿文件（`.dsh-ops/`、不进库），任何坏形态
  （不存在/坏 JSON/非对象/值非十枚举）一律用法错误、早于 core 调用；`--dry-run` 走
  `fix:false`（不取锁、零写盘、恒 exit 0）。`flow check tasks` 只读、不带 `--fix`，
  所以带合法 map **也不会**消掉 `missing-type`（只改变 `suggestion` 文案）；清零必须真跑本条命令。
- **`parent`（可选，T-13）**：父任务 id，与 `experiment` 同一宽松引用规则
  （`^[A-Za-z][A-Za-z0-9_.-]{1,60}$`）；`null`/空串 = 根；CLI 传
  `task add|update --parent <T-id>`，`--parent ''` / `none` / `null` 清空为根
  （`flow_task` 工具同名参数与 CLI 同规则：`''`/`none`/`null` 大小写不敏感 → 根）。
  写路径要求父**已存在**（否则 `invalid`，消息含 `parent-not-found`）、**禁自指**、**禁环**
  （沿 parent 链上溯回到自己 → `invalid`，消息含 `parent-cycle`）。读路径（`listTasks`/
  `getTask`/state 投影）对父不存在或成环**不报错、按根处理**（投影成 `parent: null`）：
  行仍返回、**不迁移、不写回**；删除父任务后子任务自动变根。父子是单向引用（任务→父），
  父记录不回写子 id。
- **`experiment`（可选）**：关联一条实验 id。写路径（`task add|update --experiment`）用**宽松
  引用格式**校验：字母开头、长度 2..61、只允许字母/数字/`_`/`.`/`-`
  （`^[A-Za-z][A-Za-z0-9_.-]{1,60}$`，与 `parent` 引用同一宽松规则）——这样 Myai 等项目的
  legacy 实验 id（如 `H-normalize`、`H1-baseline`）也能被任务链上。空串 / 超长 / 含其它字符
  → `FlowError('invalid')`；格式合法但现存实验里没有 → 只记一次 `task-experiment-missing`
  warning，**照常写入**（实验可能已被删除或尚未开启，引用不阻断任务）。`null`/空串表示解除
  关联；引用是**单向**的（任务→实验），实验记录不回写任务 id。
- **归档 = `status` 位**：`archived` 是合法状态之一（`draft|active|done|archived`），记录文件
  不移动、不删除；随时可 `task update <id> --status done|active` 反向恢复。归档改 `status`、
  刷新 `updated_at`、写 `archived_at = now`，并**保留原 `done_at`**（T-09 起完成日不再被
  归档日覆盖）；`created_at`/`id`/`scope`/`acceptance`/`checkpoints`/`commits`/`notes`
  原样保留。
- **完成/归档时刻（T-09，可选字段）**：`updateTask` 进入 `done` 写 `done_at = now`；状态已是
  `done` 时后续 patch **不覆盖**首个完成时刻；回到 `active`/`draft` 时清空 `done_at`/
  `archived_at`。`archiveTasks` 进入 `archived` 写 `archived_at = now`（`done_at` 原样保留）。
  两个字段都是可选 ISO 字符串；**旧记录缺字段不迁移、不批量写**，读路径（`listTasks`/
  `getTask`/state 投影）回退到 `updated_at`（归档记录无法还原真实完成日，只能近似）。
  回填发生在**读投影副本**上：`done_at`/`archived_at` 取自 `updated_at` 时该行另带
  `doneAtEstimated: true` / `archivedAtEstimated: true`（**只标记副本、不写回文件**），趋势
  据此把对应日起标 `≈`（见 §9.1.4）。
  时间戳写入异常只记 `task-time-stamp` warning，不破坏任务主写入。
- **归档判定仍按 `updated_at`**：`status === 'done'` 且
  `now - Date.parse(updated_at) >= archiveAfterDays * 86400e3`（默认 **7**，边界含端点）。
  `done` 之后的 patch 仍会刷新 `updated_at`，因此判定窗口以最后一次工单活动为准；`done_at`
  只承载**真实完成时刻**（供趋势/报表），不改变归档触发条件。
- **幂等**：已 `archived` 的任务不再参与判定；同一时刻重复 sweep 写 0 个文件、返回
  `archived: []`，第二次运行不改任何记录的字节。
- **触发面只有显式命令与门禁步**：`flow task archive`（§5.1）与 `precommit` 的归档步
  （§3.3.1）。`GET state`/TUI 面板等读路径**永不**归档（§9.1 的只读与请求代价契约），也不
  存在后台定时器或 watcher。
- **写约束**：先无锁找候选，0 候选直接返回；有候选才进 `withLock`，锁内重读重校，只对仍然
  到期的任务 `applyTaskPatch(record, {status:'archived'})` + `stampTaskTimes`（写
  `archived_at`、保留 `done_at`）后原子写。单条记录坏掉时跳过它并
  记 `task-archive-skipped` warning，不中断本次 sweep（门禁步不会被一条脏记录卡住）。写锁被
  占用（`conflict`）时跳过本次、记一条 `archive-locked` warning，命令仍退出 **0**（`--json`
  带 `locked:true`）；`--dry-run` 不写、不取锁，只报告候选。

#### 3.2.1 任务阶段 `stage`（P0：只落数据）

`stage` 是行为层，`status`（`draft|active|done|archived`）是**兼容视图**——面板队列、
归档 sweep、心跳认领仍读 `status`，它们的行为不因本字段改变。

| `stage` | 中文 | 后继 | 推进者 |
|---|---|---|---|
| `created` | 已创建 | `queued-analysis` | plugin |
| `queued-analysis` | 待分析 | `analyzing` | plugin |
| `analyzing` | 分析中 | `queued-implementation` | session |
| `queued-implementation` | 待实现 | `implementing` | plugin |
| `implementing` | 实现中 | `queued-review` | session |
| `queued-review` | 待审查 | `reviewing` | plugin |
| `reviewing` | 审查中 | `done`（通过）**或 `queued-implementation`（打回）** | reviewer |
| `done` | 已完成 | `archived` | plugin |
| `archived` | 已归档 | —（终态） | — |

**边表**（`STAGE_MACHINE[x].next` 的每一项；边级 actor 是"谁能走这条边"，为 P2 的 guard 铺路）：

| 边 | actor | 标记 |
|---|---|---|
| `created → queued-analysis` | plugin | |
| `queued-analysis → analyzing` | plugin | |
| `analyzing → queued-implementation` | session | |
| `queued-implementation → implementing` | plugin | |
| `implementing → queued-review` | session | |
| `queued-review → reviewing` | plugin | |
| `reviewing → done` | reviewer | 通过 |
| `reviewing → queued-implementation` | reviewer | **`back`**（打回） |
| `done → archived` | plugin | |

- **两级 actor**：上表"推进者"列是**阶段默认**（`STAGE_MACHINE[x].actor`，"谁负责把任务推出
  阶段 x"）；边表里每条边还有**自己的 actor**（"谁能走这条边"）。今天两者逐条相等，并由测试
  断言锁死；给单条边开特权必须显式标 `actorOverride`，那条断言会提醒同步阶段级 actor。
- **唯一后退边**：`reviewing → queued-implementation`（审查打回），也是唯一带 `back: true`
  的边。`reviewing → done` 是通过路径；两条后继在阶段表里 actor 相同，**靠 `back` 区分**。
- **边表是唯一真源**：`nextStages(stage)` / `edgeOf(from, to)` / `actorForEdge(from, to)` 都是
  从边表派生的**投影**，不另存数组；`canTransition` 与 `assertTransition` 只走这三个投影，
  不直接读 `next`。未知边返回 `null`（不抛）。
- **`stage` → `status` 派生**（写路径）：`created → draft`；`queued-analysis` / `analyzing` /
  `queued-implementation` / `implementing` / `queued-review` / `reviewing → active`；
  `done → done`；`archived → archived`。写 `stage` 时同批把派生的 `status` 写回，保证两者
  不矛盾；**同时给 `stage` 与 `status` 且不一致 → `invalid`**。
- **只写 `status` 仍然合法**：既有调用方（归档 sweep、心跳认领、`task update --status`）不改，
  此时 `stage` 原样不动。
- **存量记录**没有 `stage` 键：读投影（`listTasks`/`getTask`/`updateTask` 的返回）**按 `status`
  反推**——`archived → archived`、`done → done`、`active → queued-analysis`（唯一歧义项：`active`
  对应流水线六阶段，取最早者作"在管道中"标记）、其它 → `created`。**不写磁盘**；只有显式写
  `stage` 才会落盘，且**显式 `stage` 永远优先于 `status` 反推**。映射函数是 `lib/stage.mjs` 的
  `legacyStageFromStatus()`（唯一真源，投影只调用、不手写 if 链）。
  反推必须按 `status`：一律补 `created` 会让 done/archived 的存量记录被当成未完成、进待办栈顶并
  虚增 §9 状态块的计数（task-68 的真 bug）。台账回填是独立的显式操作，不是读路径行为。
- **校验**：非法值 → `invalid: stage must be one of created, queued-analysis, analyzing,
  queued-implementation, implementing, queued-review, reviewing, done, archived`（CLI 映射
  `exit 2`）。`stage` 在**可更新白名单**内，不在不可改清单内。
- **实现位置**：`lib/stage.mjs` 是唯一真源（阶段表、边、派生、`canTransition`/`assertTransition`）；
  `lib/core.mjs` 只 import 它的 id/派生用于校验与投影，不复制表。
- 本版**只有数据**：没有捕获、没有 guard、没有派工；`stage` 不会自行推进，
  `canTransition`/`assertTransition` 也还没有被任何写路径调用。

### 3.3 门禁 `gates/<slug>.json`

```jsonc
{
  "schema": 1,
  "id": "precommit",                    // ^[a-z0-9][a-z0-9-]{1,40}$
  "title": "提交前检查",
  "phase": "commit",                    // commit | release | manual
  "enabled": true,
  "steps": [
    {
      "id": "tests",                    // 步骤内唯一；缺省 step-N
      "run": "ctest --test-dir build/x --output-on-failure",
      "expect": "exit 0",               // exit 0 | exit N | contains:文本
      "timeoutSeconds": 600             // 整数 >= 1，默认 600
    }
  ],
  "created_at": "...",
  "updated_at": "..."
}
```

- 未指定 id 时用标题推导 slug（小写、非字母数字转 `-`，截 40），推不出则要求显式 `--id`。
- 步骤未写 `expect` 时统一落盘为 `exit 0`（core 与 CLI 一致）；未知写法在 `runGate`
  运行时按 `exit 0` 处理并记 `gate-expect-unknown` warning。
- `gate update` 的 `--step` 是**整体替换** `steps`，不是追加。
- `enabled` 是真实开关，不只是面板标记：
  - `runGate(...)`（单条）在 `enabled === false` 时抛
    `FlowError('usage', 'gate <id> is disabled; pass --force to run it')`，
    只有 `options.force === true`（CLI `--force`）才执行。
  - `runGatesByPhase(...)`（按 phase 批量）直接**跳过** disabled 的门禁并在
    `skipped` 里记 `{id, reason:'disabled'}`；批量运行不会因为 `force` 唤醒它们。
  - `gate enable <id>` / `gate disable <id>` 是 `gate update --enabled true|false` 的糖。

### 3.3.1 `flow init` 种入的默认门禁

`initProject` 在 **gates 目录为空** 时种入下表 5 条（`seededGates` 返回 id 数组）。
只要目录里已有一条门禁就一条都不加（幂等）；`options.noGates: true` / CLI `--no-gates`
跳过。种子是尽力而为的：任一条构造/写入失败只记 `default-gate-failed:` warning，
不会让 `flow init` 失败，也不计入 `created` 清单。

| id | phase | enabled | 步骤（`expect` 均为 `exit 0`） | 标题 |
|---|---|---|---|---|
| `session-open` | manual | true | `"<包内绝对路径>/bin/flow.mjs" heartbeat status --require-active` | 会话心跳检查 |
| `precommit` | commit | true | `git diff --cached --check` + `"<包内绝对路径>/bin/flow.mjs" check decisions` + `"<包内绝对路径>/bin/flow.mjs" task archive` | 提交前暂存区检查（含阻塞决策与到期任务归档） |
| `tests` | commit | false | `node --test test/` | 单元测试（默认关闭，按项目自填命令） |
| `staged-files` | commit | false | `"<包内绝对路径>/bin/flow.mjs" check staged --allow src` | 暂存文件归属检查（占位） |
| `release` | release | false | `"<包内绝对路径>/bin/flow.mjs" check release-baseline --marker RELEASE` + `"<包内绝对路径>/bin/flow.mjs" check experiments` | 发布基线检查（占位）+ 实验结果/产品化检查 |

引用本插件 CLI 的两个步骤用 `import.meta.url` 在运行时解析出的**包内绝对路径**
（`PLUGIN_BIN`），因为门禁的 cwd 是项目根，不能假设根下存在 `bin/flow.mjs`。
`tests` / `staged-files` / `release` 默认关闭：`node --test test/` 与 `--allow src`
只是模板，必须由项目改成自己的命令/路径后再 `gate enable`。`precommit` 的第二步
`check decisions` 是内置检查（见 §6.1.1）：阻塞决策命中暂存文件时提交被拦下；第三步
`task archive` 按 `tasks.archiveAfterDays`（默认 **7** 天）归档到期任务（该值为 `0` 时这一步
等价空操作，语义见 §3.2/§5.1；种子步骤 id 为 `tasks-archive`）。已有项目不会自动补这两步，
需要手动
`flow gate update precommit --step '<原步骤>' --step 'decisions=…>>exit 0' --step 'tasks-archive=…>>exit 0'`
（`--step` 是整体替换，必须带上原步骤）。

`release` 的第二步 `check experiments` 同样是内置检查（见 §6.1.2）：`experiments.enabled`
为 `false` 时它**直接 exit 0 跳过**，为 `true` 时拦住「schema2 缺七字段 / `refuted` 缺
`learned`+`cleanupAt` / `pivoted` 缺 `learned` 或后继 / `confirmed` 未产品化」，`open` 超期
只是 warning。注意 `release` 种子**默认 `enabled: false`**，须项目执行
`flow gate enable release` 才生效；已有项目缺这一步时手动
`flow gate update release --step '<原步骤>' --step 'experiments=…>>exit 0'`。

### 3.4 运行记录 `logs/<gateId>/<timestamp>.json`

```jsonc
{
  "gate": "precommit",
  "title": "提交前检查",
  "started_at": "2026-10-28T16:00:00+08:00",
  "finished_at": "2026-10-28T16:00:12+08:00",
  "durationMs": 12000,
  "ok": false,
  "steps": [
    {
      "id": "tests", "run": "...", "expect": "exit 0",
      "exit": 1,                       // 被信号杀死 / 启动失败时为 null
      "ok": false, "durationMs": 11000,
      "tail": "最后 40 行，每行截 400 字符"
    }
  ]
}
```

- 步骤顺序执行，**首个失败即停**，后续步骤不执行也不进记录。
- `tail` 合并 stdout+stderr，默认取最后 40 行（`options.tailLines` 可调），每行截 400；
  输出总量截到 512 KiB。
- 文件名由 `started_at` 生成（冒号/点替换为 `-`）；同一秒内两次运行会写同一个文件名
  （后者覆盖前者），这是已知限制。
- 批量运行 `runGatesByPhase(root, contract, phase, {force?, timeoutMs?, tailLines?})`
  按 id 升序跑该 phase 下所有 `enabled !== false` 的门禁，返回
  `{phase, runs:[运行记录], skipped:[{id, reason}]}`；单条失败/抛错**不中断**后续，
  抛错的门禁以 `{gate, title, ok:false, steps:[], error:{code,message}}` 形式进入 `runs`。
  `phase` 必须是 `commit|release|manual`，否则 `FlowError('invalid')`。

### 3.5 心跳 `<heartbeats.dir>/<session>.json`（schema 1）

心跳只面向**主会话**：同一项目可能同时开多个主会话（不同窗口、不同工作树），心跳是它们
互相避让的登记簿；**子会话（subagent / teammate 子代理）不登记心跳**。心跳根固定为
**项目主工作区**：即使会话 cwd 在某个 `git worktree` 里，读写仍落到主工作区的
`contract.heartbeats.dir`。解析方式：`git -C <cwd> worktree list --porcelain` 的第一条
worktree 即主工作区；失败时用 `git rev-parse --git-common-dir` 推导主 checkout；仍失败或
主工作区没有 store 时降级到当前 cwd，并记 `heartbeat-root-degraded` warning。
目录不存在会自动创建（`.agents/` 已在 `.gitignore` 里）。文件名就是 session id，
一个主会话一个文件。

```jsonc
{
  "schema": 1,
  "session": "session-79c1c4e6-ecf5-40a9-98c2-fd7a373a2a85",
  "agent": "lead",
  "goal": "当前任务名或 AI 自定义的一句话目标",
  "task": "T-20261029-01",              // 所属任务 id，可为 null
  "claims": ["lib/core.mjs", "bin/flow.mjs"],
  "status": "working",                  // working | idle | done | missed
  "turn": 3,
  "last_action": "本轮正在做的事",
  "started_at": "2026-10-29T11:10:37+08:00",
  "updated_at": "2026-10-29T11:14:02+08:00",
  "ended_at": null,
  "stats": { "turns": 3, "missed": 0 },
  // 存活证据（T-10）：宿主进程写全部四个字段；CLI 只补缺失的 host、不覆盖已有证据
  "host": "my-laptop|linux",            // machine_id = hostname|platform
  "boot_id": "f0e1…",                   // /proc/sys/kernel/random/boot_id
  "pid": 48213,                         // 宿主进程 pid
  "pid_start": 9943211                  // /proc/<pid>/stat 第 22 字段（pid 复用判定）
}
```

- **`claims` 语义**：本主会话**独占写入的文件域**，对外广播「这些文件别碰」；默认取
  所属任务的 `scope.allow`。它不改变 core 的写入权限，只是协作约定。
- **主会话判定**：Host 用 `agents` 服务——`roots()` 返回的活根代理即主会话，`list()` /
  `get(id)` 用来识别「活着但不是 root」的子会话；宿主不提供该服务时回退会话日志 header
  （`origin === "subagent"` 或 `delegationDepth > 0` 判为子会话；fork 出的新主会话仍算主
  会话）。`flow_heartbeat` 的 start/update/end 与 CLI `flow heartbeat start/update/end`
  在子会话里**明确拒绝**（工具报错、CLI 退出 1），list/status 只读放行。
  **注意**：`lib/core.mjs` 不感知会话类型，拒绝发生在 Host 工具与 CLI 层；直接调 core
  API 的脚本自行负责只从主会话写入。
- `session` 缺省取 `DSH_SESSION_ID`；仍为空 → `FlowError('usage')`。session 会当文件名用，
  因此按 Windows 与 POSIX 的交集校验，任一不满足 → `FlowError('invalid')`：长度上限 80；
  禁止 `/`、`\`、`..`、控制字符与 `[<>:"|?*]`（`:` 同时挡掉 NTFS ADS `name:stream`）；
  禁止**结尾点或空格**（Windows 会静默去掉，导致 `a.` / `a ` 与 `a` 同名碰撞）；禁止
  Windows 保留设备名 `CON`/`PRN`/`AUX`/`NUL`/`COM1`-`COM9`/`LPT1`-`LPT9`——大小写不
  敏感，带扩展名同样拒绝（`con.txt`、`nul.tar.gz`），按第一个点之前的词干判定。
- `status` 只有 `working` / `idle` 算 active；`done` / `missed` 是结束态。
  `ageSeconds` 按 `updated_at` 计算（解析失败回退文件 mtime），`> 6h`
  （`HEARTBEAT_STALE_SECONDS`）记 `stale`。
- **存活证据与 `liveness`（T-10）**：`host` / `boot_id` / `pid` / `pid_start` 由**宿主进程**
  写入（`process.pid`、`/proc/<pid>/stat` 第 22 字段、boot id）。**CLI 子进程不写自己的
  pid/boot_id/pid_start**；记录里已有的 `host`/`boot_id`/`pid`/`pid_start` **一律保留**
  （跨机记录不会被本机 CLI update 抹成 `dead`），只有记录原本没有 `host` 时才补一个。
  `livenessOf(record, {now, host, bootId, mtime})` 是只读判定：

  | 证据 | liveness | reason |
  |---|---|---|
  | 记录 `host` 与当前机器不同 | `foreign` | `other-host`（跨机器只标记，绝不判死） |
  | 同机、`boot_id` 不同 | `dead` | `boot-changed`（宿主重启） |
  | 同机同 boot、`pid` 已不存在 | `dead` | `pid-gone` |
  | 同机同 boot、`pid` 存活但 `pid_start` 不匹配 | `dead` | `pid-reused`（pid 被复用） |
  | 同机同 boot、`pid` 存活且 `pid_start` 匹配 | `live` | `pid-alive` |
  | 无任何证据且 age ≤ 6h | `unknown` | `no-liveness-evidence` |
  | 无任何证据且 age > 6h | `stale` | `no-liveness-evidence` |

  **非 Linux 降级**：没有 `/proc` 的平台读不到 `boot_id` 与 `pid_start`（两个字段为空），
  于是跳过「boot 变更 / pid 复用」判定，退化为 `pid` 存活探测（`process.kill(pid, 0)`）+
  6h 年龄兜底：探不到 pid → `dead`，探到 → `live`；记录没有 pid 证据时仍按 `unknown`/`stale`。

  `ageSeconds`（及 liveness 的年龄兜底）按 `updated_at` 计算；`updated_at` 不可解析时
  回退心跳文件的 mtime，**不会**因为坏时间戳而误判 `stale`。旧记录缺字段按
  `unknown` / `stale` 兜底，不报错（向后兼容）。`heartbeatStatus` 返回
  `{active, liveness, reason, ageSeconds, record}`；`active` = `status ∈ {working,idle}` 且
  （`liveness === "live"` → 直接 active（**pid 证活不受 6h 门槛**），否则
  `liveness ∉ {dead,foreign,stale}` 且 `ageSeconds ≤ 6h`）。
  `heartbeatStatus(root, contract, session, {live:true})` 是给宿主的正向证据入口（`agents`
  服务命中该会话）：判定覆盖为
  `live`/`agent-live`，忙碌但 >6h 未续写的活跃会话仍 active；没有记录时不会凭空造 active。
  因此 `flow heartbeat status --require-active` 对死会话/陈旧/跨机心跳退出 1（`session-open`
  门禁不再对死会话假绿）。
- 写操作（start/update/end）与 store 共用同一把锁与原子写（`withLock` +
  `writeJsonAtomic`），要求项目已 `flow init`（否则 `usage`）；宿主写操作刷新存活证据，
  CLI 写操作只补缺失的 `host`、保留已有证据（F1）。
- `endHeartbeat` 只写 `ended_at` 并保留文件（面板仍要列出），不删除。
- **旧子会话心跳**：已移除的「子代理自动开合心跳」留下的 `agent: "subagent"` 记录是历史
  数据。读侧把它投影为 `legacy: true` / `hidden: true`，**不进入面板与 CLI list**，只计入
  `counts.hidden`；`flow heartbeat gc [--dry-run]` 清理这些文件（其余心跳保留）。
- **读取只认 `*.json`**（心跳目录下的 `.md` 不再读取）：`readHeartbeats` 保留旧形状
  `{file,title,statusLine,ageSeconds,mtime}`（隐藏旧子会话记录）；`readHeartbeatSection`
  返回富形状 `{root,dir,items,counts}`，item 含
  `{file,session,agent,legacy,hidden,goal,task,claims,status,last_action,started_at,updated_at,ended_at,ageSeconds,stale,turn,stats,mtime,liveness,reason}`，
  计数 `{total, active, stale, dead, hidden}`（total/active/stale/dead 统计
  `heartbeats.max` 截断后的**全部行**，与 visibility 无关；
  `active` 口径见上：status active 且（live 或 fresh 且非 dead/foreign/stale）；`dead` 计
  `liveness === "dead"`；`stale` 计 `ageSeconds > HEARTBEAT_STALE_SECONDS`（6h）的行，
  **可与 `dead` 重叠**（一条记录可同时 stale 与 dead）；**没有 `foreign` 计数键**——跨机记录
  计入 `total`/`stale`，但不计 `active`、不计 `dead`；存活判定只读，GET state 读路径不写
  心跳文件；`root` 是解析后的
  主工作区绝对路径，降级时另带 `degraded: true` 与 `reason`）。
- **读侧可见性（T-13）**：`readHeartbeatSection(root, contract, {visibility:'active'|'all'})`，
  默认 `'active'`——`items` 只含 `live`，或 `unknown`/`foreign` 且 `ageSeconds ≤ 6h` 的行；
  `dead` 与 `stale` 整行隐藏（`--all` 或等价的 `includeEnded:true` 即 `visibility:'all'`，
  返回全量）。`counts` 口径**不变**（仍统计全部行），另带 `hiddenByVisibility` = 被隐藏行数
  （`visibility:'all'` 时为 0；空目录/`source:'none'` 也是 0）。读路径**零写入**：不删文件、
  不改内容、不动 mtime——隐藏只发生在内存投影里。

### 3.6 决策 `decisions/D-YYYYMMDD-NN.json`

需要用户拍板的事建一条 `D-` 记录（规格见 `docs/decision-log.md`）：**提问即建记录，回答当轮
关闭，未关闭的每轮都在场**。与实验/任务/门禁同族：`schema: 1`、`created_at`/`updated_at`、
未知字段保留、同一把锁与原子写；目录由 `decisions.dir` 声明。

```jsonc
{
  "schema": 1,
  "id": "D-20261031-01",                        // 自动 D-YYYYMMDD-NN；不可改
  "question": "是否把 flow check decisions 接入 precommit 门禁？",  // 非空，≤200 字
  "kind": "approval",                           // choice | approval | input
  "options": [                                  // choice: ≥2 且 id 唯一；approval 固定 approve/reject；input 固定 []
    { "id": "approve", "label": "同意", "impact": "预提交门禁会拦住阻塞中的提交" },
    { "id": "reject", "label": "拒绝", "impact": "决策只靠提醒与面板可见" }
  ],
  "default": null,                              // 可选；必须是 option id
  "recommendation": "approve",                  // choice 必填（option id）；approval 省略时 core 写 approve；input 为自由文本
  "rationale": "门禁是唯一能在提交动作上强制拦截的表面。",   // 必填，≤300 字
  "status": "open",                             // open | answered | withdrawn | superseded
  "blocks": ["T-20261030-23"],                  // 每个 id 必须已存在；非空时 affects 必须非空
  "affects": ["lib/core.mjs", "bin/flow.mjs"],  // 仓库相对 POSIX 路径/前缀
  "answer": null,                               // answered 时 {choice,note,at,by}
  "asked_at": "2026-10-31T09:50:00+08:00",
  "answered_at": null,
  "withdraw": null,                             // withdrawn 时 {reason,at,by}
  "supersedes": null,                           // 被本记录取代的旧 D-id
  "superseded_by": null,                        // 系统维护（反指针）
  "fingerprint": "9b2f7c4a1e6d8035",            // 系统维护：sha256(kind+"\n"+归一化 question) 前 16 位
  "asked_session": "session-…", "asked_turn": 1,
  "created_at": "2026-10-31T09:50:00+08:00",
  "updated_at": "2026-10-31T09:50:00+08:00"
}
```

- **状态机**：新建固定 `open`；`answer` 只接受 `open` → `answered`（写 `answer` 与
  `answered_at`）；`withdraw` 只接受 `open` → `withdrawn`（写 `withdraw`，`answered_at`
  保持 null）；新 ask 带 `supersedes` 可把**任意非 `superseded`** 记录置 `superseded`
  （保留其原 `answer`/`withdraw` 供审计，写 `superseded_by`，两条互相指向）。终态不可回退：
  对已关闭记录再 `answer`/`withdraw` → `conflict`；重新决策只能新建记录并 supersede 旧记录。
- **指纹去重（唯一规则）**：`sha256(kind + "\n" + normalize(question))` 取前 16 位十六进制，
  `normalize` = NFKC → 去掉全部空白与标点 → 转小写；指纹只由 core 计算、不接受传入。ask 的
  三种结果：① 同指纹存在 `open` 记录 → 不新建，返回已有记录（`created: false`）；
  ② 同指纹存在已关闭记录 → **必须** `supersedes` 恰好指向该记录，否则 `conflict` 并回显旧
  答案；③ 无同指纹 → 新建。
- **校验**：`blocks` 每个 id 必须已存在于 `tasks/`；`blocks` 非空必须声明 `affects`；
  `choice` 至少两个 option、id 匹配 `^[a-z0-9][a-z0-9-]{0,23}$` 且唯一，`recommendation`
  必填并命中 option，`default` 若给出也须命中 option；`approval` 由 core 固定
  `approve`/`reject`（调用方不得传 `options`），`recommendation` **可省略**：approval 省略
  `recommendation`（`undefined`/`null`/空串）时 core 写 `approve`，显式给值必须命中
  `approve`/`reject`——想推荐拒绝必须显式传 `reject`；`input` 无 `options`，
  `recommendation`/`default` 为自由文本；`affects` 不得绝对路径、不得 `..` 逃逸，
  存储时 `\` → `/`、去 `./`、去尾 `/`。任一不满足 → `invalid`（退出码 2）。
- **系统字段**：`fingerprint`、`superseded_by`、`answered_at`、`answer`、`withdraw` 由 core
  维护，调用方传入 → `invalid`；`id`/`schema`/`kind`/`asked_at`/`created_at`/`question`/
  `options` 一经创建不可改（没有独立 update 命令）。

## 4 写入语义

**原子写**：`mkdir -p` → `open(<name>.tmp-<pid>-<seq>, 'wx')` → 写 → `fsyncSync(fd)`
→ close → `rename` → 父目录 best-effort `fsync`。`fsync` 必须在 `rename` 之前：崩溃只会
留下旧的完整文件或新的完整文件，不会半截。父目录 `fsync` 失败一律吞掉（`/mnt/d` ntfs3
返回 `EINVAL`），不影响写入结果。`rename` 只对 `EPERM`/`EBUSY`/`EACCES` 退避重试
（10/50/150ms，最多 4 次），其他错误立即失败；任何失败都清理临时文件并抛
`FlowError('io')`，消息保持 `cannot write <path>:` 前缀。拿到锁后按 10 分钟节流清理 store
根与 experiments/tasks/gates/decisions/logs（含一级子目录）中名字匹配
`*.tmp-<pid>-<seq>` / `.lock.takeover-<pid>-<hex>` 且 mtime 超过 10 分钟的非目录文件
（绝不删 `.json`、`.lock` 与未知名字），删了 N 个记一条 `stale-temp-cleaned: N` warning。
读到的坏 JSON 文件只记 `unreadable:` warning，不影响列表。

**写锁**：每次写操作在 `<store>/.lock` 上用 `open(..., 'wx')` 加锁，内容
`{"schema":1,"pid":N,"host":"<hostname>|<platform>","at":"<ISO>","token":"<uuid>"}`，
结束即释放。`host` 带 platform 是为了区分 WSL 与 Windows 的 PID namespace；`token` 是本次
获取的所有权凭证：释放时只有 token + pid 都匹配才 `unlink`，不匹配只记
`lock-release-skipped:` warning 并原样保留（不误删第三方新锁）；释放本身**永不抛**
（它在 `finally` 里，抛会掩盖业务异常）。

锁存在且不足 30 秒（`FLOW_LOCK_STALE_MS` 可覆盖，非法值忽略）→ 直接
`FlowError('conflict')`（年龄优先，不判活）。超过 30 秒再判活：`process.kill(pid, 0)`
成功或 `EPERM` → 视为存活，仍 conflict 并给出 pid/host/path，用户核实后手动 `rm`；
`ESRCH` → 已死，可接管；`host` 不同的锁**不调用** `kill`，60 秒宽限期内只 conflict。
接管是 CAS：先赢下短命的 `.lock.takeover-claim`（串行化所有接管决策，避免两个接管者
依据同一份过期快照动作），在 claim 内重新读取并复判，再把锁 `rename` 到
`.lock.takeover-<pid>-<hex6>`；回读内容必须与快照逐字节一致，不一致或移到的锁其实还活着
→ 用 `link()`（原子 no-clobber）把它放回原处，**绝不用 `rename`**（会覆盖第三方新锁）。
确认可接管后先 `open('wx')` 创建自己的锁、再删移交文件：进入临界区的唯一入口始终是这把
新锁，任意时刻只有一个写者。

claim 自身也有恢复规则：owner 可判死（或无法判活且超过 60 秒）就按同一 CAS 恢复——先
`rename` 到 `…takeover-claim.tmp-<pid>-<seq>`（落在陈旧 tmp 清扫命名内），回读内容与快照
一致才 unlink，否则用 `link()` 放回并记 `lock-claim-restore-skipped:`。claim 写着存活 pid
但年龄超过 10 分钟（临界区本该是微秒级：SIGSTOP 或 pid 复用）按僵死 claim 恢复，并记
`lock-claim-stale: recovered <path> after Ns`；等不到 claim 的写者拿到 conflict，消息给出
pid/host/age 与「确认没有接管在跑后删除 <claim 路径>」的处置建议。

claim 的**释放**同样校验归属（与锁一致）：token + pid 都匹配才 `unlink`，不匹配只记
`lock-claim-release-skipped: <path> is held by pid N (this process is M); left in place`
并保留，且永不抛（在 `finally` 里）。这堵住「被恢复的僵死接管者恢复运行后删掉接管者新
claim、出现两个 claim 持有者」的窗口。接管者在破坏性 `rename` 前还会再回读一次 claim 并
自证 token，不匹配立刻放弃（随后 `finally` 会记 `lock-claim-release-skipped:` 暴露这次
让位）。

**有意接受的残余风险**：被恢复的僵死接管者恢复运行后，仍可能正好卡在「回读自证」与
`rename` 之间的**一次 syscall 窗口**内，按旧快照 move 一次活锁；紧随其后的 compare-mismatch
兜底会用 `link()` 放回并记 `lock-cas-raced:`，与没有 claim 的协议同伤害面（临时缺口而非
删除）。10 分钟阈值是「SIGSTOP 与 pid 复用不可区分」的取舍：不设自愈会回到 pid 复用导致
的无界阻塞，设得更短则会误伤正常的长暂停接管者。

锁只防**同一 PID namespace 的同机并发**写；store 放在共享网络盘上跨机器写不受保护。
升级注意：旧版 core 的释放逻辑会无条件删锁，新旧进程同时写同一个 store 时可能误删新锁——
升级窗口内确保没有旧进程在写同一个 store。

**id 生成**：`PREFIX-YYYYMMDD-NN`；遍历现有记录取当天最大序号 +1（跳过已占用），
当天用尽 → `FlowError('conflict')`。

**不覆盖守卫**：写新记录前（`exp/task/gate/decision add` 与心跳自动建任务）先检查
`<dir>/<id>.json` 是否已存在——存在且不是目录就抛
`FlowError('conflict', 'record id <id> is already occupied by <绝对路径> (possibly unreadable); fix or remove that file, then retry')`，
**绝不覆盖**无法解析的记录（目录目标不算，交给原子写报 `io`/`cannot write`）。显式
`--id` 与自动 id 走同一守卫。已知代价（有意接受）：当天某个 id 的坏文件会让该前缀当天的
自动 id 全部 conflict，直到坏文件被修好或删除；冲突消息带绝对路径与处置建议。

**坏记录计数**：不可读的 `<id>.json` 不出现在列表里，但也不从计数里消失——
`flow status --json` 与 `readStoreState()` 的 `counts` 各带并列 `unreadable`
（`total` 语义不变，仍是可读记录数），人类 `flow status` 追加 ` · +N 无法读取`。

## 5 CLI 参考（`bin/flow.mjs`）

全局：

```
flow <command> [options]
flow --root <dir> <command> [--json]
```

| 全局参数 | 说明 |
|---|---|
| `--root <dir>` | 项目根目录，默认当前目录 |
| `--json` | 机器可读输出：成功 `{ok:true,data,warnings}`；失败 `{ok:false,error,warnings}`（顶层 `warnings` 恒为数组，可空） |
| `-h`, `--help` | 显示帮助并退出 0 |

**警告流**：每次调用收集两个来源——`loadContract().warnings`（契约修复诊断）与
`core.drainWarnings()`（锁接管、不可读记录、containment、`gate-expect-unknown` 等）——并
去重。`--json` 模式下只出现在信封顶层 `warnings`，**不写 stderr**；人类模式下在命令输出
之后、错误行之前逐条打印 `警告: <text>` 到 stderr（成功与失败路径都打印）。
`gate run` 步骤子进程的 stderr 只进 `data.steps[].tail`，**不**转发到父进程 warnings。

### 5.1 命令

```
flow init [--name X] [--force] [--no-gates]
flow status

flow exp list | show <id> | tree
flow exp add    --title T --hypothesis H --direction TEXT --expected E
                --primary-metric M --guardrail G [--guardrail G]...
                --falsify F --window-days N --stop-loss S
                [--factor F] [--parent ID] [--scale S] [--notes N]
flow exp update <id> [--title T] [--status open|confirmed|refuted|abandoned|inconclusive|pivoted]
                [--direction TEXT] [--expected E] [--primary-metric M]
                [--guardrail G]... [--falsify F] [--window-days N] [--stop-loss S]
                [--learned L] [--hypothesis H] [--factor F] [--parent ID]
                [--scale S] [--measured M] [--metrics JSON]
                [--commits a,b] [--notes N]
flow exp review <id>
flow exp productize <id> [--gate release]
flow exp cleanup <id> [--flag F]... [--code C]... [--data D]...
flow exp rm <id> [--yes]

flow task list | show <id>
flow task add    --title T --type <t> [--status draft|active|done|archived]
                 [--stage <s>] [--owner O] [--notes N] [--experiment E-id] [--parent T-id]
flow task update <id> [--title T] [--type <t>] [--status draft|active|done|archived]
                 [--stage <s>] [--owner O] [--notes N] [--experiment E-id] [--parent T-id]
                 # <t>: feat|fix|docs|style|refactor|perf|test|chore|build|ci（add 必填）
                 # <s>: 九阶段之一（见 §3.2.1）；写 --stage 时 status 由阶段派生并同批落盘，
                 #      给 --stage done 会同时写 done_at（stampTaskTimes），两者同给且矛盾 → invalid
                 # title 承载标题与目标：--goal 已删除（旧记录由 normalizeTaskFormat 迁移）；
                 # update 的 --title/--type 可解析但恒 exit 2（invalid: task <key> cannot be changed）
flow task rm <id> [--yes]
flow task archive [--older-than N] [--dry-run]
flow task normalize [--type-map <file.json>] [--dry-run]
                 # 归一旧记录：goal 并入 title、按 map 补 type；--dry-run 只报告不改盘，
                 # 恒 exit 0（报告不是门禁）。写盘成功 → exit 0，残留见 data.ok:false。

flow gate list | show <id>
flow gate add    --id SLUG --title T --phase commit|release|manual
                 [--step 'id=run>>expect' ...]
flow gate update <id> [--title T] [--phase commit|release|manual]
                 [--enabled true|false] [--step 'id=run>>expect' ...]
flow gate enable <id>
flow gate disable <id>
flow gate rm <id> [--yes]
flow gate run  <id> [--timeout SECONDS] [--force]
flow gate run  --phase commit|release|manual [--timeout SECONDS] [--force]
flow gate logs <id> [--limit N]

flow heartbeat start  [--goal G] [--task ID] [--claim PATH]... [--agent A]
                      [--session S] [--note T]
flow heartbeat update [--status working|idle] [--note T] [--goal G]
                      [--task ID] [--claim PATH]... [--session S]
flow heartbeat end    [--note T] [--status done|missed] [--session S]
flow heartbeat list [--all]
flow heartbeat status [--require-active] [--session S]
flow heartbeat gc [--dry-run]

flow decision ask    --question Q --kind choice|approval|input
                     [--option 'id=label>>impact']... [--default ID]
                     [--recommendation ID] [--rationale R]
                     [--blocks T-id]... [--affects PATH]... [--supersedes D-id]
flow decision list   [--open] [--all]
flow decision show   <id>
flow decision answer <id> --choice C [--note N] [--by user|agent]
flow decision withdraw <id> --reason R [--by user|agent]
flow decision gc     [--days N] [--dry-run]

flow check list
flow check staged --allow <path> [--allow <path> ...]
flow check release-baseline --marker <text> [--threshold <N>]
flow check state [--file <path>]
flow check doc --file <path> --type task|design|incident|release
flow check decisions
flow check experiments
flow check tasks [--type-map <file.json>]
```

- `show|update|rm|run|logs|enable|disable` 的 id 可作位置参数，也可用 `--id`；两者都写且不一致 → 用法错误。
- `gate run --phase X` 不接 id（同时给 `--phase` 和 id → 用法错误）；批量结果在
  `data` 里是 `{phase, runs, skipped}`，人类输出显示「运行 N 条 · 通过 · 失败 · 跳过」
  以及失败门禁清单。任一门禁失败**不改变退出码**（同单条 `gate run`，用 `data.runs[].ok` 表达）。
- `--force` 只对单条 `gate run` 有意义（跑 disabled 门禁）；批量运行永远跳过 disabled。
- `gate enable|disable <id>` 等价 `gate update <id> --enabled true|false`。
- `heartbeat start/update/end` 的 session 缺省取 `DSH_SESSION_ID`（`--session` 覆盖）。
  `--claim` 可重复，是「本会话独占写入的文件域」，缺省取所属任务的 `scope.allow`。
  `start` 省略 `--task` 时按优先级认领任务：① `owner === session`；② `owner === --agent`
  （或上次心跳的 agent）；③ **最老的**无主（`owner` 为空）`active`；④ **最老的**无主 `draft`
  （③④ 按 `created_at` **升序**取最老，即 FIFO 队列；`updated_at` 不再参与认领排序；
  `created_at` 缺失或不可解析的记录排在最后）。**他人名下的任务不会被抢**——并行主会话各建各的卡，
  `claims` 才不会串味。都不命中才新建一条 `draft` 任务（标题取 `--goal`，缺省
  「未命名任务」，owner 为 session）并回填 `task`。显式 `--task` 始终优先，不存在则 `not-found`。
  重复 `start` 保留首次 `started_at`，`turn` +1（core 的 `startHeartbeat` 也接受显式 `turn`），
  `stats.turns` 递增，
  清空 `ended_at`，`status` 回 `working`。
- `heartbeat update` 只接受 `status`/`last_action`/`goal`/`task`/`claims`/`turn`，其它键
  → 校验失败；CLI 的 `--status` 只允许 `working|idle`（结束用 `heartbeat end`）。
- `heartbeat end` 默认 `status: done`，写 `ended_at`，`--note` 并入 `last_action`；文件保留。
- `heartbeat status` 无 `--require-active` 时永远退出 0（只打印状态）；带
  `--require-active` 且没有 active 心跳（无文件，或 status 不是 working/idle）→ 退出 **1**，
  供 `session-open` 这类门禁直接使用。`heartbeat status` 只打印**单会话摘要**
  （active/liveness/reason/ageSeconds），不做可见性过滤。
- `heartbeat list` 默认只列**可见行**（`visibility:'active'`，口径见 §3.5）：`live`，或
  `unknown`/`foreign` 且 `ageSeconds ≤ 6h`；被隐藏的 `dead`/`stale` 折叠为末行
  「已隐藏 N 条（已结束/可能已停，`--all` 查看）」。`--all` 用 `visibility:'all'` 列出全量，
  并恢复「已结束（dead）/可能已停」清单；两种模式的头部计数始终是全量 `counts`。
- `decision list` 默认只列 `open`；`--open` 是显式同义写法，`--all` 列全部（closed 按
  `updated_at` 倒序，排在 open 之后）。排序全局唯一：升级优先，其次 `asked_at` 旧的在前。
- `decision ask` 的 `--option` 格式 `id=label>>impact`，可重复；`choice` 至少两个。
  `--recommendation` 在 `choice` 必填；approval 省略 `--recommendation` 时 core 写
  `approve`（想推荐拒绝必须显式传 `reject`）；`--rationale` 必填；`--blocks`/`--affects`
  可重复；`--supersedes` 用于同题重开（见 §3.6）。
- `decision answer` 的 `--choice` 必填（`input` 为自由文本）；`--by` 默认 `user`，
  `--note` 可省略（落盘为空串）。`decision withdraw` 的 `--reason` 必填。
- `decision gc` 默认保留 90 天内与全部 open；`--days N` 覆盖保留天数，`--dry-run` 只报告
  不删除；只删 `answered`/`withdrawn`/`superseded` 且关闭超过保留期的记录。
- `flow check decisions` 是内置检查（bin 特判路由 core，见 §6.1.1），语义与退出码按检查
  词汇归一；`flow check experiments` 是第二个内置检查（见 §6.1.2）：`experiments.enabled`
  为 `false` 时 **exit 0 跳过**并打印原因，失败 exit 1（`failed[]`），warnings 不阻断。
- `flow check tasks` 是第三个内置检查（见 §6.1.3）：只读地报告旧任务记录的结构问题
  （残留 `goal` 键 / 缺 `type`），有 issue 即 exit 1。**它不写盘、也不提供 `--fix`**；
  `--type-map <file.json>` 只用于校验与预演 type，真正补 type 要跑 `flow task normalize`。
- `flow init --no-gates` 跳过默认门禁种子（见 §3.3.1）。
- `exp add` **不支持** `--id`（id 由 core 自动生成）；显式 id 只能直接调 `addExperiment`。
- `exp add` 的七个规范字段（`--direction`/`--expected`/`--primary-metric`/`--guardrail`/
  `--falsify`/`--window-days`/`--stop-loss`）对新记录**必填**，缺一个即 `invalid`（见 §3.1）；
  `--guardrail` 可重复、至少一次；`--window-days` 必须是正整数。
- `exp update` 对 `schema: 1` 旧记录抛 `invalid`（legacy 只读，见 §3.1）。`--status refuted`
  在缺 `learned`/`cleanupAt` 时只记 warning（清理是异步动作），由 `flow exp cleanup` 收口、
  `check experiments` 硬拦。
- `exp review <id>`：**只读**自查，输出 `{id, verdict, branch, missing[]}`（`verdict` 取
  `complete|incomplete`，`branch` 取 `success|uncertain|failure|pivot`），**恒退出 0**；不改
  任何记录，门槛由 `productize`/`check experiments` 拦。
- `exp productize <id> [--gate release]`：仅对 `status === 'confirmed'` 生效；要求 `release`
  门禁最近一次 `ok:true` 运行的 `finished_at` **≥** 该实验的 `updated_at`（进入 `confirmed`
  的时刻），早于则 `invalid`（退出 2）。通过后原子写 `productizedAt` 与
  `productizeGate: {id, runAt, log}`；已产品化再次调用**幂等**（`already:true`，退出 0）。
- `exp cleanup <id> [--flag F]... [--code C]... [--data D]...`：写 `cleanup` 的三类数组
  （开关/代码/数据，各 ≤20 项；类内可空=无）并写 `cleanupAt`（ISO）；对 `schema: 1` 记录 →
  `invalid`。
- `task add|update --experiment E-id`：宽松引用格式（字母开头、2..61、允许 `_.-`），空/超长/
  非法字符 → `invalid`（退出 2）；格式合法但实验不存在 → `task-experiment-missing` warning，
  仍写入（见 §3.2）。
- `exp update` 的 `--metrics` 必须是 JSON 对象，如 `'{"tie":0.4}'`；`--commits` 逗号分隔。
- `flow task list` 保持 `updated_at` **倒序**（CLI 的历史视角，最近更新在前），与面板
  `active`/`draft` 的 FIFO 顺序（`created_at` 升序，见 §5.3）**不同**；两者各自稳定，不要
  互相推断（`task list` 不因 FIFO 改造而改变）。
- `--step` 格式 `id=命令>>expect`，可重复；`expect` 可为 `exit 0`、`exit 2`、
  `contains:文本`；未写 `>>expect` 时为 `exit 0`。
- `gate run --timeout SECONDS` 覆盖该次运行所有步骤的超时（默认按步骤的 600 秒）。
  步骤超时后 core 终止**整个进程树**：POSIX 杀以 detached 启动的进程组；win32 先
  `taskkill /PID <pid> /T /F`（`/T` 含子进程、`/F` 强制），再直接杀子进程兜底。win32 上
  `taskkill` 之后仍可能收不到 `close`（孙进程占着 stdio），因此再等 2 秒 grace 就 resolve
  并把该步骤记为失败（`exit: null`），不再挂死；非 win32 行为不变（仍只等 `close`）。
- `gate logs --limit N` 默认 5，按 `started_at` 新→旧。
- `rm` 不带 `--yes`：TTY 下交互确认；非 TTY 或 `--json` 模式下直接用法错误（不会误删）。
- `task archive` 把 `status === 'done'` 且**已满** `tasks.archiveAfterDays` 天（默认 **7**；
  `now - updated_at >= N×86400e3`，恰 N 天即归档，边界含端点）的任务改成 `archived`（纯状态
  位，可逆、幂等；语义见 §3.2）；`--older-than N` 覆盖天数（正整数，`0` 不合法），`--dry-run`
  只报告不写。人类输出形如 `已归档 N 个任务（阈值 7 天，早于 <date>）：<ids>`——`<date>` 是
  **含端点**阈值（`updated_at ≤ <date>` 即归档，「早于 <date>」只是输出用语，等价「已满 N
  天」）。`archiveAfterDays` 为 `0` 时提示「任务归档已关闭」并退出 0（`--json` 带
  `closed:true`），但显式 `--older-than N` 仍按 N 归档——`--older-than` **优先于**关闭态；
  0 个候选退出 0；写锁被占用时跳过 + `archive-locked` warning + 退出 0（`--json` 带
  `locked:true`）；未初始化退出 1（同 `task add`）。
- `flow check` 是只读的机械检查入口（不写 store，细节见 §6）；`--timeout <seconds>`
  控制单次检查超时（默认 120），`--allow` 可重复。

### 5.2 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功（`gate run` 门禁失败也算命令成功，用 `data.ok=false` 表达） |
| 1 | 用法错误（未知命令/参数、缺必填参数、未 `flow init`、`rm` 缺 `--yes`） |
| 2 | 校验失败（`invalid`、`conflict`） |
| 3 | 未找到（`not-found`） |
| 4 | IO/环境错误 |

`flow check` 复用同一组数字但语义按检查归一：0 通过 · 1 检查失败 · 2 用法/配置错误 ·
3 脚本或解释器缺失 · 4 启动/IO 失败（含超时），见 §6.2。

补充：`gate run`（单条或 `--phase` 批量）的门禁失败仍是退出 0（用 `data.ok` /
`data.runs[].ok` 表达）；`heartbeat status --require-active` 在没有 active 心跳时退出 1
（用法语义，专门给 `session-open` 门禁当开关）；`runGate` 遇到 disabled 门禁且无
`--force` 时抛 `usage`（退出 1）；`task archive` 的锁冲突是**例外**——跳过本次 + 记
`archive-locked` warning + 退出 **0**（`--json` 带 `locked:true`），不按 `conflict` → 2
处理（见 §3.2/§5.1）。`exp review` **恒退出 0**（只读报告，结论在 `--json` 的
`ok`/`verdict`）；`exp productize` 未过硬门禁 → 2（`invalid`），`exp cleanup` 对 legacy →
2；`check experiments` 判定失败 → 1（与 `check` 家族一致，见 §6.2），`enabled=false` 时
跳过并退出 0。

### 5.3 `flow status`

人类输出：项目名、根目录、契约源 + schema、存储目录、实验/任务/门禁计数与
`待决策 N（阻塞 M）`，随后是心跳汇总（`N（可能已停 M）`）与前 5 条心跳明细（文件名 /
相对时间 / 状态行，超过 5 条提示总数），再往后是最多 3 条 open 决策明细（id / kind /
question / 挂起时长或轮数，升级项带 `⚠`）与最近 3 条实验、最近 3 条任务、最近 3 次门禁运行。
未初始化时提示 `flow init`，退出码仍为 0。`--json` 的 `data` 增加
`decisions: {items, counts:{open,blocking,escalated,answered,withdrawn,superseded,total}}`
（`items` 只放前 3 条 open，与提醒/面板同一排序）。

存在不可读记录时，人类输出的实验/任务/门禁计数追加 ` · +N 无法读取`；
`--json` 的 `counts.{experiments,tasks,gates}` 各带并列 `unreadable`（`total` 不变）。
坏记录本身的 `unreadable:` 诊断走统一的 warnings 通道（见 §5.1）。
实验计数按**六态**报：`open / confirmed / refuted / abandoned / inconclusive / pivoted`
（`experiments.enabled=false` 时计数照常，数据仍在，只是面板不展示实验区）。

归档只改计数分布、不改总数：一个 `done` 任务归档后 `done` 减 1、`archived` 加 1，`total`
不变；`counts.tasks` 一直是全量（含 `archived`）。`recent.tasks` 取全量按 `updated_at`
倒序的前 3 条，因此仍可能列出 `archived` 任务；面板的行数组（active / 最近完成 / draft）
默认不渲染 archived 行。行顺序：`active` 与 `draft` 按 `created_at` **升序**（最老在前，即
FIFO 队列；patch 刷新 `updated_at` 不会改变队列位次），最近完成按 `updated_at` **倒序**
（回顾性质）。

心跳读自**项目主工作区**的 `contract.heartbeats.dir`（默认 `.agents/heartbeat`，worktree
会话也读主工作区；解析/降级规则见 §3.5）下的 `*.json`（只有 `source: 'none'` 关闭）：
拼 `status · last_action`，按 mtime 倒序并按 `heartbeats.max`（默认 20）截断；存活按 §3.5 的
`liveness` 判定（`ageSeconds > 6h` → `stale`「可能已停」；宿主重启或 pid 消失 → `dead`「可
证明已死」；跨机 → `foreign`「只在别处活跃」）。
目录不存在按空集处理，不报错。`agent: "subagent"` 的旧记录不展示
（只提示隐藏条数，`flow heartbeat gc` 可清理）。心跳目录下的 `.md` 不再读取。
**默认可见性（T-13）**：明细只含可见行（`visibility:'active'`，见 §3.5）；`flow status` 的
人类摘要仍按**全量** `counts` 报
`N（可能已停 S · 已结束 D · 旧子会话隐藏 H）`，隐藏行数另见 `hiddenByVisibility`。

`--json` 的 `data` 含 `root/name/initialized/contractSource/schema/store/counts/heartbeats/recent`，
其中 `heartbeats` 为
`{ root, dir, items: [{ file, session, agent, goal, task, claims, status, last_action, started_at, updated_at, ended_at, ageSeconds, stale, turn, stats, mtime, liveness, reason }], counts: { total, active, stale, dead, hidden }, hiddenByVisibility }`
（富形状来自 `readHeartbeatSection`；`readHeartbeats` 仍返回旧的
`{file,title,statusLine,ageSeconds,mtime}` 以免破坏既有调用，同样只读 json）。
`counts` 是**五键**：`active` 只算 live 或「fresh 且非 dead/foreign/stale」；`stale` =
`ageSeconds > 6h`，可与 `dead` 重叠；`dead` 计 `liveness === 'dead'`；**没有 `foreign` 键**
（跨机记录计入 `total`/`stale`，不计 `active`/`dead`）。`hiddenByVisibility` 是**默认可见性**
隐藏掉的行数（`visibility:'active'` 时；`--all`/`visibility:'all'` 为 0，见 §3.5）。

`flow heartbeat list` 用同一份富形状输出表格（session 短名 / agent / status / **存活** / 年龄 /
task / claims / goal；「存活」列是 `live|dead|stale|foreign|unknown` 加 reason）：默认只列
**可见行**，并在末尾打印「已隐藏 N 条（已结束/可能已停，`--all` 查看）」；`--all` 列出全量并
恢复「已结束（dead）/可能已停」清单。`flow status` 的心跳明细同样只含可见行，摘要按全量
`counts` 报（见 §5.3 上文）。

### 5.4 会话工具面（P2 权限面，`config.enforce` 控制）

默认 `enforce: true`；`config.enforce === false` 是回滚开关——`restrict` 与全部 guard 都不注册，
行为回到 P1。权限面只作用于**工具派发**，不改任何 CLI（CLI 仍是人/脚本的入口）。

**隐藏（`tools.restrict`）**：主会话（`rootSessionVerdict === true`）在 `agent/created` 时对该
agent 的 scope 调用 `tools.restrict({deny})`，移除 `spawn_teammate`、`team_task_create|update|
list|get|delete`、`subagent`、`subagent_fork`（宿主没有的名字先过滤，`restrict` 对未知名字会抛；
子代理 scope 不加限制）。`capture:false` 时 `agent/created` 钩子不注册，改由 `agent/pre-step`
对同一会话做一次 per-agent restrict——这样插件挂载前就已存在的会话、以及关闭 capture 的项目
也被覆盖。

**拦截（`tools.guard`）**：`restrict` 只隐藏、不拦截；绕过可见面的 PTC / 子调度仍会走到 guard。
规则（拒绝文案必须让下一步可执行）：

| # | 条件 | 拒绝文案要点 |
|---|---|---|
| 1 | 主会话调用团队工具 | `主会话不得直接调度团队。用 flow_task_update（即 flow_task 的 update 动作）推进阶段，插件会派工。` |
| 2 | 主会话 `flow_task add` | `任务由插件按你的每句话自动创建，不需要也不允许手动建。若要补记一条，说明理由后由插件建。` |
| 3 | `flow_task update` 带 `stage` 且该边不存在 | `<from> 只能到 <nextStages(from)>，你给了 <to>。` |
| 4 | 边存在但 `edge.actor !== 'session'` | `<from> → <to> 由 <actor> 推进，不是你。你只能推进：<该阶段 actor=session 的边>。` |
| 5 | `flow_subtask add/remove` 而父任务不在 `queued-implementation`/`implementing` | `只有实现阶段可以改子任务（当前 <阶段中文>）。` |

规则 3/4 的唯一真源是 `lib/stage.mjs` 的 `edgeOf(from,to)` / `actorForEdge(from,to)` /
`nextStages(from)`——`index.js` 不重写任何阶段判断。规则 1/2 只作用于主会话；3/4/5 对任何会话一致；
子代理不受 1/2 限制（它负责派工与建任务）。同阶段重写（`from === to`）按幂等放行。
`flow_task update` 因此新增 `stage` 通道（`TASK_UPDATE_FIELDS` + 工具 schema 的九值枚举）；
写 `stage` 会派生 `status`（见 §5.1）。`flow_subtask` 目前尚未注册为工具，规则 5 的 guard 已就位，
待该工具落地即生效。

## 6 机械检查（`flow check`）

`flow check` 把 `skills/ai-collaborative-dev-workflow/scripts/` 下的机械检查脚本包成
CLI 入口（SKILL.md 里声明的首选检查入口）。它是**只读**的：不读写 `.dsh/flow`、不碰写锁、
不产生任何 store 写入；`lib/checks.mjs` 也不导入 `lib/core.mjs`。因此可以安全地放进
`flow gate` 步骤或 CI。

脚本路径相对于**包根**解析（`lib/checks.mjs` 在 `<pkg>/lib/`，脚本在
`<pkg>/skills/ai-collaborative-dev-workflow/scripts/`），与 `--root` 指向的项目无关；
解释器固定为 `bash`（`.sh`）与 `python3`（`doc_check.py`）。

**内置例外（三个）**：`flow check decisions` / `flow check experiments` / `flow check tasks`
不来自脚本目录，而由 `bin/flow.mjs` 特判路由到 `core.checkDecisions()` /
`core.checkExperiments()` / `core.normalizeTaskFormat({fix:false})`（只读，
复用 `loadContract`/containment/路径归一）。`lib/checks.mjs`
保持**不 import core、不读写 `.dsh/flow`** 的纪律：内置项由 bin 侧追加，不进
`checks.CHECKS`/`listChecks()`。所以 **`check list` 共七项** = 四项脚本检查
（`staged`/`release-baseline`/`state`/`doc`）+ 三个内置项 `decisions` / `experiments` / `tasks`：

```json
{"name":"decisions","interpreter":"core","script":"lib/core.mjs#checkDecisions",
 "description":"阻塞决策的 affects 命中暂存文件时失败（内置检查：bin 特判路由 core，只读）",
 "args":"（无额外参数）"}
{"name":"experiments","interpreter":"core","script":"lib/core.mjs#checkExperiments",
 "description":"实验分流未闭环（schema2 缺字段/confirmed 未产品化/refuted·pivoted 缺 learned·cleanup）时失败（内置检查，只读）",
 "args":"（无额外参数；experiments.enabled=false 时跳过）"}
{"name":"tasks","interpreter":"core","script":"lib/core.mjs#normalizeTaskFormat",
 "description":"旧任务记录未归一（残留 goal 键 / 缺 type）时失败（内置检查：bin 特判路由 core，只读）",
 "args":"[--type-map <file.json>]"}
```

`interpreter: "core"` 是唯一非 `bash`/`python3` 的合法值，`script` 是包根相对的 POSIX 路径
（`lib/core.mjs#checkDecisions`，不是 `skills/…/scripts/` 下的脚本），`args` 非空；内置项
**永远不会 spawn、不经 `scripts/`**，由 `bin/flow.mjs` 路由到 core（`lib/checks.mjs` 既不加项
也不改 `runCheck`）。

### 6.1 子命令与参数映射

| 子命令 | CLI 用法 | 实际调用 |
|---|---|---|
| `list` | `flow check list [--json]` | 不 spawn，直接打印目录 |
| `staged` | `flow check staged --allow <path> [--allow <path> ...]` | `bash check_staged_files.sh <allow...>` |
| `release-baseline` | `flow check release-baseline --marker <text> [--threshold <N>]` | `bash release_baseline.sh '<marker>' [N]` |
| `state` | `flow check state [--file <path>]` | `bash check_state.sh <file>` |
| `doc` | `flow check doc --file <path> --type task\|design\|incident\|release` | `python3 doc_check.py <file> --type <type> --root <项目根>` |
| `decisions` | `flow check decisions [--json]` | **不 spawn**：bin 特判路由 `core.checkDecisions()`（只读内置项，见 §6.1.1） |
| `experiments` | `flow check experiments [--json]` | **不 spawn**：bin 特判路由 `core.checkExperiments()`（只读内置项，见 §6.1.2） |
| `tasks` | `flow check tasks [--type-map <file.json>] [--json]` | **不 spawn**：bin 特判路由 `core.normalizeTaskFormat({fix:false})`（只读内置项，见 §6.1.3） |

- 所有子命令都吃全局 `--root <dir>`（默认 cwd）与 `--json`。脚本以 `--root` 为 cwd 执行，
  所以脚本里的 `git diff --cached` / `git log` / `git rev-list` 落在项目根。
- `staged` 至少需要一个 `--allow`（可重复）。每个 `--allow` 是一个**相对 git 仓库根**
  的路径前缀，脚本按「等于前缀」或「前缀/…」匹配暂存文件名。包装器会先去掉开头的
  `./` 与结尾的 `/`（脚本只认裸前缀，`--allow src/` 直接透传会匹配不到；这属于等价的
  路径写法，不改语义）。绝对路径不会被规范化：`git diff --cached` 输出的是仓库相对
  路径，`--allow /abs/...` 匹配不到任何文件。
- `release-baseline` 的 `--threshold` 不给时**省略**该位置参数，由脚本用自己的默认阈值（10）。
- `state` 的 `--file` 默认 `COLLAB_STATE.md`（相对 `--root` 的惯例路径）。脚本要求状态文件
  所在的**当前目录在 git 工作树内**（双源校验），否则脚本自身退 1。
- `doc` 的 `--file` 与 `--type` 都必填，`--type` 是 `doc_check.py` 的四个 choices。
  包装器**不**向 `doc_check.py` 传它自己的 `--json`：脚本输出保持原样，JSON 信封由
  `flow --json` 统一给出。`doc_check.py` 的 `--root` 用项目根，供它读取
  `<root>/.agents/gate-config.json` 的 `doc_standard`（默认 `.agents/doc-standard.json`，
  内含 required_sections / max_lines / vague_words）与任务目录配置；注意
  `precision_common.repo_root` 优先读环境变量 `TASK_ROOT`，若设置了它会覆盖 `--root`。
- 每项检查默认超时 **120 秒**，`--timeout <seconds>` 覆盖（正整数）。超时同样终止
  **进程树**：win32 先 `taskkill /PID <pid> /T /F`，再给 2 秒 grace 兜底 resolve 并报
  `check-io`（不会因为孙进程占着管道而挂死）；非 win32 沿用 detached 进程组 SIGKILL。
  `lib/checks.mjs` 的 `killProcessTree` / `superviseCheckChild` 与 core 的同名实现是同一套
  语义的导出测试位（非契约 API，用 `{platform, killImpl, taskkillImpl, graceMs}` 注入）。

### 6.1.1 `check decisions`（决策门禁）

- 语义（唯一规则）：**`status=open` 且 `blocks` 非空（blocking）且 `affects` 命中本次暂存
  改动 → 失败（exit 1）**；其余情况通过（exit 0）。暂存区为空 → 通过。
- 本次改动 = `git diff --cached --name-only --diff-filter=ACMR`（相对仓库根、POSIX 路径）。
  未暂存不拦截是设计行为：门禁只在提交动作上生效。
- 匹配：暂存文件 `f` 命中 `affects` 项 `a` 当 `f === a` 或 `f` 以 `a + "/"` 开头；大小写敏感。
- 退出码沿用 §6.2：0 通过 · 1 阻塞决策命中 · 2 未初始化/用法 · 4 `git` 失败。
- JSON 成功：`{ok:true,data:{check:"decisions",exitCode:0,stdout,stderr,durationMs,open,blocking,failed:[]}}`；
  失败错误对象：`{code:"check-failed",message,check:"decisions",exitCode:1,stdout,stderr,
  open,blocking,failed:[{id,question,blocks,affects,matched}]}`。
- 人类输出：通过 `✓ decisions：open 2 · blocking 0 · 暂存 3 个文件`；失败逐行
  `✗ <id> 阻塞 <T-id>：affects 命中 <path>`，末行提示可复制的 `flow decision answer` 命令。
- 警告：决策目录里的坏记录同样产生 `unreadable:`，走 §5.1 的 warnings 通道（`--json`
  时放在信封顶层，`data`/`error` 形状不变）。

### 6.1.2 `check experiments`（实验门禁）

只读、不写 store、不取锁。`experiments.enabled` 为 `false` 时**直接退出 0 跳过**（不阻断、
CI 保持绿；人类输出「实验功能未开启…跳过」），**不读实验目录**；缺 `enabled` 且目录里已有
实验记录的老项目同样按关闭处理——但该检查不读目录，所以**不**发引导 warning；一次性
`experiments-disabled-legacy` 由**面板读路径**发出（见 §2/§9.1.3，`state-snapshot.mjs`）。
开启时逐条检查 `schema: 2` 记录（`schema: 1` 历史记录跳过、只计入 `legacy` 计数）。

失败（退出 1，`--json` 给 `failed[]`，每项 `{id, rule, message}`）：
1. 七个规范字段任一缺失/为空（`direction`/`expected`/`primaryMetric`/`guardrails`/
   `falsify`/`windowDays`/`stopLoss`）；
2. `status === 'refuted'` 且（`learned` 为空 或 `cleanupAt` 为空）；
3. `status === 'pivoted'` 且（`learned` 为空 或 没有任何实验的 `parent` 指向它）；
4. `status === 'confirmed'` 且 `productizedAt` 为空（release 阶段不允许「已确认未产品化」）。

warning（不影响退出码，`--json` 给 `warnings[]`）：`status === 'open'` 且
`now > created_at + windowDays×86400e3` → `experiment-window-elapsed`（**不自动判失败**，
结果由人判定）；`inconclusive`/`abandoned` 缺 `learned`；`task.experiment` 指向不存在实验
（`task-experiment-missing`）。退出码沿用 §6.2：0 通过 · 1 检查失败 · 2 用法/配置错误 ·
4 IO。

### 6.1.3 `check tasks`（任务格式门禁）

只读、不写 store、不取锁（`normalizeTaskFormat({fix:false})`）。检查的是**旧任务记录的
结构**，不是业务规则；旧的两种形态各成一类 issue（形状见 §3.2「旧格式迁移」）：

1. `legacy-goal`：记录仍带 `goal` 键（`goal` 已并入 `title`）；suggestion 给出合并后的
   title 或「只删键」。
2. `missing-type`：记录缺 `type`（键不存在或 `null`/`''`）。**门禁永不替你猜 type**：
   没给 `--type-map` 时 suggestion 是「supply type…」；给了合法 map 时变成
   `type = "<mapped>"`，但**该 issue 仍然计数**——`check` 只读，盘上缺 `type` 只能由
   `flow task normalize`（§5.1）写盘消除。因此本检查带 map 时也可能红，这是设计而不是缺陷。

- `--type-map <file.json>`：`{ "<T-id>": "<type>" }`，值是 §3.2 的十个枚举之一。文件在
  `--root` 下解析（相对路径以项目根为基准）。**任何坏形态都是用法错误（exit 2 / `usage`）**：
  路径不存在、非法 JSON、顶层不是对象/是数组、值为非字符串或不属十个枚举、空串路径。
  把配置错误报成 `check-failed` 会让「台账脏」和「map 写错」混在一起，故分开。
- `--type-map` 的两条 **advisory warning**（不影响退出码，走 §5.1 的 warnings 通道）：
  `type-map-unknown-id: <id>`（map 里的 id 台账里没有）与
  `type-map-unused: <id> 已有 type "<当前>"`（该记录已有 type 且与 map 不同——迁移永远不
  改写已有 type，见 §3.2 规则 3）。之所以只 warn 不报错：AI 产出的候选清单允许宽于实际需要。
- 退出码：无 issue → 0；有 issue → 1（`error.code = "check-failed"`）；map 坏 / 未初始化 → 2；
  沿用 §6.2。`--json` 成功：
  `{ok:true,data:{check:"tasks",exitCode:0,stdout,stderr,durationMs,ok:true,counts:{...},issues:[],typeMap}}`；
  失败错误对象同形但 `ok:false`、`issues[]` 非空，每项
  `{id,kind,title,goal,suggestion}`；`counts` 是 `{"legacy-goal":N,"missing-type":M}`；
  `typeMap` 是 map 路径或 `null`。
- 人类输出：通过 `✓ tasks：legacy-goal 0 · missing-type 0`；失败逐行 `✗ <id> [<kind>] <suggestion>`，
  末行 `合计 N 条：legacy-goal X · missing-type Y` 加一条可复制提示（缺 type 时指向
  `flow task normalize --type-map <file.json>`；只差 goal 时指向 `flow task normalize`）。
  带 map 但盘上仍缺 type 时额外提示「map 已校验但不写盘」。
- 本检查**不提供 `--fix`**：`check` 家族只读（§6 开头、§6.1 开头）；写盘归 `flow task normalize`。
  不留「基线计数」之类的豁免参数——豁免等于把欠账变成长期合法状态。

### 6.2 退出码

| 退出码 | 含义 | JSON `error.code` |
|---|---|---|
| 0 | 检查通过（脚本退 0） | —（`ok:true`） |
| 1 | 检查报告失败（脚本退 1；其他非 0/2 退出码也按失败处理，原样记在 `exitCode`） | `check-failed` |
| 2 | 用法/配置错误：CLI 解析器（缺 `--allow`/`--marker`/`--type`、非法值）或脚本自身退 2 | `usage` |
| 3 | 找不到脚本或解释器（脚本文件缺失、`bash`/`python3` 不在 PATH） | `check-missing` |
| 4 | 启动/IO 失败：spawn 报错、被信号终止、超过 `--timeout` | `check-io` |

数字与 §5.2 的全局词汇一致，但 `check` 的 1 表示「检查未通过」而不是「用法错误」。
纯文本模式把子进程 stdout/stderr **原样转发**（脚本诊断已给出时不再补一条错误行），
然后按映射后的退出码退出；`check-missing` / `check-io` 这类脚本没来得及输出原因的
情况会补一行 `错误（…）`。

### 6.3 JSON 形状

成功：

```json
{"ok":true,"data":{"check":"staged","exitCode":0,"stdout":"…","stderr":"","durationMs":9},"warnings":[]}
```

失败：

```json
{"ok":false,"error":{"code":"check-failed","message":"检查未通过：staged（exit 1）",
 "check":"staged","exitCode":1,"stdout":"","stderr":"[FAIL] 暂存区包含归属外文件：…"},"warnings":[]}
```

`check <script>` 走 `lib/checks.mjs` 的 spawn、不碰 core → `warnings` 自然为空；
`check decisions` 走 core → 契约/不可读记录诊断会出现在顶层 `warnings`。

`check list --json` 返回 `{"ok":true,"data":{"checks":[{name,interpreter,script,description,args}]}}`，
`script` 是相对包根的 POSIX 路径；内置项 `decisions` 例外——它的 `script` 是
`lib/core.mjs#checkDecisions`（`#` 后是函数名，不是独立脚本文件），`interpreter` 为
`core`，`args` 为「（无额外参数）」。

**输出上限**：`stdout` 与 `stderr` 各自只保留最后 **8 KiB**（`lib/checks.mjs` 的
`MAX_CAPTURE_BYTES`）；超长输出截头保尾，并按 UTF-8 字符边界去掉开头残缺字符。
纯文本模式不受这个限制（边收边转发），8 KiB 只约束 JSON 捕获与失败诊断。

### 6.4 与门禁的关系

`check` 只读，可以直接作为 `flow gate` 的步骤（`expect` 按 `flow check` 的退出码写）：

```bash
flow gate add --id precommit --title 提交前检查 --phase commit \
  --step 'staged=node bin/flow.mjs check staged --allow src>>exit 0'
```

`gate run` 只记录步骤退出码与输出尾部；`flow check` 自身不写任何 store，门禁失败不会
污染台账。

#### 6.4.1 门禁的覆盖层次（哪层测什么，别把层次当缺陷）

仓库有**三层**验证，覆盖的对象不同；**任何一层单独绿都不代表整体绿**：

| 层 | 命令 | 测什么 | 不测什么 |
|---|---|---|---|
| 单元/契约 | `node --test test/` | 记录格式、CLI 退出码、core API、文本契约（CONTRACT/README 的数字与清单）、模块边界不变量 | 宿主事件派发、子进程 worker 的跨进程行为 |
| 宿主自测 | `.selftest/host2-tools.mjs` 等 6 个 | 插件在**模拟宿主**上的挂载、工具 schema、技能注册、面板端点、心跳门禁 | 纯函数级细节（如 `isPlainObject` 对数组的判定） |
| 客户端自测 | `.selftest/client-render.mjs` 等 | 浏览器 bundle 的渲染、注册、轮询、对比度 | 宿主侧逻辑 |

两个**实测事实**，写下来避免后来者误判：

- 有些纯函数只被 `node --test` 覆盖、**六个 selftest 全都不红**（例：把
  `lib/util.mjs` 的 `isPlainObject` 去掉 `!Array.isArray(value)`，`node --test` 有 2 条红，
  selftest 全部仍 exit 0）。**这是层次事实，不是缺陷**——selftest 测的是宿主集成面，
  不该为纯函数补覆盖。反过来说：**只跑 selftest 就说"门禁绿了"是错的**。
- `precommit` 门禁的 `tests` 步跑的是 `node --test test/`，**不跑 selftest**（selftest 需要
  模拟宿主，耗时且不属于"提交前必须过"的范畴）。所以提交前的绿只代表第一层绿。

## 7 core API（Host 工具与 CLI 共用）

`lib/core.mjs` 导出：

```js
SCHEMA_VERSION                       // 2
HEARTBEAT_SCHEMA                     // 1（心跳文件 schema，独立于 store）
HEARTBEAT_STALE_SECONDS              // 6 * 60 * 60
class FlowError extends Error        // code: invalid|not-found|conflict|io|usage

loadContract(root)                   // {contract, source, warnings}
saveContract(root, contract)         // 原子写，schema 强制 2
initProject(root, {name?, force?, noGates?})
                                     // {root, created[], warnings[], seededGates[]}
storePaths(root, contract)           // {store, experiments, tasks, gates, logs}（绝对路径，恒在根内）
containedPath(root, value, label, {allowAbsolute?})
                                     // manifest 路径 containment：根内绝对路径，
                                     // 不安全时记 warning 并返回 undefined（仅 store.root 可 allowAbsolute）
drainWarnings()                      // 取走并清空全局诊断 warning（非契约 API）
withLock(root, contract, fn)         // 在 store 写锁内同步执行 fn(paths)（非契约 API，测试用；
                                     // fn 必须同步，锁不是可重入互斥量）
releaseTakeoverClaim(claimPath, token)
                                     // 只释放自己的 takeover claim（token+pid 匹配），
                                     // 不匹配记 warning 并保留（非契约 API，测试用）
renameWithRetrySync(from, to, {renameImpl?, sleepImpl?, delays?})
                                     // rename 退避重试（EPERM/EBUSY/EACCES，10/50/150ms，
                                     // 共 4 次），最终抛 FlowError('io')（非契约 API，仅供测试注入）
writeJsonAtomic(file, data, {renameImpl?, sleepImpl?, delays?})
                                     // 原子写；retryOptions 只透传给 renameWithRetrySync，
                                     // 供测试在真实目录上制造瞬时/耗尽失败（非契约 API）
killProcessTree(child, {platform?, killImpl?, taskkillImpl?})
                                     // 杀子进程树：POSIX 进程组 SIGKILL，win32 taskkill /T /F
                                     // （非契约 API，仅供测试注入）
runStep(root, step, timeoutMs, tailLines, {platform?, spawnImpl?, killImpl?, taskkillImpl?, graceMs?})
                                     // 执行一个门禁步骤；注入位为覆盖 win32 分支（非契约 API）

listExperiments / getExperiment / addExperiment / updateExperiment / removeExperiment
                                     // add/update 只写 schema2；legacy（schema!==2）读写规则见 §3.1
experimentTree(records)              // 由记录数组组装 parent 谱系（未知 parent/成环按根）
reviewExperimentRecord(record,{hasSuccessor})  // core 单一导出：bin/index 只调用，规则与 checkExperiments 同源
                                     // {verdict,branch,missing[]}，恒 exit 0（见 §5.1）
productizeExperiment(root, contract, id, {gateId?='release', now?})
                                     // 要求 confirmed + release 最近 ok 的 finished_at
                                     // ≥ 实验 updated_at；幂等（already:true）
                                     // {id, productizedAt, productizeGate, already}
cleanupExperiment(root, contract, id, {flags?, code?, data?, now?})
                                     // 写 cleanup{flags,code,data}（各 ≤20）+ cleanupAt
                                     // {id, cleanup, cleanupAt, changed}；legacy → invalid
checkExperiments(root, contract, {now?})
                                     // {ok, checked, legacy, failed[], warnings[]}
                                     // enabled=false → {ok:true, checked:0}（不读目录）
listTasks       / getTask       / addTask       / updateTask       / removeTask
normalizeTaskFormat(root, contract, {fix?=false, typeById?={}})
                                     // 旧格式迁移的唯一通道（非契约 API：不进 CLI flag、
                                     // 不进 flow_task 参数表）：{ok, issues[], fixed[]}
                                     // fix:false 只读零写盘（不取锁）；fix:true 锁内迁移：
                                     // goal 非空且 title 非空 → title = "<title> — <goal>"，
                                     // 否则只删 goal 键；type 仅在缺失时按 typeById 补齐
                                     // （10 枚举之一）。幂等；不刷新 updated_at。见 §3.2
listGates       / getGate       / addGate       / updateGate       / removeGate
                                     // list* 第三个可选参数 {unreadable?: string[]}
                                     // 收走不可读文件的绝对路径，供调用方计数
archiveTasks(root, contract, {days?, now?, dryRun?})
                                     // {archived:[id], candidates, days, cutoff, dryRun, locked}
                                     // 只把已 done 且已满 days 天
                                     // （now - updated_at >= days*86400e3，边界含端点）的
                                     // 任务改成 archived；days 缺省取
                                     // contract.tasks.archiveAfterDays（默认 7）；
                                     // 幂等，0 候选/归档关闭直接返回（见 §3.2）

runGate(root, contract, id, {timeoutMs?, tailLines?, force?})
                                     // async；disabled 且无 force → usage
runGatesByPhase(root, contract, phase, {timeoutMs?, tailLines?, force?})
                                     // async；{phase, runs[], skipped[{id,reason}]}
listGateRuns(root, contract, gateId, limit = 5)        // 新→旧

// 心跳（写入口；读写都在 core，CLI 只解析参数）
startHeartbeat(root, contract, {session?, agent?, goal?, task?, claims?,
                                turn?, last_action?, createTask?})
                                     // 心跳记录 + createdTask（新建任务 id 或 null）
updateHeartbeat(root, contract, session, patch)
                                     // 只允许 status/last_action/goal/task/claims/turn
endHeartbeat(root, contract, {session?, status?='done', note?})
heartbeatStatus(root, contract, session, {live?})
                                     // {active, liveness, reason, ageSeconds, record|null}
                                     // live:true = 宿主的正向证据（agents 命中该会话）→ live/agent-live
readHeartbeats(root, contract)             // 旧形状 [{file,title,statusLine,ageSeconds,mtime}]，只读 json
readHeartbeatSection(root, contract, {pathMemo?})
                                     // 富形状 {root, dir, items[], counts{total,active,stale,dead,hidden}}；
                                     // item 带 liveness/reason；无 foreign 计数键（见 §3.5）
resolveHeartbeatWorkspace(root)            // {root, degraded, reason}：心跳根=项目主工作区
gcLegacyHeartbeats(root, contract, {dryRun?})  // {root, dir, removed[], kept, dryRun}

// 决策（记录族；同锁/原子写；指纹去重与终态规则见 §3.6）
listDecisions(root, contract, {all?, session?, turn?, now?})   // 数组；默认只 open
getDecision(root, contract, id)
addDecision(root, contract, input)          // {decision, created}（created:false = 复用 open）
answerDecision(root, contract, id, {choice, note?, by?})
withdrawDecision(root, contract, id, {reason, by?})
gcDecisions(root, contract, {days?, dryRun?, now?})            // {removed[], kept, dryRun}
summarizeDecisions(root, contract, {limit?, session?, turn?, now?})
                                            // {items, counts:{open,blocking,escalated,
                                            //  answered,withdrawn,superseded,total}}
checkDecisions(root, contract, {staged?})   // {open, blocking, staged[], failed[]}
DECISION_SCHEMA / DECISION_STATUS / DECISION_KINDS
DECISION_ESCALATE_TURNS / DECISION_ESCALATE_HOURS
DECISION_GC_DAYS / DECISION_REMIND_MAX

experimentTree(records)              // [{...record, children:[...]}]，环安全
readStoreState(root, contract)       // 面板聚合：experiments{items,counts,source}
                                     // tasks{items,counts,current,source}
                                     // gates{items(含 lastRun),counts}
                                     // heartbeats（= readHeartbeatSection）
                                     // decisions{items,counts}
                                     // counts.{experiments,tasks,gates}.unreadable：不可读文件数
```

`readStoreState().decisions` **逐字等于** `summarizeDecisions(root, contract,
{limit: DECISION_REMIND_MAX})`（两条读路径必须同形）：`items` 只含 `open`，按「升级优先 →
`asked_at` 旧的在前 → id」排序后截断到 `DECISION_REMIND_MAX`（3）条；`counts` 恰好 7 键
`{open,blocking,escalated,answered,withdrawn,superseded,total}`。该投影不带 session/turn，
所以 item 上的 `turnAge` 恒为 `null`，`escalated` 只由 `asked_at` 的 **24 小时**规则命中。
无决策记录（含 `decisions/` 目录不存在）→ `items: []`、`counts` 全 0（键必须在）。

`created` 是根相对 POSIX 路径数组；`seededGates` 是本次种入的默认门禁 id 数组
（空数组表示已有门禁或 `noGates`），种子不写入 `created`。`get*` 未找到抛 `not-found`；
`add*`/`update*`/`remove*` 与三个心跳写入口在未初始化时抛 `usage`
（`initProject` 与心跳读操作除外）。

心跳写入口与读入口都先把 root 解析到**项目主工作区**（`resolveHeartbeatWorkspace`），因此
linked worktree 里的会话读写同一份心跳；解析降级时记 `heartbeat-root-degraded` warning。
心跳写入口的 session 缺省取 `DSH_SESSION_ID`；`startHeartbeat` 在无任务且
`createTask !== false` 时新建 draft 任务（`title` 取 goal，缺省「未命名任务」，
`scope.allow` 取 claims），并把新 id 写回心跳的 `task`。返回值比落盘记录多一个
`createdTask`（新任务 id 或 `null`），不写入文件。

## 8 与 git 的关系

- `.dsh/flow/` 是**真相源**，可以也建议提交进项目仓库；它不再是“git trailer 的投影”。
- git 仍是历史与发布单位：实验记录的 `commits` 字段回填短 sha。
- 写锁 `.lock` 与原子写/接管的中间产物（`*.tmp-*`、`.lock.takeover-*`）都是临时文件，
  不应提交（建议 `.gitignore` 加 `.dsh/flow/.lock`、`*.tmp-*`、`.dsh/flow/.lock.takeover-*`）。
- 面板只读 store，不跑 git、不写文件（唯一例外：「初始化」按钮 POST `/api/project-flow/init`，
  由 core 校验并原子写，以及门禁开关 POST `/api/project-flow/gate`）；不要用脚本直接编辑
  JSON 绕过 core 的校验与锁。

## 9 面板 HTTP 表面

### 9.1 三个端点

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/project-flow/state?root=<dir>` | 只读投影：实验树、任务、门禁、心跳、决策 |
| POST | `/api/project-flow/init` | 初始化台账（`{root}`），走 core |
| POST | `/api/project-flow/gate` | 门禁开关（`{root, id, enabled}`），走 core |

`root` 缺省取宿主 cwd；它必须是已注册工作区、其子目录，或自带 `.dsh/flow` store 的目录。
没有 store 的工作区返回 `not-initialized` 空态（`ok:false`），不读取其它项目，也不再有
旧布局读法、运行输出扫描或 Agent Teams 投影。读路径的设施失败（期限、读子进程崩溃/不可用）
同样是 **HTTP 200 + `ok:false` + 稳定错误码**，不返回半成品或旧数据（见 §9.1.1）。
`heartbeats` 节由读子进程取**全量行**（`lib/state-snapshot.mjs` 调
`readHeartbeatSection(…, {visibility:'all'})`），再由**宿主侧**做最终可见性过滤；payload 里
`heartbeats` 是**行数组**（item = CLI section item + `title`/`statusLine`，**没有**
`counts`/`root`/`dir`），另带 `heartbeatsHidden`（被隐藏行数）。顺序固定为「全量行 →
agents 正向证据 → 宿主过滤」：`applyAgentLiveness` 先按宿主 `agents` 服务把 live 会话标成
`liveness:'live'`/`reason:'agent-live'`（`dead` 行不被覆盖），`applyHeartbeatVisibility` 再只留
`live`，或 `unknown`/`foreign` 且 `ageSeconds ≤ 6h` 的行——**agents 点亮 stale 行的能力只在
宿主侧保留**，读子进程不做最终过滤（否则 stale 行在标注前就消失）。因此面板/TUI 默认不渲染
`dead`/`stale`/超龄行。**TUI 同时用宿主给的行与 `heartbeatsHidden`**：对旧 payload（含
`liveness` 但未过滤）自行按同一判据隐藏，并与 `heartbeatsHidden` **合并计数**（宿主已过滤
时可见行里无隐藏行，计数即宿主值）；头部「活跃 N · 已结束 D / 共 M」的 **M 含隐藏行**，区段
末「+N 条已隐藏（--all 见 CLI）」。没有 `liveness` 字段的旧 payload 按旧行为展示全部行。
`counts` 由面板读端从可见行自派生
（`total`/`active`/`stale`/`dead`，**无 hidden**）；只有 CLI 的 `readHeartbeatSection` 才返回带
`counts` 与 `hiddenByVisibility` 的富形状（见 §5.3/§3.5）。两者是不同实例：面板行不读 CLI
进程的 warning 缓冲，也不写心跳文件。

#### 9.1.1 state 的根解析与文件系统纪律

- **只规范化请求的 root**：`GET state` 每次请求只对 `?root=`（缺省为宿主 cwd）做
  `realpath`/`stat`。注册表里的其它工作区行**不得**触发任何 `stat`/`realpath`/`readFile`——
  它们可能位于失联挂载（例如 Steam 盘没插时的 `/mnt/g/...`），同步 `realpath` 一次可阻塞
  3 秒以上，而面板每 2.5s 轮询一次，会直接让整个宿主事件循环卡死。
- **包含关系用纯路径比较**：工作区行只做 `resolve`（折叠 `..`、`.`、尾斜杠）后按路径
  分隔符做前缀比较，判断「root 是否在该注册工作区内」，不落地文件系统。因此注册行
  即使指向不存在/不可访问的目录也不影响本请求的耗时；代价是**不解析符号链接**——注册行
  若是 symlink，请求端 `realpath` 后的 root 可能不再与它前缀匹配（调用方应注册真实路径）。
- **请求路径上的 fs 必须异步**：`index.js` 在 HTTP/TUI 读路径的**主线程**侧只使用
  `node:fs/promises`（根解析、`stat`；工作区行连这些都不调用），`sendJson`/`sendError`、
  方法/Origin 校验与错误码（`bad-root`/`unknown-root`/`no-project`/`not-initialized`）
  保持不变。原因同上：同步 `realpath` 会阻塞宿主事件循环；异步版本最坏只让**本请求**变慢。
  快照组装里的同步 store 读取不在主线程执行（见「读隔离」）。
- **一次请求只枚举一次注册表**：`handleState()` 只枚举一次 `workspaceRegistry.list()`，行集
  **只留在主线程**用于「root 是否被接受」与展示名——IPC 请求只带
  `{root, realRoot, entry, hostWarnings, now}`，**不传行集**；读子进程不持有 registry、也不会
  二次枚举。`panelStateReader(ctx)`（TUI 读路径）同样只取一次。`lib/core.mjs` 的 store 读取
  仍是同步实现（CLI/工具共用），因此请求的 root 必须先通过异步 `stat` 判定为存在目录，才会
  把快照请求发进子进程。
- **同步 fs 只留在读子进程与被请求 root 内部**：主线程请求路径上不再出现针对注册表行或
  root 发现的 `realpathSync`/`statSync`/`readFileSync`；同步调用只在两处——读子进程内的
  快照组装（`containedPath()` 的 containment 校验 + core 的 store 读取），以及写路径对被
  异步 `stat` 确认存在的那个 root 的校验。新增读路径代码默认只准用 `node:fs/promises`，
  引入同步 fs 必须在评审里给出理由。
  同一请求内同一路径的同步 `realpath` 至多 1 次：读子进程为本次请求**自建** memo
  （`pathMemo`），主线程只把 `canonicalRoot()` 已算出的 `realRoot` 随 IPC 请求传进去——
  memo 与 fs `Error.code` 都无法结构化克隆，所以绝不跨进程传递；memo 随请求与子进程回收，
  禁止进程级缓存（挂载状态会变）；CLI/工具与写路径不传 memo，保持逐次 realpath 的旧行为。
- **验收值（失联挂载、假死 root、假死回收）**：注册表里存在一个不可访问的工作区行（例如
  未挂载的 `/mnt/g/...` automount）时，单次 `GET state` 的响应**< 100 ms**；正常 root 预热
  后仍**< 100 ms**；假死 root（真实存在但 `realpath`/`stat` 或 store 读被永久阻塞——tasks
  下的 FIFO、root 挂死等）**≤ 2 s**
  返回 `state-timeout`，期间事件循环 `max` 延迟**< 50 ms**（其它端点不被拖慢），超时后读
  子进程**≤ 300 ms** 消失且无悬挂 Promise；假死与正常 root 并发时，正常请求**≤ 500 ms**、
  两者 `payload.root` 各自正确。注册表投影本身取不到行时按空列表处理（随后只接受自带
  store 的 root），不因此报错。这些上限由 `test/t-20261104-01-state.test.mjs`（<100 ms /
  并发 <50 ms）与 `test/t-20261104-05-state-worker.test.mjs`（期限、回收、事件循环、
  并发）守着。
- **请求期限与返回形状**：读路径有硬期限 **1800 ms**（`STATE_DEADLINE_MS`）：到点返回 HTTP
  **200** + `{ok:false, error:{code:'state-timeout', message}}`，**不返回半成品、不返回旧
  payload**。另两个设施错误码：`state-worker-crashed`（读子进程异常退出或 IPC 发送失败；
  下一次请求自动重建子进程）与 `state-worker-unavailable`（无法 fork、启动期未 ready、池已
  dispose，或读子进程已达 `STATE_MAX_CHILDREN=8`——**突发饱和拒绝不排队**：冷池同一 tick 的并发
  请求各自 fork 并持有一个子进程（`acquire()` 直接建，不受 keep-warm 的 1 个空闲备用限制），
  超过 8 的那一路返回本错误码并提示 `retry`；下一次请求重试即自愈；
  `init`/`gate` 等写端点不受影响）。三者都是 `ok:false`，与
  `bad-root`/`unknown-root`/`no-project`/`not-initialized` 并列，HTTP 状态码语义不变
  （读路径仍是 200；`bad-root`/`unknown-root` 仍是 400）。
- **读隔离：fork + SIGKILL**：只读快照在 `child_process.fork` 出的读子进程里组装（**不用**
  `worker_threads`：`terminate()` 对阻塞在 fs syscall 的线程无效，FIFO 场景实测 >3 s 仍未
  回收；fork + `SIGKILL` 约 3 ms 回收）。主线程只做异步根解析、注册表枚举、IPC 与期限；
  子进程只读：只调用 core 的只读聚合与投影辅助，不调用写 API、不 import 宿主 `index.js`；
  stdio 全 `ignore`（只剩 IPC 通道），请求与回复都是 JSON；`cwd` 固定为**包根**，
  `execArgv: []`（不继承宿主的 node 参数），env 走 `stateWorkerEnv()` **白名单**（只透传
  `PATH`/`HOME`/`TMPDIR`/`LANG`/`TZ` 等运行必需项 + `PF_STATE_WORKER=1`，不继承其它环境
  变量与凭据）；两个 test-only 接缝都要配 `_ALLOW=1` 才生效：`PF_STATE_WORKER_SCRIPT` 须设
  `PF_STATE_WORKER_SCRIPT_ALLOW=1`（生产不设即不可指向别的脚本），`PF_STATE_MAX_CHILDREN`
  （池上限覆盖）须设 `PF_STATE_MAX_CHILDREN_ALLOW=1`。写路径（`init`/`gate`）仍在
  主线程、仍在 `withLock` 内完成，读路径不取锁。
- **stale 呈现归读端**：宿主不缓存、不重放上一份 payload——`ok:false` 就是「这次没读到」。
  是否降级为陈旧展示由读端决定：web 面板保留最后一份 good payload、只更新
  `errorInfo{code,message,at}` 并渲染 `stale.text` 陈旧条（附错误码 chip）；TUI 面板保留
  上一份 payload、在元信息后插一行 `数据过期：<message>（上次成功 <time>）`。两边都**只在
  没有 good payload（首读失败）时**才显示错误卡；`not-initialized`/`no-project` 的**首读**
  按空态处理（web 给初始化入口、TUI 显示未初始化提示），不算读失败。
- **已知边界（无 worker 池的宿主）**：没有读子进程池的入口——裸测试替身，或 TUI 那一行
  （`tui-host.js` 是独立的 apply 行，拿不到 host 侧的池）——快照在主线程 in-process 组装、
  **没有 1800 ms 期限**；这与搬迁前一致，不是回退。web 端点（host 的 `apply` 里创建池）
  始终有期限。

#### 9.1.2 面板轮询：单飞，按 settle 排期

web 面板对 `GET state` 的轮询是一条**单飞链**：任一时刻至多一个在途请求，下一次的计时从
上次**落定**（settle：成功或失败）开始，不是固定墙钟间隔。

- **首拉立即**：面板挂载、工作区切换、手动刷新都立刻发一次请求，不等 2500 ms；工作区尚未
  确定时完全不起链（也就没有空请求）。
- **每次 settle 后 2500 ms 再排**：下一次抓取排在上一次的 settle 时刻之后 2500 ms。因此
  慢于 2500 ms 的响应**不会被后继请求取消**——不存在「固定 tick 追上新请求、abort 旧请求」
  的路径。
- **abort 只属于 teardown**：只有卸载、工作区切换、手动刷新重启才 abort 在途请求；慢响应、
  超时、标签页切到后台都不 abort。teardown 后这条链不再排期、不再写状态。
- **`document.hidden` 不发请求但保链**：隐藏时跳过一次抓取、照常重排下一次，链不中断；
  回到可见时立即补拉一次，若此刻已有在途请求则记下意愿、在它 settle 后立刻补拉（仍不并发）。
- **失败保留最后 good snapshot**：抓取失败（网络错误，或宿主返回 `ok:false`——含
  `state-timeout`/`state-worker-crashed`/`state-worker-unavailable`）只记
  `errorInfo{code, message, at}` 并显示陈旧标记；`data` 仍是上一次成功的 payload，不清空、
  不退回空态。连续失败不堆叠提示；恢复成功后陈旧标记消失。
- **TUI 与 web 同一契约**：同一份 payload 形状、同一 stale 语义、同一错误码透出；差异只在
  传输——web 走 `GET state`（上述单飞链 + 2500 ms 排期），TUI 由 `refreshMs` tick 驱动、
  进程内调用 `panelStateReader(ctx)`（TUI 是独立的 `tui-host.js` apply 行，没有宿主那侧的
  读子进程池，所以快照 in-process 组装、同样没有 1800 ms 期限，见 §9.1.1「已知边界」）。
  TUI 不 abort 在途读：每次 tick 起的读由 effect 清理标记 `cancelled`，只有最新一次的结果
  会落到面板，旧结果丢弃、不并发写状态。
- **`cwd` 变化清空 last-good**：TUI 的工作目录（`host.snapshot().cwd`）一变，上一份 payload、
  stale 状态与「已有 good」标记立即清空、回到 loading 再读——禁止把 A 项目的陈旧数据标注
  后挂在 B 项目下。web 侧等价于工作区切换即重启整条链（abort + 清空 + 立即首拉）。
- 整条链只发 `GET state`，不发写请求；写操作只有用户点击触发的 init/gate 两个 POST。

#### 9.1.3 实验节（`GET state` 的 `experiments`）

- **关闭（默认，`experiments.enabled: false`）**：`data.experiments` 只保留
  `{ enabled: false, total, counts }`——`counts` 是 **8 键**：`total` + 六态
  （`open`/`confirmed`/`refuted`/`abandoned`/`inconclusive`/`pivoted`）另带 `unreadable`
  （坏记录诊断计数），都是真实计数；`total` 是记录条数；**没有** `source`/`items`/`tree`/
  `groups`。web 面板不渲染实验区、
  任务区**单列**占满；TUI 面板同样不显示「实验 N」与实验区段。宿主仍照常读实验目录以给出
  真实计数（不改写、不隐藏数据），旧项目缺 `enabled` 时另有一次性
  `experiments-disabled-legacy` warning（见 §2）。
- **开启（`enabled: true`）**：`data.experiments` 恢复完整节——
  `{ enabled: true, source: 'store', total, counts, items, tree, groups: [] }`；web 面板恢复
  两列、实验卡在左列首位，**实验树默认折叠**（展开状态只留在浏览器会话，不回写 store）；
  TUI 恢复实验区计数。
- `counts` 两种模式都是**同一 8 键**（`total` + 六态 + `unreadable`），面板对多余/缺失键
  容忍、按空节兜底（与 §9.4 决策节同一纪律）；`items` 截断与 `tree` 组装沿用 §9.1.1 的
  一次枚举/投影纪律。面板仍**只读**：开关只改 `flow.json`，没有开关 POST，实验写操作只走
  CLI / `flow_exp`。

#### 9.1.4 面板任务区：行形状、视觉树与趋势

- **行形状**：`tasks.active` / `tasks.draft` / `tasks.recentDone` 的行是**固定键序**的 13 键
  `id, type, title, status, owner, notes, scope, acceptance, commits, created_at, updated_at,
  parent, depth`（`recentDone` 行尾再追加 `gate`）——**顺序即契约**，`panelTaskRow`、
  `.selftest/host2-tools.mjs` 与本节三处逐字一致。行里**没有 `goal`**（§3.2：已合并进
  `title`）。`type` 取记录字段的裁剪值：缺失或非字符串一律投影为 `''`（行内字段全是字符串），
  客户端据此**降级为只显示 `title`**——不加 `': '` 前缀、不显示占位符；有 `type` 时首行渲染
  `type: title`（`: ` 硬编码，不走 i18n），第二行是 `notes`（为空则整行不渲染），弱化的右对齐
  署名是业务 `id`。`parent: string|null`（父任务 id；父失效/成环时读投影为 `null`）与
  `depth: 0..3`（相对根的深度，超过 3 截断）是 T-13 A3 起的树字段；数组仍按各自既有顺序
  （active/draft FIFO、`recentDone` 按 `updated_at` 倒序）——树只由行上的 `parent`/`depth`
  表达，**不改数组顺序、不新增 `children` 数组**，前端据此嵌套渲染。
- **视觉树（a11y 口径）**：任务树是**视觉树**，**没有**采用严格的 `role="tree"`/`role="treeitem"`
  ——行是 `<li>`，按 `aria-level` = `min(depth,3)+1`（1..4）标注层级，配 12px/级缩进
  （`calc(var(--d) * 12px)`）与左侧连接线；行头是 `role="button"`（`aria-expanded` 控制详情）。
  有子行的父行另有一个**独立** caret `<button>`（`aria-expanded`/`aria-controls` 指向
  `role="group"` 的子 `<ul>`），点击 caret 不冒泡开详情。严格 tree 语义属于后续增强，
  需要时另立卡。
- **趋势图**：`tasks.trend` = `{from,to,days,estimatedFrom,created[],done[],archived[]}`
  （`state-snapshot.mjs` 的 `deriveTrend` 按本地日分桶；默认 **14 天**、上限 **60 天**）。
  面板画**双折线**（`created` 用品牌色、`done` 用成功色，图例两个色点）：两条线**共享同一
  峰值刻度**（按单线峰值、不是当日合计），0 值落在基线；每天一根透明热区 `<rect>` 内嵌
  `<title>`，给出该日 `created`/`done`/`archived` 三项数字——`archived` **不画第三条线**，
  只在摘要与 tooltip 保留。`estimatedFrom` 当天起（含）的线段改为**虚线**
  （`stroke-dasharray`、opacity 0.6），分界点画标记点，摘要前缀 `≈`；`estimatedFrom` 为
  `null` 时全实线。空窗显示「暂无趋势」不画 svg；旧 payload 没有 `tasks.trend` 时整块隐藏。
  图是 `role="img"` + `aria-label`（「近 N 天任务趋势」）。
- **显示开关（A5）**：趋势块可被「显示设置」的**趋势开关**关闭（`display.showTrend`，按
  workspace 持久化在本地 UI 设置 `project-flow.display:<root>`，**不写 `flow.json`**）；
  同理心跳区段受 `display.showHeartbeats` 控制、实验卡受 `display.showExperiments` 控制——
  后者在项目级 `experiments.enabled=false` 时**禁用**（置灰并提示「项目未开启实验区」）。
  关闭某开关只是前端不渲染对应卡片/区段，payload 与数据不受影响。

### 9.2 心跳作用域：只面向主会话

心跳是**主会话之间**的协作面：同一项目的多个主会话（不同窗口、不同工作树）靠它登记
goal/task/claims 并互相避让。子会话（subagent / teammate 子代理）**没有心跳**。

- **不再订阅 `subagent/start` / `subagent/end`**：已移除 registerSubagentHooks、
  `subagentRoots` 内存表、start/end 自动开合心跳等全部逻辑，子代理运行不再产生心跳文件。
- **提醒与门禁只对根会话生效**：`agent/pre-step` 的首步提醒与 `edit`/`write` 硬门禁先用
  宿主 `agents` 服务判定——`roots()` 里包含该活代理（或 id 一致）才是主会话；活代理
  `get(id)` 存在但不在 `roots()` 里即子会话。宿主不可用时回退会话 header
  （`origin === "subagent"` / `delegationDepth > 0` 判为子会话）。判定为子会话时
  **不提醒、不拒绝写入**；判定不出来时也不阻断（宿主旧版本降级）。
- **工具/CLI 明确拒绝**：`flow_heartbeat` 的 start/update/end 在子会话里抛错并给可行动
  提示（不要静默写一个面板会隐藏的文件）；CLI `flow heartbeat start/update/end` 由
  `DSH_SESSION_ID` 对应会话日志 header 判定，子会话里退出码 1 并提示向主会话汇报。
  `list`/`status` 是只读，任何会话可调用。
- **心跳根 = 项目主工作区**：worktree 会话也写主工作区的 `.agents/heartbeat`，
  见 §3.5 的解析与降级规则。这样「面板默认看主工作区」与「worktree 会话的心跳」不再分裂。
- **旧数据**：`agent: "subagent"` 的历史心跳读侧隐藏（`counts.hidden`），
  `flow heartbeat gc [--dry-run]` 清理。
- 子代理的进度通过**最终报告**回到主会话，由主会话统一登记/收尾心跳；这与 Agent Teams
  的任务板 + 最终报告模型一致。

#### 9.2.1 `agent/pre-step` 钩子的宿主契约（只读遵守，本插件不改）

下面的形状是**宿主声明的事件契约**，不是本项目定义的语义；本插件的 `agent/pre-step`
监听器（`index.js` 的 `registerHeartbeatReminder`）只能**按它遵守**，无权扩展或兜底。

- **`agent/pre-step` 的 mode 是 `waterfall`**：监听器是链上的一环，**必须返回一个
  `PreStepDecision`** 才能让链继续推进，不存在"不返回也能通过"的形态。
- **签名返回 `Promise<PreStepDecision>`**，且**宿主会 await 它**：
  `(this: Scoped<Agent>, payload: { agent; messages: UserMessage[]; turn; step; signal;
  modelSelection }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>`。
- **`next()` 的语义是「保留当前消息」**（宿主原文：*calling `next()` preserves the current
  messages*）。即：调用 `next()` ＝ 同意按 `payload.messages` 进入本 step。
- **`PreStepDecision` 是封闭联合**，只有两种形态、**没有 `null`**：
  `{ kind: 'reject' }` 或 `{ kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }`。
- **宿主契约未定义「监听器自身抛错」的语义**：契约只规定监听器返回什么样的 decision，
  没有规定它抛错时宿主如何呈现。

**因此本插件的处置（§9.2 的执行口径）**：`await next()` 故意**位于插件自己的 `try`
之外**，`next()` 的 rejection **原样传播给宿主**，插件不兜底。

理由不是"传播更优雅"，而是**兜底在契约层面做不到无损**：`next()` 抛错时插件拿不到任何
可合法返回的 decision——返回 `null` 违反封闭联合；返回 `{ kind: 'enter', messages: [] }`
会**静默丢弃 `payload.messages`**（用户本轮的输入从该 step 消失），比报错更难排查；
而"返回原 decision"恰好需要 `next()` 的返回值，正是拿不到的那个。**同一块里方向相反是刻意的**：
handler（插件自身逻辑）抛错必须被 `catch` 吞掉并返回原 decision（最多少一条提醒），
而 `next()`（宿主链）抛错必须传播。

> **诚实边界**：本节描述的契约来自宿主运行时导出的 Event 接口声明；**宿主的 agent 实现
> 源码本项目读不到**，因此"`next()` 抛错后在宿主内部如何呈现（step 被拒 / turn 中断 /
> 会话 error / 进程级失败）"**未经实测**，本节不对其作任何断言。该边界不影响上面的
> 处置结论——无论宿主如何呈现，兜底都比传播更差。

#### 9.2.2 `agent/turn-stopping` 钩子的宿主契约（只读遵守，本插件不改）

下面的形状是**宿主声明的事件契约**，不是本项目定义的语义；本插件的 `agent/turn-stopping`
监听器（`index.js` 的 `registerHeartbeatKeepalive`）只能**按它遵守**，无权扩展或兜底。
本节内容取自宿主运行时导出的 Event 接口声明（Inspect Provider `Event.listEvents`），
**不是**从插件注释转抄。

- **mode 是 `serial`**：宿主在 turn 边界提交前**会 await** 每个监听器，监听器抛错会传到
  host。与 §9.2.1 的 `waterfall` 不同，这里**不需要、也没有**返回 decision 的义务。
- **签名**（逐字）：
  `'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number;
  signal: AbortSignal }): Promise<void> | void`。
  `Agent` 只有 `readonly id: SessionId` 一个字段；`SessionId` 是 `string` 的品牌类型。
- **`this` 带 `Scoped<Agent>` 作用域**：agent-scoped 监听器**只收到该 agent** 的派发
  （宿主原文：*Scope-filtered dispatch: agent-scoped listeners receive only that agent*），
  插件因此不需要自己再按 agent 过滤。
- **`payload.signal` = 当前 turn 的显式中止信号**（宿主原文：*the current turn's explicit
  abort signal*）。已 `aborted` 的 turn 上做保活没有意义，插件据此提前返回。
- **语义**：turn 即将关闭——模型不再欠响应（没有在途工具调用、没有新 steering）。宿主
  **在边界提交前 await**；监听器完成后**无 steering 就关闭 turn**。

**⚠️ 在这个事件上写盘的硬约束**：监听器**可以调用 `agent.steer(...)` 让 turn 不结束**
（宿主原文：*a listener that objects steers (`agent.steer(...)`) and the machine re-reads
its inbox: fresh steering runs another step, none closes the turn*）。因此：

1. **绝不调用 `agent.steer()`**——那会把本该关闭的 turn 重新打开，制造无法收敛的循环；
2. **不在慢 IO 上久留**——宿主 await 本监听器，长耗时会**直接推迟 turn 边界提交**
   （不是后台延迟，是前台阻塞）；
3. **绝不抛错**——serial 链上抛错会传到 host，一个可丢的保活不值得冒这个险。

宿主还声明了两条对本事件同等重要的性质，插件不依赖它们但**不得违反**：*listener order
cannot change the outcome*（数据决定结果，监听器顺序不影响）；结论**不会短路已提交的
下一步工作**（同 step 的 `additionalContexts` 或竞态 steering 仍会跑，turn 只在 inbox
排空后关闭）。

**因此本插件的处置**：`heartbeatKeepalive` 只刷**本会话既有 working 心跳**的 `updated_at`
（`updateHeartbeat(root, contract, session, {})` 空 patch），**不建心跳、不写任何语义字段**
（`status`/`goal`/`task`/`claims`/`turn` 原样）；不 steer；全程包在 `try/catch` 里，
任何失败只留一条 mount warning。存在性与归属复用 `heartbeatWorking`——**与写门禁同一个
判定**，所以别的会话的心跳文件结构上够不着。

目的很具体：长 turn 会让 `updated_at` 老化超过 `HEARTBEAT_STALE_SECONDS`（6 小时）的
新鲜度窗口，`heartbeatStatus` 会报 stale/dead，`heartbeatGuardReason` 就会**错误地
拒绝 `edit`/`write`**。保活解决的是这个误判，不改变"是否该拒绝写入"的任何语义。

> **诚实边界**：本节契约来自宿主运行时导出的 Event 接口声明；**宿主的 agent 实现源码本
> 项目读不到**，因此(a) turn 边界提交之后宿主内部如何记账、(b) `signal` 在何种时序下被
> abort、(c) 同一 turn 上多个 serial 监听器的相对顺序**均未经实测**，本节不作断言。
> 该边界不影响上面的处置：无论宿主内部如何实现，"不 steer、不久留、不抛错"都是唯一
> 安全的写法。

### 9.3 与工具的关系

模型侧另有 6 个工具：`flow_status`、`flow_exp`、`flow_task`、`flow_gate`、`flow_heartbeat`、
`flow_decision`。
`flow_heartbeat` 的 `action` 为 `start|update|end|list|status`，session 取当前会话 id，
语义与 CLI `flow heartbeat ...` 完全一致（同一 `lib/core.mjs`）。start/update/end 只在
主会话可用；心跳根解析到项目主工作区；`root` 参数仍可覆盖工作区，但不会绕开主工作区
解析与会话判定。
`flow_decision` 的 `action` 为 `ask|list|show|answer|withdraw|gc`，与 CLI `flow decision ...`
一一对应（同一 `lib/core.mjs`）。`ask`/`answer`/`withdraw`/`gc` 是写动作，**只在主会话可用**：
子会话调用抛错并提示把待决策项写进最终报告、由主会话建/关 `D-` 记录；`list`/`show` 只读，
**任意会话可调用**。`ask` 的 `asked_session`/`asked_turn` 缺省取当前心跳；approval 省略
`recommendation` 等同推荐 `approve`（想推荐拒绝必须显式传 `reject`），`rationale` 仍必填。

### 9.4 面板决策节（`GET state` 的 `decisions`）

- payload 形状（`data.decisions`）：`{items, counts}`。`counts` 与
  `readStoreState().decisions.counts`、`summarizeDecisions(root, contract,
  {limit: DECISION_REMIND_MAX}).counts` **逐字相同**，恰好 7 键
  `{open,blocking,escalated,answered,withdrawn,superseded,total}`。
- `items` **同源、不重排**：取 `readStoreState().decisions.items`（= `summarizeDecisions` 的
  `items`）——只含 `open`，最多 3 条，顺序为「升级优先 → `asked_at` 旧的在前 → id」；payload
  再把它投影成固定 11 键 `{id,kind,status,question,blocks,options,recommendation,default,
  escalated,ageSeconds,asked_at}`（`options[].label`/`impact` 按长度上限裁剪）。core 侧的
  item 是「完整记录 + `escalated`/`turnAge`/`ageSeconds`」标注，还含 `schema`/`rationale`/
  `affects`/`fingerprint`/`asked_session` 等字段，**不**直接进 payload。
- **升级判定只有 24 小时规则**：这条读路径没有会话上下文，core 投影里的 `turnAge` 恒为
  `null`（payload 也不含该键），所以 `escalated` 只可能由 `asked_at` 超过 **24 小时**触发；
  「同会话挂起 ≥3 轮」的升级只出现在 `agent/pre-step` 提醒里（主会话面，§9.2），面板**不是**
  漏了轮数升级。
- 空态分三种，规则唯一：
  1. 工作区无 store → `ok:false` + `error.code: "not-initialized"`，**不带任何节**；
  2. store 存在但不可读（`emptyStoreState`）→ `decisions` 节在、`items: []`、`counts` 全 0；
  3. store 可读但无决策记录（含 `decisions/` 目录不存在）→ 同上，`items: []`、`counts` 全 0。
  **键必须存在、数组为空**，不是缺键；面板侧对缺键要按空节兜底（不抛）。
- 面板**只读**：不新增 HTTP 写端点、不调工具、不写 store；「复制回答串」在浏览器端拼接
  `flow decision answer <id> --choice <推荐值>`（取值顺序 `recommendation` → `default` →
  首个 option id；`input` 类型用引号包裹自由文本），回答由用户粘回会话或直接在 CLI 执行。
