# 模块职责与并行写域

> 面向：并行改这个仓库的多个会话（任务 / 决策 / 心跳 / 描述 / 面板 / CLI）。
> 一句话：**每个文件都有唯一归属；共享文件只准改登记过的区段；越界先改边界、再改代码。**
>
> 数据真源是 [`module-domain.json`](module-domain.json)；本文档是人的读法，两者由
> `test/t-20261108-module-domain.test.mjs` 与 `node scripts/module-domain.mjs verify` 互相钉住。

## 1 判定标准

一个改动「属于本模块」当且仅当满足其一：

1. 文件在该模块的 `owns`（精确路径，或 `dir/` 前缀）里；
2. 文件在该模块的 `shared` 里，且改动落在 `sections` 给该模块登记的区段内；
3. 测试文件在该模块的 `tests` 里。

否则就是越界：`check` 会把它标成 `FOREIGN` 并 exit 1。**测试跟着被测模块走**，不跟着目录走。

## 2 模块表

| 模块 | 职责 | 独占文件（owns） | 共享文件（shared） | 测试 |
|---|---|---|---|---|
| `framework` | Host 装配：`apply`、路由、工具/技能/提示注册、权限面、子插件入口、清单；装配层已拆到 `lib/host/*` | `index.js`、`lib/host/*`、`tasks.js`/`gates.js`/`experiments.js`、`tui-host.js`、`lib/plugin/*`、`dsh-plugin.json`、`cordis.patch.yml`、`package.json`、`docs/`、`scripts/module-domain.mjs`、`scripts/doc-counts.mjs` | `lib/core.mjs`（aggregate）、`bin/flow.mjs`（entry）、`README.md`（selftest-count）、`CONTRACT.md`（c1.1） | 7 |
| `store` | 存储基础：契约骨架、记录原语、锁、原子写、路径 containment、进程树 | `lib/store/`、`lib/core.mjs`、`lib/util.mjs`、`lib/paths.mjs`、`lib/atomic.mjs`、`lib/lock.mjs`、`lib/proc.mjs` | — | 6 |
| `tasks` | 任务 CRUD、九阶段状态机、捕获流水线、子任务、P3b 派工、团队板对账 | `lib/stage.mjs`、`lib/capture.mjs`、`lib/team-sync.mjs`、`lib/dispatch.mjs`、`lib/tools/tasks.mjs`、`lib/tools/subtasks.mjs` | `lib/core.mjs`（tasks）、`lib/state-snapshot.mjs`（snapshot-tasks）、`client.js`、`bin/flow.mjs`、`CONTRACT.md`（c3.2） | 12 |
| `decisions` | 决策台账、否决、命令解析、会话隔离 | `lib/decisions/`、`lib/veto.mjs`、`lib/commands.mjs` | `lib/core.mjs`（decisions×2）、`lib/host/session.mjs`（reminder）、`lib/host/tools.mjs`（tools）、`client.js`、`bin/flow.mjs`、`CONTRACT.md`（c3.6） | 4 |
| `heartbeats` | 心跳存活判定、自动开关、面板行 | `lib/heartbeats/` | `lib/core.mjs`（heartbeats）、`index.js`（heartbeats）、`lib/state-snapshot.mjs`（snapshot-heartbeats）、`client.js`、`bin/flow.mjs`、`CONTRACT.md`（c3.5） | 3 |
| `gates` | 门禁定义/运行、`flow check` 检查器 | `lib/runner.mjs`、`lib/checks.mjs`、`lib/tools/gates.mjs` | `lib/core.mjs`（gates/default-gate-seeds）、`index.js`（gate-http）、`bin/flow.mjs`、`CONTRACT.md`（c3.3/c3.4/c6） | 3 |
| `experiments` | 实验树、七字段、分流 | `lib/experiments/`、`lib/tools/experiments.mjs` | `lib/core.mjs`（experiments）、`client.js`、`bin/flow.mjs`、`CONTRACT.md`（c3.1） | 0 |
| `description` | 文件图/模块图/语义/漂移 | `lib/description/`、`lib/desc.mjs`、`lib/source-scan.mjs` | `lib/core.mjs`（description）、`lib/state-snapshot.mjs`、`index.js`、`bin/flow.mjs`、`CONTRACT.md`（c3.7/c6.1.4）、`README.md` | 5 |
| `panel` | 只读快照投影、Web 面板、TUI 面板 | `lib/state-snapshot.mjs`、`client.js`、`tui-panel.js`、`locale/*` | `index.js`（state-read-isolation）、`CONTRACT.md`（c9） | 11 |
| `backup` | 台账本地快照、`flow doctor` 完整性报告、过期快照提醒 | `lib/backup.mjs` | `bin/flow.mjs`（命令）、`lib/host/session.mjs`（挂载提醒）、`CONTRACT.md`（c8） | 1 |
| `cli` | 参数面、命令分发、输出 | `lib/cli/`、`bin/flow.mjs`（薄入口） | — | 4 |
| `docs` | 契约正文、README、内嵌技能 | `CONTRACT.md`、`README.md`、`skills/` | — | 3 |

> 2026-11-11 Phase 1 起，`heartbeats` 也有独占目录 `lib/heartbeats/`（此前它的代码全在
> `core` / `index` / `state-snapshot` 的区段里）；"唯一无文件模块"的历史特例就此消失。

## 3 共享文件的区段协议

共享文件按注释锚点切段（锚点必须是文件里一字不差的一行，`verify` 会检查存在、唯一、顺序）：

| 文件 | 区段（`docs/module-domain.json` 的 `sections` 键） |
|---|---|
| `lib/core.mjs` | `contract` · `default-gate-seeds` · `storage-helpers` · `experiments` · `tasks` · `gates` · `decisions`（+`decisions-2`）· `heartbeats` · `aggregate` · `description` |
| `index.js` | `entry`（只剩 `apply` 装配与 `mountJsonRoute`） |
| `lib/host/shared.mjs` | `workspace` · `http`（常量 / 工作区作用域 / HTTP 助手） |
| `lib/host/session.mjs` | `heartbeats` · `reminder` · `capture` · `switches` |
| `lib/host/state.mjs` | `state`（快照池 + HTTP 读路由 + 面板读路径） |
| `lib/host/team.mjs` | `team`（团队板读面 + 面板载荷组装） |
| `lib/host/enforce.mjs` | `enforce`（P2 权限面） |
| `lib/host/tools.mjs` | `tools`（工具定义 + 注册） |
| `lib/state-snapshot.mjs` | `primitives` · `snapshot-tasks` · `snapshot-heartbeats` · `payload` |
| `bin/flow.mjs` | `parse` · `output` · `commands` · `entry` |
| `CONTRACT.md` | `c3.1`…`c3.7` · `c6` · `c6.1.4` · `c9` |
| `README.md` | `selftest-count`（自测用例数/文件数，全仓派生数字，由框架会话维护） |

规则：

- 只改登记给本模块的区段；**跨区段需要的公共函数**放进 `storage-helpers` / `aggregate`（`store` 的区段），
  由框架会话改，不在别人的业务区段里加公共工具。
- 同一区段内优先**追加**（新函数放段尾），不改段首的分段注释——那是锚点。
- 新增区段：先改 `docs/module-domain.json` 的 `sections` 与对应模块的引用，跑 `verify`，再动代码。

## 4 并行工作协议

1. **动手前先自检**：`node scripts/module-domain.mjs check --module <你的模块>`。
   `FOREIGN` 一律停手——那是别人的 `owns`；`shared` 会打印你只能改的区段。
2. **提交只带自己模块的文件**。与 `scripts/commit-scope.mjs` 配合：台账与源码不同提，
   跨模块改动拆成多笔，每笔只属于一个模块。
3. **合并顺序**：`framework` → `store` → `tasks` → `decisions` → `heartbeats` → `gates` →
   `experiments` → `description` → `panel` → `cli` → `docs`。后合并者对自己的共享文件改动做 rebase；
   冲突处理只允许"保留双方各在自己的区段"，**不允许**把另一模块的改动挪位置。
4. **边界变更走框架会话**：改 `docs/module-domain.json`、改分段锚点、新增模块、拆文件，
   都由框架会话统一做（先数据、后代码、最后跑 `verify` + 全量测试）。

## 5 检查与门禁

```bash
node scripts/module-domain.mjs verify              # 数据完整性（CI / precommit）
node scripts/module-domain.mjs matrix              # 模块矩阵
node scripts/module-domain.mjs check --module tasks            # 按当前 git 改动判越界
node scripts/module-domain.mjs check --module tasks --files lib/desc.mjs
```

接入建议（待并行波次合并后加进 `precommit` 门禁，不替换原步骤）：

```text
node scripts/module-domain.mjs verify  # 期望 exit 0
```

## 6 与现有守卫的关系

| 守卫 | 守什么 | 不守什么 |
|---|---|---|
| `t-20261107-module-boundaries` | 依赖方向：无环、`checks` 不 import `core`、`util` 是叶子、`taskkill` 一处 | 谁该改哪个文件 |
| `t-20261107-module-map-drift` | `CONTRACT §1.1` 覆盖 `lib/*.mjs`，无幽灵行 | 区段归属、并行冲突 |
| `scripts/commit-scope.mjs` | 台账与源码不同提交 | 源码内部的模块归属 |
| **本文档 + `module-domain.mjs`** | **谁该改哪个文件、共享文件只能改哪段** | 代码正确性、依赖方向（交给上面三条） |

四者是互补关系，任何一条都不能替代另一条。

## 7 物理拆分路线（消除共享文件本身）

写域协议只是"并行时不打架"的第一层；共享文件本身越大，区段重叠的概率越高。目标拆法：

| 期 | 动作 | 状态 |
|---|---|---|
| 1 | `lib/core.mjs` 按 `sections` 拆成 `lib/store/{contract,tasks,decisions,heartbeats,gates,experiments,description,aggregate}.mjs`，`core.mjs` 变成只做 re-export 的聚合层（所有现有 `import ... from './core.mjs'` 不变） | **未做**（下一期） |
| 2 | `index.js` 拆成 `lib/host/*.mjs`，`index.js` 只剩 `apply` 装配 | ✅ 2026-11-08 完成（3256 → 320 行；707 用例 + 6 selftest 全绿） |
| 3 | `client.js` 按面板区块拆 | **2026-11-11 判定：不拆**（见 §7.1） |
| 4 | `bin/flow.mjs` 拆成薄入口 + `lib/cli/*` 命令模块 | ✅ 2026-11-11 完成（3756 → 520 行 + 9 个命令模块；825 用例 + 门禁全绿） |

每期都按「先加新文件 + re-export，再迁移实现，最后删旧段」三步走，任何一步测试全绿才进下一步。
期 2 的实际顺序：`shared` → `session`（用 `sessionHooks` 注入打破与 enforce/team 的循环）→ `routes` → `team` → `state` → `enforce` → `tools` → `skills` → `index.js` 只剩入口。

### 7.1 client.js 为什么保持单文件（2026-11-11 只读评估）

评估结论：**物理拆分的两条路都不划算，保持单文件 + `#region` 逻辑分区。**

1. **ESM 拆分（`lib/panel/*.mjs` + import/export）不可行（P0）**：DSH 宿主把
   `package.json` 的 `exports["./client"]` 文件**原样当经典脚本**下发（`<script src>`、
   无 `type=module`、不打包、只剥 sourcemap 后与其他插件 `;` 拼接），静态 import 在
   浏览器就是 SyntaxError；`node --check` 因按 ESM 解析还会给出假绿。三个探针
   harness（`.selftest/client-render.mjs`、`client-poll.mjs` 复制到 `.client-probe/`，
   `test/t-20261111-01-goals-framework.test.mjs` 写 `.cjs`）在拆分后分别会
   `ERR_MODULE_NOT_FOUND` / 语法错；另有 10 处直接读 `client.js` 源码的断言（字典定位、
   CSS、token、挂载顺序）会全红。
2. **源分片 + 生成单文件（形态 B）技术可行但代价过高**：原型按现有区段切片再顺序拼接，
   输出与现文件逐字节相同（md5 一致），selftest 零改动；但要引入 `scripts/build-client.mjs`
   构建步骤与漂移守卫 `--check`，并同步 CONTRACT/README/写域数据——与本插件
   「零 import、无构建」的定位冲突。当前收益（5 个模块共享文件的写域冲突）不足以换这一层
   构建管线；等真实出现并行编辑冲突再重启。
3. **宿主 chunk（`client.<name>.js` + `require.async`）不满足约束**：异步化后
   `__probe` 无法同步导出，两个 selftest 必须改；且 HMR 只监听入口、chunk 响应带
   immutable，改了看不到。

**当前并行编辑约定**（`client.js` 仍是 5 个模块的 shared 文件）：

| 区段（`#region`） | 行段 | 主要归属 |
|---|---|---|
| locale dictionaries | 141–~500 | panel（改动影响所有卡片，需全员知觉） |
| defensive helpers / state normalization / icon / presentational / fold header | ~502–1768 | panel |
| experiment tree | ~1442–1577 | experiments |
| right column cards | ~1769–3018 | tasks / decisions / heartbeats / gates / experiments（各自只改自己的卡片组件，跨卡片改动先协商） |
| top bar / footer / states / panel + polling / display preferences / right-bar seats | ~3019–4064 | panel |
| styles | ~4065–4370 | panel |

真正发生并行冲突时，优先方案是给 `right column cards` 段内加更细的 `#region` 锚点并登记
`sections`，而不是引入构建。
