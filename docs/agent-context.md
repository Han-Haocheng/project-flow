# 代理共享上下文：跨任务不变量

> 面向：在本仓库并行工作的所有会话——中心（maintainer）、分析者、实现者、审查者、只读审计。
> 本文只写**跨任务共享的不变量**：领域与写域、门禁与基线、交接协议、纪律。任务目标与进度属于 `.agents/flow` 台账与任务书，不在本文复制；任何单卡状态都不应写进这里。
>
> 真源优先级：用户当次指令 > 全局/项目 `AGENTS.md` > `docs/module-domain.json`（写域）> `CONTRACT.md`（行为契约）> 本文件（协议索引）> `skills/` 操作手册。本文与更高优先级的真源冲突时，以更高优先级为准，并回头修本文。

## 1 领域与写域

### 1.1 写域的唯一真源

- `docs/module-domain.json` 是**机器真源**；`docs/module-boundaries.md` 是人的读法，不抄全量数据。
- 判定一个改动「属于某模块」只看三条：文件在该模块的 `owns`（精确路径或 `dir/` 前缀）；文件在 `shared` 且改动落在登记给该模块的 `sections` 内；测试文件列在该模块的 `tests` 里。其余一律 `FOREIGN`，`check` 退出 1。
- 日常核对命令：

  ```bash
  node scripts/module-domain.mjs matrix                      # 各模块 owns/shared/tests 计数
  node scripts/module-domain.mjs owners --files a.mjs,b.mjs  # 这批文件属于谁
  node scripts/module-domain.mjs verify                      # 锚点/归属/幽灵检查（提交前必跑）
  ```

- `sections` 是**一字不差的行锚点**（`from`/`to`，`to: null` 表示到文件末尾），必须存在、唯一、顺序正确。追加内容放段尾，不移动锚点行；**新增区段先改 JSON、跑 verify，再动代码**。
- 共享文件（`shared`）没有登记区段 = 整文件可改，verify 判红；每个顶层区段也必须至少被一个模块引用（孤儿区段同样是红）。

### 1.2 aspect 不是写权

- `aspect` 是横切关注面：一句话不变量 + 复核角色 + 文件清单，用来回答「改它要通知谁」。
- aspect **不参与越界判定**，也**不是审批闸**；不得用 aspect 决定「这个文件我能不能改」，更不得把 `ownerRole` 当放行条件。
- aspect 锁（`flow aspect list|acquire|renew|release|sweep`，状态存 `.agents/aspect-locks/`）是**占用登记 + 租约**，不是第二套写权：它只防止同一个 aspect 被两个会话同时改。占用方的租约到期即视为放弃，即使进程还活着；长于默认租约的工作必须持续续租（宿主在 `turn-stopping` 会为本会话持有的锁续期），结束或放弃时释放（判活优先级与 claims 的差异见 `CONTRACT.md` §3.5.1）。

### 1.3 台账与派生数据

- `.agents/flow/` 是运行期台账（任务/实验/门禁/决策/心跳），**不入 git**，是这些领域的唯一权威值。Team 板/TUI 面板只是执行视图，状态与 commits 以台账为准，禁止双写。
- `.agents/description/` 是**派生数据**（文件图、模块图、语义、计划），只能经 `flow desc build` / `flow desc set` 写；**禁止手改目录内 JSON**。新增/删除顶层声明或改模块后先 `flow desc build`，语义（文件/模块）仍由人写。
- `.agents/reports/` 是交接产物目录（见 §3），与台账同属 `.agents/`，不进 git、不进 module-domain 扫描。

## 2 门禁与基线

### 2.1 门禁定义与命令

门禁定义在 `.agents/flow/gates/<slug>.json`（运行期数据，禁止手改），用 `flow gate list` / `flow gate show <id>` 读取。当前启用项：

| 门禁 | 阶段 | 用途 |
|---|---|---|
| `precommit` | commit | 提交前检查，共 10 步：whitespace / decisions / tasks-archive / tasks-format / description / commit-scope / module-domain / tests / selftest / rules |
| `tests` | commit | 单测：`node --test test/`（等价于 precommit 的 tests 步） |
| `verify` | manual | 全流程验证 5 步：tests / description / module-domain / doc-counts / e2e-pipeline |
| `session-open` | manual | 会话心跳检查 |

- 提交前：`node bin/flow.mjs gate run precommit` 必须全绿；中心在合并前后各复跑一次 `verify`。
- 任一删除/移动/覆盖前先核对绝对路径；门禁失败先保留现场（输出、退出码、路径），停止盲目重试，上报中心。
- 规则文件防篡改：`docs/module-domain.json`、`CONTRACT.md` 的登记区段、`.agents/flow/flow.json` 受 checksum 基线保护；改它们必须带理由走 `flow gate rules` 留痕流程，否则 `rules` 步直接红。

### 2.2 基线的定义与记录

- **基线 = 最近一次全绿的「命令 + 用例数/文件数 + commit + 时间」**，不是文档里钉死的数字；数字随代码漂移，文档只描述口径，数据看现场。
- 基线证据放 `.agents/reports/<task-id>/`（原始 stdout/stderr 与退出码），报告只引用指针与摘要，不转述、不美化。
- 当前必须保持绿的验收口径（顺序即 precommit/verify 里的顺序）：`node --test test/`、`node scripts/module-domain.mjs verify`、`node scripts/doc-counts.mjs`、`node bin/flow.mjs check description`、`node --test test/t-20261111-03-pipeline-e2e.test.mjs`。
- 新增/修改测试后必须同步 README 的用例数：`node scripts/doc-counts.mjs --fix` 只改那一行，不要手写数字。
- 门禁红时不得以「别人的在途改动」作为唯一解释；必须给出命中路径与对照证据（例如同一命令在基线上的表现）。

## 3 交接协议（artifact 指针 + 消息信封）

### 3.1 原则：正文进文件，消息只发指针

- 代理之间的**大信息**（任务书、实现证据、审查结论、复跑输出）一律落成 **artifact 文件**；任务记录只存**指针与摘要**；会话消息只发**信封**。
- 目的：任务随状态在角色之间流转，接手的代理只读任务与 artifact 就能继续，不需要发送方的会话上下文。

### 3.2 存放与登记

- 正文路径：`.agents/reports/<task-id>/<role>-<ts>.md`（`role` ∈ `analyzer|implementer|reviewer`；`ts` 建议 ISO 紧凑格式）。
- 任务记录的可选 `artifacts[]` 存指针，每条：`{role, stage, summary, path, sha256, agent, at}`——只存指针与一句话摘要，不存正文。
- 容量：每卡每角色保留最近 3 条，超出剪掉最旧；**不得**把产物写到 `.agents/` 之外。
- 命令面以 `docs/cli-contract.md` 的 `task art` 段与 `CONTRACT` 为准；命令尚未落地时，仍按同一目录、同一字段登记，不另造格式。

### 3.3 阶段交接点

| 角色 | 交接时机 | 产物必含 |
|---|---|---|
| 分析者 | `analyzing → queued-implementation` 之前 | 任务书：目标、base、写域切分、验收命令、风险、依赖 |
| 实现者 | `→ queued-review` 之前 | 分支 + commit、改动文件（在写域内）、命令原文 + 退出码、影响面、风险 |
| 审查者 | `→ done` 之前 | 结论（accept / reject / request-rebase）+ 五条清单逐条结论 + 自己复跑的命令与结果；reject/rebase 必须列**必须修改项** |

阶段门当前对缺失产物只给 warning（不硬拦），但交接报告必须给指针；没有 artifact 的「已完成」按未交接处理。

### 3.4 消息信封（唯一允许的字段）

一条交接消息只写这些字段，正文不展开：

```text
task: T-YYYYMMDDNNNNNN
role: analyzer | implementer | reviewer
status: working | blocked | done | failed
artifact: .agents/reports/<task-id>/<role>-<ts>.md
sha256: <artifact 内容的 64 位十六进制摘要；无产物写 n/a>
verdict: accept | reject | request-rebase | n/a
needs: <一句话：要对方做什么；没有写 n/a>
```

- 每个信封 = 一条消息；字段缺失或指针失效视为**未交接**。
- `sha256` 由发送方对 artifact 内容计算；接受方校验一致后再引用其中结论，不一致按未交接处理并回 `status: blocked`。
- `verdict` 只由审查者填写；`reject` / `request-rebase` 时 `needs` 必须指向 artifact 里逐条编号的必改项。
- `status: blocked` 时 `needs` 写清阻塞点与解除条件；不得只写「做不了」。

## 4 纪律（所有会话，含中心）

### 4.1 只读与写入的边界

- 标为**只读审计**的任务：不写任何文件（含 `.agents/` 台账）、不跑写命令；结论只回信封。只读任务允许的命令：`git show/log/cat-file`、读文件、`grep`、`flow ... --json` 的读子命令。
- 实现任务：只改任务书写域内的文件；越界先改 `module-domain.json` 的边界（走规则留痕）再动手，不得先写代码再补边界。

### 4.2 共享工作树的 git 纪律

- **禁止**在共享工作树上执行 `git reset --hard`、`git checkout -- .`、`git clean -fd`、`git stash`、`git restore .`。需要恢复单个文件时用 `git cat-file -p <blob> > <path>` 或单文件补丁。
- 提交归属：禁止 `git add -A`；`git commit -m "..." -- <自己的文件>` 带 pathspec；只暂存自己写域内的文件，不裹他人改动。
- `push` 只在中心、且用户当次明确授权；贡献者不 push；发布分支只接收合并，不直接提交、不 cherry-pick、不 force。
- 不触碰他人未提交的在途文件；发现工作树异常先 `git status` 留证，再上报，不擅自「打扫干净」。

### 4.3 证据与报告

- 每条结论给 `file:line` 或「命令 + 原文输出 + 退出码」；grep 结论用第二种方法复核（读实现 / 跑用例）。
- 不编造行号、输出或验收结果；不确定就写不确定，并给下一步验证命令。
- 部分完成要如实标注覆盖范围与未覆盖项；不得把「没查」写成「没问题」。
- 门禁红、构建竞争、跨会话冲突：保留现场、停止盲目重试、按信封上报中心，由中心决定顺序。

### 4.4 描述与契约同步

- 新增/删除/改名顶层声明或模块：`flow desc build`；语义（文件级/模块级，≥10 字符，写「是什么/负责什么」而不是复述文件名）用 `flow desc set --input <json>`。
- 提交前 `node bin/flow.mjs check description` 必须 0 问题；不通过就补语义或修正成员归属，禁止为绿整段删区段。
- 行为变化先改 `CONTRACT.md`（按登记区段），再让代码与测试跟上；`CONTRACT.md` 是共享文件，只改登记给本模块的区段。

## 5 会话接续（新会话 / 上下文压缩后）

1. `node bin/flow.mjs status` + `flow task list` 读台账，`flow heartbeat list` 看谁在跑；不凭对话记忆改文件。
2. 找到自己要接的任务：`flow task show <id>` 读任务书与最新 artifact 指针；指针失效就按 §3 重新交接。
3. 动手前核对写域与在途改动（`git status`、`module-domain.mjs owners`）；有冲突先上报，不抢文件。

## 6 复审与派工（可操作）

### 6.1 delta 复审：先钉住被审对象

- 派复审**必须**写明 `target: <commit>`，以及「工作树是否允许脏」。只写「审一下当前代码」会在 HEAD 漂移后审到别的东西。
- 复审在**被审对象**上跑，不在当前工作树跑：`git archive <sha> | tar -x -C /tmp/pf-review-<短sha>`，进入导出目录跑测试/命令，主仓库零改动；需要干净基线时这条是唯一安全做法。
- 结论首行写 `target: <sha>` 与使用的命令；对象不符、HEAD 已漂移时回 `status: blocked`，不在错误基线上给 `accept`。

### 6.2 派工前先查重

- 派工前对该卡写域跑 `git log --oneline -n 20 -- <写域路径...>`，并对照 `flow task show <id>` 的 notes/commits：待办创建后是否已有提交覆盖同一行为。
- 已被后来提交顺手修掉的待办**不派工**：在卡上记「已由 <sha> 覆盖」并按阶段机收口/归档，不重复实现、不白跑一轮。
- 判据是「同文件域 + 同行为」而不是「同标题」：拿不准就先只读复核一遍代码，再决定派不派。

### 6.3 写域声明到段落级

- 多域并行时写域不能只写文件名，要写到**段落/行为边界**：例如「只改 `CONTRACT.md` 的 dispatch-close 段」「只改 CAS 写入」「只改冲突重读重试」。
- 共享文件用 `docs/module-domain.json` 的 `sections` 名指代区段（如只改 `c3.5`），并同时列出**不许改**的相邻段落。
- 写域 = 文件 + 区段/锚点 + 允许改动的行为；三者缺一，同文件并发就可能互相覆盖。
