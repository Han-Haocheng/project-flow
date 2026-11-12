# 模块职责与并行写域

> 面向：并行改这个仓库的多个会话（任务 / 决策 / 心跳 / 门禁 / 实验 / 描述 / 面板 / CLI / 文档）。
> 一句话：**每个文件都有唯一归属；共享文件只准改登记过的区段；aspect 告诉你改它要通知谁；越界先改边界再动手。**
>
> 数据真源是 [`module-domain.json`](module-domain.json)；本文是人的读法，**不抄全量数据**——精确清单以
> `node scripts/module-domain.mjs matrix` / `owners` / `verify` 的输出为准。

## 1 判定标准

一个改动「属于本模块」当且仅当满足其一：

1. 文件在该模块的 `owns`（精确路径，或 `dir/` 前缀）里；
2. 文件在该模块的 `shared` 里，且改动落在 `sections` 给该模块登记的区段内；
3. 测试文件在该模块的 `tests` 里。

否则就是越界：`check` 会把它标成 `FOREIGN` 并 exit 1。**测试跟着被测模块走**，不跟着目录走。
`aspect` 不参与这条判定（见 §4）。

## 2 模块表（职责；精确写域以命令输出为准）

| 模块 | 职责 |
|---|---|
| `framework` | Host 装配：`apply`、路由、工具/技能/提示注册、权限面、子插件入口、清单；`lib/host/*`、`scripts/*`、`docs/` |
| `store` | 存储基础：契约骨架、记录原语、锁、原子写、路径 containment、进程树 |
| `tasks` | 任务 CRUD、九阶段状态机、捕获流水线、子任务、P3b 派工、团队板对账 |
| `decisions` | 决策台账、否决、命令解析、会话隔离 |
| `heartbeats` | 心跳存活判定、自动开关、面板行 |
| `gates` | 门禁定义/运行、`flow check` 检查器、规则文件监视 |
| `experiments` | 实验树、七字段、分流 |
| `description` | 文件图/模块图/语义/漂移（AST 派生字段已停用，只保留语义与 issue 形状） |
| `panel` | 只读快照投影、Web 面板、TUI 面板、`client.js`、`locale/*` |
| `backup` | 台账本地快照、`flow doctor` 完整性报告、过期快照提醒 |
| `cli` | 参数面、命令分发、输出、`--json` 契约、完整 MCP 工作流与自动编排 |
| `docs` | 契约正文、README、内嵌技能与写域文档 |

> 每个模块的 owns / shared / tests 条目数：`node scripts/module-domain.mjs matrix`；
> 「这批文件属于谁」：`node scripts/module-domain.mjs owners --files a,b`。

## 3 区段协议（`sections`）

区段是文件内**一字不差的一行锚点**（`from`/`to`，`to: null` 表示到文件末尾）：

- `verify` 检查锚点**存在、唯一、顺序正确**；
- 锚点不匹配时打印**期望行、最接近的实际行与逐码点差异**（全角 `（` 与半角 `(` 当场可辨）；
- **不再手抄区段表**：清单以 `docs/module-domain.json` 的 `sections` 为唯一真源，用
  `matrix` / `verify` 输出核对。旧的固定行号表已删除（它漂移过）。
- 共享文件必须登记 **至少一个区段**（`verify` 的「共享未登记区段」检查）：没有区段的 shared
  等于整文件可改，会直接判红；
- 每个顶层区段都必须被至少一个模块引用（否则是「孤儿区段」，同样判红）；
- 模块可以给自己 `owns` 的文件登记**自用区段**（用于标记内部边界），这类区段不要求出现在 `shared` 里；
- 规则：只改登记给本模块的区段；**追加**时把新代码放段尾、不要移动锚点行；
  新增区段先改 JSON（`sections` + 模块引用），跑 `verify`，再动代码。

`client.js` 按 `#region` 登记了 12 个逻辑区段（`panel + polling` 是包裹型 region，不单独登记）：

| 区段 | 归属 |
|---|---|
| `locale-dictionaries` / `defensive-helpers` / `state-normalization` / `icon` / `presentational-pieces` / `fold-header` / `top-bar` / `display-preferences` / `right-bar-seats` / `styles` | panel |
| `right-column-cards` | panel 拥有；tasks / decisions / heartbeats / experiments 各自只改自己的卡片组件 |
| `experiment-tree` | panel 拥有；experiments 可改 |

### 3.1 数据为什么留在 `docs/module-domain.json`

不迁到 `.agents/flow/`（那里是运行期台账），理由：

1. **可追溯性**：`.agents/` 被 `.gitignore` 整目录忽略；写域图必须随代码 review、可 diff、可留痕；
2. **随包分发**：`package.json` 的 `files` 明确发布 `docs/module-domain.json` 与本文；
3. **构建期 vs 运行期**：本脚本是纯 FS、零依赖、不加锁、不要求 `flow init` 的**构建期门禁**，放进 store 会变成运行期台账，干净克隆上 precommit 就跑不了；
4. **归属自洽**：`docs/` 是 framework 的 `owns`，放在这里不需要额外豁免。

## 4 `aspect`：改它要谁知道 / 谁复核

`aspect` 是**横切关注面**：一句话不变量 + 指定复核角色（`ownerRole`）+ 显式文件清单 + 增删理由。
它**不给写权**，只回答「改这些文件时，哪个角色必须知道」。

当前四条（数据见 `docs/module-domain.json` 的 `aspects`）：

| aspect | 一句话语义 | 复核角色 | 代表文件 |
|---|---|---|---|
| `state-machine` | 任务只能沿九阶段的合法边迁移；任何写 stage 的路径都必须过同一处校验。 | `tasks-owner` | `lib/stage.mjs`、`lib/tasks/records.mjs`、`CONTRACT.md`、`client.js` |
| `liveness` | 心跳存活判定决定面板、任务与 claims 的「活」与「死」，只有一套口径。 | `heartbeats-owner` | `lib/heartbeats/records.mjs`、`lib/host/session.mjs`、`lib/state-snapshot.mjs` |
| `contract-text` | 契约正文、README、技能文档与写域文档是同一套口径，改一处必须同步另一处。 | `docs-owner` | `CONTRACT.md`、`README.md`、`docs/`、`skills/` |
| `concurrency` | 所有写盘走同一把锁与原子写；CAS / 补偿不得绕过这一层。 | `store-owner` | `lib/lock.mjs`、`lib/atomic.mjs`、`lib/store/*`、`lib/backup.mjs` |

### 4.1 `aspect` 与 `owns` 的区别（三句话）

1. `owns` 回答「**谁能改**」，`aspect` 回答「**改它要谁知道 / 谁复核**」；
2. `owns` 排他（一个文件恰好一个 owner），`aspect` **天然多归属**（一个文件可属多个关注面）；
3. `owns` 参与 `check` 的越界判定（会 exit 1），`aspect` **不参与越界判定、不产生审批闸**
   （裁定 6：审批换成锁；aspect 单点归属不能变成新瓶颈）。

### 4.2 新增 aspect 的判据（三条缺一不可）

1. 该不变量**已有独立守卫测试**；
2. **跨 ≥2 个模块**；
3. 漏了会出**正确性事故**（不是风格问题）。

`verify` 用「数量 ≤ 6」做刹车：超过上限必须先在数据里补理由。**不建议**加 style / formatting /
perf / test-coverage 类 aspect——它们没有事故面，只会稀释复核责任。

### 4.3 数据形状与只读消费契约（供 aspect 锁等程序）

`aspects⟫ / `roles⟫ 不只是人读文本：每条都要能被确定性校验、被程序稳定解析。下面是**字段契约**；
消费方（例如阶段 2 的 aspect 锁）**只读**，不得写、不得推导没声明的字段。

~~~text
aspects: {                                // 键 = aspectId，^[a-z][a-z0-9-]{2,40}$
  <aspectId>: {
    title:      string,                   // 人读短名（不参与匹配）
    semantics:  string,                   // ≥10 字符：这条横切面保证什么不变量（唯一权威语义）
    ownerRole:  <roleId>,                 // 必须能在 roles 里解析；是「复核角色」，不是人、不是 session
    files:      string[],                 // 非空、去重；精确文件或 dir/ 前缀；每项必须存在且已归属某模块
    rationale:  string                    // ≥20 字符：为什么存在（证据：已有守卫测试 / 跨模块 / 事故面）
  }
}
roles: {                                  // 键 = roleId，同一 id 规则
  <roleId>: {
    title:     string,
    semantics: string,                    // ≥10 字符
    modules:   string[]                   // 非空；每个名字必须是 modules{} 的键
  }
}
~~~

校验对照（`verify⟫ 的保证；逐条列出是为了让消费方知道「合法数据长什么样」）：

| 检查 | 结果 |
|---|---|
| aspect / role 的 id 形态 | 非法即红 |
| `semantics⟫ < 10 字符 / `rationale⟫ < 20 字符 | 红 |
| `ownerRole⟫ 不在 `roles⟫ 里 | 红 |
| aspect 的 `files⟫ 为空 / 有重复 / 路径不存在 | 红 |
| aspect 的 `files⟫ 条目未被任何模块 owns/shared/tests 覆盖 | 红 |
| aspect 数量 > 6 | 红 |
| `role.modules⟫ 为空或指向未知模块 | 红 |
| role 未被任何 aspect 使用 | 仅 warn |

**匹配语义（与 `owns⟫ 完全同一套，不要另写一份）**：

- 条目以 `/⟫ 结尾 → 目录前缀：`file === entry.slice(0, -1) || file.startsWith(entry)⟫；
- 否则 → 精确相等：`file === entry⟫；
- 文件路径一律是**仓库相对 POSIX 路径**（`/⟫ 分隔、无 `./⟫ 前缀、按 FS 大小写）；
- 一个文件可同时命中多个 aspect（多归属是特性，不是冲突）。

**aspect 与 owns 的机器边界（消费方必读）**：

1. aspect **不是写权**：判断「这次改动越不越界」只用 owns / shared + sections，绝不能用 aspect；
2. aspect **不是审批闸**：不得把 `ownerRole⟫ 当批准条件（裁定 6：审批换成锁）；
3. `ownerRole⟫ 只有两个用途：解析「复核通知发给谁」（`roles[ownerRole].modules⟫），以及
   在 aspect 锁上记录「持锁角色关注的面」——**都不产生放行/拒绝语义**；
4. 数据里**没有「人」**：角色到会话的映射由心跳与 claims 管，不要在 aspects/roles 里塞 session id。

**只读消费契约（aspect 锁必须遵守）**：

1. **只读**：任何程序不得写回 `docs/module-domain.json⟫；写入口只有「编辑该文件 + 跑 verify」；
2. **每次从磁盘读**，不跨会话缓存；数据变更（git diff 命中该文件）后已持有的 aspect 锁一律失效重建，
   不得自动迁移到新的 `files⟫；
3. **先校验再消费**：读之前跑 `node scripts/module-domain.mjs verify --json⟫，`ok:false⟫ 时拒绝加锁
   （宁可不锁，也不要基于坏数据锁错文件）；
4. **反查用 `owners⟫**：单文件 → aspect 列表以 `owners --json⟫ 的 `files[].aspects⟫ 为准（它做路径匹配），
   不要自己重新实现前缀匹配；
5. **锁键用 `aspectId⟫**：不要用 `ownerRole⟫ 当锁键（同角色多 aspect 会串行，等于退回单点瓶颈）；
6. **缺键降级**：`aspects⟫ / `roles⟫ 缺失时按「无 aspect」处理，不崩；未知字段忽略（schema 恒为 1）。

**机器接口**：

~~~bash
node scripts/module-domain.mjs verify --json   # {ok, problems:[{kind,path,module,detail,hint,extra,level}], warnings}
node scripts/module-domain.mjs owners --files a.mjs,b.mjs --json
#   {schema:1, range, files:[{path,status,owners,sharedBy,sections,aspects,attribution}],
#    summary:{modules,aspects,exempt,unknown}, ok}
~~~

`problem.kind⟫ 是**稳定标识**（如 `aspect 文件不存在⟫、`aspect ownerRole 未定义⟫），消费方可按 kind 分类；
`detail⟫ 是人读文案，**不得**被程序做字符串匹配（会随措辞改进而变）。

## 5 `roles`：职责角色

`roles` 声明「哪些模块由同一个职责角色负责」，供 `aspects[].ownerRole` 解析。
角色是**职责**，不是人、不是 session id：**人的归属由心跳与 claims 管**，两者不混。
每个 `role.modules[]` 必须指向已知模块；未被任何 aspect 使用的 role 只告警、不判红。

## 6 `unmanaged`：归属宇宙之外

归属宇宙 = `lib/`、`bin/`、`test/`、`scripts/`、`locale/`、`skills/`、`docs/`，加上根目录白名单
（`*.js`、`CONTRACT.md`、`README.md`、`dsh-plugin.json`、`cordis.patch.yml`、`package.json`）。

宇宙之外的 git 跟踪文件必须在 `unmanaged` 登记（当前 17 条：`.selftest/` 的 13 个探针 +
`.github/workflows/ci.yml` + `.gitignore` + `LICENSE` + `icon.svg`）。`verify` 检查：

- 条目必须存在；
- 条目**不得**与任何模块的 owns 冲突（防止拿 `unmanaged` 当偷渡逃生舱）；
- 仓库根出现新的、未被扫描的目录时**告警**（提醒补扫描范围，而不是静默漏掉）。

## 7 并行工作协议

1. **动手前先自检**：`node scripts/module-domain.mjs check --module <你的模块>`。
   `FOREIGN` 一律停手——那是别人的 `owns`；`shared` 会打印你只能改的区段。
2. **提交只带自己模块的文件**。与 `scripts/commit-scope.mjs` 配合：台账与源码不同提，
   跨模块改动拆成多笔，每笔只属于一个模块。
3. **合并顺序**：`framework` → `store` → `tasks` → `decisions` → `heartbeats` → `gates` →
   `experiments` → `description` → `panel` → `backup` → `cli` → `docs`。后合并者对自己的共享文件改动做 rebase；
   冲突处理只允许「保留双方各在自己的区段」，**不允许**把另一模块的改动挪位置。
4. **边界变更走框架会话**：改 `docs/module-domain.json`、改分段锚点、新增模块、拆文件，
   都由框架会话统一做（先数据、后代码、最后跑 `verify` + 全量测试）。
5. **合流前反查写域**：`node scripts/module-domain.mjs owners --base <main>` 打印这批改动命中的
   模块 / 区段 / aspect；出现 `UNKNOWN` 就该先补归属，而不是先合并。

## 8 检查与门禁（命令行契约）

```bash
node scripts/module-domain.mjs verify                 # 数据完整性（12 项检查；CI / precommit）
node scripts/module-domain.mjs verify --json          # 结构化 issues（kind/path/module/detail/hint）
node scripts/module-domain.mjs matrix                 # 模块矩阵（owns/shared/tests 计数）
node scripts/module-domain.mjs check --module tasks   # 按当前 git 改动判越界
node scripts/module-domain.mjs check --module tasks --files lib/desc.mjs
node scripts/module-domain.mjs owners --files a.mjs,b.mjs   # 反查：文件 → 模块 / 区段 / aspect
node scripts/module-domain.mjs owners --stdin
node scripts/module-domain.mjs owners --cached              # 反查暂存区（提交前）
node scripts/module-domain.mjs owners --base main           # 反查 main...HEAD（合流前）
```

退出码：`0` 通过；`1` 数据问题 / 越界 / 反查出现未归属；`2` 用法或环境错误。
`verify` 有 12 项检查：未归属/重复归属、幽灵条目、自相矛盾、锚点（存在/唯一/顺序）、
未定义区段、越域区段、孤儿区段、共享未登记区段、role、aspect、unmanaged、扫描根漂移（告警）。

> 门禁接线：`precommit` 与本仓库 CI 都跑 `verify`。**门禁定义本身在 gitignored 的 `.agents/` 里**，
> 别人克隆后看不到接线——所以 `verify` 是**命令行契约**，不依赖门禁定义存在。

## 9 与现有守卫的关系

| 守卫 | 守什么 | 不守什么 |
|---|---|---|
| `t-20261107-module-boundaries` | 依赖方向：无环、`checks` 不 import `core`、`util` 是叶子、`taskkill` 一处 | 谁该改哪个文件 |
| `t-20261107-module-map-drift` | `CONTRACT §1.1` 覆盖 `lib/*.mjs`，无幽灵行 | 区段归属、并行冲突 |
| `scripts/commit-scope.mjs` | 台账与源码不同提交 | 源码内部的模块归属 |
| `t-20261112-module-aspects` / `t-20261112-module-owners` | aspect/role/unmanaged 的形状、严格归属检查、锚点诊断、`owners` 反查 | 代码正确性 |
| **本文档 + `module-domain.mjs`** | **谁该改哪个文件、共享文件只能改哪段、改它要通知谁** | 代码正确性、依赖方向（交给上面几条） |

## 10 物理拆分路线（消除共享文件本身）

写域协议只是「并行时不打架」的第一层；共享文件本身越大，区段重叠的概率越高。

| 期 | 动作 | 状态 |
|---|---|---|
| 1 | `lib/core.mjs` 按 `sections` 拆成 `lib/store/*`，`core.mjs` 只做 re-export 聚合层 | ✅ 2026-11-11 完成（`core.mjs` 仅剩聚合与 6 个区段） |
| 2 | `index.js` 拆成 `lib/host/*.mjs`，`index.js` 只剩 `apply` 装配 | ✅ 2026-11-08 完成 |
| 3 | `client.js` 按面板区块拆 | **2026-11-11 判定：暂不物理拆分**（见 §10.1）；2026-11-12 起先登记区段 |
| 4 | `bin/flow.mjs` 拆成薄入口 + `lib/cli/*` 命令模块 | ✅ 2026-11-11 完成 |

### 10.1 `client.js` 为什么保持单文件

评估结论：**物理拆分的两条路都不划算，保持单文件 + `#region` 逻辑分区。**

1. **ESM 拆分不可行（P0）**：宿主把 `exports["./client"]` 当经典脚本原样下发（无 `type=module`、
   不打包），静态 import 在浏览器就是 SyntaxError；三个 selftest 探针与 10 处直接读源码的断言会全红。
2. **源分片 + 生成单文件**技术可行但代价过高：要引入构建步骤与漂移守卫，与本插件「零 import、无构建」
   的定位冲突，收益（共享文件写域冲突）不足以换这一层管线。
3. **宿主 chunk** 不满足约束：异步化后 `__probe` 无法同步导出，HMR 也看不到 chunk 变更。

**当前并行编辑约定**：`client.js` 是 panel 的 `owns`，同时 shared 给 tasks / decisions / heartbeats /
experiments——四个模块只能改各自在 §3 表里引用的 `#region` 区段。真正发生并行冲突时，优先方案是在
`right column cards` 段内加更细的 `#region` 锚点并登记 `sections`，而不是引入构建。
