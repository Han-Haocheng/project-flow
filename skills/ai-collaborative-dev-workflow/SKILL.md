---
name: ai-collaborative-dev-workflow
description: 通用 AI 协作开发工作流，只有一个流程：中心-贡献者（maintainer）模型。中心是集成权威——唯一合并主分支、唯一写主分支台账、唯一决定合并顺序，并对每份提交按五条清单做合理性判定（accept / reject / request-rebase）；贡献者（子代理、队友、外部协作者、人）在自己分支产出可评审提交与证据，向中心提申请，不与其他贡献者协调、同步或互锁。仅依赖 shell 系统命令与 git（工具链命令由项目技能以"命令契约"声明）：提交归属纪律（pathspec 提交）、默认提交即写 CHANGELOG（项目可覆盖）、分支纪律（发布分支只接收合并）、发布节奏（git 基线计数阈值或里程碑 --force）、环境与协作陷阱。长期项目需处理多会话、上下文压缩、对话中断等连续性场景。最高硬性约束：代理有权也必须反驳和纠正用户提出的内容与建议，包括错误、不合理或不建议之处，并说明对未来项目的影响；普通任务说明后即可执行；本地可回退的操作（含 commit）不需要逐次确认，push 等不可逆或范围外操作仍需当次确认。适用于协调多个 AI 子代理/队友处理开发提交、版本发布节奏、协作环境问题排查；单人项目是"中心=唯一贡献者"的退化情形，仍跑门禁与 CHANGELOG 纪律，不是另一种模式。
metadata:
  short-description: 中心-贡献者协作开发工作流
---

# AI 协作开发工作流：中心-贡献者模型（通用版；仅系统命令与 git）

> 随 `@local/project-flow` 插件分发（技能来源 `bundled`）：`resourceBase` 即本文件所在目录，文中 `references/`、`assets/`、`scripts/` 均相对该目录解析。

> 技能版本 2.15（2026-11-04）：随 project-flow 插件分发；检查入口 `flow check`。**2.15**：实验型项目一节——七段流程、假设七字段硬规范（缺一即拒）、结果分流四分支（成功/不确定/失败/转向）、任务 `experiment` 字段与 `exp/<E-id>/<topic>` 分支（§十二）。**2.14**：团队派工规范——命名（队友名 `<role>-<scope>`、任务标题 `<feat|fix|chore>: <范围>`，§10.2.1）；配比 `round(N×0.25) / round(N×0.375) / 余数`（§10.2）；七阶段生命周期与现有状态的映射（§10.3.1）；关键路径与满编调度、满编六条、每轮对账、Lead 派工检查清单（§10.6）；空转三分法与派工前三问（references §3.3）。**2.13**：团队名额上限内按角色配比建满（§10.2 / §10.6）；Lead 收口改为队友 `send_message` 回报唤醒，**默认不 `wait_agent`**（仅排障，§10.6 / §10.7）。**2.12**：Agent Teams 固定四类角色（中心 / 分析者 / 实现者 / 审查者）+ 一条状态机 + 四类交接物 + Team 卡 `role:` / `domain:` 标注 + 单域小任务降级（§十）。**2.11 重写**：唯一流程改为**中心-贡献者模型**（§一）——中心唯一合并主分支、唯一写主分支台账、唯一决定合并顺序，并对每份提交做合理性判定；贡献者在自己分支提交并提评审申请，中心只给 accept / reject / request-rebase 三种结论。删除上一版的整套差异化流程与两套并行工作方式、令牌与文件锁；分支隔离降为"让提交可评审"的手段（§1.3）。贡献者与中心两侧的完整操作见 `references/contribution-flow.md`。2.10：接入 Agent Teams。2.9：精度层参考实现（task/doc_check/gate）。2.7：新项目接入清单。2.4：授权模型与 DSH 0.2.0 工具面（任务板 / 团队 / 时效纪律）。2.3：任务板卡片模式。

本技能只有一个流程：**一个项目有且只有一个中心负责合并与同步，其余人产出可评审的提交与证据，由中心判断提交是否合理**。没有模式开关、没有多中心协商；单人就是"中心与贡献者合一"的退化情形（§1.5）。与语言/构建体系无关。**本技能的命令只使用 shell 系统命令与 git**；随包附带的 `scripts/` 运行需要 `bash`（`doc_check.py`、`gate.py`、`task` 另需 `python3`），项目若在 CI / 非 DSH 环境使用，应把需要的脚本复制进仓库（如 `.agents/scripts/`）随版本管理，而不是依赖某个用户级目录里的副本。类型检查、lint、构建、测试、打包、安装依赖等工具链操作一律由项目技能以"命令契约"声明（见〇）。

> 依据（2026-10-30 用户判断）：AI 使用经验足够后，"多人多 AI 同进同退"不是必要复杂度。一个项目一定有一个中心负责合并与同步，只需要判断提交是否合理即可。贡献者之间不必互相协调、同步、建令牌或登记文件锁；这些机制换不来正确性，只增加流程成本。

> 本流程面向你长期维护的自己项目：默认 dev 单线集成、master 正式 / beta 预发布、提交即写 CHANGELOG。项目技能 / AGENTS.md 另有约定时，以项目为准（例如项目禁止代理写 CHANGELOG 时，不执行"提交即写 CHANGELOG"）。

## 硬性约束（最高优先级，违反即事故）

1. **有权且必须反驳**：用户提出的内容、建议或方案，只要存在错误、不合理、不建议之处，或会累积成未来项目负担（如设计债、范围膨胀、兼容性风险），必须先指出并说明理由、影响与替代方案，不得照单执行。没有实质问题时明确说"没有异议，按你的意见执行"，不为反驳而反驳。
2. **反驳后直接推进普通任务**：反驳与建议按 [assets/advice-format.md](assets/advice-format.md) 回馈后，普通任务按已确认的任务书直接执行，不需要每条指令都等用户确认。
3. **本地操作直接做，push 必须当次确认**：`commit`、`merge`、`cherry-pick`、在自己分支上的 `rebase`/`amend`、建/删本地分支与工作树，都是**本地可回退**的操作，不需要逐次确认。需要当次明确确认的只有两类：①**push**（含 tag push、force push、删除远程分支）；②**已推送分支的历史重写**。此外仍按敏感操作确认：删除数据（`rm -rf`、删文件/分支/工作树）、覆盖他人未提交改动、改依赖、动发布分支、改 CI/发布工作流、改版本声明、改动契约外文件。判断标准：**本地能回退的不用问，push 之后难改的必须问**。
4. 执行中发现偏离已确认方案，先停止并回馈，再等用户确认；不得自行扩大范围。
5. 只读调研、查证、阅读代码可直接做，用于形成反驳与建议。
6. **授权分层**：任务书经用户确认后，贡献者在任务书范围内向中心负责，不再逐条找用户；范围外动作回到用户确认。贡献者发现任务书或中心指令不合理，也必须反驳中心，不照单执行。

## 〇、项目命令契约（唯一的工具扩展点）

- 项目技能必须声明一份命令契约，协作开始前由中心确认，任务书直接引用：
  - 验证命令：typecheck / lint / build / test / smoke（可缺省，缺省项在任务书注明"本项目无此项"）；
  - 版本声明位置清单：版本号需要同步修改的全部文件；
  - 发布脚本入口与冒烟方式、Release/CI 集成约定（如适用）；
  - 工具链禁令细节（临时执行器、依赖安装的限制等）；
  - 分支名与 CHANGELOG 策略（默认：dev / master / beta；提交即写 CHANGELOG）。
- 本技能对这些命令只有流程要求：0 错误基线、全绿才提交、中心验收时全仓复跑。
- 写代理禁止使用契约之外的构建/包管理工具，禁止安装或升级任何依赖；直调工具一律用本地已安装入口，禁止包管理器的"临时执行"模式。
- 项目技能缺失或过时时，中心先与用户拟定最小命令契约（验证命令、版本声明位置、禁止项、分支约定），写入任务书后再开工。

## 与 project-flow 插件的分工

- **台账/存储归插件**：`.dsh/flow/` 由 `@local/project-flow` 拥有——写入口是 `flow` CLI 与 `flow_*` 工具，面板是只读视图；记录字段、schema 与校验以插件 `CONTRACT.md` 为准。
- **本技能只管流程纪律**：角色与判定、命令契约、质量门禁、提交/发布/交接纪律。**不得重定义记录字段**；需要记实验/任务/门禁时调用插件，不要在技能或项目文档里另立一套字段。
- **机械检查由插件提供**：`flow check staged|release-baseline|state|doc`（DSH 内首选入口）。同一批脚本随本技能分发在 `scripts/`，项目可在 CI / 非 DSH 环境把需要的脚本复制进 `.agents/scripts/` 直接运行。

## 一、唯一流程：中心-贡献者（maintainer）模型

> 一句话：**中心负责合并与同步，贡献者负责产出可评审的提交；提交是否合理由中心判定**。贡献者之间不协调、不同步、不排队、不互锁。

### 1.1 两个角色

| 角色 | 谁 | 能做 | 不能做 |
|---|---|---|---|
| **中心**（Lead / 集成权威；旧文档称协调者） | 主工作区会话、项目维护者 | 唯一合并主分支；唯一写主分支台账与 CHANGELOG；决定合并顺序与取舍；对每份提交做合理性判定；合并前与合并后复跑门禁；派工与最终汇报 | 替贡献者在其分支上代写代码（接管时必须写明 branch + commit 交接）；跳过判定直接合并；用"看板/工具显示成功"代替验收 |
| **贡献者** | 子代理、队友、外部协作者、人 | 在自己的 branch/worktree 里提交；跑门禁；按模板提评审申请；按结论 rebase、补提交或放弃 | 合并、push、切换或写主分支、写主分支台账、替其他贡献者排队或协调 |

- **主分支只有一个写入者：中心**（dev 为集成线，master/beta 为发布线，以项目契约为准）。发布分支仍只通过合并接收集成线内容。
- 贡献者之间**不建令牌、不登记文件锁、不互相排队**。两条分支改了同一文件时，由中心在合并阶段按 diff、时间与合理性裁决：保留最新且正确的版本，另一份要求重提或丢弃。
- 中心对本项目所有提交负责：没看过的 diff 不合并，没复跑的门禁不算过。
- **组队时（§十）**：五条清单的逐条结论先由**独立审查者**做（不得是实现者），中心复跑门禁后**最终裁定**（可推翻审查结论，须写明理由）；单域小任务不组队时中心自析自验（§10.8），审查权仍不交给实现者本人。

### 1.2 申请 → 判定 → 三种结论

1. 中心在任务书（贡献者须知）里写清 base、允许文件域、验证命令、交付格式与停止条件（[assets/task-brief-template.md](assets/task-brief-template.md)）。
2. 贡献者完成提交、跑门禁，按 [assets/merge-request-template.md](assets/merge-request-template.md) 发**提交评审申请**：task id、branch、工作树路径、base commit、commits、改动文件、测试命令与结果、影响面、风险、希望中心做什么。申请必须写 **branch + path + commit**（面板与工具面看不到分支）。
3. 中心按 §1.4 的五条清单判定，只给三种结论之一（组队时先由独立审查者逐条复核给结论，中心最终裁定，见 §10.3）：
   - **accept**：由中心合并。默认 `git merge --no-ff <branch>`（保留合并点，便于回退）；分支历史杂乱或只要个别提交时 `git cherry-pick <sha>`；仅当分支是主分支的直线后继且项目允许时才 fast-forward。合并后**复跑门禁**，更新台账，再决定保留或清理分支/工作树。
   - **reject**：给具体理由——哪条清单不满足、哪段 diff 不该有、缺什么证据、影响面哪里没同步；同时给替代做法。被 reject 的提交不原样重提。
   - **request-rebase**：集成分支已前进，或存在可自动化解的冲突 ⇒ 贡献者把**自己**的分支 rebase 到中心给出的新 base，解决冲突、复跑门禁后**重新提申请**。中心不在自己的主工作区替贡献者解冲突，也不替贡献者 rebase。
4. 贡献者的"完成"是申请，不是交付；中心的"看过"是判定，不是口头通过。合并动作只属于中心。

### 1.3 分支隔离：让提交可评审的手段

分支隔离的目的不是分布式协调，而是让中心能拿到**独立、可回退、可比较**的一组提交。

- **有 `@deepseek-ai/dsh-experimental-tool-worktree` 时**：贡献者**自己**调用 `create_worktree({ name?, from? })` 建工作树+分支并进入。该工具**只创建、不合并**，且会把**调用者**的 cwd 切到新工作树 ⇒ 中心代建只会切走中心自己的 cwd，贡献者仍留在原地。中心只给 name 与 base。
- **没有该工具时**：贡献者用普通本地分支（`git switch -c <task-id>-<slug> <base>`）。若与中心共用同一个 checkout，必须由中心确认此刻不在主工作区并行工作，否则贡献者先用 `git worktree add <path> <branch>` 自建独立工作树（这一步只创建，不合并）。
- **base 写死**：一律用任务书声明的集成线提交；申请里记 `baseCommit`，中心用它算 diff 范围。不 fetch；要远端最新就由中心先同步，贡献者再从同步后的提交起分支。
- **只在自己分支写**：不 push、不 merge、不切主分支、不 rebase 他人分支、不改主工作区。需要离开时用 `working_directory` 切回主工作区，工作树与分支保留。
- **失败保留现场**：不删工作树、不 reset。报告"已提交到分支 X（path，n 个提交，HEAD sha）"或"未提交（path，改动文件…）"，由中心接管或丢弃。
- 完整操作（贡献者侧全流程 + 中心侧验收与清理 + 常见错误）：[references/contribution-flow.md](references/contribution-flow.md)。

### 1.4 中心判定清单（五条，写死；逐条给结论）

1. **diff 与任务范围是否一致**：文件都在任务书允许的文件域内；无夹带、无无关格式化、无密钥、无生成物、无越界重构。
2. **门禁/测试复跑结果**：**中心自己复跑**契约命令（申请里的结果只作参考），看命令、退出码与末尾输出；全绿才算过。
3. **影响面**：接口/共享类型、台账、文档、CHANGELOG、版本声明是否同步；影响域是否被任务书覆盖；外部可见行为是否说明。
4. **提交信息与证据是否充分**：提交粒度可独立验证，message 说清"为什么"，申请含命令原文 + 退出码/摘要，风险与未完成无隐瞒。
5. **是否与当前集成分支冲突**：先 `git merge-tree`（或 `--no-commit` 试合）预判；能自动化解或只需要换 base ⇒ request-rebase；与用户未提交改动或他人在改的文件冲突 ⇒ 停下问用户，不覆盖。

五条全过才 accept；任何一条不过，给出 reject 或 request-rebase，并写明缺的是哪一条。判定结论与理由写进任务 notes（含 branch + commit），不只在对话里说。

### 1.5 单人：中心与贡献者合一（退化情形，不是模式）

- 一个人做时，中心与贡献者是同一个会话：直接在主分支提交，但**门禁照跑、CHANGELOG 照写、提交信息照写清"为什么"**，发布纪律不变。
- 没有"单人可跳过台账/门禁"的档；台账规模可以小，纪律不减。需要留证据时仍写一条任务 notes 或申请记录，方便未来的自己或接手的中心复核。
- 一旦出现第二个写者（子代理、队友、外部协作者），直接按 §1.1–§1.4 走，**不需要切换配置或模式**。

### 1.6 提交与分支纪律（贡献者、中心都适用）

- **提交归属**：只 `git add` 自己文件域内的文件（禁止 `git add -A`）；**commit 带 pathspec**：`git commit -m "..." -- <自己的文件>`；提交前用 `bash scripts/check_staged_files.sh <允许路径...>` 或 `git diff --cached --stat` 自检；误 add 他人文件用 `git restore --staged <file>` 摘出（只动暂存区不动工作树）。
- **分步提交**：每个可独立验证的步骤一次提交（`feat:`/`fix:`/`style:`/`chore:`/`refactor:`/`docs:` + 中文或英文说明）；每个目标达成即提交。
- **CHANGELOG**：默认随提交写入 `[Unreleased]`（贡献者写在自己分支的提交里；项目另有约定时遵项目）。中心合并时若与主分支冲突，由中心决定合并顺序或要求贡献者重提。
- **发布分支纪律（硬性）**：master / beta 等发布分支**只由中心通过合并接收集成线内容**——禁止直接提交、禁止 cherry-pick 到发布分支、禁止 force 更新。
- **提交不需要确认，push 才需要**：本地 `commit`/`merge`/分支操作直接做（本地可回退，见硬性约束 3）；只有 push（含 force push、tag push）与已推送历史重写才找用户当次确认。
- **push 归中心**：贡献者不 push；中心完成合并且复跑门禁后统一 push（push 属敏感操作，按硬性约束当次确认）。

## 二、质量门禁（每次提交/合并后必跑，命令全部来自契约）

1. **静态检查**：契约中的 typecheck + lint，**0 错误基线**。
2. **静态检查盲区扫描**：类型检查/lint 覆盖不到的构造——动态导入/反射、宏或模板生成代码、`include!` 引入的生成文件、内嵌脚本块、配置引用等——对新增/重写文件必须补扫或人工核查。
3. **资源与文案同步**：用户可见文案/资源变更必须同步全部语言或资源文件。
4. **全绿基线**：契约全部命令通过后才提交；中心在合并前与合并后各复跑一次。

## 三、发布节奏

- 阈值：dev 自上次发布基线累积 **N 个提交**（默认 10，项目可调）后自动发布下一版；手动里程碑用 `--force` 跳过阈值。
- 发布前契约 build/test/smoke 全绿；冒烟统一用**环境变量门控探针**模式。
- 版本 bump 脚本化并同步契约列出的全部版本声明位置；预发布后缀 `.N` 从正式基线重新起算。
- 分支纪律：beta 用临时 worktree 合并接收 dev，main/master 快进；禁止直推、cherry-pick、force。发布动作由中心执行。
- 详细流程与停止条件：[references/release-flow.md](references/release-flow.md)

## 四、环境与协作陷阱

完整清单见 [references/collaboration-traps.md](references/collaboration-traps.md)。核心几条：

- 多行脚本/代码**先写成文件再执行**，不内联进工具参数或字符串拼接。
- 连续编辑同一文件前重读目标区段；批量/长文档改动走"整文件读 → diff → patch"；只有新建文件才整文件 write。
- grep 的结论要用第二种方法复核（编译错误、依赖树、运行时行为）。
- 贡献者"已派工"不等于"已产出"：用 `git status` + 文件 mtime 核实。
- 门禁变红/合并冲突/脚本失败：保留现场，停止盲目重试，上报中心。

## 五、协作流程清单（中心视角）

> 派工前先执行「硬性约束」：预研、反驳与建议回馈给用户；任务书获得确认后，范围内推进，范围外与敏感操作当次再确认。新会话、上下文压缩或中断恢复时，先执行「六、长期项目与会话连续性」的恢复协议。

1. **选执行面（先定怎么跑）**：中心先读项目任务与进度（`flow_task list` / `flow_task show`），再按顺序选执行面——**本次会话内有多路可并行写域、或需要来回追问/补证据 ⇒ Agent Teams（§十，默认，按四类角色跑）**；**跨会话 / 无人值守 / 要钉工作区与权限 ⇒ Host 任务板卡片（§九）**；**大规模只读扇出 ⇒ `workflow` / 并行子代理**；**一次性只读调研，或当前会话工具列表里没有 Team 工具 ⇒ 一次性 subagent（唯一降级，只做只读）**。项目任务再多、只有一条写线时也不组队：中心自己推进更快。
2. **分析（只读）→ 任务书**：组队时先把项目任务交给分析者（`role: analyst` 卡）只读出任务书：目标、范围/base、文件域切分、验收标准、验证命令、风险、依赖（[assets/task-brief-template.md](assets/task-brief-template.md)）；中心确认后才派实现。单域小任务不组队，中心自析自验（§10.8）。
3. **拆分：项目任务 → Team 任务**：按**文件域与依赖**拆三类卡——分析卡（`role: analyst`，只读）、实现卡（`role: implementer` + `domain:`，一片可独立验收且域不相交的写域）、审查卡（`role: reviewer`，只读，`blocked_by` 实现卡）；`description` **首行 `flow: <T-id>`、第二行 `role:`，实现者第三行 `domain:`**（一张卡只对应一个项目角色/一片域；要覆盖多个就拆多张），正文写任务书路径、交付格式（分支 + 提交 + 证据 + 申请/结论）与停止条件；依赖用 `blocked_by`、文件域用 `write_scopes` 预声明（**协调信息，不是锁**）。拆完由中心把 `team: <taskId>` 回记到**项目任务 notes**——项目台账是 durable 真源，Team 板只是本次会话的执行视图。
4. **派队友**：`spawn_teammate`（Lead 专用）按角色建持久队友——实现者每人一条分支/worktree、一片 `domain:`，**审查者必须是非实现者**；prompt 必须自带 role/domain 标注、Team 任务 id、项目 task id、任务书路径、base、允许写域、映射约定、交付格式与停止条件（队友看不到 Lead 的对话）。**建卡与派工都不会自动开跑**：队友按 `team_task_get` 取当前 revision 后 `claim`；Lead 用 `send_message` 唤醒或追加指令。人数与配比见 §10.2、命名见 §10.2.1（不在本清单复述数字）；唤醒后**结束本轮等队友 `send_message` 回报**，不用 `wait_agent` 干等。
5. **外部世界核对**：派工/恢复前做 `git status`、当前 HEAD、台账 `COLLAB_STATE.md`、远端/CI 是否变化；未归属改动先冻结并询问用户。
6. **实现者产出**：队友认领后只在自己的分支/worktree、只写自己 `domain:` 内的文件，按任务书提交、跑门禁、按模板提评审申请（branch + path + commit + 命令结果 + 影响面 + 希望中心做什么），完成后把实现卡置 `completed`；**不写项目台账、不写心跳、不合并、不审自己**。
7. **审查者复核**：审查者认领审查卡（`blocked_by` 对应实现卡），只读 + 跑测试，按 §1.4 五条清单独立复核 diff / 范围 / 门禁 / 契约影响，给 **accept / reject（具体理由）/ request-rebase（新 base）** + 证据；**不得是实现者**，不改代码、不合并。
8. **中心裁定与合并**：中心按 §1.4 复跑门禁并做最终裁定（**可推翻审查结论，须写明理由**）；accept 才合并（`git merge --no-ff` / `git cherry-pick` / 允许时 fast-forward）→ 复跑门禁 → 更新项目任务（status / commits / notes 含 `team:` 与验收结论）→ 回收 Team 卡 → 清理工作树与分支（保留现场原则）。
9. **会话结束前逐卡回收**：Team 板随 Lead 会话消失（与 Host 任务板卡片不同），离开会话前必须逐张检查 Team 任务：没有 `in_progress` 悬空，没有"结论只写在 Team 板/对话里"的交付，每张实现/审查卡的角色与结论都在（实现者未自审、审查者未改代码），每个项目任务 notes 都能独立恢复（映射 id、branch/commit、验收结论）。检查单见 [references/contribution-flow.md](references/contribution-flow.md) §8.2 与 [references/agent-teams-and-tasks.md](references/agent-teams-and-tasks.md) §3.1。
10. **核实产出**：中心核实贡献者产出——`git status` + 文件 mtime 与最终答复；**卡片**看**会话产出**（最后一次 `turn/end` 的 reason + 有无实质文本——**看板绿 ≠ 交付**，被中断的执行会被记成 succeeded）。长时间无改动则中断并接管（接管时记录 branch + commit）。
11. **代理完成报告**：改动清单、行为说明、验证摘要、提交 hash；交付验收四步：产出物存在 → 引用/接口可解析 → 事实零丢失 → 影响域接口兼容。
12. 每满发布阈值执行 `scripts/release_baseline.sh '<发布提交特征>' [阈值]` 并跑发布脚本（含冒烟）。

## 六、长期项目与会话连续性

> 中心是唯一台账写者；贡献者不写主分支台账。恢复协议、心跳、交接与影响域纪律不因角色不同而放松。

- **外部事实源**：每个项目维护 `COLLAB_STATE.md`（模板 [assets/collab-state.template.md](assets/collab-state.template.md)）；台账只由中心写入，贡献者用独立心跳/状态文件上报，中心汇总。
- **恢复协议**：先 `git log -1`、`git status`、读台账与当前任务书，再核对远端/CI；state、git、reflog 矛盾时以 git 为准并回馈差异；复跑受影响门禁。任务仍 confirmed 且范围/基线/任务书未变可续作，变化先回用户确认。
- **状态健康检查与重建**：`scripts/check_state.sh <COLLAB_STATE.md>` 检查版本、更新时间、基线漂移、容量与敏感信息；台账损坏时用 git 历史、reflog、最近任务书与提交重建，重建前不执行。
- **心跳与交接**：写会话记录 owner/session_id/heartbeat 与 **branch + worktree path + commit**；接管前先把 owner 置为 pending，用户确认后才正式接管，禁止双写同一 checkout。
- **授权与审批衰减**：任务书确认后范围内不再逐条确认；敏感操作每次重新确认；台账不存密钥。
- **上下文预算**：启动只加载台账+任务书+命令契约；references 随当前任务读取；台账分 Active/Archive，超过 64KB 先归档。
- **恢复点与回滚**：每目标记录 last-known-good；改坏先 `git checkout` 回退再重做。
- **影响域与接口边界**：任务书同时声明文件边界和影响域/接口边界；涉及共享接口先做依赖分析，验收时复跑受影响模块门禁并检查接口兼容。
- **里程碑复盘**：每里程碑或每 N 提交写复盘结论；被反驳/拒绝的想法写入 Rejected Ideas，恢复或新任务前查重；重复陷阱合入技能。
- **跨机器/配置**：台账用仓库根相对路径；恢复时检查 git 版本、profile、模型与可用工具。
- **目标与自动续轮（goal，DSH 0.2.0 起）**：长跑目标用 `create_goal` 让会话跨自动续轮推进（非单轮任务）；`update_goal complete` 只在**真达成**、`blocked` 只在**同一阻塞连续 ≥3 轮**；**恢复/分叉后目标会被解除武装** ⇒ 用户说"继续/接着干"时先 `resume`（细节见 `references/agent-teams-and-tasks.md` §4）。
- **入仓策略**：台账默认不入 git；入仓与否由项目契约决定，入仓时不写本地路径与敏感信息。
- 详细规则：[references/session-continuity.md](references/session-continuity.md)

## 七、可复用资产与技能分层

- `references/contribution-flow.md`：一次贡献的完整生命周期——选 base → 建分支/worktree → 提交 → 跑门禁 → 写评审申请 → 审查者复核 → 等审查结论 → rebase/重提/放弃；团队四类角色握手、状态机、各角色检查单，中心侧验收、三种结论落地命令、清理与常见错误。提交、审查、验收、合并时读。
- `references/release-flow.md`：发布阈值、版本 bump、分支合并、冒烟与停止条件；发布相关任务时读取。
- `references/collaboration-traps.md`：文件修改工具纪律、结论复核、门禁盲区、协作管理陷阱；遇到工具调用失败/环境问题/派工失联时读取。
- `references/session-continuity.md`：恢复协议、台账单写者、心跳与交接、授权衰减、上下文预算、影响域、复盘与跨机器检查；长期项目/多会话/压缩/中断时读取。
- `references/agent-teams-and-tasks.md`：**DSH 0.2.0 工具面速查**（任务板卡 / 会话定时 / 智能体团队 / goal / workflow 的语义、陷阱与选型表，含"怎么核实工具是否真的在跑"、四类角色到 `team_task_*` / `spawn_teammate` 的映射）；派单前、恢复前，或要判断"板上/调度上是否真有东西在跑"时读取。
- `references/structured-tasks.md` / `task-cli.md` / `doc-standard.md` / `enforcement.md`：精度层（结构化任务、CLI、文档骨架、hooks/CI 接线）。它是**工具而不是模式**：用与不用不改变协作流程，只让任务书、文档、门禁可被脚本校验。
- `references/onboarding.md`：新项目接入清单、AGENTS.md 模板、命令契约与精度层接入顺序；新项目第一次使用时读。
- `assets/task-brief-template.md`：派工时复制为"贡献者须知"（角色 `role` / 实现者 `domain`、base、允许文件域、必须提交与证据、验收字段、禁令、停止条件）。
- `assets/merge-request-template.md`：贡献者向中心提交评审申请时复制（字段、示例、发送前自检）。
- `assets/collab-state.template.md`：派工前复制为项目协作台账（仅中心写入，默认不入 git）。
- `assets/advice-format.md`：给用户回馈反驳与建议时按此格式组织。
- `assets/experiment-brief-template.md`：实验型项目开工前复制（假设七字段、观测周期与止损、结果判定与清理清单）。
- `scripts/check_staged_files.sh`（相对本技能目录；DSH 内优先 `flow check staged`）：提交前核对暂存区是否都在允许清单内。
- `scripts/check_state.sh`（同上；DSH 内优先 `flow check state`）：恢复前做台账健康检查，损坏时进入重建协议。
- `scripts/release_baseline.sh`（同上；DSH 内优先 `flow check release-baseline`）：计算自发布基线以来的提交数并判断是否达阈值。
- `scripts/smoke_test.sh`（同上；无 `flow check` 等价入口，直接 `bash scripts/smoke_test.sh`）：隔离临时仓库回归本技能的核心纪律。
- 技能分层：本技能（流程/纪律，仅系统命令与 git）+ 项目技能（命令契约、工具链细节与禁令、目录结构、基线状态、事故案例）双 skill 组合使用。
- 中心与贡献者都需要 `check_staged_files.sh`、`release_baseline.sh`、`smoke_test.sh`；collab-state 模板与心跳由中心使用；贡献者只需要任务书、申请模板与 `references/contribution-flow.md`。

## 八、验证本技能

- 结构校验：`python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py <本技能目录>`
- 机械检查（DSH 内首选）：`flow check staged` / `flow check release-baseline` / `flow check state` / `flow check doc`，分别对应本技能目录下的 `scripts/check_staged_files.sh`、`scripts/release_baseline.sh`、`scripts/check_state.sh`、`scripts/doc_check.py`。
- 行为回归：`bash <本技能目录>/scripts/smoke_test.sh`（在 `/tmp` 建隔离仓库，不触碰当前工作区；需要可写 `/tmp` 与 `bash`）。
- 精度层不是模式：接入 task/doc 检查只是让任务书与文档可脚本校验，协作流程仍是中心-贡献者；接入顺序先只读、再阻断。

## 九、Host 任务板卡片模式与自动化任务（2026-09-19 起；2026-10-10 按 DSH 0.2.0 修订）

**适用**：部署里有 Host 侧任务板（DSH 为 `@linxin666/dsh-client-ui-task-board`）时，把"派子代理"升级成**派卡片**：卡片钉住**工作区 / agent 预设 / 权限**，由 Host 调度、执行与结算，**浏览器关掉也照跑**。中心（Coordinator）仍是派单、判定、合并、写台账与汇报的唯一主体；**卡片是贡献者**——只在自己分支提交并提申请。

**三块"板"别混（2026-10-30 起，按 T-26/T-21 口径）**：① **项目台账** `.dsh/flow`（`flow_task` / `flow task`）是 **durable 真源**，跨会话、跨工作树；② **Host 任务板卡片**（`task_board_*`，本节）是 Host 持久调度面，浏览器关掉照跑；③ **Agent Teams 共享任务板**（`team_task_*`，§十）只活本次 Lead 会话，是会话内执行视图。**卡片与 Team 任务都不是真源**：由项目任务派生时，Team 任务 `description` 首行写 `flow: <T-id>`、项目任务 notes 回记 `team: <taskId>`；卡片若也由项目任务派生，沿用同一写法（协调建议，非硬性字段）。状态/证据/结论最终一律回收到项目任务（字段约定见 [references/agent-teams-and-tasks.md](references/agent-teams-and-tasks.md) §3.1）；项目流面板**不做** Team 投影（T-26 已删），Team 板只在原生 Agent Teams UI 看。跨会话 / 无人值守 / 要钉工作区与权限仍走卡片。

**标题统一（2026-11-04）**：三块板的标题一律 `<feat|fix|chore>: <一句话范围>`——项目任务 `title`、Team 卡 `subject`、Host 卡片 `title`；Team 卡另按 §10.4 写 `description` 三行标注。命名细则见 §10.2.1。

**工具名映射（DSH 0.2.0 实测）**：`task_board_create`（落 backlog/todo，**不执行**）→ `task_board_set_parent`（挂子任务，深度上限见板摘要 `maxSubtaskDepth`）→ `task_board_run`（**才执行**；跑父卡会**并发跑整棵子树**）→ `task_board_manage`（move / archive / restore / delete / `settle` 强收卡住的执行）；读全貌 `task_board_get` / `task_board_list`（`includeArchived` 看归档）；改卡 `task_board_update`（已执行卡的 `title`/`description`/`prompt` **冻结**，执行目标可改）；排期 `task_board_schedule`（**5 段 cron + Host 本地时区**：错过**不补跑**、卡在跑则跳过、树里有未确认权限则**拒绝并顺延**）。**会话内定时是另一套**：`schedule_*` 只给会话发提示、不干活，要"到点真的干活"必须用 `task_board_schedule`。完整清单与语义见 `references/agent-teams-and-tasks.md`。

**⚠ 时效纪律（2026-10-10 新增，本节最容易被文档骗的一条）**："某卡存在 / 某 cron 在跑 / 有看门狗兜底"**全是断言**，能否当真取决于**当前板上事实** ⇒ **派单或恢复前先 `task_board_list`（含 `includeArchived`）核实**，并读板摘要的 `armedSchedules` / `sessionDefaultPermission` / `maxSubtaskDepth`（**权限闸门只在"卡的权限 > 部署默认"时才武装**）。实测反例：某项目文档写着"看门狗卡每小时跑、永不归档"，真实状态是**看门狗与全部角色卡已归档、`schedule.enabled=false`、`armedSchedules=0`** ⇒ 无人值守保护**并不存在**，照文档行事等于把恢复押在一个不存在的东西上。

**角色分工（与 §十 固定四类角色一致；卡片不得混用角色）**：
- **Coordinator = 中心**：从项目台账拉任务、拆分与分配、**唯一合并者**、**唯一台账写者**、唯一 push 者；不兼任实现；
- **Planner = 分析者**（**只读权限**）：产出任务书「目标 + 可证伪 DoD + 切片与文件域 + 风险与回退 + 验证命令 + 依赖」；不写实现；
- **Executor = 实现者**（可写权限，贡献者，每人一片 `domain`）：按任务书实现，**只在自己分支提交**，完成且已 commit 后按模板提评审申请；不合并、不写主分支台账、不审自己；
- **Reviewer = 审查者**（**只读权限**，且**不得是实现者**）：独立复跑 DoD 命令、抽做变异检查，给 `accept` / `reject` / `request-rebase` + findings；不改代码、不合并。

状态机（`pulled→analyzing→assigned→implementing→reviewing→accepted|rejected→merged→reclaimed`）、交接物与 Team 卡 `role:` / `domain:` 标注见 §10.2–§10.8；审查结论由审查者给，最终合并与项目台账归中心。

**六条硬事实（2026-09-19 实测，踩过）**：
1. **卡片内容首次执行后冻结**：标题/描述/提示词只在"从未执行过"时可改（Host 硬拒 `400 task has already been executed`）；权限/工作区/模型/`reuseSession`/标签始终可改。⇒ 派单按**一事一卡**；要长期复用一张已确认的卡，就用**指针文件**（提示词固定写"读 <项目内指针文件>"，中心每次改写它）。
2. **看板绿 ≠ 交付**：结算只看 `turn/end` 的 reason 是否为 `error`，**被中断的执行（`interrupted`）会被记成成功**。复核必须看**会话产出**（有无实质 assistant 文本、最后一次 `turn/end` 的 reason），不能只看 `result`。
3. **重跑会新开一条执行记录**（旧记录的结果永久保留，列表顺序不代表新旧）⇒ 判"最新一次执行"要按开始时间排序。
4. **服务重启后的恢复**：卡片台账（定义/排期/执行记录）持久化并对账；**半途未记下会话 id 的启动会被结算成"取消"且不重发**；**cron 错过的触发点跳过、不补跑**；会话本身持久化，卡片开 `reuseSession` 后重跑**接着原会话历史继续**（会话不存在或非空闲时自动新开，不阻塞调度）；**中心自己的后台任务随 Host 一起消失且不通知** ⇒ 恢复只能靠 Host 侧机制（看门狗卡 + Host 自启）。
5. **看门狗卡**：用**只读权限**的定时卡判"运行中但会话最后事件太久没动"或"成功但被中断 / 无实质产出"⇒ 重新触发；**同一张卡 1 小时内 ≥2 次执行只报告不重跑**（防死循环）。前提是 Host 自身能在重启后起来（systemd user service / 启动器自启），否则没有任何调度。
6. **权限闸门是防升级设计**：有效权限高于部署默认值时，卡片**首次运行需要人确认一次**，改权限或交接包会**重新武装**闸门；卡片创建卡片也绕不过（新卡仍未确认）。别用"卡自己建卡"来免确认。

**并行度**：卡片默认**不排队**（可以同时跑），中心按申请顺序逐份判定、逐份合并。真实限制只有三类——① 同一文件同时被两路改会产生冲突与返工（派单时尽量把文件域切开，这是减少返工的建议，不是锁）；② 共享构建产物目录（`target/`、`dist/`、`.cache/` 等）并发构建会互相破坏，约定"检测到并发构建就跳过本地验证，由中心收口后统一跑"；③ 依赖链上后者要等前者合并。**全量门禁由中心在合并前后各跑一次**，其余时候各卡跑定向命令。**大规模只读扇出**用并行子代理/工作流工具，不要把看板当批处理队列使。

**分支纪律**：卡片会话**看不到你的对话上下文** ⇒ 派单必须自带任务书路径、允许的文件域、交付格式与停止条件。卡片**只在自己分支提交**，完成且已 commit 后向中心提申请（branch + path + commit + 命令结果）；**合并、主分支台账、发布归中心**。分支不可见 ⇒ 申请必须写 branch + path + commit，中心按 §1.4 判定后合并。

## 十、智能体团队（Agent Teams；DSH 0.2.0 新增，2026-10-30 起为默认执行面）

> **它是执行面，不是另一种协作模式**：中心-贡献者模型不变（§一），Team 只是"多路贡献者 + 共享任务板"的具体跑法。本次会话内有多路可并行写域、或需要来回追问/补证据时**默认组队，不需要用户点播**；单人单线不组队；跨会话 / 无人值守 / 钉工作区与权限走卡片（§九）；大规模只读扇出走 `workflow`。
>
> **2026-10-31 起（T-20261031-01）：团队固定四类角色——中心 / 分析者 / 实现者 / 审查者**（§10.2），配一条状态机（§10.3）与四类固定交接物（§10.4）。角色是**权限与职责划分**，不是头衔：写的人不审自己、审的人不改代码、合并与台账只归中心；单文件/单域小任务不组队（§10.8）。

**工具**：`spawn_teammate`（Lead 专用；`context` = `fresh` 无历史 / `fork` 继承**已完成**轮次）· `send_message`（durable，**唯一能唤醒 inactive 队友**的手段，也是派新活的方式）· `wait_agent`（**Lead 默认不用**，仅排障时确认还有谁在跑；只观察**调用之后**的状态/邮箱/任务变化，**从不唤醒**任何成员；无人在跑时立即 `noProgress`）· `list_agents`（`inactive` = 此刻没在跑，**不代表失败或完成**；`provisioning` / `failed` 才是创建态）· `interrupt_agent`（Lead 专用，**保留 pending inbox**）· `team_task_create` / `get` / `list` / `update`（共享任务板；`update` 用 `expected_revision` 做 **CAS**：claim → 干活 → complete）。

### 10.1 真源与执行视图：项目台账 durable，Team 板随会话消失

| 面 | 持久性 | 存什么 | 谁写 |
|---|---|---|---|
| **项目台账** `.dsh/flow/tasks/`（`flow_task` / `flow task`） | **durable，跨会话/跨工作树** | status、goal、scope、acceptance、notes、commits | 中心（Lead）；队友不写 |
| **Team 共享任务板**（`team_task_*`） | **随 Lead 会话消失** | 执行卡片、owner、依赖、write_scopes、完成状态 | 队友 claim/complete；Lead 建卡/回收 |
| **原生 Agent Teams UI** | 随会话 | 实时观察成员与卡 | 只展示，不是真源；项目流面板**不做** Team 投影（T-26 已删） |

### 10.2 固定四类角色（写死）

| 角色 | 谁 | 能做 | 不能做 | 交接物（交给谁） |
|---|---|---|---|---|
| **中心**（Lead；集成权威） | 主工作区会话、项目维护者 | 从项目台账拉取任务（`flow_task list` / `show`）、拆分与分配、裁决并发、**最终合并主分支**、**唯一写项目台账**、唯一 push、逐卡回收 | 不兼任实现（组队时不下场写实现域）；不跳过独立复核直接合并；不把审查权交给自己或实现者本人 | 项目台账更新 + Team 卡回收 |
| **分析者**（analyst） | 只读队友（单域降级时可由中心自析） | 只读仓库/契约/任务，产出**任务书**：目标、范围/base、文件域切分、验收标准、验证命令、风险、依赖 | 不写代码、不提交、不改任何文件、不合并、不写台账 | 任务书（中心确认后下发给实现者与审查者） |
| **实现者**（implementer ×N） | 各占一条分支/worktree 的队友 | 只写**自己 `domain:`**：提交、跑门禁、写证据、提评审申请 | 不写他人 domain；不合并、不 push、不写台账/心跳；不审自己 | 提交 + 证据 + 评审申请 |
| **审查者**（reviewer） | 只读队友，**必须与实现者不同人**；验收面多就建多名 | 只读 + 跑测试：独立复核 diff/范围/门禁/契约影响，给结论与证据 | 不改代码（问题回实现者改）；不合并、不写台账；不能是实现者本人 | 结论（accept / reject / request-rebase）+ 证据 |

**默认配比与满编（2026-11-04 用户纪律；数字只在本节与 [references/agent-teams-and-tasks.md](references/agent-teams-and-tasks.md) §3.0 各写一次）**

人数上限 `maxMembers` 来自 profile 的 `agent-team` 插件 `config.maxMembers`（包缺省 `DEFAULT_MAX_MEMBERS = 16`；`lead` 不占名额，**创建失败的成员仍占名额**，超限报 `TEAM_MEMBER_LIMIT`）。**N = 本次实建数 = `min(maxMembers, 计划槽数)`**；**计划槽数 = 计划卡数（含被 `blocked_by` 挡住的审查/后续卡），不是当前已存在或当前可开工的卡数**。**实现者数 I 由写域定；余数 < I 时把 N 上调到「余数 ≥ I」的最小值**（I=2 ⇒ N=5、I=3 ⇒ N=8、I=4 ⇒ N=9）——比例不得压掉写域。**配比（N≥3 才用）：分析者 `round(N×0.25)`、审查者 `round(N×0.375)`、实现者取余数**；N=8 ⇒ 2/3/3，N=16 ⇒ 4/6/6；分析者、审查者各至少 1。**N<3 不用比例**：确需组队时先**补足 ≥3 个计划槽（使 N≥3）**再按 3 人组（分析 / 审查 / 实现 各 1）；补不出 ⇒ 按 §10.8 不组队；**`maxMembers<3` 一律不组队**。**若 `I` > 余数(`maxMembers`)，按 `maxMembers` 建队并把写域合并 / 串行（§10.6 第 8 条）或拆项目任务，不得超 `maxMembers`**。

- **分析者**：单卡固定 1 名；多卡并行时按 25% 拆多名，各卡范围互斥（文件域不重叠），任务书只认中心确认过的那份。
- **实现者**：一人一片互斥 `domain:`；**不为凑比例硬拆同一个文件**——写域不够就把实现者名额让给只读（审查/核验），并在卡 notes 记原因。
- **审查者**：非实现者，按 37.5% 建；每名覆盖一个验收面（实现面 / 文档与外观面 / 门禁与打包面），互不写文件。
- **满编 = 名额用满，且每槽挂着在跑卡或被 `blocked_by` 挡住的卡（合法空转）**：没活可给的名额**不建**（建了只是空转占额，队友无法 dismiss）。**允许空转 = 该槽的卡被 `blocked_by` 挡住（不论是否关键路径）**；关键路径卡的 owner 额外约束：**不接新的写卡、可接只读核验**；**空转合法性只看三分法（表见 [references/agent-teams-and-tasks.md](references/agent-teams-and-tasks.md) §3.3）**（依赖未清等待合法；可并行未派、依赖未建卡一律不许）。

**五条铁律（违反按事故处理）**：
1. **写审分离**：同一变更的实现者不得担任审查者；审查者发现问题只写结论，不顺手改代码。
2. **中心不兼实现**：组队时中心只拉取/分配/裁定/合并/写台账/回收；中心要自己写就不组队，按 §1.5 退化，不在团队里既当中心又占实现域。
3. **合并与台账单一写者**：主分支合并、项目台账、push 只归中心；实现者与审查者都不碰。
4. **审查独立且只读**：审查者不能是实现者，也不由实现者兼；团队没有独立审查者时由中心复核（中心不兼实现），**审查权永远不交给实现者本人**。
5. **降级只降规模，不降审查**：小任务可以不组队（§10.8），但"实现者不自审、中心唯一合并/台账"两条不变。

### 10.2.1 命名规范（写死，2026-11-04）

**三类名字都是「类型 + 范围」，范围写模块/产物名，不写序号。**

- **队友名**：`<role>-<scope>`，kebab-case；**role 用简写**（`analyst` / `impl` / `reviewer`），scope 是它能处理的范围（模块、目录、产物）；**卡内 `role:` 用全称**（`analyst` / `implementer` / `reviewer`）。**硬约束**：`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`、≤64 字符、不能叫 `lead`（违反报 `TEAM_INVALID_MEMBER_NAME`）；名字唯一不复用（重名 `TEAM_MEMBER_NAME_TAKEN`），建员前先 `list_agents` 核对。正例：`analyst-lifecycle`、`impl-skill-docs`、`reviewer-consistency`；反例：`analyst-1`（序号）、`Impl_Skill`（大写/下划线）、`lead`（保留名）、`reviewer-alldocs`（范围大于实际域）。
- **任务标题**：项目任务 `title` 与 Team 卡 `subject` **写同一句**：`<feat|fix|chore>: <一句话范围>`，type 只允许这三个，总长 ≤60 字符。正例：`feat: 团队派工规范（命名/配比/七阶段）`、`fix: 面板轮询慢响应被自噬取消`、`chore: 技能版本升到 2.14`；反例：`实施：T-06 技能纪律`（无 type）、`feat:修复bug`（无空格、范围含糊）、`feature: 改文档`（type 不合法）。**长度事实**：flow 侧 `requireText`（`lib/core.mjs:1536`）**只拒空**、无上限；Team 卡 `subject` 经 `requiredText(..., 200)` ⇒ **拒空且 >200 字符硬报错**。`<type>:` 前缀与 ≤60 字符纯属**技能纪律**（工具不校验），靠 Lead 与审查者把关。
- **历史不追溯**：已有 `T-*` 任务与已建卡不改名；新卡、新建项目任务、Host 卡片从本版起按此命名。
- Team 卡 `description` 仍按 §10.4 写三行标注（首行 `flow:`、次行 `role:`、实现者第三行 `domain:`）——标题管"叫什么"，标注管"归属谁"。

### 10.3 状态机（一张实现卡的生命周期，写死）

```text
pulled → analyzing → assigned → implementing → reviewing
                                                  ├─ accept ──────────────→ accepted → merged → reclaimed
                                                  └─ reject / request-rebase → rejected → 回 implementing → reviewing
```

| 状态 | 含义 | 谁推进 | 进入下一态的条件 |
|---|---|---|---|
| `pulled` | 中心从项目台账拉取任务（`flow_task list` / `show`），确认要做 | 中心 | 多路/可并行 ⇒ `analyzing`；单域小任务 ⇒ §10.8 不组队 |
| `analyzing` | 分析者只读产出**任务书**（目标、范围/base、文件域切分、验收标准、验证命令、风险、依赖） | 分析者（`role: analyst` 卡） | 中心确认任务书 + 文件域切分互不重叠 ⇒ `assigned` |
| `assigned` | 中心建 Team 卡（`flow:` / `role:` / `domain:`）并派实现者与审查者 | 中心 | 实现者 claim 实现卡 ⇒ `implementing` |
| `implementing` | 实现者只在自己 `domain:` 与分支写：提交 + 证据 + 评审申请 | 实现者 | 实现卡 `completed` 且申请含 branch/path/commit ⇒ `reviewing` |
| `reviewing` | 审查者（非实现者）只读独立复核 diff/范围/门禁/契约影响，逐条给 §1.4 结论 | 审查者 | `accept` ⇒ `accepted`；`reject` / `request-rebase` ⇒ `rejected`（回 `implementing`） |
| `accepted` | 审查通过；中心复跑门禁并最终裁定（可推翻审查结论，须写明理由） | 中心 | 中心 accept ⇒ 合并 ⇒ `merged` |
| `rejected` | `reject`：按具体理由重做；`request-rebase`：实现者 rebase 到新 base、复跑、重新提申请 | 实现者 | 重新提交申请 ⇒ 重返 `reviewing` |
| `merged` | 中心合并主分支（`merge --no-ff` / `cherry-pick` / 允许时 fast-forward）并复跑门禁 | 中心 | 项目台账 status / commits / notes 更新 ⇒ `reclaimed` |
| `reclaimed` | 中心逐卡回收 Team 卡、决定分支/工作树保留或清理；**项目台账是唯一 durable 真源** | 中心 | 会话结束前全部卡到达本状态（§10.7） |

- `analyzing` / `reviewing` 分别由 `role: analyst` / `role: reviewer` 的卡承载；`rejected` 是回边不是终态；状态只写两份——Team 卡（执行视图）+ 项目台账（真源）。

### 10.3.1 七阶段生命周期与现有状态（映射，写死；不扩展枚举）

用户口径的**七阶段**（创建 → 分析 → 等待 → 实现 → 审查 → 完成 → 归档）是**管理视图**；底层只有两套枚举：§10.3 的九态、Team 卡的 `pending` / `in_progress` / `completed`，外加项目任务的 `draft` / `active` / `done` / `archived`（`lib/core.mjs` 的 `TASK_STATUS`，**没有 `blocked`**）。**不新增状态、不把阶段写进 notes**（notes 是台账字段，禁双写，§10.5）。

| 阶段 | §10.3 九态 | Team 卡 | 项目任务 | 推进者 |
|---|---|---|---|---|
| 创建 | （未建卡）→ `pulled` | — → `pending` | `draft` | 中心 |
| 分析 | `analyzing` | `in_progress` | `active` | 分析者 |
| 等待 | `assigned` + `blocked_by` 非空 | `pending` / `in_progress`（已认领但依赖未清） | `active`（flow 无 blocked；依赖只记 Team 卡 `blocked_by`） | 中心调度 |
| 实现 | `implementing` | `in_progress` | `active` | 实现者 |
| 审查 | `reviewing` | `in_progress` | `active` | 审查者 |
| 完成 | `accepted → merged` | `completed` | `done` | 中心 |
| 归档 | `reclaimed` | 卡回收（`release` / 不再建） | `archived`（自动归档可先置、无卡回收、不回退） | 中心 |

- **等待 = `assigned` 且 `blocked_by` 非空**：`blocked_by` 是唯一判据，**依赖完成后也不清空**，所以"能否开工"看两支名单——**`team_task_list({ status: 'pending' })` 里不在 `team_task_list({ ready: true })` 名单的卡 = 被 `blocked_by` 挡住**（再核对其 `blocked_by` 上游卡是否仍在板上）；Team 卡此时是 `pending`（未认领）或 `in_progress`（已认领但依赖未清）。**别反查"非 ready"名单判等待**：`ready` 的定义是 `status==='pending' && 依赖已清`（`lib/index.js:382`），`completed` / `in_progress` 卡因此恒不 ready，历史卡永远落在那个名单里。**两支名单都要 `limit: 100` 并翻完 `nextCursor`**；跨两次调用的差集不是快照，逐卡再用 `blocked_by` + `revision` 核对。
- **完成 ≠ 归档**：完成 = 审查 `accept` + 中心合并 + 门禁复跑 + 台账更新。归档分两种：**自动归档**只做 `done → archived`（时间阈值触发，不要求分支/工作树清理，由 T-07 的 precommit 步执行）；**人工归档**走回收检查单（卡已回收、分支/工作树已清理、现场已记入 notes 之后）。本技能只管"没完成的不许归档"。
- **审查不过回分析**：`reject` ⇒ 阶段回「分析」，由分析者修订任务书后再回 `等待 → 实现`（九态回边仍是 `rejected → implementing`，阶段纪律要求在 `implementing` 之前先经过 `analyzing`，本节优先）；`request-rebase` 只换 base、不动任务书，可直接回 `implementing`。**不新建卡、不开新回边**。
- **跳过分析卡**：已有中心确认的任务书（含既有分析产物）可跳过分析卡，在项目 notes 记 `analyzing: skipped (brief=<来源>)`，阶段直接进「等待 / 实现」。
- **多卡规则**：一个 flow 任务对应多张 Team 卡时，**阶段取最慢的卡**（任一张还在实现 ⇒ 实现阶段；**任一审查卡 `in_progress` ⇒ 审查阶段**）。
- 九态语义与 §10.5 状态映射不变；与本节冲突时以本节映射为准，并在项目 notes 写一句原因。

### 10.4 交接物与 Team 任务标注（写死）

**四类交接物**：

| 交接物 | 从 → 到 | 必含内容 | 形态 |
|---|---|---|---|
| **任务书** | 分析者 → 中心确认 → 实现者/审查者 | 目标、范围/base（branch + commit）、文件域切分、验收标准、验证命令、风险、依赖 | [assets/task-brief-template.md](assets/task-brief-template.md)；不含实现代码 |
| **提交 + 证据 + 评审申请** | 实现者 → 中心（审查者同读） | branch + worktree path + commit、改动文件（在 domain 内）、命令原文 + 退出码、影响面、风险、希望中心做什么 | [assets/merge-request-template.md](assets/merge-request-template.md) |
| **审查结论 + 证据** | 审查者 → 中心 | `accept` / `reject`（缺哪条、哪段 diff、缺什么证据）/ `request-rebase`（新 base）；§1.4 五条逐条结论 + 自己复跑的命令与结果 | 对话/Team 卡 notes，由中心回记项目 notes |
| **台账更新 + 卡回收** | 中心 → 项目台账 / Team 板 | 项目任务 status / commits / notes（含 `team: <taskId>` 与验收结论）；Team 卡 `completed`；分支/工作树保留或清理 | 项目台账 + `team_task_update` |

**Team 任务标注（`description`，写死）**：

```text
flow: T-YYYYMMDD-NN                    ← 首行：对应一个项目任务
role: analyst | implementer | reviewer ← 第二行
domain: <path prefix>                  ← 仅实现者（多个用逗号分隔；有多个域就拆多卡）
```

- 一张卡 = 一个角色 + 一片可独立验收的写域；分析卡（`role: analyst`）先于实现卡；审查卡（`role: reviewer`，只读）`blocked_by` 对应实现卡，且审查者与实现者不同人。
- 正文只写任务书路径、验收标准、验证命令、交付格式（分支 + 提交 + 证据 + 申请/结论）与停止条件；不复制台账字段（§10.5 禁止双写）。
- `write_scopes` 与实现者 `domain:` 保持一致；`role:` / `domain:` 缺失的卡由中心补全后再派，不靠队友猜。

### 10.5 真源回记与禁止双写（写死）

- **正向锚点**：Team 任务 `description` 首行 `flow: <T-id>`（§10.4）；一张卡只对应一个项目任务（覆盖多个就拆多张）；正文不重复台账字段。
- **反向回记**：项目任务 `notes` 追加 `team: <taskId>`（可带 branch / commit / 验收结论）。notes 是整字段覆盖式更新，回记时保留原内容。
- **状态映射**：Team `pending` ↔ 项目 `draft`；`in_progress` ↔ `active`；`completed` ↔ **已合并**后才置项目 `done`（未合并不得置 done）。被 reject / 阻塞 / 放弃时写原因，项目任务回 `active`（还要做）或 `archived`（确定不做）。**`archived` = 归档阶段**（§10.3.1）：**人工归档**只在卡已回收、分支/工作树已清理、现场已记进 notes 之后置；**自动归档**例外：只做 `done → archived`（时间阈值，由 T-07 precommit 步执行，不要求清理）。
- **证据**：项目任务 `commits` 由中心合并后回填（合并提交与纳入的贡献提交）；实现者与审查者都不写项目台账。
- **禁止双写**：status / commits / 验收结论只以项目台账为权威值；Team 卡状态只是执行视图，不把同一进度叙事两边各写一份。
- **队友不写台账、不写心跳**：心跳只面向主会话；队友的进度经 Team 卡 + 申请/结论回中心，由中心登记。

### 10.6 拆分、派工与并发（写死）

1. 读 `flow_task list` / `flow_task show <id>`（或 `flow task ... --root <主工作区>`）拿项目任务、依赖与验收。
2. **先分析后派单**：`role: analyst` 卡先出任务书（目标/base/文件域切分/验收/验证命令/风险/依赖），中心确认后才是拆分依据；不拿"边想边派"的卡开工。
3. 按**文件域与依赖**拆卡：一实现者 = 一条分支/worktree = 一片 `domain:`；`write_scopes` 预声明文件域（**协调信息，不是锁**）；`blocked_by` 表达依赖（审查卡依赖实现卡；依赖未完成时 readiness 不会自动开跑，完成后仍要 `send_message`）；**blocker 全 `completed` 而卡仍 `ready:false`** 时，owner 先 `team_task_get` 取最新 revision，再 `set_dependencies` 清空已完成项后 claim（不要重建卡或绕开依赖，见 [references/agent-teams-and-tasks.md](references/agent-teams-and-tasks.md) §3.3）。
4. **关键路径与满编调度**（判据写死）：**卡 X 是关键路径 ⟺ ∃Y，Y.status≠completed 且 Y.`blocked_by` ∋ X.id**（X 不完成，Y 起不来；`blocked_by` 完成后不清理，所以判据必须带 `status≠completed`）；依赖只写 Team 卡——**flow 任务没有 `blocked_by` 字段**；`depth` = 卡的后继链最长长度（有后继 ⇔ `depth>0`）。规则：① **允许空转 = 该槽的卡被 `blocked_by` 挡住**（不论是否关键路径）；关键路径卡的 owner **不接新的写卡**（可接只读核验）；② `depth=0` 的尾卡（无后继）优先满编，可并行多张；③ **空转判定**（合法性只看三分法（表见 [references/agent-teams-and-tasks.md](references/agent-teams-and-tasks.md) §3.3），**没有数量上限**）：`pending` 里有卡**不在 `ready: true` 名单**（= 被 `blocked_by` 挡住，且上游卡仍在板上）⇒ 空转合法，在卡 notes 记 `waiting on <上游卡 id>`；**`pending` 为空、或全部 `pending` 都在 `ready: true` 名单里 ⇒ backlog 枯竭（缺口）**，当场拆卡 / 补只读卡，**不得判为合法空转**；`ready: true` 名单非空而无人负责 ⇒ 不许空转，立刻填空闲槽（**无人负责 ⇒ `team_task_update action=reassign`**；**owner `inactive` ⇒ `send_message` 唤醒**）。
5. `team_task_create` 建卡：`subject` 按 §10.2.1（`<feat|fix|chore>: <范围>`），`description` 按 §10.4 标注（`flow:` / `role:` / 实现者 `domain:`）；正文写任务书路径、允许写域、交付格式、验证命令与停止条件。
6. 项目任务 notes 回记 `team: <taskId>`（Lead 写，§10.5）。
7. `spawn_teammate({ context: "fresh" })` 按角色建持久队友（**名额与配比见 §10.2**、命名见 §10.2.1，不在本条复述数字）：实现者每人一域；**审查者必须是非实现者**；prompt 自带 role/domain 标注、Team 任务 id、项目 task id、任务书路径、base、允许写域、映射约定、交付格式（只在自己分支提交 + 按模板提申请/结论，不合并、不 push）、停止条件。
8. **并发与冲突**：`write_scopes` 不相交是派工前提；重叠时中心二选一——① **串行化**（先合一份，后一份 rebase 后再合）；② **让分析者重拆**（把共享文件划给唯一写者，或拆成先后卡）。同一文件同一时段只给一个写者；共享构建产物目录（`target/`、`dist/`、`.cache/`）并发构建需约定跳过本地验证、由中心收口统一跑。
9. **结论回流**：`reject` ⇒ 阶段回「分析」（§10.3.1），由分析者修订任务书再重派；`request-rebase` ⇒ 回实现者换 base、复跑、重提（中心不代做；只换基线，不算审查不过）；审查者不得自己改代码绕过实现者。
10. **派工后结束本轮，不 `wait_agent`**：需要追加指令或推进时用 `send_message`（running 队友在最近步边界收到，inactive 队友被唤醒）；**Lead 派工/唤醒后即结束本轮**，说明派了谁、等哪几路回报；队友完成后主动 `send_message` 唤醒 Lead，**收口以 inbox 回报为准**。`wait_agent` **只在排障时用**（确认还有谁在跑），且只观察变化、不催活、不唤醒任何人。

**满编六条（直接照做；判据见上面第 4 条，空转归因见 [references/agent-teams-and-tasks.md](references/agent-teams-and-tasks.md) §3.3）**：

1. **建队顺序**：① 建分析卡并 spawn 分析者 → ② 收任务书后**纸上**拆卡（估计划槽数）→ ③ 一次性补齐其余名额（②→③ 合计 ≤60s）；**Lead 不先自己读代码侦察**（实测本会话因此白丢 98 member-min）。拆完补不出卡就补只读核验；**队友无法 dismiss，不建无活名额**。
2. **常驻配比**按 §10.2 公式（N 见 §10.2）；**任何时刻不许 0 审查或 0 执行**。
3. **事件驱动流水**：一张实现完立刻派审查、一份审查过立刻派下一张实现卡；**禁止"整波齐发齐收"**。
4. **backlog ≥ 空闲槽**：每次收报告当场补位；**无 `blocked` 卡的空闲者**才必须补只读卡（预研 / 冲突 diff / 红测计划 / 风险清单）。
5. **关键路径三问**：`blocked_by` 空？owner 空？完成能解锁 ≥1 下游卡？皆 yes ⇒ 立刻派；否则给等待者派只读预审。
6. **收报告 ≤1min 回执**：回一张新卡或明确「等待中」；**空转必须归因**（`dep-wait` = 依赖未清等待 / `parallel-unassigned` = 可并行未派 / `no-card` = 依赖未建卡，与 §3.3 三分类同名），**禁止无卡沉默**；<10min 的小卡合并、>15min 的大卡按文件域拆。

**每轮对账（reconcile；2026-11-04 用户反馈「任务进度不会自动更新状态」）**：Lead **每轮开始**先做一次对账——`team_task_list` + `flow_task list` 各读一次（不 `wait_agent`），把项目任务状态按七阶段（§10.3.1）推进到板上实际进度：

- 分析中 ⇒ 项目 `active`；等待 ⇒ 项目 `active` + 卡 `blocked_by` 非空（等依赖或名额）；
- 实现中 / 审查中 ⇒ 项目 `active`（只改状态，不写进度叙事，禁双写 §10.5）；
- 合并后 ⇒ 项目 `done`；卡已回收、分支/工作树清理完 ⇒ `archived`（完成 ≠ 归档）。**自动归档不排回收检查、可先于回收置 `archived`**（无卡回收），**不要回退**，清理后补 notes。

- **同轮回写**：收到队友 `send_message` 回报的那一轮里，**立即**把卡（`team_task_update`）与项目任务（`flow_task update`，notes 记 `team:`/branch/commit）改掉——**不允许"只在任务结束时补一次"**。
- **不需要用户触发**：对账是 Lead 每轮固定第一步（也是派工前的第 0 步）；台账与板上事实对不上时以项目台账为准回写，并在回复里说明改了哪张卡。

**Lead 派工检查清单（10 条，派工前逐条过；第 0 步是先做上面的每轮对账）**：

1. `flow_task list` / `show` 拉取并确认标题合规（`<type>: <范围>`）。
2. 项目任务 status `draft` → `active`。
3. 建 analyst 只读卡（prompt 带 flow id / 任务书路径 / 停止条件）。
4. 收任务书、确认验收命令与写域互斥后才派实现。
5. 按 §10.2 公式算配额（写域不足则让位只读并记原因）。
6. `team_task_create`：每卡 `flow:` / `role:` / 实现者 `domain:`，`write_scopes` 与 `domain` 一致。
7. 审查卡 `blocked_by` 实现卡；按 `∃Y·Y.status≠completed ∧ Y.blocked_by∋X.id` 判关键路径卡并标出。
8. `spawn_teammate`：名字 `role-scope`、审查者≠实现者、建员前 `list_agents` 数名额。
9. `send_message` 唤醒后结束本轮（**不 `wait_agent`**）。
10. 收口：accept → 复跑门禁 → 合并 → 回记 notes/commits → 卡 `completed` → flow `done`；会话结束前逐卡回收。

### 10.7 执行与回收：一次会话的完整闭环

```text
项目任务（flow_task）→ 中心拉取（pulled）
  → 分析者只读出任务书（analyzing）→ 中心确认
  → 拆 Team 卡：role: analyst / implementer(+domain) / reviewer（assigned）
  → 项目 notes 回记 team: <taskId> → spawn_teammate + send_message
  → 实现者 claim → 自己分支提交 + 门禁 + 评审申请（implementing）
  → 审查者（非实现者）独立复核 → accept | reject | request-rebase + 证据（reviewing）
  → 中心按 §1.4 复跑门禁并最终裁定 → 合并 → 更新项目台账（accepted → merged）
  → 回收 Team 卡（completed）+ 清理分支/工作树（reclaimed）
  → 会话结束前逐卡回收：项目台账是唯一 durable 真源
```

- **阶段口径**：七阶段（创建/分析/等待/实现/审查/完成/归档）与九态的映射见 §10.3.1；**完成 ≠ 归档**：**人工归档**前必须走完回收检查；**自动归档**（T-07 precommit 按 `updated_at` 阈值）只做 `done → archived`，**不等回收检查**。

- **会话结束前逐卡检查**：没有 `in_progress` 悬空；每张 `completed` 卡都能在项目 notes 找到 `team: <taskId>` 与对应提交；reject / 放弃 / 接管的卡写清原因与现场（branch + path + commit）；每张卡的角色与结论可核（实现者未自审、审查者未改代码）。完整检查单见 [references/contribution-flow.md](references/contribution-flow.md) §8.2 与 [references/agent-teams-and-tasks.md](references/agent-teams-and-tasks.md) §3.1。
- **失败保留现场**：Lead 不替队友继续写；记录 branch + commit 后接管或丢弃。队友的"已完成"是声明，交付按产出物验收（`git status` + mtime + 复跑门禁 + 申请字段）。
- **收口靠 inbox 回报，不靠 `wait_agent`**：Lead 派工或 `send_message` 唤醒后结束本轮；队友完成后主动 `send_message` 唤醒 Lead，Lead 收到回报再复跑门禁、裁定、合并与回收。`wait_agent` 只在排障时用（确认还有谁在跑），且只观察、不催活、不唤醒。**没收到必需队友的回报、没回记项目台账，就不得宣布任务完成**（会话收尾仍按「会话结束前逐卡检查」执行）。

### 10.8 降级：单域小任务不组队（唯一降级）

| 情形 | 做法 | 审查底线 |
|---|---|---|
| 单文件 / 单域小任务，组队成本高于收益 | **不组队**：中心自析自验（自己出任务书要点、自己实现、自己复跑门禁），按 §1.5 单人退化 | 降级时中心自己实现、自己复跑；**审查权不得交给任何实现者本人**——若实现由队友做，审查仍由中心或独立审查者做 |
| 本次会话内多路可并行写域、需要来回追问/补证据 | **Agent Teams（默认）**，按 §10.2–§10.7 四角色跑 | 独立审查者；中心合并 |
| **Team 工具不在当前会话工具列表** | **一次性 subagent（唯一降级）**，且**只派只读活**；写活回到中心自己做 | 中心复核 |
| 多路只读调研 / 审计 / 方案对比 | 一次性 subagent（`subagent` / `subagent_fork`）或 `workflow` 扇出 | 结论回中心汇总 |
| 跨会话 / 无人值守 / 钉工作区与权限 / cron | **Host 任务板卡片（§九）** | 卡片按四角色分，合并与台账归中心 |

- **降级只降组队规模，不降审查独立性与"中心唯一合并/台账"**；"单域小任务"不等于"可以把审查权交给实现者本人"。
- 一次性 subagent **不 claim Team 任务、不写项目台账、不写心跳**；结论由中心汇总进项目任务 notes。

### 10.9 纪律（与卡片模式同源；差异处已标注）

1. **每个成员在自己的分支/worktree 里写**：有 `create_worktree` 时成员自己建；没有就用普通本地分支，共用 checkout 时先由中心确认或自行 `git worktree add`。`write_scopes` 是**协调信息，不是锁**——重叠由中心串行或让分析者重拆，没人会替你挡住双写。
2. **只读可任意并行，写入按文件域切分**：同一文件同一时段只给一个成员；**大规模只读扇出**用 `workflow` 或并行子代理，别用队友硬顶。
3. **派工自带上下文**：队友**看不到 Lead 的对话** ⇒ 提示词必须含任务书路径、role/domain 标注、允许写域、映射约定（`flow:` / `team:`）、交付格式、**只在自己分支提交 + 按模板提申请/结论（不合并、不 push）**、停止条件。
4. **角色边界不可越**：实现者不自审、审查者不改代码、分析者不写实现、中心不兼实现；**合并、主分支台账、发布归中心**，队友只在自己分支提交，可以在自己的提交里写 CHANGELOG 条目；合并冲突与定稿由中心处理；队友不写心跳。

## 十一、CHANGELOG 建议形态：碎片 → 生成 → 同源检查（2026-09-19 建议）

手写单文件 CHANGELOG 有三个结构性毛病：**并行硬冲突点**（每个提交都要改同一个文件）、**无长度预算**（单条动辄数千字符，一个版本段可达十几万字符）、**无校验**（格式/是否面向用户全靠自觉，发布说明得手抄）。建议改成：

1. **碎片**：每次提交写一个文件（如 `.changelog/unreleased/<时间>-<slug>.md`），带 front-matter：`type` / `scope` / `userFacing` / `summary`（一句话，给长度上限制）；正文非必填并同样限额。
2. **生成**：`CHANGELOG.md` 变成**生成物**——构建脚本把碎片渲染进 `[Unreleased]` 的**带标记生成区**（`<!-- generated:start/end -->`），标记区外一个字节都不许动（幂等、可 diff）。
3. **同源检查**：与"生成物必须与源同源"的检查同一套路（渲染结果 ≠ 磁盘内容 ⇒ 退出码非 0），并入质量门禁与 CI ⇒ 从此没人手写、也就没有"插入锚点写错吞掉标题行"这类事故。
4. **闸门迁移**：提交前检查从"必须包含 CHANGELOG.md"改成"**必须带一个新碎片**"（无用户可见变更时显式声明豁免）。
5. **历史拆分**：主文件只留 `[Unreleased]` + 最新一版，更老版本段逐字搬进 `CHANGELOG-history.md`（**历史不改写**）。
6. **附带收益**：`userFacing` + `summary` 让**发布说明草稿可自动生成**（发布页要的是用户向摘要，不是工程细节）。

## 十二、实验型项目：假设 → 任务 → 结果分流（2026-11-04）

> **定位**：实验是**任务的外围功能**——任务仍是唯一执行单元，门禁、命名、配比、满编、自动归档全部照旧（§二 / §十）；实验只多两件事：**开工前把假设写死**，**收尾时把结果分流**。面板/CLI 的实验区可选开启（`flow.json` 的 `experiments.enabled`，默认关闭。**关闭 = 面板隐藏实验区 + `flow check experiments` 直接 exit 0 跳过**；`flow exp` / 工具 / 写路径照常。缺键补 `false`，**契约层不记 warning**（只有类型错才回退并记 `manifest-invalid`）；旧项目已有实验时给**一次性引导 warning**，**不自动开启**）。

> **落地状态**：**均已落地**——core（`schema:2` 七字段 + 软/硬分离、`task.experiment` 校验、`checkExperiments`、`productizeExperiment` / `cleanupExperiment`）随 **B1（`5a2ae37`）**；CLI 与 `check` 路由（`flow exp review|productize|cleanup`、七字段 flag、`flow check experiments`、`task --experiment`）随 **B2（`b4bf113`）**。退出码：`exp review` **恒 0**（**无 `--result`**，结论看 `--json`）；`exp productize` 不满足 confirmed / 门禁基准 → **2**（`invalid`）；`check experiments` **0 通过 / 1 判定失败**（`check` 家族词汇与 CLI 退出码表一致：0 成功 / 1 用法·检查失败 / 2 校验·配置 / 3 未找到 / 4 IO）。

### 12.1 七段流程（实验项目专用，写死）

1. **识别问题**：写清要回答的问题与现状证据，先不改代码。
2. **提出假设**：方向 + 验证目标，七字段必须齐（§12.2）。
3. **创建任务**：`title` 仍按 `<type>: <范围>`（§10.2.1），并带 `experiment: <E-id>`（§12.4）。
4. **设计实现**：任务书写清改动面、验证命令、观测方式与回滚方式（模板见 [assets/task-brief-template.md](assets/task-brief-template.md)）。
5. **隔离分支实现**：分支名 `exp/<E-id>/<topic>`；提交、门禁按 §1.6 / §二 执行。
6. **审查实现**：独立审查者按 §1.4 五条给结论（写审分离不变）。
7. **完成任务后测试并判断结果**：按 §12.3 四分支分流，每支都有强制动作。

### 12.2 假设硬规范（新实验缺任一即拒；旧记录 legacy 不补）

| 字段 | 含义 | 机器拒绝条件 |
|---|---|---|
| `direction` | 方向（措辞，自由文本 ≤120 字符，不设枚举） | 空或缺；>120 字符 |
| `expected` | 验证目标（一句可判真假、含阈值） | 空 |
| `primaryMetric` | **主指标**：单个字符串（唯一；多指标放 `guardrails[]`） | 缺；空 |
| `guardrails[]` | **护栏指标**（不可退化的约束，≥1 条） | 缺；空数组 |
| `falsify` | 证伪条件（什么观测结果说明假设错） | 缺 |
| `windowDays` | 观测周期（正整数天；**起算点 = `created_at`**） | 缺；≤0；非整数 |
| `stopLoss` | 止损线（到什么程度立即停并回滚） | 缺 |

- 中心**派实验任务前**核对 7 项；缺一项 ⇒ 不建实验、不建实现卡，退回分析者补全。
- **`title` / `hypothesis` 沿用旧必填**（非空），七字段是在此之上的追加硬规范。
- **机器只校验**：存在 / 非空 / `guardrails` ≥1 / `windowDays` 正整数 / `primaryMetric` 为单个非空 string / `direction` ≤120 字符；**`falsify` 与 `expected` 同义、`stopLoss` 是否可判定、`expected` 是否真可证伪**属语义判断，**由审查者把关，不依赖机器校验**。
- 只对**新实验**硬拒；**legacy**：旧 `schema:1` 记录只读、不迁移、不补字段（数量以项目实测为准，不是通用值）。
- **CLI flag（B2）**：`exp add` 必填 `--direction` / `--expected` / `--primary-metric` / `--guardrail`（可重复）/ `--falsify` / `--window-days` / `--stop-loss`；`exp update` 同名可选。
- 七字段落在实验记录（`experiments/E-*.json`）与实验简报（[assets/experiment-brief-template.md](assets/experiment-brief-template.md)）两处；插件侧校验以 `flow check experiments`（并入 release gate）兜底，落地前由中心与审查者把关。

### 12.3 结果分流（四分支，写死）

| 判定 | 条件 | 必做动作 |
|---|---|---|
| **成功** | 主指标达 `expected`，护栏全绿 | 实验置 `confirmed` → `flow exp productize`（要求 `release` 最近一次 `ok` 运行的 `finished_at` **≥** 实验进入 `confirmed` 的 `updated_at`，早于则拒，**不满足退出码 2**）写 `productizedAt` / `productizeGate` → 合并 / 上线 |
| **不确定** | 窗口内主指标无定论、护栏未破 | 实验置 **`inconclusive`**（`learned` **建议写**，`check experiments` 不硬拦；`open` 只表示进行中未判定）→ 延长 `windowDays` 继续观测，或**调整假设**派生 `parent` 子实验；**不得直接产品化** |
| **失败** | 命中 `falsify`，或触 `stopLoss` | **停止并丢弃**：实验置 `refuted` + `learned`；`flow exp cleanup <id> --flag/--code/--data` 写 `cleanup{flags[], code[], data[]}`（开关 / 代码 / 数据，各 ≤20 项）与 `cleanupAt`；notes 记清理证据，不留死开关。**`exp update --status refuted` 不拦（清理是异步动作），收口靠 `cleanupAt` + `check experiments` 硬拦** |
| **转向** | 部分资产值得保留、假设要换 | 实验置 `pivoted` + `learned`；保留可复用资产（模块 / 测试 / 数据），**新假设另建子实验**（新实验 `parent` 指向原实验，单向），不改写原结论 |

- 四分支动作都在**任务回收之前**完成（§10.7 逐卡检查），结论进项目任务 `notes`；`refuted` / `pivoted` 缺 `learned`（`refuted` 另缺 `cleanupAt`）视为实验未收尾；`inconclusive` 的 `learned` 只提示、不计未收尾。
- **产品化 ≠ 实验内合并**：`exp/<E-id>/<topic>` 的内容要进主分支，仍按 §1.2 提评审申请 → 中心合并；产品化门禁是**额外的**一道（release phase）。
- 判定前可 `flow exp review <id>` **只读自查**（返回 `verdict` / `branch` / `missing[]`，不改记录；**无 `--result`，恒 exit 0**，结论看 `--json`）。
- `flow check experiments`（`release` gate 内）**硬拦四项**：七字段缺失、`refuted` 缺 `learned` / `cleanupAt`、`pivoted` 缺后继实验、`confirmed` 未产品化；`open` 超过 `created_at + windowDays` **只给 `experiment-window-elapsed` warning，不判失败**；命令退出码 **0 通过 / 1 判定失败**；`inconclusive` 的 `learned` 与 `abandoned` 同级——只提示、不拦。该步须项目先 **`gate enable release`** 才生效（种子默认 `enabled: false`）。
- **`abandoned`** = 主动放弃且不判定：**不强制 `learned`**（建议写），`check experiments` 只提示、不计失败。

### 12.4 实验与任务的挂接（写死）

- **任务带 `experiment`**：任务记录增加可选字段 `experiment: "E-YYYYMMDD-NN"`，**应指向已存在实验**；格式非法才拒（`invalid`），**不存在时只记 `task-experiment-missing` warning、不拒绝写入**（实验被删或功能未开启时也照常写入）；**实验记录里不存 tasks 列表**（单向引用，不双写）。缺该字段的任务按普通任务跑。
- **分支约定**：实验实现分支固定 `exp/<E-id>/<topic>`（topic 小写短横线）；同一实验可多条分支，但**不得混入非本实验提交**（提交归属仍按 pathspec 纪律，§1.6）。
- **状态沿用**：实现 / 审查 / 完成走 §10.3.1 七阶段，不为实验新增 Team 状态；实验状态（`open` / `confirmed` / `refuted` / `abandoned` / `inconclusive` / `pivoted`）只存在实验记录里。
- **降级**：单域小实验不组队时中心自析自验（§10.8），但 §12.2 的 7 项与 §12.3 的四分支动作一项不少。
