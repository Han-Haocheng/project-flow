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
| `id` | 是 | `T-<YYYYMMDDHHMMSS>`（本地时间 14 位，如 `T-20261105212130`），加锁自动生成；同一秒第二张起追加 `-02`、`-03`…（上限 99，超出 conflict）；**天然单调、删除不复用**；旧 `T-YYYYMMDD-NN` 保留可读可引用（不迁移）；跨分支同秒撞名属 **git 合并冲突**，人工重编号、**禁止** `-X ours/theirs` |
| `legacy_id` | 否 | 旧 Markdown 的 `TASK-NNN`，迁移用 |
| `title` | 是 | `<type>: <一句话范围>`（type ∈ `feat` / `fix` / `chore`），≤60 字符；正反例见 `SKILL.md` §10.2.1 |
| `status` | 是 | `draft/active/done/archived`（**无 `blocked`**，见 `lib/core.mjs` 的 `TASK_STATUS`）；只允许 `draft→active→done→archived`；依赖记在 Team 卡 `blocked_by`，不落 flow 状态 |
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
| `parent` | 否 | **任务拆分层级**：父任务 id，宽引用 `^[A-Za-z][A-Za-z0-9_.-]{1,60}$`（字母开头、2..61）；`null`/空串 = 根（CLI/工具另接受 `none`，`''`/`none`/`null` **大小写不敏感**）。写路径要求父**已存在**（`parent-not-found`）、**禁自指**、**禁环**（`parent-cycle`）；读路径父失效/成环**按根**（投影 `parent: null`，不迁移、不写回）；**单向 child→parent，不存 `children` 数组** |
| `experiment` | 否 | 实验型项目用：`E-YYYYMMDD-NN`，**应指向已存在实验**（格式非法才拒；不存在只记 warning、不拒绝写入）；**实验记录不存 tasks 列表**（单向引用，不双写） |

**任务 id 的分配与重编号**：新 id 是**本地时间戳** `T-<YYYYMMDDHHMMSS>`（如 `T-20261105212130`），`addTask` 在锁内生成；同一秒建第二张起追加 `-02`、`-03`…（两位补零，同秒上限 99，超出 `conflict: no free T id left for <stamp> (same-second limit 99)`）。时间戳只前进，**删除记录不会复用旧号**，所以任务 id **不需要** `flow.json` 计数器（契约无该键）。旧 `T-YYYYMMDD-NN` 历史 id 继续可读、可被 `parent`/`decisions.blocks`/heartbeat `task` 引用，**不迁移、不回填**；实验 `E-YYYYMMDD-NN` 不变。**跨分支/worktree** 同一秒创建会得到相同 id，合并时属 **git 合并冲突**，必须**人工重编号**（保留一方、另一方顺延到新时间戳或改后缀），**禁止** `git merge -X ours` / `-X theirs` 静默丢弃。重编号同时要改所有文本引用：`decisions` 的 `blocks`、heartbeat 的 `task`、任务的 `parent`、实验的 `commits` 等（批量工具 `flow task renumber` 尚未提供，属后续可选卡）。

**两种 `parent` 别混**：实验 `parent` = 后继/派生关系（`pivoted` 的新实验指向旧实验，硬规则里「有后继」即指它）；任务 `parent` = 拆分层级（子任务挂父任务）。两者都**单向**——记录只存自己的 `parent`，父记录不回写子 id。

**任务 `parent` 的落地面**：**写入口已可用**——CLI `flow task add|update --parent <T-id>`（`''` / `none` / `null` **清空为根，大小写不敏感**，与 `flow_task` 共用 `core.normalizeParentInput`）以及 `flow_task` 的 `parent` 参数；core `addTask` / `updateTask` 校验父存在 / 禁自指 / 禁环。读路径父失效或成环按根（`parent: null`，不迁移）。**面板已按树展示**（T-13 A3：缩进 + 连接线 + caret 折叠 + 跨组徽标 + `aria-level`）。**仍未落地**的只有 `T-20261030-13`（schema 3 实验 + 任务合并进度树）——本版只做任务的 `parent` 子集，**没有 rollup、没有统一状态机**。

## 2.1 实验记录字段（`experiments/E-*.json`，schema 2 约定）

> 实验是任务的外围功能（`SKILL.md` §十二）。下表为新实验的字段约定；**新实验缺 `direction` / `expected` / `primaryMetric` / `guardrails` / `falsify` / `windowDays` / `stopLoss` 任一即拒**。旧 `schema:1` 记录只读、不迁移、不补字段（数量以项目实测为准）。机器只校验存在/非空/`guardrails`≥1 且**每项非空 string**/`windowDays` 正整数且 **≤3650**/`primaryMetric` 为单个非空 string（唯一主指标；多指标放 `guardrails`）/`direction` ≤120；同义、可判定性等语义项由审查者把关。CLI（B2）：`exp add` 必填 `--direction` / `--expected` / `--primary-metric` / `--guardrail`（可重复）/ `--falsify` / `--window-days` / `--stop-loss`，`exp update` 同名可选。落盘以 core 实现与 `flow check experiments` 为准。

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` / `schema` | 是 | `E-YYYYMMDD-NN`；`schema: 2` |
| `title` | 是 | 一句话实验名，≤60 字符 |
| `hypothesis` | 是 | 可证伪的假设，非空字符串（沿用旧必填） |
| `direction` | 是* | 方向（措辞，自由文本 ≤120 字符，不设枚举） |
| `expected` | 是* | 验证目标，可判真假 |
| `primaryMetric` | 是* | 主指标，**单个 string**（唯一；多指标放 `guardrails`） |
| `guardrails` | 是* | 护栏指标数组，≥1 条且**每项非空 string** |
| `falsify` | 是* | 证伪条件（与 `expected` 同义由审查把关） |
| `windowDays` | 是* | 正整数天 **1..3650**；**起算点 = `created_at`**（`check experiments` 据此判超期） |
| `stopLoss` | 是* | 止损线（可判定性由审查把关） |
| `status` | 是 | `open` / `confirmed` / `refuted` / `abandoned` / `inconclusive` / `pivoted`（后两态为加法，旧四态兼容） |
| `parent` | 否 | 父实验 id 或 `null`；环安全，不得自指 |
| `metrics` | 否 | 观测值对象（按 `primaryMetric` / `guardrails` 记） |
| `learned` | 条件 | **`refuted` / `pivoted` 必填**；`inconclusive` **建议写**（`check experiments` 不硬拦）：学到什么、下次怎么改 |
| `cleanup` | 条件 | **`refuted` 必填**：`{flags[], code[], data[]}`（开关 / 代码 / 数据，各 ≤20 项，空数组 = 无该类） |
| `cleanupAt` | 条件 | **`refuted` 必填**：`flow exp cleanup` 写入的 ISO 时间（系统维护，直接 patch → `invalid`） |
| `productizedAt` | 否 | 只由 `flow exp productize` 写：要求 `release` 最近一次 `ok` 的 `finished_at` ≥ 进入 `confirmed` 的 `updated_at` |
| `productizeGate` | 否 | `{id, runAt, log}`，只由 `productize` 写 |
| `commits` | 否 | 关联提交 sha |
| `created_at/updated_at` | 是 | ISO8601 带时区 |

是* = 新实验必填，旧记录 legacy 不补。

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