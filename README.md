# project-flow

项目流程台账 + 只读面板：实验（含 `parent` 谱系）、任务、门禁定义与运行记录都写在
**项目自己的 `.agents/flow/`** 下；面板是它的只读视图，写入口只有 `bin/flow.mjs`（CLI）与
agent 工具（`flow_exp` / `flow_task` / `flow_gate`，共用同一个核心 `lib/core.mjs`）；面板自身
有两个写例外：未初始化空态的「初始化」`POST /api/project-flow/init`，与门禁开关
`POST /api/project-flow/gate`（均经 core 校验与原子写，见 `CONTRACT.md` §9.1 三端点表）。

| 入口 | 用途 |
|---|---|
| 右侧栏标签页「项目流」 | 看实验树、任务进度、门禁、心跳（只读；未初始化时可一键初始化） |
| 会话头小图标 / 指南卡 | 打开同一面板 |

面板按**项目主工作区**读台账：会话在 linked git worktree 里时也看同一份台账，头部同时显示
「台账分支」与「当前分支」，心跳行标注该会话所在分支（`branch`/`worktree` 字段）。
| `node bin/flow.mjs …` | 人改台账、跑门禁 |
| agent 工具 `flow_*` | 模型改台账、跑门禁 |
| 内嵌技能 `project-flow-init` / `project-flow-usage` / `ai-collaborative-dev-workflow` | 教模型何时初始化、怎么维护台账，以及中心-贡献者协作（谁提交、谁判定、谁合并）、Agent Teams 四类角色（中心/分析者/实现者/审查者）与状态机、项目任务映射、发布纪律 |

契约与记录格式见 [CONTRACT.md](CONTRACT.md)；Agent 技能正文见 `skills/`。前两个技能是单文件
（`skills/<name>.md`）；`ai-collaborative-dev-workflow` 以目录形式随包分发
（`skills/ai-collaborative-dev-workflow/`，含 `references/`、`assets/`、`scripts/`，
注册时带 `resourceBase` 目录），它的机械检查同时可由
`flow check staged|release-baseline|state|doc|decisions|experiments|tasks|description` 触发（共八项，
`flow check list` 是权威清单；`experiments` 在项目关闭实验区时直接 exit 0 跳过，`tasks`
只读报告旧任务记录未归一，`description` 检查描述台账漂移）。

## 初始化一个项目

```text
node bin/flow.mjs --root <项目根> init [--name 名称]
```

会在 `<项目根>/.agents/` 下创建：

```
.agents/
  flow/
    flow.json               契约（schema 2）
    logs/<gateId>/<时间>.json 门禁运行记录
  experiments/<id>.json     实验（E-YYYYMMDD-NN，parent 指向父实验）
  tasks/<id>.json           任务（T-YYYYMMDD-NN）
  gates/<id>.json           门禁定义（步骤 + 期望 + 超时）
  description/              项目描述台账（project.json / files/ / tasks/，见「项目描述」）
```

`flow/` 只放契约与门禁日志；其余记录目录与它平级。

## 常用 CLI

```text
flow status                     # 项目名/契约/计数/最近记录
flow exp list|show <id>|tree    # 实验列表、详情、谱系树（可选功能，默认关闭）
flow exp add --title T --direction '降低 tie 率' --expected E --primary-metric M \
             --guardrail G --falsify F --window-days 7 --stop-loss S
flow exp review <id>            # 只读自查分流还缺什么（恒 exit 0）
flow exp productize <id>        # 门禁通过后写产品化；失败实验用 flow exp cleanup <id> --flag …
flow task add --title T --type feat [--status draft|active|done|archived] [--parent T-id]
                             # --parent ''|none|null 清空为根；task update 同
flow task archive [--older-than N]   # 归档到期任务（默认 tasks.archiveAfterDays=7，0 关闭）
flow task normalize [--type-map <file.json>] [--dry-run]
                             # 旧记录归一：goal 并入 title、按 map 补 type（不猜 type；--dry-run 只报告不写盘）
flow gate add --id smoke --title 冒烟 --phase commit --step 'tests=ctest ...>>exit 0'
flow gate run smoke             # 顺序执行步骤、首个失败即停、写运行记录
flow gate logs smoke            # 最近运行记录

flow desc build                 # 扫 include 范围，建/同步文件记录（哈希、import、模块边）
flow desc status                # 文件数 / 模块数 / 缺语义 / 计划数
flow desc plan T-… --template lib/core.mjs    # 分析阶段：写语义变更计划（--input 提交）
flow desc apply T-…             # 实现阶段：把计划语义落进文件记录（计划转 implemented）
flow desc render [--out p]      # 生成 description.render 指向的文档（确定性，勿手改）
flow check description --task T-… [--strict]  # 审查阶段：计划对齐 + 漂移检查
```

所有命令支持 `--root <dir>` 与 `--json`；`rm` 需 `--yes`。退出码：0 成功 / 1 用法 /
2 校验 / 3 未找到 / 4 IO。

## 实验（可选）

实验是任务的**外围**，默认关闭：`flow.json` 的 `experiments` 节 `enabled` 缺省为 `false`
（`flow init` 写入 `false`）。关闭时 web/TUI 面板不渲染实验区、任务区单列；`flow exp …` 与
`flow_exp` 工具照常可用——数据始终在 `.agents/experiments/`，只是不展示。开启后实验树在
面板里**默认折叠**，展开状态只留在当前会话。

**开启**：在 `.agents/flow/flow.json` 里把 `experiments` 写成 `{ "enabled": true, … }`（保留
`source`/`dir`），下一次面板刷新即生效，不需要重新 `flow init`。旧项目缺 `enabled` 且已有
实验记录时**仍按关闭处理**并给一次性引导 warning（不自动开启）；本仓库当前 **0 条**，其它
项目数量以 `ls .agents/experiments | wc -l` 实测为准。

实验项目的七步：**识别问题** → **提出假设**（七字段：`direction` 方向、`expected` 期望、
`primaryMetric` 主指标、`guardrails` 护栏指标、`falsify` 证伪条件、`windowDays` 观测周期、
`stopLoss` 止损线）→ **建任务**（`flow task add --experiment E-…`）→ **设计实现**（隔离分支）
→ **实现** → **审查实现** → **完成任务并按测试判定分流**。

```text
flow exp add --title T --direction '降低 tie 率' --expected 'tie_mean<=1.0' \
             --primary-metric tie_mean --guardrail p95_ms --falsify 'tie_mean>1.05' \
             --window-days 7 --stop-loss 'p95 恶化 >10% 立即停止'
flow exp review <id>            # 自查分流还缺什么（只读，恒 exit 0）
flow exp productize <id>        # 门禁通过后写产品化；失败实验用 flow exp cleanup <id> --flag …
```

| 结果 | 状态 | 必做动作 | 之后 |
|---|---|---|---|
| 成功（主指标达标、护栏未破） | `confirmed` | 写 `--measured`/`--metrics`；过 `release` 门禁后 `flow exp productize <id>` | 合并/上线，`productizedAt` 已记录 |
| 不确定（窗口内证据不足） | `inconclusive` | `--learned` 记结论（建议） | 继续验证或调整假设（新实验 `--parent` 指向它） |
| 失败（证伪条件命中） | `refuted` | `--learned`，再 `flow exp cleanup <id> --flag/--code/--data` | 停止丢弃，保留学习与清理记录 |
| 转向（保留部分资产换假设） | `pivoted` | `--learned`，新建后继实验 `--parent` 指向旧实验 | 沿用资产继续，旧实验不再更新 |

**门禁**：`release` 阶段可跑 `flow check experiments`（实验关闭时**直接 exit 0 跳过**，不
阻断）；硬拦只有四类：schema2 缺七字段、`refuted` 缺学习/清理、`pivoted` 缺学习或后继、
`confirmed` 未产品化；`open` 超过观测周期只 warning（`experiment-window-elapsed`），结果仍
由人判定。

## 项目描述（强制语义更新）

`.agents/description/` 记的不是「有哪些文件」，而是「每个文件/模块是干什么的」。结构（哈希、
import、模块边）由 `flow desc build` **自动**同步；语义**不能自动推断**，只能由人/模型在分析阶段
写进计划、在实现阶段 apply 到文件记录。三族记录的 schema、编码与校验见 `CONTRACT.md` §3.7，
检查判定见 §6.1.4。

为什么强制：注释会漂、地图会漏。语义台账把「改代码必须解释改了什么语义」变成**可检查的动作**，
而不是靠审查者记得问；漂移（改了代码没改语义）由 `stale-hash` / `unknown-member` 这类检查抓，
不靠人盯 diff。

| 阶段（任务 `stage`） | 谁 | 做什么 | 命令 |
|---|---|---|---|
| 分析 `analyzing` | 分析者 / 中心 | 只读仓库，写**语义变更计划**：新增/修改/删除哪些文件与模块、各自的新语义是什么；不动代码 | `flow desc plan <T> --template <src>` → `--input plan.json` |
| 实现 `implementing` | 实现者 | 照计划写代码；先同步结构，再把计划语义落进文件记录，最后补未计划模块的语义 | `flow desc build` → `flow desc apply <T>` → `flow desc set --input …` |
| 审查 `reviewing` | 审查者 | 计划对齐 + 漂移检查 + 测试证据（`testGate` 的绿记录要晚于 `implemented_at`） | `flow check description --task <T>`（门禁里再用 `--strict`） |

```text
flow desc build                                   # 先建记录（结构齐全、语义为空）
flow desc plan T-20261108113206 --template lib/core.mjs > plan.json
$EDITOR plan.json                                 # 写 files[].semantics 与 modules[]
flow desc plan T-20261108113206 --input plan.json # 分析阶段的产物；--rebase 只刷新 base
flow desc build && flow desc apply T-20261108113206   # 实现阶段：结构同步 + 语义落盘
flow desc show --path lib/core.mjs --graph tree   # 看一个文件的模块图
flow desc render --out docs/description.md        # 生成文档（两次输出逐字相同）
flow check description --task T-20261108113206    # 审查阶段：计划对齐 + 漂移
```

- **计划二选一**：`files` 非空 xor `noSemanticChange: true` + 非空 `reason`；确实没有语义变更
  时写明理由，不要留空（`plan-missing` 会拦）。
- **apply 后计划冻结**：之后要改语义就改文件记录（`flow desc set`），不要回改计划；审查阶段想改计划，
  先把任务退回 `implementing`（阶段机见 `CONTRACT.md` §3.2.1）。
- **不要手写结构字段**：`hash`/`imports`/`moduleEdges` 由 `build` 推导，手写只会在下一次 build 被覆盖、
  或被 `stale-module-edges` 判红。

**强制级别 `description.enforce`**：`auto`（默认——store 里已有 ≥1 条文件记录才约束任务阶段推进，
新项目零记录时不受限）、`on`（恒约束，计划缺失即拒）、`off`（只关阶段门；`flow check description`
仍可手动跑）。阶段门在**进入** `queued-implementation`（计划合法）/ `queued-review`（计划
`implemented`、计划内文件全量检查通过、无 `unplanned-change`）/ `done`（再加测试证据：`testGate`
有晚于证据起点的绿记录）时生效。

**门禁**：`flow init` 的 `precommit` 多一步 `flow check description`、`release` 多一步
`flow check description --strict`（`undescribed-file` 在严格模式下才算失败）。种子只对**空 gates
目录**生效，已有项目要手动 `flow gate update … --step` 补步且**必须带上原步骤**（`--step` 是整体
替换，见 `CONTRACT.md` §3.3.1）。

**生成文档**：把 `description.render` 写成仓库相对路径（如 `docs/description.md`），
`flow desc render` 从记录生成确定性 Markdown（无墙钟时间，两次逐字相同），`--check` 只比对不写；
配置后 `check description` 也会比对，**手改生成物会红**（`render-stale`）——生成物是投影，不是第二个
真源。

## 安装（本机 DSH）

本地 bundle `@local/project-flow`，无 npm 依赖、无构建步骤：

```text
plugin_manager install_bundle  target=<仓库根目录>
```

`cordis.patch.yml` 会 insert 五个条目：`project-flow`（面板）、`project-flow-tui`（TUI 侧栏）、
`project-flow-tasks` / `project-flow-gates` / `project-flow-experiments`（三个子插件入口）——
安装即五个一起装载，不提供逐条启用。安装后刷新页面；卸载用
`plugin_manager remove_bundle target=@local/project-flow`。

## TUI 侧栏面板

在 dsh-tui 里，同一份 `.agents/flow` 台账还会以一个只读侧栏面板呈现（面板标题「项目流程」）。
web 端「项目流」标签页与 TUI 面板读的是同一个工作区的同一份 store，不存在第二份数据。

- **打开**：`Ctrl+B` 展开侧栏后，标签栏会出现「项目流程」（临时面板默认启用）；也可用 `/panel` 选择器切换。
- **只读**：TUI 面板不写台账；写入仍只走 CLI 与 `flow_*` 工具（「初始化」只在 web 面板的空态上提供）。
- **刷新与滚动**：每 3 秒自动刷新当前工作区；`r` 手动刷新，`j` / `k` 上下滚动。
- **身份（已知限制）**：面板走 `tuiPanels`，这是 dsh-tui 的实验性接缝。宿主用**调用方
  activation 的 Component 身份**做面板 id 前缀，而 Cordis 里唯一能通过服务调用的上下文是
  `inject` 生成的作用域 —— 它没有 Component 身份。因此当前面板 id 是每次会话的
  `session:actN:flow`（临时面板，会自动进入侧栏启用集合）。包根 `dsh-plugin.json` 仍保留：
  它让 dsh-tui 承认本包为 Component（componentId `project-flow`，用于效果台账/授权归属），
  一旦上游把「注入作用域继承激活身份」补上，面板 id 就会自动变成 `project-flow:flow`，无需改本包。

## 边界

- **面板只读（两个例外）**：面板仅有的写操作是「初始化」`POST /api/project-flow/init` 与门禁
  开关 `POST /api/project-flow/gate`，两者都经 `lib/core.mjs` 的校验与原子写；其余写入口只有
  CLI 与 agent 工具。
- **单一写者**：同一个 `.agents/flow/` 不要再用其它脚本写；旧的 `task`/`exp.py` 在 store 项目里应停用。
- **描述台账可提交**：`.agents/description/` 与其它台账一样是**真相源**（语义要评审、要回溯），
  随 `.agents/flow/` 一起提交；只有 `.lock` 与 `*.tmp-*` 是临时文件（见 `CONTRACT.md` §8）。
  `description.render` 指向的生成文档同样可提交，但它由 `flow desc render` 生成、**不要手改**
  （`check description` 会比对出 `render-stale`）。
- **任务自动归档**：`precommit` 里的 `flow task archive` 步把 `tasks.archiveAfterDays`
  （默认 **7** 天；`0` 关闭）**已满** N 天（按 `updated_at` 计，边界含端点）的任务改成
  `archived`——纯状态位、可逆、幂等。归档只由显式命令与门禁步骤触发，面板与读端点从不写；
  旧项目**缺哪步补哪步**（`decisions` 与 `tasks-archive` 两步，见 `CONTRACT.md` §3.3.1）。
- **实验面板默认关闭**：`experiments.enabled` 默认 `false`，只影响面板展示与 `check experiments`
  （关闭时该检查直接 exit 0 跳过）；CLI、`flow_exp` 与写路径不受影响。旧项目缺键默认关闭、需
  手动开启（见「实验（可选）」）。
- **零依赖**：只用 node 内置模块；不联网。
- **锁只防同机并发**；门禁步骤会以 `shell` 执行，命令来自项目自己的 `gates/*.json`，请只放可信命令。
- **单飞轮询**：面板对 `GET /api/project-flow/state?root=<当前工作区目录>` 任一时刻至多一个在途请求，
  下一次在上一次落定（settle，成功或失败）后 2500 ms 再排，不是固定墙钟间隔；慢于 2500 ms 的响应
  不会被后继请求取消。页面隐藏时不发请求但链保持，回到可见立即补拉；`abort` 只用于卸载、工作区切换、
  手动刷新。面板只展示该工作区的台账，不切换或汇总其它项目；该工作区没有 `.agents/flow` 台账时显示
  「未初始化」空状态。无 watcher，每次请求现算。state 读在 fork 出的子进程里完成、有
  **1800 ms** 期限：超时 / 子进程崩溃 / 池满返回 200 `ok:false`（`state-timeout` /
  `state-worker-crashed` / `state-worker-unavailable`）；面板保留最后一次好数据并标「数据
  过期」，不显示半成品（见 `CONTRACT.md` §9.1.1）。
- **心跳存活**：心跳按 `liveness` 分 `live` / `dead` / `stale` / `foreign` / `unknown`——宿主
  重启或 pid 消失记 **dead**（可证明已死），跨机记 **foreign**（只在别处活跃），
  `ageSeconds > 6h` 记 **stale**（可能已停，可与 dead 重叠）。`flow heartbeat list` 有「存活」
  列；`flow heartbeat status --require-active` 对 dead/stale/foreign 退出 1（见 `CONTRACT.md` §3.5）。
- **心跳默认只显示活跃/新鲜条目**：`dead` 与超 6h 无证据的 `stale` 折叠为计数（CLI 末行「已隐藏
  N 条」，`flow heartbeat list --all` 可看全部，文件不删）；面板/TUI 同样默认隐藏，只在区末提示
  「+N 条已隐藏」（见 `CONTRACT.md` §3.5/§5.1）。
- 实验默认关闭（见「实验（可选）」）；开启后只示「最近」切片（实验 400 条、心跳 20 条）；门禁示最近一次运行。
- **任务 id 是时间戳**：`T-<YYYYMMDDHHMMSS>`（如 `T-20261105212130`，同秒追加 `-02`…），
  **天然单调、删除不复用**；旧 `T-YYYYMMDD-NN` 仍可读；跨分支同秒撞名属 **git 合并冲突**，
  需**人工重编号**，**禁止** `-X ours/theirs`（见 `CONTRACT.md` §3.2）。

## 自测

`.selftest/` 与 `test/` 是可重跑的回归资产：

```text
node --test test/                        # core + CLI + check：710 用例（56 个文件）
node .selftest/harness.mjs               # Host 只读端点：store 投影 / 未初始化空态
node .selftest/host2-tools.mjs           # Host store 模式、6 工具、3 技能
node .selftest/client-registration.mjs   # Client 座位注册 / locale
node .selftest/client-render.mjs         # Client 渲染 + 真实 payload 回放
node .selftest/client-poll.mjs           # Client 轮询 / 取消 / 可见性
node .selftest/root-explicit.mjs         # 显式 --root 的 Host 读路径
```

`.selftest/state-*.json` 是 Host 自测生成的快照，`client-render.mjs` 直接回放。

## 许可证

[MIT](LICENSE) © 2026 Han-Haocheng。可自由使用、修改、分发与再许可，保留版权与许可声明即可。
