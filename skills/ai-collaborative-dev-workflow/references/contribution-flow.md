# 贡献流程：贡献者侧与中心侧（中心-贡献者模型）

> 定位：`SKILL.md` §一 的操作层。**唯一流程**——中心负责合并与同步，贡献者产出可评审的提交与证据，由中心判定。分支隔离只是让提交可评审的手段，不是另一套协作模式。
> 工具前提：DSH 插件 `@deepseek-ai/dsh-experimental-tool-worktree` 暴露 `create_worktree` 时用它建工作树；没有该工具时用普通本地分支，协议其余部分完全相同。工具面以**当前会话工具列表**为准。

## 0 一次贡献的生命周期

```text
中心派工（贡献者须知：base / 允许文件域 / 验证命令 / 交付格式）
  → 贡献者选 base、建分支（或工作树）
  → 提交（pathspec）+ 每步跑门禁
  → 按模板写"提交评审申请"
  → 中心判定（五条清单）→ accept | reject | request-rebase
  → accept：中心合并 + 复跑门禁 + 更新台账 + 清理
  → reject：理由与替代做法，同一份提交不原样重提
  → request-rebase：贡献者 rebase 到新 base、解冲突、复跑、重新提申请
```

贡献者之间不协调、不同步、不排队、不登记文件锁。冲突在中心合并阶段由中心裁决。

在 Agent Teams 中执行时，一次贡献对应一张 Team 任务；**项目台账才是 durable 真源**，Team 板只是本次会话的执行视图。映射字段与回收检查单见 §7.1 / §7.2。

## 1 选 base 与建分支

- **base**：任务书声明的集成线提交（默认 `dev` 的 HEAD）。不 fetch；要远端最新就由中心先同步，再从同步后的提交起分支。
- **有 `create_worktree` 时（贡献者自己做）**：

  ```text
  create_worktree({ name: "t-20261030-99-contribution-flow", from: "dev" })
  → { path: "/repo/.agents/worktrees/t-20261030-99-contribution-flow",
      branch: "t-20261030-99-contribution-flow",
      baseCommit: "<sha>", repositoryRoot: "/repo" }
  ```

  - **必须由贡献者自己调用**：工具会把**调用者**的 cwd 切到新工作树 ⇒ 中心代建只会切走中心自己的 cwd，贡献者仍留在原地。
  - 工具**只创建、不合并**：检查、合并、删除工作树、删分支都不做，合并是中心的手工 git 操作。
  - 未提交改动留在源 checkout，不复制进新工作树。
  - `name` 同时是分支名与目录名；同名即失败，中途失败会保留已建内容并在错误里带 path。

- **没有 `create_worktree` 时（贡献者自己做）**：

  ```bash
  # 主工作区或自己的 checkout；分支名带 task id
  git switch -c t-20261030-99-contribution-flow dev
  git log -1 --oneline   # 核对 base
  git status --short     # 应为干净
  ```

- 创建后把 `branch` + `path` + `baseCommit` 登记到心跳/任务 notes，并在申请里重复一遍（面板与工具面都看不到分支）。
- 一个任务一条分支；同一分支只做该任务，不夹带无关改动。

## 2 提交与门禁

- 粒度：每个可独立验证的步骤一次提交（`feat:`/`fix:`/`docs:`/`chore:`/`refactor:`…），message 带 task id 并说清"为什么"。
- 只 `git add` 任务书允许的文件域；**commit 带 pathspec**：

  ```bash
  git add <file1> <file2>
  git diff --cached --stat                     # 自检：add 的 == 我改的
  bash <技能目录>/scripts/check_staged_files.sh <file1> <file2>
  git commit -m "feat(skill): <说明>" -- <file1> <file2>
  ```

- 禁止：`push`、`merge`、切主分支、rebase 他人分支、`reset`、删分支、改主工作区。
- **门禁**：按任务书里的契约命令逐项跑，记录命令原文 + 退出码/摘要；全绿才提交，红了先修，不在申请里写"基本通过"。
- 默认随提交写 CHANGELOG `[Unreleased]`（项目另有约定时遵项目）；写在自己分支的提交里，合并冲突由中心处理。
- **申请前必须已 commit**：工作树里不得留未提交改动当"交付"。

## 3 写评审申请

- 按 [assets/merge-request-template.md](../assets/merge-request-template.md) 填，发给中心（对话消息，或写入任务 notes 后发指针）。
- 必须写 **branch + worktree path（或"同一 checkout"）+ HEAD commit**；只写"我改好了"等于没写。
- 在 Team 中执行时，申请同时写 **Team 任务 id** 与项目 task id；`team: <taskId>` 由中心回记到项目 notes，贡献者不写项目台账。
- 测试结果写命令原文 + 退出码/摘要；风险/未完成写"无"或具体项；写明"希望中心做什么"（`merge --no-ff` / `cherry-pick <sha>` / 若需 rebase 请给目标 base）。
- 多份申请撞同一文件时由**中心逐份裁决**；贡献者不得自行合并，也不得抢改主工作区。

## 4 等中心结论：三种动作

| 结论 | 中心做什么 | 贡献者做什么 |
|---|---|---|
| **accept** | `git merge --no-ff` / `cherry-pick` / fast-forward；合并后复跑门禁；更新台账；清理分支/工作树 | 等中心确认合并完成；如被要求，报告后续事项。不要自己 push 或清理他人的工作树 |
| **reject** | 给出具体理由（不满足清单第几条、哪段 diff 不该有、缺什么证据）与替代做法 | 不原样重提；按理由重做或放弃。若认为是中心误判，按硬性约束反驳并给证据 |
| **request-rebase** | 指定新 base（当前集成分支 HEAD）与冲突文件 | 在自己分支 `git rebase <new-base>`，解冲突、复跑门禁，**重新提申请**；不把 rebase 后的 force-push 到任何远端 |

- 中心**不在自己的主工作区替贡献者解冲突**，也不替贡献者 rebase；冲突本身是"这份提交还没准备好"的信号。
- rebase 后 `baseCommit` 与 commits 列表会变 ⇒ 申请必须重填，不能只回一句"rebase 好了"。

## 5 失败与放弃（贡献者侧）

- 任何失败（测试红、冲突、工具报错）**保留现场**：不删工作树、不 reset、不强行清理。
- 报告格式：`已提交到分支 <branch>（<path>，<n> 个提交，HEAD <sha>）` 或 `未提交（<path>，改动文件：…）`，附失败命令与末尾输出。
- 放弃由**中心**决定并记录：中心可接管该分支继续改，或记录原因后删除。贡献者不自行删除分支/工作树。
- 同一命令连续两次因相同原因失败即停止并上报（与主技能一致）。

## 6 中心侧：验收、三种结论落地、清理

### 6.1 验收（按 §1.4 五条清单逐条给结论）

```bash
# 身份核对：申请里的 path/branch 与 git 对得上
git worktree list
git log --oneline <baseCommit>..<branch>
git diff --stat <baseCommit>...<branch>
git diff <baseCommit>...<branch>          # 逐段看，不只看 stat

# 清单第 5 条：与当前集成分支的冲突预判
git merge-tree $(git merge-base <branch> dev) dev <branch>
```

1. **diff 与任务范围一致**：无夹带、无密钥、无生成物、无越界重构。
2. **门禁中心自己复跑**：按契约命令，看退出码与末尾输出；申请里的结果只作参考。
3. **影响面**：接口/台账/文档/CHANGELOG/版本声明是否同步。
4. **提交信息与证据充分**：粒度、message、命令原文、风险披露。
5. **与集成分支冲突**：能自动解或只需换 base ⇒ request-rebase；与用户未提交改动或他人在改的文件冲突 ⇒ 停下问用户。

### 6.2 accept：合并命令

```bash
# 主工作区，工作区干净、需要时已由中心 fetch
git switch dev
git merge --no-ff <branch> -m "merge: <task-id> <一句说明>"   # 默认：保留合并点，便于回退
# 或只取个别提交（分支历史杂乱时）
git cherry-pick <sha>
# fast-forward 仅当分支是 dev 的直线后继且项目允许
git merge --ff-only <branch>

# 合并后必须复跑契约命令，再决定清理
```

- 冲突由**中心**解决；解完复跑测试再继续。无法接受就 reject 或记录后丢弃。
- 合并后复跑门禁是 accept 的一部分，不是可省步骤；主分支测试红就保留现场、回退该合并提交并上报。

### 6.3 清理

```bash
git worktree remove <path>    # 有未提交改动时先确认，再决定是否 --force
git branch -d <branch>        # 未合并会被拒绝；-D 仅在确认丢弃时用
```

- 清理前确认 path 是 `.agents/worktrees/<name>` 下的目标目录；禁止对主工作区 `rm -rf`。
- 保留还是删除工作树/分支由中心决定，并写进任务 notes。

## 7 台账、心跳与分支可见性

- **台账真源在主工作区**：`.dsh/flow/` 只在主工作区初始化与提交；工作树继承**已提交**的台账，**不要**在每个 worktree 重复 `flow init` 或另建 store。
- **中心是唯一台账写者**：贡献者不 init、不建卡；确需更新状态时经中心，或显式 `flow --root <主工作区> ...`（且需中心同意）。
- 心跳是运行态，可留在自己工作树；不得因心跳自动建卡，也不登记文件锁。
- **分支不可见**：面板与工具面都看不到某会话在哪条分支 ⇒ 心跳 `last_action`、任务 `notes`、评审申请三处都写 `branch` + `worktree path` + `commit`。

### 7.1 项目任务 ↔ Team 任务映射（项目台账是 durable 真源）

Agent Teams（`team_task_*`）的共享任务板只活 Lead 本次会话，随会话消失；项目台账（`.dsh/flow/tasks/`）跨会话、跨工作树持久。两者只靠文本字段对接：

| 方向 | 位置 | 写法 | 谁写 |
|---|---|---|---|
| 项目 → Team | Team 任务 `description` **首行** | `flow: <T-id>`（一张 Team 任务只对应一个项目任务；覆盖多个就拆多张） | Lead 建卡时写 |
| Team → 项目 | 项目任务 `notes` | `team: <taskId>`（可带 branch / commit / 验收结论；notes 覆盖式更新，保留原内容） | Lead（唯一台账写者） |
| 状态 | Team `pending` / `in_progress` / `completed` | 项目 `draft` / `active` / `done`；**只有已合并**才置 `done`，reject/放弃写原因后回 `active` 或 `archived` | Lead |
| 证据 | 项目任务 `commits` | Lead 合并后回填合并提交与纳入的贡献提交 | Lead；队友不写 |

- **禁止双写**：`status` / `commits` / 验收结论只以项目台账为权威值；Team 卡状态是执行视图，不复制一份进度叙事到项目 notes；Team 描述正文不重复台账字段。
- **队友不写项目台账、不写心跳**：心跳只面向主会话（T-20/T-26）；队友只在自己分支提交，把结论交回 Lead，由 Lead 登记映射。
- 映射是**文本约定**：项目流面板不做 Team 投影（T-26 已删），Team 板只在原生 Agent Teams UI 看。

### 7.2 会话结束前回收检查单（Lead 逐卡）

- [ ] 每张 Team 任务都有结论：`completed`（已合并）或 `release` / `reopen` + 原因；没有 `in_progress` 悬空
- [ ] 每个对应项目任务 notes 有 `team: <taskId>`，`status` / `commits` 已更新（未合并不得 done）
- [ ] 被 reject / 放弃 / 接管的卡写清原因与现场（branch + path + commit）
- [ ] 没有"只活在 Team 板或对话里"的状态、证据或验收结论；下一个会话只读项目台账就能恢复
- [ ] 分支 / 工作树已由 Lead 决定保留或清理，并写进项目任务 notes

## 8 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 贡献者仍在主工作区改文件 | 中心代建了工作树（被切走 cwd 的是中心） | 让贡献者自己 `create_worktree`；中心只给 name/base |
| 申请里没有 branch/commit | 以为"面板能看到" | 面板看不到分支；按模板补齐 branch + path + commit |
| 合并时发现改动没进分支 | 忘记 commit，改动只在工作树工作区 | 回分支 `git add` + commit 后重新申请；不得在主工作区补提 |
| 贡献者分支里冒出第二个 `.dsh/flow/` | 在分支里跑了 `flow init` | 确认无独有卡片后删掉该 store，改用 `--root <主工作区>` |
| 工作树建在工作树里 | 贡献者继承了中心的工作树 cwd | 申请里写清绝对 path；下次从主工作区起步 |
| 贡献者自己合并/推送了 | 把"申请"当成了"交付" | 停止后续操作、保留现场并上报；由中心评估是否回退 |
| 申请被 request-rebase 后只回一句"好了" | 没重填 base/commits | 重新提交完整申请，baseCommit 与 commits 必须是 rebase 后的 |
| `worktree branch already exists` / `path already exists` | 同名残留 | `git branch -a` + `git worktree list` 核实；清理或换名，不硬删 |
| 合并后主工作区测试红 | 只测了分支，没测合并结果 | 合并后复跑；红则保留现场、回退该合并提交并上报 |
| 中心跳过判定直接合并 | 把"看起来没问题"当成了验收 | 回到 §1.4 五条清单，逐条留结论 |

## 9 一页检查单

**贡献者**

- [ ] 从任务书 base 起的分支/工作树（branch + path 已登记）
- [ ] 改动全部在允许文件域内；commit 带 pathspec；已 commit
- [ ] 门禁按契约全跑，记录命令原文 + 退出码
- [ ] 申请含 task id / 贡献者 / branch / path / base / commits / 改动文件 / 测试 / 影响面 / 风险 / 希望中心做什么
- [ ] 未合并、未 push、未切主分支、未写主分支台账

**中心**

- [ ] 申请身份与 `git worktree list` 对得上；base 是集成分支祖先
- [ ] diff 逐段看过；门禁自己复跑；影响面核对
- [ ] 结论是 accept / reject / request-rebase 之一，理由写进任务 notes
- [ ] 若用 Agent Teams：项目任务已回记 `team: <taskId>`，Team 任务有 `flow: <T-id>` 锚点
- [ ] 会话结束前逐卡回收（§7.2），Team 板上不留唯一真源；队友未写项目台账/心跳
- [ ] accept 后：合并 → 复跑门禁 → 更新台账 → 清理（写进 notes）
- [ ] reject / request-rebase 后：给具体理由与新 base，等贡献者重提
