# project-flow 契约（flow contract）

`project-flow` 是只读面板：它按项目自己声明的 `flow.json` 找到台账，再把这些内容
归一化成一份固定结构的 JSON 交给面板。**没有 `flow.json` 的项目只要带默认布局标记
也能直接看**——契约是可选的。

- 端点：`GET /api/project-flow/state`（exact 路由，仅 GET）
- 只读：Host 半不写任何文件、不常驻 watcher、不调用网络
- 失败也返回 200：缺目录、坏 JSON、非 git 仓库都只是空段 + `warnings`

## 1 发现顺序

每次请求现算。候选根来自 `ctx.workspaceRegistry.list()` 的每个 `.path`；注册表服务
缺失时只用 `process.cwd()`。

对每个候选根：

1. 依次找清单：`flow.json` → `.flow/flow.json` → `.agents/flow.json`。命中第一个就用它，
   `contract.source` 为相对路径（如 `.agents/flow.json`）。
2. 一个都没有时，只要存在任一默认布局标记即仍算候选，契约全用默认值，
   `contract.source = "defaults"`：
   - `<root>/.agents/tasks`（目录）
   - `<root>/.agents/gate-observe.log`
   - `<root>/.agents/scripts/exp.py`
3. 其余 workspace 不进入 `roots`（除非通过查询参数显式指定，见下）。

选根：

| 情况 | 行为 |
|---|---|
| 查询参数 `root=<绝对路径>` | `path.resolve` 后等于某个候选，**或**该目录自带 flow 清单（显式 opt-in，即使尚未注册为 workspace）都被接受；两者都不是则 `400 unknown-root`。显式接受的根会补进本次响应的 `roots`。 |
| 不传 `root`，单候选 | 用它 |
| 不传 `root`，多候选 | 取 `<root>/.agents/tasks` 目录 mtime 最新者（无则 `-Infinity`） |
| 一个候选都没有 | `200 {ok:false, error:{code:"no-project"}}` |

## 2 契约字段与默认值

`flow.json` 顶层就是一个对象。合并规则：**出现的键覆盖默认值；数组整体替换；对象逐键
浅合并；未知键忽略**。JSON 解析失败（或顶层不是对象）→ 该根用全套默认值，并记一条
`manifest-invalid` warning。

```jsonc
{
  "schema": 1,
  "name": "<默认 basename(root)>",
  "experiments": {
    "source": "git-trailers",            // "git-trailers" | "none"
    "groupBy": "Factor",                 // 分组用的 git trailer 键名
    "ungroupedLabel": "未分组",
    "limit": 400,                        // git log 扫描的提交条数
    "keys": {                            // 逻辑字段 → 实际 trailer 键名
      "id": "Exp-Id", "hypothesis": "Hypothesis", "factor": "Factor",
      "scale": "Scale", "expected": "Expected", "measured": "Measured",
      "verdict": "Verdict"
    }
  },
  "tasks": {
    "source": "json",                    // "json" | "markdown" | "none"
    "dir": ".agents/tasks",
    "current": ".agents/.current",       // 空字符串表示不读
    "recentLimit": 6,
    "fields": {                          // 逻辑字段 → 台账 JSON 里的键名
      "id": "id", "title": "title", "status": "status", "owner": "owner",
      "goal": "goal", "updatedAt": "updated_at", "commits": "commits"
    }
  },
  "gate": {
    "log": ".agents/gate-observe.log",   // null 或 "none" → gate 段为 null
    "lines": 40
  },
  "heartbeats": {
    "source": "md",                      // "md" | "json" | "none"
    "dir": ".agents/heartbeat",
    "max": 20
  },
  "runs": {
    "dirs": [".agents/tmp", "build/agent-*"],  // 末段支持 "*" 通配
    "maxDepth": 3,
    "maxAgeMinutes": 15,
    "max": 4,
    "tailLines": 15,
    "maxBytes": 2000000,
    "extensions": [".txt", ".log", ".out", ".json", ".csv"]
  }
}
```

说明：

- `groupBy` 是**实际 trailer 键名**，不是 `keys` 里的逻辑名；默认 `Factor`，改成
  `Scale` 就按 Scale 分组，与 `keys.factor` 无关。
- `runs.dirs` 的元素先 `resolve(root, dir)`，再对**最后一段**做 `*` 前缀/后缀匹配
  （`build/agent-*` 只匹配 `build/` 下以 `agent-` 开头的目录）。
- 所有数值越界都会被夹到合理区间；非法枚举值回退默认值。

## 3 响应结构（字段名固定）

```jsonc
{
  "ok": true,
  "generatedAt": "2026-10-28T14:50:00+08:00",
  "contract": { "source": "defaults", "schema": 1, "name": "alpha" },
  "roots": [{ "path": "/tmp/pf-demo/alpha", "name": "alpha" }],
  "root": "/tmp/pf-demo/alpha",
  "head": { "sha": "f5f176b", "subject": "...", "branch": "dev", "dirty": 0 },
  "experiments": {
    "total": 1, "confirmed": 1, "refuted": 0, "open": 0,
    "groups": [{ "factor": "engine-config", "items": [{
      "id": "H1-baseline", "verdict": "confirmed", "date": "2026-10-28",
      "sha": "f5f176bc", "subject": "...", "hypothesis": "...",
      "expected": "...", "measured": "...", "scale": "small"
    }] }]
  },
  "tasks": {
    "total": 49,
    "counts": { "draft": 20, "active": 0, "done": 29, "archived": 0, "other": 0 },
    "current": null,
    "active": [{ "id": "...", "title": "...", "status": "active",
                 "owner": "...", "updated_at": "...", "goal": "..." }],
    "recentDone": [{ "id": "...", "title": "...", "updated_at": "...",
                     "commits": ["..."], "gate": "pass" }]
  },
  "gate": { "lines": ["..."], "mtime": 1761621916000, "size": 28954 },
  "heartbeats": [{ "file": "...", "title": "...", "statusLine": "...",
                   "ageSeconds": 178000, "mtime": 1761447480000 }],
  "runs": [{ "path": ".agents/tmp/t47/FINAL_sum.txt", "ageSeconds": 60,
             "size": 1200, "lines": ["..."] }],
  "warnings": []
}
```

字段表：

| 段 | 字段 | 含义 |
|---|---|---|
| `head` | `sha` / `subject` / `branch` / `dirty` | 短 sha、末条提交标题、当前分支、`git status --porcelain` 行数；**非 git 根四项全 null** |
| `experiments` | `total/confirmed/refuted/open` | 实验条数与判读计数；`open = total - confirmed - refuted` |
| | `groups[].factor` | 分组名（空 factor → `ungroupedLabel`），组按名称升序，组内新→旧 |
| | `items[].verdict` | 只取 `confirmed` / `refuted`，其余为 `null` |
| | `items[].sha` | 8 位 |
| `tasks` | `counts` | 固定键 `draft/active/done/archived/other`，未知状态进 `other` |
| | `current` | `<current>` 文件内容；不存在 → `null` |
| | `active` | status 恰为 `"active"`，按 `updated_at` 倒序 |
| | `recentDone` | status 恰为 `"done"`，按 `updatedAt` 倒序取 `recentLimit`；`gate` 取最后一条 `checkpoints[].gate` |
| `gate` | `lines/mtime/size` | 末尾 `lines` 行；关闭时为 `null`；文件缺失 → `{lines:[],mtime:null,size:0}` + warning |
| `heartbeats` | `file/title/statusLine/ageSeconds/mtime` | 按 mtime 倒序取 `max` |
| `runs` | `path/ageSeconds/size/lines` | `path` 为根相对 POSIX 路径；按 mtime 倒序取 `max` |

截断：`title/hypothesis/expected/measured/goal/statusLine` 与 `gate.lines`、`runs.lines`
的每一行都截到 400 字符（`heartbeats.statusLine` 在 json 适配器里截 200，markdown 任务
标题截 200）；`head.subject` 不截断。

## 4 适配器

### 4.1 experiments — `git-trailers`

`git log --date=short -n <limit>`，用 `%x1f` / `%x1e` 分隔字段（与 `exp.py` 同做法），
trailer 键名取 `keys.*`。只保留带 `id` trailer 的提交。`source:"none"` → 全零。

### 4.2 tasks — `json`

`<dir>/*.json` 逐个解析：坏文件跳过并记 warning；字段名取 `fields.*`。`counts` 按 status
归类；`active` 收集 status 为 `"active"`；`recentDone` 取 `"done"` 按更新时间倒序。

### 4.3 tasks — `markdown`

`<dir>/*.md`：

- `id` = 文件名去扩展名
- `title` = 第一行 `# ` 之后的文本（截 200）
- `status` = 文件以 `---` 开头且 front matter 块内有 `status:` 时用该值，否则 `"unknown"`
  （计入 `other`）
- `updatedAt` = 文件 mtime 的本地 ISO
- `commits: []`、`gate: null`

### 4.4 tasks — `none`

空结构（`total:0`、计数全 0、`current:null`、两个数组为空）。

### 4.5 heartbeats — `md`

`<dir>/*.md`：`title` 取首个 `# ` 行；`statusLine` 取首个含「状态」的行（去掉列表符号），
否则首个非空非标题行；`ageSeconds` 用 mtime。

### 4.6 heartbeats — `json`

`<dir>/*.json`：`statusLine` = `status` 与 `last_action` 中有值者以 ` · ` 连接（截 200）；
`ageSeconds` 优先解析 `updated_at`（ISO 或 `YYYY-MM-DD HH:MM`），解析不了才用 mtime；
`title` = 文件名去扩展名。

### 4.7 gate

末尾 `lines` 行，保留缩进、每行截 400；`mtime`/`size` 来自 stat。

### 4.8 runs

在 `dirs` 展开后的目录里扫，深度 ≤ `maxDepth`；只收普通文件、mtime 在 `maxAgeMinutes`
内、大小 1 B ~ `maxBytes`、扩展名命中（大小写不敏感）；按 mtime 倒序取 `max`，每个取末
`tailLines` 行。

## 5 示例

### 5.1 alpha：零配置

alpha 根有 `.agents/tasks/`、`.agents/gate-observe.log`、`.agents/scripts/exp.py`，
且**不需要任何 `flow.json`**：

```json
{ "contract": { "source": "defaults", "schema": 1, "name": "alpha" } }
```

实验来自 `Exp-Id`…`Verdict` trailer，任务来自 `.agents/tasks/*.json`，门禁日志来自
`.agents/gate-observe.log`，心跳来自 `.agents/heartbeat/*.md`。

### 5.2 qbank：一个四行清单

其根目录 `flow.json`：

```json
{
  "schema": 1,
  "name": "qbank",
  "experiments": { "source": "git-trailers" },
  "tasks": { "source": "markdown", "dir": ".agents/tasks" },
  "gate": { "log": null },
  "heartbeats": { "source": "json", "dir": ".agents/heartbeat" },
  "runs": { "dirs": [".agents/tmp"] }
}
```

结果：`contract.source = "flow.json"`，任务走 markdown 适配器（`.agents/tasks/TASK-001.md`、
`TASK-002.md`，均无 front matter → `status:"unknown"` → `counts.other = 2`），`gate = null`，
心跳走 json 适配器（`status` + `last_action`），`experiments.total = 0`（仓库无 `Exp-Id` trailer）。

## 6 安全边界

- 仅注册一条 exact GET 路由，其余方法 `405`（`allow: GET`）
- 请求带 `origin` 头且不等于 `ctx.webServer.getOrigin()` → `403`
- 所有响应 `cache-control: no-store`，正常响应 < 1 MB（超限时从实验项、运行输出逐级裁剪并加
  `payload-truncated` warning）
- git 调用超时 4 s、`maxBuffer` 16 MB；任何异常只进 `warnings`，HTTP 仍为 200
