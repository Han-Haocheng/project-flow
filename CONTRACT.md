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
  .lock                     写锁（临时文件，30 秒过期，不要提交、不要展示）
```

子目录可由契约覆盖（见 §2），但覆盖值必须留在项目根内；`<id>` 一律是安全路径段（不含 `/`、`\`、`.`、`..`）。

## 2 `flow.json`（schema 2）

`flow init` 写入下面这份完整默认值：

```jsonc
{
  "schema": 2,
  "name": "<basename(root)>",
  "store": { "root": ".dsh/flow" },
  "experiments": { "source": "store", "dir": ".dsh/flow/experiments" },
  "tasks": { "source": "json", "dir": ".dsh/flow/tasks", "current": null, "recentLimit": 6 },
  "gates": { "dir": ".dsh/flow/gates", "logs": ".dsh/flow/logs" },
  "heartbeats": { "source": "json", "dir": ".agents/heartbeat", "max": 20 },
  "decisions": { "dir": ".dsh/flow/decisions" }
}
```

合并规则：缺的键补默认值，对象递归补，数组整体替换；未知键**保留**（向前兼容）。
`loadContract` 返回 `{ contract, source, warnings }`，`source` 为 `.dsh/flow/flow.json`
或 `defaults`（文件不存在）；文件坏掉时回退默认值并带 `manifest-invalid` warning。
`schema` 不是 2 时只记一条 warning，仍按 schema 2 归一化。

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

合法相对路径的解析结果与旧行为完全一致。

## 3 记录格式

### 3.1 实验 `experiments/E-YYYYMMDD-NN.json`

```jsonc
{
  "schema": 1,
  "id": "E-20261028-01",
  "title": "短标题",                    // 必填，非空字符串
  "hypothesis": "可证伪的假设",
  "factor": "focus/normalize",          // 分组键，可为空
  "parent": null,                       // 另一实验 id 或 null
  "expected": "tie_mean<=1.0",
  "scale": "small",
  "status": "open",                     // open | confirmed | refuted | abandoned
  "measured": "",
  "metrics": {},                        // JSON 对象
  "commits": [],                        // 字符串数组（短 sha / 提交信息）
  "notes": "",
  "created_at": "2026-10-28T15:00:00+08:00",
  "updated_at": "2026-10-28T15:00:00+08:00"
}
```

- id：自动 `E-YYYYMMDD-NN`（本地日期，两位序号，遍历现有 id 递增）；显式指定必须匹配
  `^[A-Z]+-\d{8}-\d{2}$`，已存在 → `FlowError('conflict')`。
- `parent` 必须指向已存在实验或为 `null`/空串；指向不存在 → `FlowError('invalid')`；
  指向自己 → `invalid`。历史坏数据在 `experimentTree` 里按根处理（未知 parent、成环、
  自引用都不会丢记录）。
- `created_at` 不可改；更新自动刷新 `updated_at`；`id`/`schema`/`created_at` 出现在
  patch 里 → `invalid`。
- 未知字段保留。

### 3.2 任务 `tasks/T-YYYYMMDD-NN.json`（兼容既有台账格式）

```jsonc
{
  "schema": 1,
  "id": "T-20261028-57",
  "title": "任务标题",                  // 必填
  "status": "draft",                    // draft | active | done | archived
  "owner": "",
  "goal": "",
  "scope": { "allow": [], "deny": [] },  // 数组元素必须为字符串
  "acceptance": [],                      // 字符串数组
  "checkpoints": [],                     // 对象或字符串数组
  "commits": [],
  "notes": "",
  "created_at": "...",
  "updated_at": "..."
}
```

- id 规则与实验相同（`^[A-Z]+-\d{8}-\d{2}$`，`T-` 前缀）。
- 更新时 `scope` 逐键合并（`{allow:[...]}` 不会清掉 `deny`），其余字段整体替换。
- `created_at`/`id`/`schema` 不可改。

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
| `precommit` | commit | true | `git diff --cached --check` + `"<包内绝对路径>/bin/flow.mjs" check decisions` | 提交前暂存区检查（含阻塞决策） |
| `tests` | commit | false | `node --test test/` | 单元测试（默认关闭，按项目自填命令） |
| `staged-files` | commit | false | `"<包内绝对路径>/bin/flow.mjs" check staged --allow src` | 暂存文件归属检查（占位） |
| `release` | release | false | `"<包内绝对路径>/bin/flow.mjs" check release-baseline --marker RELEASE` | 发布基线检查（占位） |

引用本插件 CLI 的两个步骤用 `import.meta.url` 在运行时解析出的**包内绝对路径**
（`PLUGIN_BIN`），因为门禁的 cwd 是项目根，不能假设根下存在 `bin/flow.mjs`。
`tests` / `staged-files` / `release` 默认关闭：`node --test test/` 与 `--allow src`
只是模板，必须由项目改成自己的命令/路径后再 `gate enable`。`precommit` 的第二步
`check decisions` 是内置检查（见 §6.1.1）：阻塞决策命中暂存文件时提交被拦下。已有项目
不会自动补这一步，需要手动 `flow gate update precommit --step '<原步骤>' --step 'decisions=…>>exit 0'`
（`--step` 是整体替换，必须带上原步骤）。

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
  "stats": { "turns": 3, "missed": 0 }
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
- `session` 缺省取 `DSH_SESSION_ID`；仍为空 → `FlowError('usage')`。session 会当文件名用：
  禁止 `/`、`\`、`..`、控制字符，长度上限 80，否则 `FlowError('invalid')`。
- `status` 只有 `working` / `idle` 算 active；`done` / `missed` 是结束态。
  `ageSeconds` 按 `updated_at` 计算（解析失败回退文件 mtime），`> 6h`
  （`HEARTBEAT_STALE_SECONDS`）记 `stale`。
- 写操作（start/update/end）与 store 共用同一把锁与原子写（`withLock` +
  `writeJsonAtomic`），要求项目已 `flow init`（否则 `usage`）。
- `endHeartbeat` 只写 `ended_at` 并保留文件（面板仍要列出），不删除。
- **旧子会话心跳**：已移除的「子代理自动开合心跳」留下的 `agent: "subagent"` 记录是历史
  数据。读侧把它投影为 `legacy: true` / `hidden: true`，**不进入面板与 CLI list**，只计入
  `counts.hidden`；`flow heartbeat gc [--dry-run]` 清理这些文件（其余心跳保留）。
- **读取只认 `*.json`**（心跳目录下的 `.md` 不再读取）：`readHeartbeats` 保留旧形状
  `{file,title,statusLine,ageSeconds,mtime}`（隐藏旧子会话记录）；`readHeartbeatSection`
  返回富形状 `{root,dir,items,counts}`，item 含
  `{file,session,agent,legacy,hidden,goal,task,claims,status,last_action,started_at,updated_at,ended_at,ageSeconds,stale,turn,stats,mtime}`，
  计数 `{total, active, stale, hidden}`（total/active/stale 只统计可见项；`root` 是解析后的
  主工作区绝对路径，降级时另带 `degraded: true` 与 `reason`）。

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
  "recommendation": "approve",                  // choice/approval 必填（option id）；input 为自由文本
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
  `approve`/`reject`（调用方不得传 `options`）；`input` 无 `options`，`recommendation`/
  `default` 为自由文本；`affects` 不得绝对路径、不得 `..` 逃逸，存储时 `\` → `/`、去 `./`、
  去尾 `/`。任一不满足 → `invalid`（退出码 2）。
- **系统字段**：`fingerprint`、`superseded_by`、`answered_at`、`answer`、`withdraw` 由 core
  维护，调用方传入 → `invalid`；`id`/`schema`/`kind`/`asked_at`/`created_at`/`question`/
  `options` 一经创建不可改（没有独立 update 命令）。

## 4 写入语义

**原子写**：`mkdir -p` → 写 `<name>.tmp-<pid>-<seq>` → `rename`；失败清理临时文件并抛
`FlowError('io')`。读到的坏 JSON 文件只记 `unreadable:` warning，不影响列表。

**写锁**：每次写操作在 `<store>/.lock` 上用 `open(..., 'wx')` 加锁，内容
`{"pid":N,"at":"<ISO>"}`，结束即释放。锁存在且不足 30 秒 → `FlowError('conflict')`
（提示稍后重试）；超过 30 秒视为过期，记 `lock-stale:` warning 后接管。锁只防同机并发
写，不跨机器。

**id 生成**：`PREFIX-YYYYMMDD-NN`；遍历现有记录取当天最大序号 +1（跳过已占用），
当天用尽 → `FlowError('conflict')`。

## 5 CLI 参考（`bin/flow.mjs`）

全局：

```
flow <command> [options]
flow --root <dir> <command> [--json]
```

| 全局参数 | 说明 |
|---|---|
| `--root <dir>` | 项目根目录，默认当前目录 |
| `--json` | 机器可读输出：成功 `{ok:true,data}`；失败 `{ok:false,error:{code,message}}` |
| `-h`, `--help` | 显示帮助并退出 0 |

### 5.1 命令

```
flow init [--name X] [--force] [--no-gates]
flow status

flow exp list | show <id> | tree
flow exp add    --title T [--hypothesis H] [--factor F] [--parent ID]
                [--expected E] [--scale S] [--notes N]
flow exp update <id> [--title T] [--status open|confirmed|refuted|abandoned]
                [--hypothesis H] [--factor F] [--parent ID] [--expected E]
                [--scale S] [--measured M] [--metrics JSON]
                [--commits a,b] [--notes N]
flow exp rm <id> [--yes]

flow task list | show <id>
flow task add    --title T [--status draft|active|done|archived]
                 [--owner O] [--goal G] [--notes N]
flow task update <id> [--title T] [--status draft|active|done|archived]
                 [--owner O] [--goal G] [--notes N]
flow task rm <id> [--yes]

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
flow heartbeat list
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
  （或上次心跳的 agent）；③ 最新的**无主**（`owner` 为空）`active`；④ 最新的**无主** `draft`
  （③④ 多条取 `updated_at` 最新）。**他人名下的任务不会被抢**——并行主会话各建各的卡，
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
  供 `session-open` 这类门禁直接使用。
- `decision list` 默认只列 `open`；`--open` 是显式同义写法，`--all` 列全部（closed 按
  `updated_at` 倒序，排在 open 之后）。排序全局唯一：升级优先，其次 `asked_at` 旧的在前。
- `decision ask` 的 `--option` 格式 `id=label>>impact`，可重复；`choice` 至少两个。
  `--recommendation` 在 `choice`/`approval` 必填，`--rationale` 必填；`--blocks`/`--affects`
  可重复；`--supersedes` 用于同题重开（见 §3.6）。
- `decision answer` 的 `--choice` 必填（`input` 为自由文本）；`--by` 默认 `user`，
  `--note` 可省略（落盘为空串）。`decision withdraw` 的 `--reason` 必填。
- `decision gc` 默认保留 90 天内与全部 open；`--days N` 覆盖保留天数，`--dry-run` 只报告
  不删除；只删 `answered`/`withdrawn`/`superseded` 且关闭超过保留期的记录。
- `flow check decisions` 是唯一内置检查（bin 特判路由 core，见 §6.1.1），语义与退出码按检查
  词汇归一。
- `flow init --no-gates` 跳过默认门禁种子（见 §3.3.1）。
- `exp add` **不支持** `--id`（id 由 core 自动生成）；显式 id 只能直接调 `addExperiment`。
- `exp update` 的 `--metrics` 必须是 JSON 对象，如 `'{"tie":0.4}'`；`--commits` 逗号分隔。
- `--step` 格式 `id=命令>>expect`，可重复；`expect` 可为 `exit 0`、`exit 2`、
  `contains:文本`；未写 `>>expect` 时为 `exit 0`。
- `gate run --timeout SECONDS` 覆盖该次运行所有步骤的超时（默认按步骤的 600 秒）。
- `gate logs --limit N` 默认 5，按 `started_at` 新→旧。
- `rm` 不带 `--yes`：TTY 下交互确认；非 TTY 或 `--json` 模式下直接用法错误（不会误删）。
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
`--force` 时抛 `usage`（退出 1）。

### 5.3 `flow status`

人类输出：项目名、根目录、契约源 + schema、存储目录、实验/任务/门禁计数与
`待决策 N（阻塞 M）`，随后是心跳汇总（`N（可能已停 M）`）与前 5 条心跳明细（文件名 /
相对时间 / 状态行，超过 5 条提示总数），再往后是最多 3 条 open 决策明细（id / kind /
question / 挂起时长或轮数，升级项带 `⚠`）与最近 3 条实验、最近 3 条任务、最近 3 次门禁运行。
未初始化时提示 `flow init`，退出码仍为 0。`--json` 的 `data` 增加
`decisions: {items, counts:{open,blocking,escalated,answered,withdrawn,superseded,total}}`
（`items` 只放前 3 条 open，与提醒/面板同一排序）。

心跳读自**项目主工作区**的 `contract.heartbeats.dir`（默认 `.agents/heartbeat`，worktree
会话也读主工作区；解析/降级规则见 §3.5）下的 `*.json`（只有 `source: 'none'` 关闭）：
拼 `status · last_action`，按 mtime 倒序并按 `heartbeats.max`（默认 20）截断；
`ageSeconds > 6h` 记为可能已停（`HEARTBEAT_STALE_SECONDS`，与面板一致）。
目录不存在按空集处理，不报错。`agent: "subagent"` 的旧记录不展示
（只提示隐藏条数，`flow heartbeat gc` 可清理）。心跳目录下的 `.md` 不再读取。

`--json` 的 `data` 含 `root/name/initialized/contractSource/schema/store/counts/heartbeats/recent`，
其中 `heartbeats` 为
`{ dir, items: [{ file, session, agent, goal, task, claims, status, last_action, started_at, updated_at, ended_at, ageSeconds, stale, turn, stats, mtime }], counts: { total, active, stale, hidden } }`
（富形状来自 `readHeartbeatSection`；`readHeartbeats` 仍返回旧的
`{file,title,statusLine,ageSeconds,mtime}` 以免破坏既有调用，同样只读 json）。

`flow heartbeat list` 用同一份富形状输出表格（session 短名 / agent / status / 年龄 /
task / claims / goal），并额外打印一条汇总与可能已停的文件名。

## 6 机械检查（`flow check`）

`flow check` 把 `skills/ai-collaborative-dev-workflow/scripts/` 下的机械检查脚本包成
CLI 入口（SKILL.md 里声明的首选检查入口）。它是**只读**的：不读写 `.dsh/flow`、不碰写锁、
不产生任何 store 写入；`lib/checks.mjs` 也不导入 `lib/core.mjs`。因此可以安全地放进
`flow gate` 步骤或 CI。

脚本路径相对于**包根**解析（`lib/checks.mjs` 在 `<pkg>/lib/`，脚本在
`<pkg>/skills/ai-collaborative-dev-workflow/scripts/`），与 `--root` 指向的项目无关；
解释器固定为 `bash`（`.sh`）与 `python3`（`doc_check.py`）。

**唯一内置例外**：`flow check decisions` 不来自脚本目录，而由 `bin/flow.mjs` 特判路由到
`core.checkDecisions()`（只读，复用 `loadContract`/containment/路径归一）。`lib/checks.mjs`
保持**不 import core、不读写 `.dsh/flow`** 的纪律。`check list` 仍只列脚本检查（四项）：
`decisions` 是 core 实现的内置检查，不出现在该清单里。

### 6.1 子命令与参数映射

| 子命令 | CLI 用法 | 实际调用 |
|---|---|---|
| `list` | `flow check list [--json]` | 不 spawn，直接打印目录 |
| `staged` | `flow check staged --allow <path> [--allow <path> ...]` | `bash check_staged_files.sh <allow...>` |
| `release-baseline` | `flow check release-baseline --marker <text> [--threshold <N>]` | `bash release_baseline.sh '<marker>' [N]` |
| `state` | `flow check state [--file <path>]` | `bash check_state.sh <file>` |
| `doc` | `flow check doc --file <path> --type task\|design\|incident\|release` | `python3 doc_check.py <file> --type <type> --root <项目根>` |

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
- 每项检查默认超时 **120 秒**，`--timeout <seconds>` 覆盖（正整数）。

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
{"ok":true,"data":{"check":"staged","exitCode":0,"stdout":"…","stderr":"","durationMs":9}}
```

失败：

```json
{"ok":false,"error":{"code":"check-failed","message":"检查未通过：staged（exit 1）",
 "check":"staged","exitCode":1,"stdout":"","stderr":"[FAIL] 暂存区包含归属外文件：…"}}
```

`check list --json` 返回 `{"ok":true,"data":{"checks":[{name,interpreter,script,description,args}]}}`，
`script` 是相对包根的 POSIX 路径。

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

listExperiments / getExperiment / addExperiment / updateExperiment / removeExperiment
listTasks       / getTask       / addTask       / updateTask       / removeTask
listGates       / getGate       / addGate       / updateGate       / removeGate

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
heartbeatStatus(root, contract, session)   // {active, record|null}
readHeartbeats(root, contract)             // 旧形状 [{file,title,statusLine,ageSeconds,mtime}]，只读 json
readHeartbeatSection(root, contract)       // 富形状 {root, dir, items[], counts{total,active,stale,hidden}}
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
```

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
- 写锁 `.lock` 是临时文件，不应提交（建议 `.gitignore` 加 `.dsh/flow/.lock`）。
- 面板只读 store，不跑 git、不写文件（唯一例外：「初始化」按钮 POST `/api/project-flow/init`，
  由 core 校验并原子写，以及门禁开关 POST `/api/project-flow/gate`）；不要用脚本直接编辑
  JSON 绕过 core 的校验与锁。

## 9 面板 HTTP 表面

### 9.1 三个端点

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/project-flow/state?root=<dir>` | 只读投影：实验树、任务、门禁、心跳 |
| POST | `/api/project-flow/init` | 初始化台账（`{root}`），走 core |
| POST | `/api/project-flow/gate` | 门禁开关（`{root, id, enabled}`），走 core |

`root` 缺省取宿主 cwd；它必须是已注册工作区、其子目录，或自带 `.dsh/flow` store 的目录。
没有 store 的工作区返回 `not-initialized` 空态（`ok:false`），不读取其它项目，也不再有
旧布局读法、运行输出扫描或 Agent Teams 投影。

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

### 9.3 与工具的关系

模型侧另有 5 个工具：`flow_status`、`flow_exp`、`flow_task`、`flow_gate`、`flow_heartbeat`。
`flow_heartbeat` 的 `action` 为 `start|update|end|list|status`，session 取当前会话 id，
语义与 CLI `flow heartbeat ...` 完全一致（同一 `lib/core.mjs`）。start/update/end 只在
主会话可用；心跳根解析到项目主工作区；`root` 参数仍可覆盖工作区，但不会绕开主工作区
解析与会话判定。
