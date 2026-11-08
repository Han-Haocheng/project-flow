---
description: 通过 `flow` CLI 与 `flow_*` 工具记录和查看可证伪实验、任务与门禁。
metadata:
  when-to-use: 当用户询问 project flow 状态、实验、任务或门禁，或想登记一次实验、一个任务、一次门禁运行时使用。
---
# project-flow-usage

技能名：`project-flow-usage`。用 `flow` CLI 维护 `.dsh/flow/` 里的实验、任务与门禁；
面板读同一份 store（唯一写动作是未初始化空态上的「初始化」按钮，同样走 core）。
所有命令都接受全局 `--root <dir>` 与 `--json`，**位置不限**（`parseArgv` 全位置扫描，
`flow --root P task list` 与 `flow task list --root P` 等价）。

## 实验：生命周期与谱系

状态：`open`（新建默认）→ `confirmed` | `refuted`，任何阶段可改 `abandoned`。
一次实验一条记录，用 `metrics` 存结构化数字，`measured` 存一句话结论。

`exp add` 对新记录有**七个必填字段**（`CONTRACT §3.1`）：`--direction`、`--expected`、
`--primary-metric`、`--guardrail`（可重复，至少一次）、`--falsify`、`--window-days`（正整数）、
`--stop-loss`；外加 `--title` 与 `--hypothesis`。缺一个即 `invalid`。

```bash
# 新建（id 自动生成 E-YYYYMMDD-NN）；下面是最小可用的完整形态
flow exp add --title "focus 归一化降 tie" \
  --direction "focus 归一化后对比度是否下降" \
  --hypothesis "归一化后 tie_mean<=1.0" \
  --expected "tie_mean<=1.0" \
  --primary-metric tie_mean \
  --guardrail tie_max \
  --falsify "tie_mean>1.0" \
  --window-days 7 \
  --stop-loss "tie_mean>2.0 连续两天" \
  --factor focus/normalize --scale small

# 在父实验下开子实验（parent 必须已存在）；七个必填字段同样要带全
flow exp add --title "调 PI 增益" --parent E-20261028-01 --factor focus/pi \
  --direction "PI 增益对收敛速度的影响" --hypothesis "增益 2x 后 step 减少 30%" \
  --expected "steps<0.7*基线" --primary-metric steps --guardrail tie_max \
  --falsify "steps>=0.7*基线" --window-days 7 --stop-loss "连续两次发散"

# 记录结果并判定
flow exp update E-20261028-01 --measured "tie_mean=0.4" \
  --metrics '{"tie_mean":0.4,"runs":3}' --status confirmed

# 关联提交（逗号分隔）
flow exp update E-20261028-01 --commits abc1234,def5678

# 查看
flow exp list
flow exp show E-20261028-01
flow exp tree                # 按 parent 缩进；未知 parent / 成环按根显示
```

- `flow exp add` 的 id 固定自动生成，不能指定；`--parent` 指向不存在的实验会直接报
  `invalid`（退出码 2）。
- `exp update` 不能改 `id`/`schema`/`created_at`，但会自动刷新 `updated_at`；任务另有
  `title`/`type` 也不可改（见下「任务」段）。
- 删除需 `--yes`：`flow exp rm E-20261028-01 --yes`（不带 `--yes` 且非交互 → 退出码 1）。

## 任务：状态流转

`draft` → `active` → `done`，废弃用 `archived`。`scope` 用 `--json`/API 维护，
CLI 只暴露常用字段。

- **`title` 是"标题兼目标"**：`goal` 已并入 `title`，`task add/update` **没有** `--goal`
  （传了是未声明参数 → 用法错误 `exit 1`）。目标就写进 `--title`，用 ` — ` 分隔。
- `task add` **必填** `--type`（`feat`/`fix`/`docs`/`style`/`refactor`/`perf`/`test`/`chore`/
  `build`/`ci`，conventional commit 类型）；缺 → `invalid: type is required`。

```bash
flow task add --title "接 CLI 与面板 — 跑通主链路" --type feat \
  --status active --owner agent-a
flow task list
flow task show T-20261028-01
flow task update T-20261028-01 --status done --notes "测试全绿"
flow task rm T-20261028-01 --yes
```

- `task update` **不能改** `id`/`schema`/`created_at`，也**不能改** `title`/`type`
  （→ `invalid: task <key> cannot be changed`，退出码 2）；换标题就新建任务。
- 旧记录磁盘上的 `goal` 键由格式门禁的 `normalizeTaskFormat` 迁移到 `title`
  （`title = "<旧 title> — <旧 goal>"`），**不是数据丢失**。

## 项目任务 ↔ Team 任务（Agent Teams 执行视图）

项目台账（`.dsh/flow/`）是 **durable 真源**；Agent Teams 的共享任务板（`team_task_*`）只是本次
Lead 会话的执行视图，随会话消失。两者用文本字段对接（用户已确认，写死）：

| 方向 | 位置 | 写法 | 谁写 |
|---|---|---|---|
| 项目 → Team | Team 任务 `description` 首行 | `flow: <T-id>`；一张 Team 任务只对应一个项目任务 | Lead 建卡时写 |
| Team → 项目 | 项目任务 `notes` | `team: <taskId>`（可带 branch / commit / 验收结论） | Lead |
| 状态 | Team `pending` / `in_progress` / `completed` | 项目 `draft` / `active` / `done`；**已合并**才置 done | Lead |
| 证据 | 项目任务 `commits` | Lead 合并后回填合并提交与纳入的贡献提交；队友不写 | Lead |

- **只有 Lead 写映射**：队友（Team 子代理）不 `flow task update`、不建卡、不写心跳（心跳只面向
  主会话）；进度经 Team 卡与最终报告回 Lead。
- **禁止双写**：`status` / `commits` / 验收结论只在项目台账写权威值；Team 卡状态只作执行视图，
  不把同一进度叙事两边各写一份。
- **`notes` 是覆盖式更新**：回记时保留原 notes 内容再拼 `team: <taskId>` 与验收结论。
- **会话结束前回收**：Lead 逐张 Team 卡把状态、结论、提交回收到项目任务；离开会话前不允许有
  “只活在 Team 板里”的交付。
- 项目流面板**不做** Team 投影（T-26 已删）；Team 板只在原生 Agent Teams UI 看，映射只走上述字段。
- 示例（Lead 在主工作区回记）：

  ```bash
  flow --root /path/to/main-workspace task update T-20261030-31 \
    --notes "原 notes…；team: task-6；branch t-20261030-31-x；已合并 <sha>"
  ```

## 门禁：定义 + 运行记录

门禁是**定义**（`gates/<id>.json`）加**运行记录**（`logs/<id>/<ts>.json`）。步骤顺序执行，
首个失败即停；命令在项目根执行，`expect` 支持 `exit 0`、`exit N`、`contains:文本`。

```bash
flow gate add --id precommit --title "提交前检查" --phase commit \
  --step 'tests=node --test test/>>exit 0' \
  --step 'diff=git diff --check>>exit 0'

flow gate run precommit
flow gate run precommit --timeout 120      # 覆盖本次所有步骤超时（秒）

flow gate list                             # 每行带最近一次运行结果
flow gate show precommit
flow gate logs precommit --limit 5         # 新→旧；失败步骤打印末尾输出
flow gate update precommit --enabled false
flow gate rm precommit --yes
```

- `gate update --step` 会**整体替换**步骤列表；想追加就把旧步骤一起写上。
- 门禁失败**不是命令失败**：`flow gate run` 仍退出 0，结果看 `data.ok`
  （`--json` 时 `{ok:true,data:{ok:false,...}}`）。脚本里判断：

```bash
flow gate run precommit --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(JSON.parse(s).data.ok?0:1))"
```

- `--json` 输出形状：成功 `{ok:true,data}`，失败 `{ok:false,error:{code,message}}`；
  退出码 0 成功 / 1 用法 / 2 校验 / 3 未找到 / 4 IO。

## 项目描述：文件图 / 模块图 / 模块语义

`.dsh/flow/description/` 把「有哪些文件」升级成「每个文件/模块干什么」：结构由命令自动同步，
语义由你写。**不要手改 JSON**——锁与原子写都在 core，手改只会被 check 判成漂移。

| 命令 | 作用 |
|---|---|
| `flow desc build [--dry-run]` | 扫 `include` 范围，建/同步文件记录（哈希、行数、import、模块边）；无变化不写盘 |
| `flow desc status [--json]` | 文件数 / 模块数 / 缺语义 / 计划数（`flow status` 也有一行摘要） |
| `flow desc show [--path <src>] [--graph tree\|mermaid]` | 看单个文件的模块与语义，或整张文件图 |
| `flow desc set --input <json>` | 补/改文件或模块语义（单对象或数组；**不写结构字段**） |
| `flow desc plan <T> --template <src>` | 打印计划骨架（由当前记录生成，先 build 再取） |
| `flow desc plan <T> --input <json>` | 建/改语义变更计划（`--rebase` 只刷新 base）；`--show` 查看 |
| `flow desc plan <T> --no-semantic-change --reason "…"` | 声明本次无语义变更（与 `files` 互斥） |
| `flow desc apply <T> [--dry-run]` | 把计划语义落进文件记录，计划转 `implemented`（幂等） |
| `flow desc render [--out <p>] [--check]` | 生成/比对 `description.render` 指向的文档 |
| `flow check description [--task <T>] [--strict]` | 漂移检查；`--task` 加计划对齐，`--strict` 把欠账算失败 |

**三阶段职责**（规则真源是 `CONTRACT.md` §3.7 / §6.1.4；本技能只规定谁在什么时候跑哪条命令，
不重定义字段）：

| 阶段 | 谁 | 做什么 | 怎样算过 |
|---|---|---|---|
| 分析 | 分析者 | 读代码写计划：哪些文件/模块新增、修改、删除，各自语义是什么；**不动代码** | 计划合法：`files` 非空 xor `noSemanticChange` + `reason` |
| 实现 | 实现者 | 写代码 → `build` 同步结构 → `apply` 落语义 → `set` 补计划外模块 | 计划 `implemented`、无 `stale-hash` / `unknown-member` |
| 审查 | 审查者 | 复跑 `flow check description --task <T>`，并确认 `testGate` 有晚于 `implemented_at` 的绿记录 | 检查全绿、测试证据齐 |

```bash
flow desc build                                    # 第一次先建记录（语义为空）
flow desc plan T-20261108113206 --template lib/core.mjs > plan.json
# 编辑 plan.json：files[].semantics、modules[]（id 用 slug，members 必须是真实声明名）
flow desc plan T-20261108113206 --input plan.json  # 分析阶段的产物
flow desc build                                    # 实现阶段：结构变化先进记录
flow desc apply T-20261108113206                   # 语义落盘；计划冻结
flow desc set --input modules.json                 # 补计划没覆盖的模块语义
flow check description --task T-20261108113206     # 审查阶段
```

- **模块 id**：`^[a-z0-9][a-z0-9-]{0,40}$`、文件内唯一；`members` 写**声明名**（函数/类/顶层变量），
  不是任意标识符。扫描可能漏（解构声明、匿名默认导出、生成代码）：**漏扫不要求归属、也不会假红**；
  但已归属的成员必须真实存在。
- **模块边不要手写**：`moduleEdges` 由 build 从「模块 A 的成员引用了模块 B 的成员」推导；手写会被
  `stale-module-edges` 判红。
- **语义下限**：项目/文件/模块的 `semantics` 去空白后要 ≥ `minSemanticsChars`（默认 10 字符）。
  这是防呆不是质量线——「占位」「待补」能过检查，但审查者会打回。
- **写窗口**：计划只在 `stage ∈ {queued-analysis, analyzing, implementing}` 可写；`apply` 后**冻结**。
  审查阶段要改计划，先把任务退回 `implementing`，不要就地改。
- **跳过是显式的**：`description.enabled=false`，或「`enforce: auto` 且一条文件记录都没有」时，
  `check description` exit 0 并打印「未建立描述，跳过」；看 `mode` / `counts` 判断是真过还是没查。

## 项目状态

```bash
flow status            # 项目名、契约源、计数、最近 3 条实验/任务/门禁运行
flow --json status     # 同上 + data.store 绝对路径
```

## 与 git 的关系

- `.dsh/flow/` 是真相源：可以提交，实验的 `commits` 字段负责回指提交；
- 提交信息里的 `Exp-Id`/`Verdict` trailer **不再被读取或迁移**；实验与提交的关联改用
  `flow exp update <id> --commits <sha>` 维护。
- 写锁 `.dsh/flow/.lock` 不要提交；并发写会得到 `conflict`（退出码 2），重试即可；
- 需要给面板/他人看时不用导出：面板直接读同一份 store。

## 分支/工作树与台账

中心-贡献者模型下（贡献者在自己分支提交、中心唯一合并与写台账；协议见
`ai-collaborative-dev-workflow/references/contribution-flow.md`）：

- **台账真源在主工作区**：`.dsh/flow/` 只在主工作区初始化与提交；工作树继承已提交的
  台账，**不要**在工作树里 `flow init` 或另建 store，否则会出现两份互不相认的卡片。
- **中心唯一写台账**：贡献者不 init、不建卡；需要更新状态时经中心，或用 `--root` 显式
  指向主工作区（且需中心同意）。
- **子会话写卡必须 `--root` 主工作区**：面板只按**当前工作区**查找 `.dsh/flow/`，而且
  **看不到某会话在哪条分支**。在子 worktree 里直接 `flow task add` 会把卡写进工作树，
  主面板看不到，合并时才变成"多出来的文件"。正确写法：

  ```bash
  flow --root /path/to/main-workspace task update T-20261030-02 --status active --notes "..."
  ```

- **分支信息写进文字**：心跳 `last_action`、任务 `notes`、提交评审申请三处都写
  `branch` + `worktree path` + `commit`；这些不会自动出现在面板上。
- 心跳可留在各自工作树（运行态、不入台账），但不要靠心跳在工作区自动建卡，也不登记
  文件锁。
- 提交评审申请模板：`ai-collaborative-dev-workflow/assets/merge-request-template.md`。

## 排错

| 现象 | 原因与处理 |
|---|---|
| `错误（usage）：run flow init first ...` | store 未初始化，先 `flow init` |
| `错误（conflict）：store is locked ...` | 另一个写者持有锁，等它结束或等 30 秒过期后重试 |
| `错误（invalid）：parent experiment does not exist` | 先建父实验，或确认 id 拼写 |
| `错误（not-found）：experiment E-... not found` | id 不存在：`flow exp list` 核对 |
| `gate run` 退出 0 但结果失败 | 门禁本身失败，检查 `data.steps[].tail` |
| 记录读不出来 | `--json` 会带 warning；删除坏 JSON 前先备份，别手改 id |
| `✗ plan-missing` | 该任务没有合法计划：先 `flow desc plan <T> --template <src>` 写一份；确实无语义变更就 `--no-semantic-change --reason "…"`（`files` 与它互斥） |
| `✗ plan-unrealized` | 计划还是 `planned`：实现阶段跑 `flow desc apply <T>`；审查阶段才发现，说明漏了 apply，回实现者补，不要在审查期改计划 |
| `✗ stale-hash` | 记录哈希 ≠ 当前文件（改了文件没 build）：`flow desc build`；然后确认 `semantics` 是否也要更新（测试证据起点取记录 `updated_at`） |
| `✗ tests-missing` | `description.testGate` 没有晚于 `max(implemented_at, 计划内记录 updated_at)` 的绿记录：跑门禁（如 `flow gate run tests`），或先 `flow desc apply <T>` 刷新起点 |
