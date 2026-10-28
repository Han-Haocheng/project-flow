# project-flow 契约（schema 2）

`project-flow` 现在是**项目的流程台账**，面板只是它的只读视图：实验（含 parent 谱系）、
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
  logs/<gateId>/<ts>.json   门禁运行记录，<ts> 为 started_at 把冒号换成连字符
  .lock                     写锁（临时文件，30 秒过期，不要提交、不要展示）
```

子目录可由契约覆盖（见 §2）；`<id>` 一律是安全路径段（不含 `/`、`\`、`.`、`..`）。

## 2 `flow.json`（schema 2）

`flow init` 写入下面这份完整默认值：

```jsonc
{
  "schema": 2,
  "name": "<basename(root)>",
  "store": { "root": ".dsh/flow" },
  "experiments": { "source": "store", "dir": ".dsh/flow/experiments", "groupBy": "factor", "fallbackTrailers": true },
  "tasks": { "source": "json", "dir": ".dsh/flow/tasks", "current": null, "recentLimit": 6 },
  "gates": { "dir": ".dsh/flow/gates", "logs": ".dsh/flow/logs" },
  "gate": { "log": null },                  // 旧观察日志，保留可选
  "heartbeats": { "source": "md", "dir": ".agents/heartbeat", "max": 20 },
  "runs": {
    "dirs": [".agents/tmp", "build/agent-*"], "maxDepth": 3, "maxAgeMinutes": 15,
    "max": 4, "tailLines": 15, "maxBytes": 2000000,
    "extensions": [".txt", ".log", ".out", ".json", ".csv"]
  }
}
```

合并规则：缺的键补默认值，对象递归补，数组整体替换；未知键**保留**（向前兼容）。
`loadContract` 返回 `{ contract, source, warnings }`，`source` 为 `.dsh/flow/flow.json`
或 `defaults`（文件不存在）；文件坏掉时回退默认值并带 `manifest-invalid` warning。
`schema` 不是 2 时只记一条 warning，仍按 schema 2 归一化。

`storePaths(root, contract)` 解析出的绝对目录（`store` / `experiments` / `tasks` /
`gates` / `logs`）。`store.root` 改成别的相对路径时，未自定义的各子目录跟随新 store 根；
写绝对路径则原样使用。

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

### 3.2 任务 `tasks/T-YYYYMMDD-NN.json`（兼容既有 alpha 台账）

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
flow init [--name X] [--force] [--migrate trailers|tasks|all]
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
flow gate rm <id> [--yes]
flow gate run  <id> [--timeout SECONDS]
flow gate logs <id> [--limit N]
```

- `show|update|rm|run|logs` 的 id 可作位置参数，也可用 `--id`；两者都写且不一致 → 用法错误。
- `exp add` **不支持** `--id`（id 由 core 自动生成）；显式 id 只能直接调 `addExperiment`。
- `exp update` 的 `--metrics` 必须是 JSON 对象，如 `'{"tie":0.4}'`；`--commits` 逗号分隔。
- `--step` 格式 `id=命令>>expect`，可重复；`expect` 可为 `exit 0`、`exit 2`、
  `contains:文本`；未写 `>>expect` 时为 `exit 0`。
- `gate run --timeout SECONDS` 覆盖该次运行所有步骤的超时（默认按步骤的 600 秒）。
- `gate logs --limit N` 默认 5，按 `started_at` 新→旧。
- `rm` 不带 `--yes`：TTY 下交互确认；非 TTY 或 `--json` 模式下直接用法错误（不会误删）。

### 5.2 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功（`gate run` 门禁失败也算命令成功，用 `data.ok=false` 表达） |
| 1 | 用法错误（未知命令/参数、缺必填参数、未 `flow init`、`rm` 缺 `--yes`） |
| 2 | 校验失败（`invalid`、`conflict`） |
| 3 | 未找到（`not-found`） |
| 4 | IO/环境错误 |

### 5.3 `flow status`

人类输出：项目名、根目录、契约源 + schema、存储目录、实验/任务/门禁计数，随后是最近
3 条实验、最近 3 条任务、最近 3 次门禁运行。未初始化时提示 `flow init`，退出码仍为 0。
`--json` 的 `data` 含 `root/name/initialized/contractSource/schema/store/counts/recent`。

## 6 core API（Host 工具与 CLI 共用）

`lib/core.mjs` 导出：

```js
SCHEMA_VERSION                       // 2
class FlowError extends Error        // code: invalid|not-found|conflict|io|usage

loadContract(root)                   // {contract, source, warnings}
saveContract(root, contract)         // 原子写，schema 强制 2
initProject(root, {name?, force?, migrate?:['trailers'|'tasks'], taskSourceDir?})
                                     // {root, created[], imported:{trailers,tasks}, warnings[]}
storePaths(root, contract)           // {store, experiments, tasks, gates, logs}（绝对路径）
drainWarnings()                      // 取走并清空全局诊断 warning（非契约 API）

listExperiments / getExperiment / addExperiment / updateExperiment / removeExperiment
listTasks       / getTask       / addTask       / updateTask       / removeTask
listGates       / getGate       / addGate       / updateGate       / removeGate

runGate(root, contract, id, {timeoutMs?, tailLines?})  // async，写日志并返回运行记录
listGateRuns(root, contract, gateId, limit = 5)        // 新→旧

experimentTree(records)              // [{...record, children:[...]}]，环安全
readStoreState(root, contract)       // 面板聚合：experiments{items,counts,source}
                                     // tasks{items,counts,current,source}
                                     // gates{items(含 lastRun),counts}
migrateTrailers(root, contract)      // {imported, skipped, ids, warnings}
migrateLegacyTasks(root, contract, sourceDir = '.agents/tasks')
```

`created` 是根相对 POSIX 路径数组。`get*` 未找到抛 `not-found`；`add*`/`update*`/`remove*`
在未初始化时抛 `usage`（`initProject`/`migrate*` 除外；`migrate*` 要求已初始化）。

## 7 迁移

### 7.1 `--migrate trailers` / `migrateTrailers`

读 `git -C root log` 的提交正文，识别 trailer（大小写不敏感，键名）：

| trailer | 落到实验字段 |
|---|---|
| `Exp-Id` | `id`（逗号/空白分隔可多个；不符 `^[A-Z]+-\d{8}-\d{2}$` → warning） |
| `Hypothesis` | `hypothesis`，同时截 80 字符作 `title` |
| `Factor` / `Scale` / `Expected` | 同名字段 |
| `Measured` | `measured` |
| `Verdict` | `status`：`confirmed/confirm`→confirmed，`refuted/refute`→refuted，`abandoned/abandon`→abandoned，其余→open |

- 同一 `Exp-Id` 的多个提交合并成一条：`commits` 收集 7 位短 sha，后出现的非空
  `hypothesis`/`measured`/`verdict` 覆盖旧值，`updated_at` 取最新提交时间，`created_at`
  取最早提交时间。
- 已存在的 id **跳过**（不合并）；`skipped` 按“已存在 id 在提交中出现的次数”计数。
- 非 git 仓库 / git 失败只进 `warnings`，不抛错。
- `parent` 迁移为 `null`（trailer 没有谱系信息）。

### 7.2 `--migrate tasks` / `migrateLegacyTasks`

读 `<sourceDir>/*.json`（默认 `.agents/tasks`），按任务 schema 校验后写入 store：

- 缺 `title` 时用 `id`；缺 `created_at`/`updated_at` 用文件 mtime。
- id 冲突跳过（不覆盖）；非法 id、坏 JSON 记 warning 后跳过。
- `initProject({migrate:['tasks']})` 时迁移结果同时计入 `imported.tasks` 与 `created[]`。

## 8 与 git 的关系

- `.dsh/flow/` 是**真相源**，可以也建议提交进项目仓库；它不再是“git trailer 的投影”。
- git 仍是历史与发布单位：实验记录的 `commits` 字段回填短 sha，提交信息里的
  `Exp-Id`/`Verdict` 只在 `--migrate trailers` 时单向导入一次，之后以 store 为准。
- 写锁 `.lock` 是临时文件，不应提交（建议 `.gitignore` 加 `.dsh/flow/.lock`）。
- 面板只读 store，不跑 git、不写文件；不要用脚本直接编辑 JSON 绕过 core 的校验与锁。
