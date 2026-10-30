# 结构化任务模型（精度层）

> 通用规范；项目通过命令契约提供具体值。实现语言由项目决定（bash/Node/Python 均可），本层只定义行为。
> 参考实现：通用技能 `scripts/task` + `precision_common.py`；项目可复制到 `.agents/scripts/`。
> 目标：任务从自由文档变成可校验记录；脚本负责创建、校验、聚合，代理只读需要的字段。

## 1 目标与非目标
目标：字段完整可校验；scope 可对接提交归属；preflight 可阻断“先做完再提意见”；sync 可触发跨文件检查；状态可聚合。
非目标：不让脚本替人做范围/契约/验收判断；不重写存量任务书；不引入新依赖（JSON + 项目自选运行时）。

## 2 字段表
| 字段 | 必填 | 规则 |
|---|---|---|
| `schema` | 是 | 固定 `1`，迁移时升版本 |
| `id` | 是 | `T-YYYYMMDD-NN`，全局唯一，加锁分配 |
| `legacy_id` | 否 | 旧 Markdown 的 `TASK-NNN`，迁移用 |
| `title` | 是 | ≤60 字，动宾结构 |
| `status` | 是 | `draft/active/blocked/done/archived`；只允许 `draft→active→done→archived`，`active↔blocked` |
| `owner` | 是 | 协调者会话 id；子代理不写 |
| `created_at/updated_at` | 是 | ISO8601 带时区 |
| `baseline` | 是 | 开工前完整 HEAD sha 或短 sha；active 时必须非空 |
| `workdir` | 是 | 仓库根相对路径，默认 `.` |
| `goal` | 是 | 一句话、可验证，不用“优化/完善”这类空词 |
| `scope.allow` | 是 | 非空路径/前缀列表；提交文件必须全部命中 |
| `scope.deny` | 否 | 显式排除，优先于 allow |
| `interfaces` | 是 | `api/schema/tokens` 各取 `none/read/change`；`change` 必须写 notes |
| `sync` | 否 | 枚举：`version/readme/tokens/schema/api`；由 scope 推导，缺项拒绝；项目负责把枚举映射到具体检查 |
| `invariants` | 是 | ≤5 条，每条 ≤120 字，写“不可破坏什么” |
| `acceptance` | 是 | ≥1 条，每条 `{cmd, expect}`；expect 必须可判定（exit 0/empty/≥N） |
| `forbidden` | 是 | 默认含 push、`git add -A`、装依赖、改版本号、写 CHANGELOG |
| `stop_conditions` | 是 | ≥1 条，触发即停并上报 |
| `preflight` | 是 | `{understanding, objections[], resolution, decided_by, decided_at}` |
| `checkpoints` | 否 | 追加式：`{at, files[], gate, note}`；只增不改 |
| `commits` | 否 | 关联提交 sha；done 时 ≥1 |
| `notes` | 否 | ≤20 行/2000 字；只放判断性说明，超出链接设计文档 |

## 3 校验规则（`task check` 应实现）
- **ID/状态**：id 唯一；非法跳转拒绝；`active` 时 baseline、acceptance、preflight 必须齐全。
- **scope**：`allow` 非空；路径不越出仓库根；deny 优先；与其它 `active` 任务的 allow 求交，非空则拒绝（同域双写）。
- **sync 推导**：scope 命中版本文件 → 必须有 `version`；命中 README → `readme`；命中令牌文件 → `tokens`；命中 `db/*.sql` → `schema`；命中 API 文件 → `api`。声明缺项即失败；具体文件清单由项目 `gate-config` 提供。
- **preflight**：understanding 非空；`resolution=pending` 禁止进入 active；有 objections 但 resolution=none 失败。
- **acceptance**：至少一条；cmd/expect 非空；expect 只能是 `exit 0`、`empty`、`>= N` 这类可判定值。
- **notes**：超 20 行或 2000 字拒绝；`invariants` 超 5 条拒绝。
- **commits**：done 时至少 1 个；格式为 7–40 位十六进制（由脚本校验，不在此写正则）。

## 4 已定决策
- schema 入仓：`.agents/task-schema.json`。
- 锁：`mkdir .agents/tasks/.lock` + 5 分钟 TTL；过期自动清理并告警。
- scope 求交：纯前缀匹配（统一补尾斜杠），deny 优先；Phase 2 再评估 glob。
- `done`：要求 commits ≥1 且至少一个 checkpoint.gate=pass。
- 迁移：旧 `.md` 关闭时用 `legacy_id` 转换，不批量重写。

## 5 迁移与下一步
- 新任务直接写 JSON；旧 `.md` 保持只读，关闭时用 `legacy_id` 转换，不批量重写。
- Phase 1 薄片：`task new/show/check` 三命令，先只读与校验，不接 hooks/CI；用真实任务样例做 fixture。
- Phase 2 再约束 notes/设计文档骨架；Phase 3 接 `gate commit` 与 pre-commit。

## 6 最小示例

~~~json
{
  "schema": 1,
  "id": "T-YYYYMMDD-01",
  "title": "示例任务",
  "status": "draft",
  "owner": "coord-...",
  "created_at": "2026-01-01T00:00:00+08:00",
  "updated_at": "2026-01-01T00:00:00+08:00",
  "baseline": "<sha>",
  "workdir": ".",
  "goal": "一句话可验证目标",
  "scope": { "allow": ["src/"], "deny": [] },
  "interfaces": { "api": "none", "schema": "none", "tokens": "none" },
  "sync": [],
  "invariants": ["不可破坏项"],
  "acceptance": [{ "cmd": "<command>", "expect": "exit 0" }],
  "forbidden": ["push", "git add -A"],
  "stop_conditions": ["门禁红"],
  "preflight": { "understanding": "理解", "objections": [], "resolution": "none" },
  "checkpoints": [],
  "commits": [],
  "notes": ""
}
~~~