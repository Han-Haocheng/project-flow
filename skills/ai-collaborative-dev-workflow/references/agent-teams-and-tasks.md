# DSH 0.2.0 工具面速查：自动化任务 / 智能体团队 / 目标 / 会话定时

> 实测环境：`dsh 0.2.0-rc.2`（2026-10-10，profile `web`）。**本文件是"派单前/恢复前按需读"的细节层**；纪律在 `SKILL.md` §九（卡片与自动化任务）与 §十（智能体团队）。
> **第一原则**：**可用性以当前会话的工具列表为准**——Host 暴露什么就是什么，别照文档猜工具名或字段；下面的"纪律"才是文档该记的东西（参数细节看工具 schema 本身）。

## 0 怎么核实"这些工具到底在不在"

1. **工具列表**（最直接）：会话里能不能看到 `task_board_*` / `team_task_*` / `spawn_teammate` / `schedule_*` / `*_goal`。
2. **板摘要**：`task_board_list` 返回 `board.sessionDefaultPermission`（**权限闸门**的默认线）、`board.armedSchedules`（**真正在跑的 cron 数量**——这是"有没有无人值守"的唯一硬证据）、`board.maxSubtaskDepth`、`board.counts`。
3. **Host 侧配置**（profile 的 cordis 补丁层）里找 `web-ui-task-board` → `@linxin666/dsh-web-all/task-board`（客户端 UI 插件为 `@linxin666/dsh-client-ui-task-board`）。
4. **打包来源**（`dsh` 安装树的 `node_modules/@deepseek-ai/`）：`dsh-experimental-tool-agent-team`（团队工具）+ `dsh-experimental-agent-team`（团队内核与任务图）+ `dsh-experimental-client-ui-agent-team`（UI）；`dsh-schedule` + `dsh-experimental-schedule-bundle` + `dsh-client-ui-schedule`（会话定时）；`dsh-goal` / `dsh-tool-goal` / `dsh-command-goal`（目标与 `/goal`）。**包存在 ≠ 已启用**，仍以第 1、2 条为准。

## 1 自动化任务：Host 任务板 `task_board_*`

| 工具 | 一句话 | 不看会踩的点 |
|---|---|---|
| `create` | 建卡（可带 `parentId`、标签、排期、执行钉定） | 只落 `todo`，**不执行**；子任务继承父的工作区/预设/权限/模型；深度上限有拒绝 |
| `set_parent` / `update` | 挂父 / 改卡 | **已执行过的卡：`title`/`description`/`prompt` 冻结**（Host 硬拒 `400 task has already been executed`）；执行目标（权限/工作区/模型/`reuseSession`/标签）**始终可改** |
| `run` | **真跑**（可 `rerun` 已结算的） | 跑父卡会**并发跑整棵子树**；**消耗真实额度**；有效权限高于会话默认时**需人在 GUI 确认**（工具无确认能力） |
| `manage` | 列移动 / `archive` / `restore` / `delete` / `settle` | 归档是**整棵子树**、子树有未结算执行时拒绝；`settle` 是把"卡住不动的运行中卡"强收成 cancelled 的唯一手段，之后可重跑 |
| `get` / `list` | 读全貌（执行记录、会话 id、结果、错误） | 判"最新一次执行"要**按 `startedAt` 排序**——重跑会新开一条记录，旧记录永久保留，列表顺序不代表新旧 |
| `schedule` | 卡级 cron（5 段，Host 本地时区） | 错过的触发点**跳过不补跑**；卡在跑则**跳过本次**；子树里有未确认权限 ⇒ **拒绝并顺延**（原因见板摘要 `schedulerError`） |
| `task_board_github_*` | issue ↔ 卡、建 PR、关 issue、刷新、配置仓库 | 只在**已授权远端**时用；关 issue 需要已合并的 PR |

**结算与复核（最高频事故）**：结算只看最后一次 `turn/end` 的 reason 是否为 `error` ⇒ **被中断（`interrupted`）的执行会被记成 `succeeded`**。所以 **看板绿 ≠ 交付**，必须看**会话产出**：有无实质 assistant 文本、`turn/end` 结局、`startedAt` 最新那条。

## 2 会话内定时 `schedule_*`（与卡级 cron 是两套）

`schedule_create`（`after_seconds` / `at` / `every_seconds` / `daily` / `weekly` / `cron` **六选一**）、`list`、`update`（改时间/文案，id 不变）、`delete`。
**语义**：只给**本会话**投递提示（提醒、周期巡检提示），**不执行任何任务**；本地时间不存在（DST 缺口）则跳过，重复时刻只触发一次；停机期间**只投递最近一次**错过的触发点。
**因此**：要"到点真的干活"⇒ 用卡级 `task_board_schedule`；要"到点提醒这个会话"⇒ 用 `schedule_*`。

## 3 智能体团队 `spawn_teammate` / `send_message` / `wait_agent` / `list_agents` / `interrupt_agent` / `team_task_*`

| 工具 | 语义 | 陷阱 |
|---|---|---|
| `spawn_teammate` | Lead 专用；建**持久**队友（`fresh` = 无历史 / `fork` = 继承**已完成**轮次） | `fork` **看不到当前在飞的轮**；名字唯一；`description` 决定它自己怎么理解职责 |
| `send_message` | durable 投递；**running 队友在最近步边界收到，inactive 队友被唤醒** | 成功发送 = 已持久化，**别重发**；这是唯一"开跑"手段 |
| `wait_agent` | 等下一次成员状态/邮箱/共享任务变化 | **只观察调用之后的变化**，**从不唤醒**任何人；没有其他成员在跑时立刻返回 `noProgress`；超时后应 `list_agents` 重列而不是轮询 |
| `list_agents` | 花名册与可用性 | `inactive` = **没在跑**，不等于失败/完成/等待；`provisioning` / `failed` 才是创建态 |
| `interrupt_agent` | Lead 专用中断某队友当前轮，**保留 pending inbox** | 中断 ≠ 取消任务；唤醒不保证恢复原状 |
| `team_task_*` | 共享任务板；`update` 用 `expected_revision` 做 **CAS**（`claim` / `complete` / `release` / `reopen` / `edit` / `set_dependencies` / `reassign` / `delete`） | 先 `list`/`get` 拿**当前 revision** 再改；`write_scopes` 与 `blocked_by` 是**协调信息，不是锁**；**readiness 不会自动开跑 owner**——要 `send_message` 唤醒 |

**派工检查单**：任务书路径 / 允许写域（与其他在跑成员两两不相交）/ 交付格式（只给结论 + 指针，≤6–8KB）/ **零 git 写** / 停止条件 / 验证命令。

## 4 目标 `create_goal` / `get_goal` / `update_goal`

- `create_goal`：把**长跑目标**持久化，会话按自动续轮继续推进（`max_goal_rounds` 限轮）。**不是**单轮任务的替代品。
- `update_goal`：`complete` 只在**客观达成**时用；`blocked` 只在**同一阻塞连续 ≥3 轮**且写明具体条件；`edit` / `pause` / `resume` 需**用户直接要求**。
- **恢复/分叉后目标会被解除武装**：用户说"继续/接着干"时要先 `resume` 重新武装。

## 5 `workflow`（脚本化扇出）

一次性编排**大量相互独立**的子任务（审计、迁移、多角度核验）时用：脚本里 `agent()` 跑子代理、`pipeline()` 无屏障串联、`parallel()` 汇聚。**只在用户明确要求 workflow 或大编排时**用；日常批处理、单卡任务、需要来回对话的协作都不该用它。

## 6 选型表

| 场景 | 用 |
|---|---|
| 跨会话 / 无人值守 / 要钉工作区与权限 / 要 cron | **任务板卡**（§1） |
| 本次会话内并行几路写域，需与 Lead 来回对话 | **智能体团队**（§3） |
| 大规模**只读**扇出、跨很多文件的审计/迁移 | **`workflow`**（§5） |
| 到点提醒"这个会话" | `schedule_*`（§2） |
| 到一个持续推进的目标 | `goal`（§4） |

三者**共用同一条铁律**：**唯一 git 写者是协调者/Lead**；队友与卡片一律零 git 写，产出留工作树按路径提交。
