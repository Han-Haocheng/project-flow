# CLI --json 契约（v1）

> 单一真源：`lib/cli/contract.mjs`（机器可读，含校验器）。
> 本文是同一份契约的**人类可读**版本；两边必须同步，契约测试 `test/cli-json-contract.test.mjs` 会抓漂移。
> 任务卡：T-20261112161101（重构⑤）。父卡：T-20261112154348（后端收敛为单可执行）。

## 0 这条契约管什么

用户定的边界是：**后端（唯一真源）通过 CLI 暴露 API，前端只通过 CLI 子进程 + `--json` 交互**，
不 import 后端代码、不读 `.agents/`。因此 `flow <command> --json` 的输出就是前后端之间唯一的接口，
它必须像协议一样冻结：形状稳定、版本可见、改动可审计。

本文只管**机器可读面**。人类输出（表格、中文摘要）不在契约内，可以随时美化 —— 见 §8。

## 1 信封

所有命令在 `--json` 下都往 stdout 写**恰好一行** JSON（无缩进、无附加文案），
stderr 只在极少数非契约场景出现（见 §8）。

成功：

```json
{ "schemaVersion": 1, "ok": true, "data": <命令各自的 data>, "warnings": [] }
```

失败：

```json
{ "schemaVersion": 1, "ok": false, "error": { "code": "usage", "message": "..." }, "warnings": [] }
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `schemaVersion` | integer | 契约版本。**破坏性变更才 +1**；前端据此判断兼容性 |
| `ok` | boolean | 命令是否成功；**与退出码 0 等价但独立**（`gate run` 门禁失败仍是 ok:true） |
| `data` | 见 §4 | 仅成功信封；形状按命令登记，命令失败时**不出现** |
| `error` | object | 仅失败信封；`code` 是机器判据（见 §2），`message` 是人类文案 |
| `warnings` | array<string> | 恒为数组（可为空）；诊断只走这里，不写 stderr |

`error` 是**开放对象**：`check` 族在失败时额外带 `check` / `exitCode` / `stdout` /
`stderr` / `durationMs`（与成功 data 的同名字段一致），前端不该假设它只有 code/message。

## 2 退出码

成功/失败与退出码分开表达：`data.ok` 说业务结果，退出码说进程结果。

| 退出码 | 含义 | error.code |
|---|---|---|
| 0 | 成功（含 `gate run` 门禁失败：用 `data.ok` 表达） | — |
| 1 | 用法错误 | `usage` / `check-failed` |
| 2 | 校验失败 | `invalid` / `conflict` |
| 3 | 未找到 | `not-found` / `terminal` |
| 4 | IO 或环境错误 | `io` |

`flow check ...` 复用同一组数字但语义按检查归一：
0 通过 · 1 检查失败 · 2 用法/配置错误 · 3 脚本或解释器缺失 · 4 启动/IO 失败（含超时）。

前端判据：**只看 `ok` 与 `error.code`，不要从 `message` 里解析语义**；
退出码用于进程级分支（比如 `flow task next` 的终态是 3，不是错误）。

## 3 契约版本与兼容性

- 当前版本：**`1`**（`CLI_CONTRACT_VERSION`）。
- **增字段**（含新增命令）= 向后兼容：旧前端忽略未知字段即可，但**必须**同步 `lib/cli/contract.mjs` 与本文，
  否则 `test/cli-json-contract.test.mjs` 立刻变红（未登记字段即失败）。
- **删字段 / 改名 / 改类型 / 去掉命令** = 破坏性变更：必须把 `CLI_CONTRACT_VERSION` +1，并重跑全部前端。
- 记录的 `schema` 字段（experiment=2、task=1、gate=1、heartbeat=1、decision=1）是**记录格式**版本，
  与 `schemaVersion`（契约版本）是两件事，不要混用。
- `schema:1` 的历史 experiment / task 记录只读，形状与本文登记的不完全一致；
  前端必须先看记录自己的 `schema` 再用对应解读（见 CONTRACT §3.1 / §3.2）。

## 4 逐命令 data 形状

形状是**纯数据**（JSON 可序列化），完整定义见 `lib/cli/contract.mjs` 的 `DATA_SHAPES` 与 `RECORD_SHAPES`，
也可用 `contractDocument()` 一次取全量。下面这张表由注册表生成，是命令面的索引。

「开放对象」= 允许未登记字段（只用于 core 自有载荷，已在契约里显式标注）；
其它对象都是**封闭**的：多一个字段就是违约。

### A 命令索引

| 命令 | data 顶层形状 |
|---|---|
| flow init | 对象（必填 root·created·warnings） |
| flow status | 对象（必填 root·name·initialized·contractSource·schema·store·counts·heartbeats·decisions·recent；可选 intents·status） |
| flow state | 开放对象（必填 ok·generatedAt·root·roots；面板状态快照载荷） |
| flow aspect | 联合（list：aspects/locks/counts + 可选 source·swept ；acquire：{acquired,lock} 或 {acquired,holder,waitedMs}；renew：{renewed,lock} 或 {renewed,reason}；release：{released,aspect,owner,forced?,reason?} 或 {released:false,reason}；sweep：{root,dir,dryRun,released,kept}） |
| flow backup | 对象（必填 name·path·files·bytes·pruned） |
| flow doctor | 对象（必填 ok·root·findings） |
| flow exp list | 数组<记录 experiment> |
| flow exp show | 记录 experiment |
| flow exp tree | 数组<对象（必填 experiment 全字段·children）> |
| flow exp add | 记录 experiment |
| flow exp update | 记录 experiment |
| flow exp review | 对象（必填 id·verdict·branch·missing） |
| flow exp productize | 开放对象（必填 id·already） |
| flow exp cleanup | 对象（必填 id·cleanup·cleanupAt·changed） |
| flow exp rm | 对象（必填 id·removed） |
| flow task list | 数组<记录 task> |
| flow task show | 记录 task |
| flow task add | 记录 task |
| flow task update | 记录 task |
| flow task link | 记录 task |
| flow task unlink | 记录 task |
| flow task archive | 对象（必填 archived·candidates·days·cutoff·dryRun·locked；可选 closed —— archiveAfterDays=0 时 closed:true 且 cutoff 为 null） |
| flow task sweep | 对象（必填 olderThanHours·scanned·closed·skipped·dryRun·locked） |
| flow task normalize | 对象（必填 fix·dryRun·ok·issues·fixed·counts·remaining·longTitles·typeMap） |
| flow task next | 对象（必填 id·title·stage·stageZh·owner·terminal·actor·next·alternatives·acceptance） |
| flow task verify | 对象（必填 id·ok·executed·passed·failed·steps·verification；可选 skipped·repair） |
| flow task rm | 对象（必填 id·removed） |
| flow gate list | 数组<记录 gate> |
| flow gate show | 记录 gate |
| flow gate add | 记录 gate |
| flow gate update | 记录 gate |
| flow gate enable | 记录 gate |
| flow gate disable | 记录 gate |
| flow gate rm | 对象（必填 id·removed） |
| flow gate run | 联合（记录 gateRun / 对象（必填 phase·runs·skipped·segments）） |
| flow gate rules | 联合（开放对象（必填 files·baselineAt） / 开放对象（必填 ok·baselineAt） / 开放对象（必填 changed）） |
| flow gate logs | 数组<记录 gateRun> |
| flow heartbeat start | 对象（必填 heartbeat 全字段·stack·counts·team·capture·unfinished·recentCaptured） |
| flow heartbeat update | 对象（必填 heartbeat 全字段·stack·counts·team·capture·unfinished·recentCaptured） |
| flow heartbeat end | 记录 heartbeat |
| flow heartbeat list | 对象（必填 root·dir·items·counts·hiddenByVisibility·livenessEvidence·leaseSeconds） |
| flow heartbeat status | 对象（必填 active·liveness·reason·ageSeconds·livenessEvidence·leaseExpiresAt·record·taskStage·taskStageZh） |
| flow heartbeat rm | 对象（必填 session·removed） |
| flow heartbeat gc | 对象（必填 root·dir·removed·kept·dryRun·olderThanHours） |
| flow decision ask | 对象（必填 decision·created） |
| flow decision list | 对象（必填 items·counts） |
| flow decision show | 记录 decision |
| flow decision answer | 对象（必填 decision 全字段；否决自动应用**失败**时追加 vetoApplied:false·vetoWarning，成功时不追加） |
| flow decision withdraw | 记录 decision |
| flow decision gc | 对象（必填 removed·kept·dryRun） |
| flow desc status | 对象（必填 established·name·semantics·files·modules·missingSemantics·plans·described·enabled·enforce） |
| flow desc build | 对象（必填 created·updated·unchanged·pruned·warnings） |
| flow desc show | 联合（对象（必填 counts·files） / 描述文件记录（--path 命中，直接返回记录本身） / 对象（必填 path·record） / 对象（必填 graph）） |
| flow desc set | 联合（对象（必填 schema·name·semantics·revision·generated_at·updated_at·counts） / 开放对象（必填 records·changed）） |
| flow desc plan | 联合（开放对象（必填 plan·amended） / 开放对象（必填 files）） |
| flow desc apply | 对象（必填 plan·applied·warnings） |
| flow desc render | 联合（对象（必填 checked·markdown） / 对象（必填 checked·path·bytes）） |
| flow check list | 对象（必填 checks） |
| flow check staged | 对象（必填 check·exitCode·stdout·stderr·durationMs） |
| flow check release-baseline | 对象（必填 check·exitCode·stdout·stderr·durationMs） |
| flow check state | 对象（必填 check·exitCode·stdout·stderr·durationMs） |
| flow check doc | 对象（必填 check·exitCode·stdout·stderr·durationMs） |
| flow check decisions | 对象（必填 check·exitCode·stdout·stderr·durationMs·open·blocking·failed） |
| flow check experiments | 对象（必填 check·exitCode·stdout·stderr·durationMs·enabled·checked·legacy·failed·warnings） |
| flow check tasks | 对象（必填 check·exitCode·stdout·stderr·durationMs·ok·counts·issues·typeMap） |
| flow check description | 对象（必填 check·exitCode·stdout·stderr·durationMs·mode·counts·failed·warnings） |

**`task.verify` 的两种形状**（`--json`）：

- 有可执行验收项（`cmd:<shell>` / `gate:<id>`）：`{id, ok, executed, passed, failed[], steps[], verification, repair}`，
  `failed` 是 `"<kind>:<target>"` 字符串数组，`steps[]` 每项带 `repair`（重跑命令），
  `gate` 步骤跑不起来时额外带 `error{code,message}`；全通过时 `repair` 为 null。
  验收失败 = 命令失败：退出码 1、`error.code='check-failed'`，明细挂在 `error.verification`（与成功 data 同形）。
- 没有可执行验收项：返回 `{id, ok:true, executed:0, passed:0, failed:[], steps:[], skipped:'no-executable-acceptance', verification:null}`，
  不跑命令、不写回执 —— 静默成功比失败更危险，所以显式给 `skipped`。

**`status.intents`（未完成 saga intent，T-20261112183138-02）**：仅当 `data.initialized===true` 时出现，
是可选项（可缺席，**从不为 null**）。读不到时整键缺席并在顶层 `warnings` 里给 `intents-unavailable: ...`
（「读不到」与「很干净」必须可区分）。形状：
`{ open: number, items: [{ id, kind, target, steps[], done[], missing[], updated_at: string|null }] }`；
`open` 是在途（state=open）intent 总数，`items` 最多 10 条、按 `updated_at` 倒序，
`missing = steps - done`。派工这类多步写（spawn → 写回执）崩溃后，这是唯一线索，所以必须可读。

`flow desc ...` 的载荷里有 core 自有的记录/骨架（`plan`、`record`、`records`、`files`），
它们被登记为**开放对象**：契约保证外层字段，内层按 CONTRACT §3.7 的记录格式演进。
描述模块当前 `description.enabled=false`（用户指示先忽略），所以这些形状不阻塞其它工作。

## 5 记录形状

### B 记录形状（必填 / 可选）

**experiment** — 必填：schema、id、title、hypothesis、direction、expected、primaryMetric、falsify、stopLoss、guardrails、windowDays、factor、parent、scale、status、measured、metrics、commits、notes、learned、cleanup、cleanupAt、productizedAt、productizeGate、created_at、updated_at

**task** — 必填：schema、id、title、status、parent、owner、scope、acceptance、checkpoints、commits、notes、created_at、updated_at；可选：type、stage、done_at、archived_at、experiment、team、source、veto、decision、verification

**gate** — 必填：schema、id、title、phase、enabled、steps、created_at、updated_at；可选：allowUnknownExpect、kind、mount、failFast、lastRun

**gateStep** — 必填：id、run、expect、timeoutSeconds；可选：kind

**gateRun** — 必填：gate、title、started_at、finished_at、durationMs、ok、steps；可选：kind、mount、failFast、segments

**heartbeat** — 必填：schema、session、agent、goal、task、claims、status、turn、last_action、started_at、updated_at、ended_at、host、stats；可选：title、boot_id、pid、pid_start、branch、worktree（判活证据与分支来源，有值时才出现）

**heartbeatItem** — 必填：file、session、agent、legacy、hidden、goal、title、task、claims、status、last_action、started_at、updated_at、ended_at、ageSeconds、stale、turn、stats、mtime、liveness、reason、livenessEvidence、leaseExpiresAt、taskStage、taskStageZh；可选：branch、worktree、pid（branch/worktree 只在有值时出现，pid 旧记录为 null；started_at/updated_at/ended_at/turn/stats 可为 null）

**decision** — 必填：schema、id、question、kind、rationale、options、recommendation、default、status、blocks、affects、supersedes、answer、answered_at、withdraw、superseded_by、fingerprint、asked_at、created_at、updated_at、asked_session、asked_turn

**statusBlock** — 必填：stack、counts、team、capture、unfinished、recentCaptured

补充约定（形状之外的类型语义）：

- `cleanup` 的三个数组各 ≤20 项，空数组 = 该类无清理项；`cleanupAt` 为 ISO 时间戳或 null。
- `metrics` 是自由指标表（对象，键名由实验决定，值为数字/字符串）。
- `task.stage` 与 `task.type` 可为 null/缺省（legacy 记录、刚建的 draft）；状态机见 CONTRACT §3.2.1。
- `gate.kind` 取 `structure|behavior`；`gate.mount.level` 取 `layer|module|feature|aspect`，
  且 `behavior` 只准 `mount.level=feature`；`mount.target` 在 module/aspect 层必填。
- `gateRun.segments` 是结构/行为两段各自的计数（`{kind,total,passed,failed,ok,steps}`）；
  `gate run --phase` 的批量载荷另带顶层 `segments`（结构/行为各 `{gates,failed,ok}`）。
- `heartbeat.livenessEvidence` 是判活依据（`pid` / `ttl` / ...），`leaseExpiresAt` 是租约到期时刻。

## 6 契约测试与「自证有效」

`test/cli-json-contract.test.mjs` 做五件事：

1. 在一次性项目里**真实执行** SPEC 里的每一条命令（`bin/flow.mjs` 的 SPEC 是参数真源），
   校验信封 + data 形状；
2. 断言 SPEC ↔ `DATA_SHAPES` ↔ 文档三方**一一对应**（漏登记、幽灵形状都红）；
3. **自证**：对真实的 status/task 输出做改名、加字段、改类型、改枚举、改版本号，
   校验器必须报错 —— 证明这套测试真的会因为字段变动变红；
4. `--json` 只吐单行 JSON、stderr 为空；
5. 文档与 `contractDocument()` 与注册表一致。

新增/修改命令时的操作顺序（别反）：

1. 改实现（`lib/cli/*.mjs` 或 core 的返回值）；
2. 同步 `lib/cli/contract.mjs` 的形状表；
3. 同步本文 §4 / §5；
4. 跑 `node --test test/cli-json-contract.test.mjs`，红了就按报错路径改；
5. 全量 `node --test test/` 与 `node bin/flow.mjs gate run precommit`。

## 7 前端接入建议（dsh-web / dsh-tui / 其他平台）

1. 只用 `spawn(flow, ['--root', root, ...args, '--json'])`，不要 import 后端、不要读 `.agents/`；
2. 解析 stdout 的**第一行** JSON，校验 `schemaVersion===1`（不认识就降级到只读/提示升级后端）；
3. 业务分支看 `ok`，错误分支看 `error.code`；
4. 退出码只用于进程级判断（尤其是 `task next` 的 `terminal` → 3）；
5. `warnings` 展示在「诊断」区域，不要当错误。

## 8 `--json` 与人类输出的分工（硬规则）

- `--json` 只服务机器：**永不**为了好看改形状、加装饰、分多行、掺中文提示；
- 默认输出（无 `--json`）可以随便美化：表格列宽、中文摘要、颜色都行；
- 两套输出必须来自同一份数据（命令的返回值），不允许各算一遍；
- 因此「把工具输出改成中文可读文本」这类美化（T-20261112151914 的 `renderToolText`）**只能改默认输出**，
  不许动 `--json` 的 data 形状。契约测试会在形状变动时红。

## 9 工具面形状（**不进** `--json` 信封）

用户边界把契约面定为 CLI，所以下面这些字段**不在**上面的命令表里；但它们同样被前端/日志消费，
统一登记在此，避免「某一侧的字段没人管」。消费方必须知道：它们来自宿主插件工具（`flow_*`），
不是 `flow <cmd> --json` 的 data。

### 9.1 `flow_task dispatch` / 自动派工的结果

`dispatch` 是工具结果里的兄弟字段（`{root, task, dispatch}`），不是任务记录字段，也不出现在任何 CLI data 里。
成功派工：

```text
{ childId, role, provider, model, degraded?, from, to, aspect?, auto? }
```

自动派工失败（台账已写成功，调用方决定重试）：`{ auto:true, ok:false, code, error }`。

**`dispatch.aspect`（T-20261112183138，additive）**：只有该次派工经过 aspect 占用逻辑时出现，
是可选键、**从不为 null**：

```text
{ aspects: string[], acquired: string[],
  pending: Array<{ aspect: string, holder: string|null, waitedMs: number|null }>,
  skipped?: 'no-session' | 'no-aspect-overlap' }
```

- `aspects`：任务 `scope.allow` 命中的全部 aspect（按 id 字典序）；`acquired`：本次真的拿到的；
- `pending`：没拿到（被别的**活**会话占着）的 aspect + 占用方 + 等待毫秒；**非空不阻断派工**（裁定 6），
  warnings 里会给 `aspect-pending: <aspect>（占用方 <session>）等不到锁，按裁定 6 放行派工`；
- `skipped`：`no-session`（派工没有会话 id）/`no-aspect-overlap`（scope.allow 为空或不命中，no-op）。

### 9.2 aspect 锁投影（`flow aspect list` 的 `locks[]` 行同源）

`{aspect, title?, files[], owner{session,pid,host,acquired_at,renewed_at,ttl_seconds}, waiters[], state, releasable, reason, evidence, leaseExpiresAt, ttlSeconds, updated_at}`；

`title` 是可选键：定义投影带了 title 的版本会下发它，当前 `projectLock` 不下发（面板用 `aspects[]` 按 id 关联），两种投影都必须能读。
`state` 取 `held|dead|foreign|expired`，`releasable` 是「可以被清扫」的唯一判据。

## 10 变更记录

| 契约版本 | 日期 | 变更 |
|---|---|---|
| 1 | 2026-11-12 | 首次冻结：信封 + schemaVersion + 全部命令（当前 66 条）的 data 形状 + 记录形状 + 退出码表 + 契约测试（T-20261112161101）；同日并入 `state`（前端快照）与 `gate rules`（规则防篡改） |
