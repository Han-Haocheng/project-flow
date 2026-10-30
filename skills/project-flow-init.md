# project-flow-init

技能名：`project-flow-init`。给一个项目建立 `.dsh/flow/` 流程台账（实验 / 任务 / 门禁），
之后用 `project-flow-usage` 维护。写入只走 `flow` CLI 或 `lib/core.mjs`，不要手改 JSON。

## 何时用

- 项目第一次需要记录可证伪实验、任务状态或可执行门禁时；
- 项目已有 `.agents/tasks/*.json` 或提交里的 `Exp-Id` trailer，想迁进 store 时；
- 从别处拷来一个已有 `.dsh/flow/` 的项目：**不要**重新 init，先 `flow status` 确认。

## 初始化

在项目根目录执行（CLI 在 PATH 里时用 `flow`，否则用 `node <包路径>/bin/flow.mjs`）：

```bash
flow init
flow init --name MyProject
```

- 只在 `<root>/.dsh/flow/flow.json` 不存在时写契约；重复执行是幂等的，只给
  `already-initialized` 警告，不覆盖。
- `--force` 才会用当前参数重写 `flow.json`（记录文件不受影响）。
- `--name X` 设置契约里的项目名，缺省为目录名。
- **台账真源在主工作区，中心是唯一写者**：工作树（worktree）继承**已提交**的 `.dsh/flow/`，
  不要在每棵 worktree 里重复 `flow init`。**贡献者不 init、不建卡**；需要更新状态时经中心，
  或显式 `flow --root <主工作区> ...`（见 `project-flow-usage` 的「分支/工作树与台账」）。

产物：

```
<root>/.dsh/flow/
  flow.json
  experiments/  tasks/  gates/  logs/
```

写锁 `.dsh/flow/.lock` 是运行时临时文件，建议加进 `.gitignore`：

```gitignore
.dsh/flow/.lock
```

## 从旧台账迁移

```bash
# 从 .agents/tasks/*.json 导入任务（id 冲突跳过，不覆盖）
flow init --migrate tasks

# 从 git 提交 trailer（Exp-Id/Hypothesis/Factor/Scale/Expected/Measured/Verdict）导入实验
flow init --migrate trailers

# 两者都迁
flow init --migrate all
```

- 已初始化过的项目也会执行迁移，迁移是幂等的：已存在的 id 跳过。
- 迁移不会删除旧文件；确认 store 内容无误后再自行决定旧台账去留。
- 非 git 仓库跑 `--migrate trailers` 只产生 warning，不会失败。

## 初始化后验收

```bash
flow status                 # 应显示契约源 .dsh/flow/flow.json 与三个计数
flow exp list               # 空项目输出「（没有实验记录）」
flow task list
flow gate list
flow --json status          # data.initialized === true
```

再走一遍最小闭环，确认可写：

```bash
flow exp add --title 冒烟实验
flow exp show E-YYYYMMDD-01          # 用上一步输出的 id
flow gate add --id smoke --title 冒烟门禁 --phase manual --step 'ok=echo hi>>contains:hi'
flow gate run smoke                  # 结果为「通过」
```

## 协作注意

- **单一写者（中心）**：同一时刻只让中心写 store；贡献者不直接写，并发写会被 `.dsh/flow/.lock`
  拒绝（报 `conflict`，稍后重试即可），30 秒未释放的锁会被下一个写者接管并记 warning。
- **不要手改 id**：id 是文件名与引用（`parent`、`commits`）的一部分，改 id 等于制造坏引用。
  需要改内容就用 `flow exp update` / `flow task update`。
- **不要直接编辑 JSON**：绕过 core 会跳过校验、原子写与锁；坏 JSON 只会在读取时变成 warning。
- 需要机器可读结果时统一加 `--json`，按退出码判断：0 成功、1 用法、2 校验、3 未找到、4 IO。
- 门禁定义是项目资产，建议提交；运行记录 `logs/` 按项目约定决定是否提交（量大，通常只留最近若干条）。
