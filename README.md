# project-flow

项目流程台账 + 只读面板：实验（含 `parent` 谱系）、任务、门禁定义与运行记录都写在
**项目自己的 `.dsh/flow/`** 下；面板是它的只读视图，写入只走 `bin/flow.mjs`（CLI）或
agent 工具（`flow_exp` / `flow_task` / `flow_gate`），两者共用同一个核心 `lib/core.mjs`。
唯一例外：未初始化工作区的空态上有个「初始化」按钮，会 POST `/api/project-flow/init`
调用同一个 core 写入者建台账。

| 入口 | 用途 |
|---|---|
| 右侧栏标签页「项目流」 | 看实验树、任务进度、门禁、心跳、运行输出（只读；未初始化时可一键初始化） |
| 会话头小图标 / 指南卡 | 打开同一面板 |
| `node bin/flow.mjs …` | 人改台账、跑门禁、迁移旧数据 |
| agent 工具 `flow_*` | 模型改台账、跑门禁 |
| 内嵌技能 `project-flow-init` / `project-flow-usage` / `ai-collaborative-dev-workflow` | 教模型何时初始化、怎么维护台账，以及中心-贡献者协作（谁提交、谁判定、谁合并）与发布纪律 |

契约与记录格式见 [CONTRACT.md](CONTRACT.md)；Agent 技能正文见 `skills/`。前两个技能是单文件
（`skills/<name>.md`）；`ai-collaborative-dev-workflow` 以目录形式随包分发
（`skills/ai-collaborative-dev-workflow/`，含 `references/`、`assets/`、`scripts/`，
注册时带 `resourceBase` 目录），它的机械检查同时可由 `flow check staged|release-baseline|state|doc` 触发。

## 初始化一个项目

```text
node ./bin/flow.mjs --root <项目根> init [--name 名称] [--migrate all]
```

会在 `<项目根>/.dsh/flow/` 下创建：

```
.dsh/flow/
  flow.json                 契约（schema 2）
  experiments/<id>.json     实验（E-YYYYMMDD-NN，parent 指向父实验）
  tasks/<id>.json           任务（T-YYYYMMDD-NN）
  gates/<id>.json           门禁定义（步骤 + 期望 + 超时）
  logs/<gateId>/<时间>.json 门禁运行记录
```

`--migrate all` 会把旧的 `git` 提交里的 `Exp-Id` trailer 和 `.agents/tasks/*.json` 一次性导入；
之后以 store 为准，不再写 trailer。

## 常用 CLI

```text
flow status                     # 项目名/契约/计数/最近记录
flow exp list|show <id>|tree    # 实验列表、详情、谱系树
flow exp add --title T [--hypothesis H --factor F --parent ID --expected E]
flow exp update <id> --status confirmed --measured '...' --commits abc1234
flow task add --title T [--status draft|active|done|archived]
flow gate add --id smoke --title 冒烟 --phase commit --step 'tests=ctest ...>>exit 0'
flow gate run smoke             # 顺序执行步骤、首个失败即停、写运行记录
flow gate logs smoke            # 最近运行记录
```

所有命令支持 `--root <dir>` 与 `--json`；`rm` 需 `--yes`。退出码：0 成功 / 1 用法 /
2 校验 / 3 未找到 / 4 IO。

## 安装（本机 DSH）

本地 bundle `@local/project-flow`，无 npm 依赖、无构建步骤：

```text
plugin_manager install_bundle  target=.
```

`cordis.patch.yml` 会 insert 条目 `project-flow`。安装后刷新页面；卸载用
`plugin_manager remove_bundle target=@local/project-flow`。

## 两种数据模式

- **store 模式**：项目有 `.dsh/flow/flow.json` → 实验/任务/门禁读 store，面板画 `parent` 谱系树；
- **legacy 模式**：没有 store → 沿用旧布局（git `Exp-Id` trailer、`.agents/tasks` JSON 或 Markdown、
  `.agents/gate-observe.log`、`.agents/heartbeat`），面板只读展示，不迁移、不写。

## 边界

- **面板只读（一个例外）**：面板唯一的写操作是「初始化」——`POST /api/project-flow/init`，
  同样经过 `lib/core.mjs` 的校验与原子写；其余写入口只有 CLI 与 agent 工具。
- **单一写者**：同一个 `.dsh/flow/` 不要再用其它脚本写；旧的 `task`/`exp.py` 在 store 项目里应停用。
- **零依赖**：只用 node 内置模块；不联网。
- **锁只防同机并发**；门禁步骤会以 `shell` 执行，命令来自项目自己的 `gates/*.json`，请只放可信命令。
- 面板每 2.5 秒轮询 `GET /api/project-flow/state?root=<当前工作区目录>`，只展示该工作区的台账，
  不再切换或汇总其它项目；该工作区没有 `.dsh/flow` 台账时显示「未初始化」空状态。页面隐藏时暂停，无 watcher，每次请求现算。
- 实验/门禁日志只示「最近」切片（实验 400 条、门禁日志 10 行、心跳 20 条、运行输出 4 个文件）。

## 自测

`.selftest/` 与 `test/` 是可重跑的回归资产：

```text
node --test test/                        # core + CLI + check：48 用例
node .selftest/harness.mjs               # Host legacy 适配器
node .selftest/host2-tools.mjs           # Host store 模式、4 工具、3 技能
node .selftest/client-registration.mjs   # Client 座位注册 / locale
node .selftest/client-render.mjs         # Client 渲染 + 真实 payload 回放
node .selftest/client-poll.mjs           # Client 轮询 / 取消 / 可见性
```

`.selftest/state-*.json` 是 Host 自测生成的快照，`client-render.mjs` 直接回放。

## 许可证

[MIT](LICENSE) © 2026 Han-Haocheng。可自由使用、修改、分发与再许可，保留版权与许可声明即可。
