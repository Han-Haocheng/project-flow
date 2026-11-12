---
description: 给一个项目建立 `.agents/flow/` 流程台账（schema 2，实验 / 任务 / 门禁），并查看生成的目录结构。
metadata:
  when-to-use: 当项目还没有 `.agents/flow/flow.json`、用户要求搭建 project flow、项目从别处拷来但已带 `.agents/flow/`（先跑 `flow status` 确认，不要重新 init），或 flow 工具报缺少台账时使用。旧的非 store 台账不会迁移，历史需要人工补录。
---
# project-flow-init

技能名：`project-flow-init`。给一个项目建立 `.agents/flow/` 流程台账（实验 / 任务 / 门禁），
之后用 `project-flow-usage` 维护。写入只走 `flow` CLI 或 `lib/core.mjs`，不要手改 JSON。

## 何时用

- 项目第一次需要记录可证伪实验、任务状态或可执行门禁时；
- 项目从别处拷来、已有 `.agents/flow/`：**不要**重新 init，先 `flow status` 确认。
- 旧的非 store 台账（仓库根的 `tasks/*.json`、git `Exp-Id` trailer）**不再自动迁移**；如需保留历史，
  请手动整理成 store 记录（`flow task add` / `flow exp add`）。

## 初始化

在项目根目录执行（CLI 在 PATH 里时用 `flow`，否则用 `node <包路径>/bin/flow.mjs`）：

```bash
flow init                         # 建立契约 + gates 目录为空时种入 5 条默认门禁
flow init --name MyProject        # 指定项目名
flow init --no-gates              # 只建立空台账，不种默认门禁
```

- 只在 `<root>/.agents/flow/flow.json` 不存在时写契约；重复执行是幂等的，只给
  `already-initialized` 警告，不覆盖。
- `--force` 才会用当前参数重写 `flow.json`（记录文件不受影响）。
- `--name X` 设置契约里的项目名，缺省为目录名。
- 默认会种入 `session-open`、`precommit`、`tests`、`staged-files`、`release` 五条门禁；
  只有 gates 目录为空时种入。`--no-gates` 跳过种入。
- **台账真源在主工作区，中心是唯一写者**：`.agents/` **整目录不入 git**（`CONTRACT.md` §8），worktree 会话一律读写**项目主工作区**的 `.agents/`，不存在"工作树继承已提交台账"这回事。不要在每棵 worktree 里重复 `flow init` 或另建 store。**贡献者不 init、不建卡**；需要更新状态时经中心，或显式 `flow --root <主工作区> ...`（见 `project-flow-usage` 的「分支/工作树与台账」）。

`flow init` 实际创建的目录/文件（记录目录是 `.agents/flow/` 的**兄弟目录**，不要在 `flow/` 里找 tasks/experiments）：

```
<root>/.agents/
  flow/
    flow.json                 # 契约（项目名、schema、各域配置）
    logs/                     # 门禁运行记录 logs/<gateId>/<ts>.json
    .lock                     # 写锁（运行时临时文件）
  tasks/                      # 任务记录 T-*.json
  experiments/                # 实验记录 E-*.json
  gates/                      # 门禁定义 <id>.json
  decisions/                  # 决策记录 D-*.json
  description/                # 描述台账（project.json + files/ + tasks/）
```

`heartbeat/`、`worktrees/`、`tmp/` 不是 init 立即创建的目录，会由心跳/宿主在首次使用时建立。

`.gitignore` 不会由 `flow init` 自动修改。新项目必须确认已忽略整个 `.agents/`：

```gitignore
.agents/
```

## 旧台账（不再自动迁移）

- `flow init` 建立 schema 2 store，并可能种入默认门禁；`--migrate` 与旧 `git Exp-Id` trailer 读取已在 v0.2 移除。
- 旧的非 store 台账（仓库根 `tasks/*.json`、Git trailer、旧 Markdown 任务书）不会被读取；需要历史时
  用 `flow task add` / `flow exp add` 手工补录。
- **`.agents/tasks/`、`.agents/experiments/`、`.agents/heartbeat/` 等是当前活目录，不是旧目录**；
  不要因为看到它们就迁移或删除。

## 初始化后验收

```bash
flow status                 # 应显示契约源 .agents/flow/flow.json 与三个计数
flow exp list               # 空项目输出「（没有实验记录）」
flow task list
flow gate list
flow --json status          # data.initialized === true
```

再走一遍最小闭环，确认可写。**请在临时项目里执行**；它会在真实台账里留下实验和门禁记录：

```bash
flow exp add --title 冒烟实验 \
  --hypothesis "最小闭环可写" \
  --direction "验证台账可写" \
  --expected "记录成功落盘" \
  --primary-metric "记录数" \
  --guardrail "无报错" \
  --falsify "命令退出非 0" \
  --window-days 7 \
  --stop-loss "任一步失败即停"
flow exp show E-YYYYMMDD-01          # 用上一步输出的 id
flow gate add --id smoke --title 冒烟门禁 --phase manual --step 'ok=echo hi>>contains:hi'
flow gate run smoke                  # 结果为「通过」
```

## 协作注意

- **单一写者（中心）**：同一时刻只让中心写 store；贡献者不直接写，并发写会被 `.agents/flow/.lock`
  拒绝（报 `conflict`，稍后重试即可），30 秒未释放的锁会被下一个写者接管并记 warning。
- **不要手改 id**：id 是文件名与引用（`parent`、`commits`）的一部分，改 id 等于制造坏引用。
  需要改内容就用 `flow exp update` / `flow task update`。
- **不要直接编辑 JSON**：绕过 core 会跳过校验、原子写与锁；坏 JSON 只会在读取时变成 warning。
- 需要机器可读结果时统一加 `--json`，按退出码判断：0 成功、1 用法、2 校验、3 未找到、4 IO。
- 门禁定义也在 `.agents/gates/`，与其余台账一样**不入 git**；需要随仓库分发时，用 `flow gate show <id> --json` 导出或写进项目自己的初始化脚本，不要 `git add .agents`。
