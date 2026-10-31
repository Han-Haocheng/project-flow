# 决策台账（D- 记录）：设计定稿

> 类型：设计文档（模块规格）。读者：实现 T-20261030-23 的 agent、后续维护者。
> 状态：定稿。本文只定规格，不含实现代码；一切存储写入仍只经 `lib/core.mjs`。
> 一句话：**提问即建记录，回答当轮关闭，未关闭的每轮都在场。**

## 1 问题与目标

用户多次遇到同一类事故：需要拍板的问题被后续问题、工具输出或子代理消息冲掉，用户与当前会话都忘了自己还在等一个答案。目标是把"需要用户拍板的事"做成 `.dsh/flow` 里的持久记录（`D-`），带选项、推荐、阻塞对象与影响路径，在四个表面持续可见。可见性只有一个终点：用户显式 `answer`，或显式 `withdraw`。

## 2 非目标

- 不做问答收集器：事实性问答、自查项、模型可自行决定的技术细节不进 `D-`（边界见 §5.1 的判定三问）。
- 不做面板写入：面板只读，回答由用户通过会话或 CLI 触发；面板只提供复制回答串。
- 不做多轮对话管理：一条 `D-` 一题，选项固定；没有追问链、没有分支对话。
- 不替代任务/实验台账：`D-` 不存进度、不写 `commits`、不改任务 `status`；跨族只存 id 引用。
- 本期不改 store 为 schema 3：只新增独立记录族与 `flow.json` 配置节（§8 说明 schema 3 的预留）。

## 3 现状与约束

- 存储根 `<root>/.dsh/flow/`，单一写者 `lib/core.mjs`，CLI 只做参数解析与输出；原子写 + `.lock`（`CONTRACT.md` §4）。
- 记录族惯例：`<PREFIX>-YYYYMMDD-NN.json`、`schema: 1`、`created_at`/`updated_at`、未知字段保留、坏文件只记 `unreadable:` warning（`CONTRACT.md` §3.1、§3.2）。
- 提醒面：`agent/pre-step` 已有主会话心跳提醒（`index.js` 的 `registerHeartbeatReminder`），只对根会话生效（`CONTRACT.md` §9.2）；子会话不提醒、不拒绝写入。
- 门禁面：`flow check` 只读，脚本目录在 `lib/checks.mjs`，该模块不 import core、不读写 `.dsh/flow`（`CONTRACT.md` §6）；`flow gate` 步骤按退出码判定。
- 面板面：只读投影 `readStoreState`（`lib/core.mjs`），HTTP 只有 GET state 一个读端点，写入只有 init/gate 两个点（`CONTRACT.md` §9）。

## 4 方案

### 4.1 备选与取舍

| 备选 | 做法 | 结论 |
|---|---|---|
| A 挂在任务卡 notes 里 | 把决策写进 `T-` 记录的 `notes`，靠文本检索 | 否决：notes 是自由文本，无法计数、无法去重、无法做门禁；一个决策阻塞多张任务时无处挂 |
| B 只靠会话与技能纪律 | `ask_user_question` 消息 + 技能要求"记住" | 否决：这正是当前失败模式；fork/上下文压缩/恢复即丢 |
| C 独立记录族 + 四个表面 | 新增 `decisions/` 目录、`flow decision` 命令组、`flow_decision` 工具，接提醒/面板/门禁/恢复 | 采用：与实验、任务、门禁同构（独立目录、同一把锁、同一原子写、同一 CLI 风格），代价是新增一个命令组与三处接线 |

### 4.2 存储位置与配置

```
<root>/.dsh/flow/decisions/D-YYYYMMDD-NN.json
```

`flow.json` 新增一个配置节，合并规则与其它节一致（缺键补默认、未知键保留、containment 相同）：

```json
{"decisions": {"dir": ".dsh/flow/decisions"}}
```

- `storePaths` 增加 `decisions` 绝对路径；配置值逃出项目根时按该节默认值降级并记 `manifest-path-rejected` warning（复用 §2.1 规则）。
- id 自动生成 `D-YYYYMMDD-NN`（本地日期、两位序号、跳过已占用）；CLI 不开放 `--id`（与 `exp add` 一致），显式 id 只供 core 调用方，必须匹配 `^[A-Z]+-\d{8}-\d{2}$`，已存在 → `conflict`。
- 决策文件与任务同批入 git（T-21 已确认"台账随代码提交"）；`.lock` 与 `logs/` 已在 `.gitignore`，决策目录不忽略。

### 4.3 记录字段

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `schema` | 1 | 是 | 固定 1，不可改 |
| `id` | string | 是 | `D-YYYYMMDD-NN`，不可改 |
| `question` | string | 是 | 一个问句，非空，≤200 字 |
| `kind` | `choice` \| `approval` \| `input` | 是 | 不可改 |
| `options` | `[{id,label,impact}]` | 视 kind | `choice`：≥2，id 唯一且匹配 `^[a-z0-9][a-z0-9-]{0,23}$`；`impact` 非空；`approval`：由 core 固定为 `approve`/`reject`，调用方不得传；`input`：固定 `[]` |
| `default` | string \| null | 否 | 必须是某个 option id（`input` 为自由文本）；用户说"按默认/你定"时模型采用的兜底值 |
| `recommendation` | string \| null | `choice` 必填；`approval` 可省略 | `choice`/`approval` 必须是某个 option id；**approval 省略**（`undefined`/`null`/空串）时 core 写 `approve`，想推荐拒绝必须显式传 `reject`；`input` 为自由文本建议值 |
| `rationale` | string | 是 | 推荐理由与影响，非空，≤300 字 |
| `status` | `open` \| `answered` \| `withdrawn` \| `superseded` | 是 | 新建固定 `open`；终态不可回退（§4.4） |
| `blocks` | `[T-id]` | 否 | 每个 id 必须已存在于 `tasks/`，否则 `invalid`；非空时 `affects` 必须非空 |
| `affects` | `[path]` | 否 | 仓库相对 POSIX 路径或前缀（目录以 `/` 结尾）；`\` 归一为 `/`，去 `./`；不得绝对路径、不得 `..` 逃逸 |
| `answer` | `{choice,note,at,by}` \| null | `answered` 必填 | `choice` 命中 option id（`input` 为自由文本）；`note` 字符串可为空；`by` 为 `user` \| `agent` |
| `asked_at` | ISO 8601 | 是 | 提问时间，不可改 |
| `answered_at` | ISO 8601 \| null | 视状态 | `answered` 必填，其余 null |
| `withdraw` | `{reason,at,by}` \| null | `withdrawn` 必填 | `reason` 非空；`by` 同 `answer.by` |
| `supersedes` | `D-id` \| null | 否 | 被本记录取代的旧记录；旧记录必须存在 |
| `superseded_by` | `D-id` \| null | 系统维护 | `supersedes` 的反向指针 |
| `fingerprint` | string | 系统维护 | 去重指纹（§4.5），16 位十六进制 |
| `asked_session` | string \| null | 系统维护 | 提问的主会话 id |
| `asked_turn` | integer \| null | 系统维护 | 提问时该会话的心跳 turn |
| `created_at` / `updated_at` | ISO 8601 | 是 | 家族惯例；`created_at` 不可改，每次写入（ask/answer/withdraw/supersede）刷新 `updated_at` |

本期不开放独立 `update` 命令：`ask` 之外的写入只有 `answer`/`withdraw`/`supersede` 三种，各自只改自己的字段并刷新 `updated_at`；`id`/`schema`/`kind`/`asked_at`/`created_at`/`question`/`options` 一经创建不可改。要改问题或选项：`withdraw` 旧记录后重新 `ask`（新记录 supersede 旧记录）。

### 4.4 状态机与终态

```
open ──answer────▶ answered
  │
  ├──withdraw───▶ withdrawn
  │
  └──新 ask --supersedes──▶ superseded

任意非 superseded 记录 ──新 ask --supersedes──▶ superseded（保留原 answer/withdraw 供审计）
```

- `answer` 只接受 `open`；`withdraw` 只接受 `open`；终态不可再 `answer`/`withdraw`（→ `conflict`）。
- `supersede` 可指向除 `superseded` 外的任意状态：旧记录 `status` 置 `superseded`，原 `answer`/`withdraw` 字段**保留不删**（审计用），写 `superseded_by`；新记录写 `supersedes`，两条互相指向。这是终态之间唯一允许的迁移。
- `answer` 写 `answer` 与 `answered_at`；`withdraw` 写 `withdraw`（`answered_at` 保持 null）。

### 4.5 校验与指纹去重（唯一规则）

- 指纹：`sha256(kind + "\n" + normalize(question))` 取前 16 位十六进制；`normalize` = NFKC → 去掉全部空白与标点 → 转小写。指纹只由 core 计算，不接受调用方传入。
- `ask` 的三种结果（没有模式开关，按同一条规则判定）：
  1. 同指纹存在 `open` 记录 → **不新建**，返回已有记录（`created: false`），输出提示"已存在 open 决策 `<id>`，不要重复提问"；
  2. 同指纹存在已关闭记录 → **必须**显式 `--supersedes <旧 id>`，否则 `conflict` 并回显旧答案（阻止同一个问题被反复开）；旧记录按 §4.4 置 `superseded` 并保留原答案；
  3. 无同指纹 → 新建。
- `blocks` 中每个 id 必须已存在；`kind=choice` 的 `recommendation` **必填**，`recommendation`/`default` 必须命中 option；`kind=approval` 不接受 `options`，`recommendation` **可省略**——省略时 core 写 `approve`，显式给值必须命中 `approve`/`reject`（想推荐拒绝必须显式传 `reject`）；`kind=input` 的 `options` 必须为空。任一不满足 → `invalid`（退出码 2）。

### 4.6 `open` 记录 JSON 示例

```json
{
  "schema": 1,
  "id": "D-20261031-01",
  "question": "是否把 flow check decisions 接入 flow init 种入的 precommit 门禁？",
  "kind": "approval",
  "options": [
    {"id": "approve", "label": "同意", "impact": "预提交门禁会拦住阻塞中的提交，直到决策被回答"},
    {"id": "reject", "label": "拒绝", "impact": "决策只靠每轮提醒与面板可见，提交不被拦截"}
  ],
  "default": null,
  "recommendation": "approve",
  "rationale": "门禁是唯一能在提交动作上强制拦截的表面；没有它，阻塞决策会被带病提交。",
  "status": "open",
  "blocks": ["T-20261030-23"],
  "affects": ["lib/core.mjs", "bin/flow.mjs"],
  "answer": null,
  "asked_at": "2026-10-31T09:50:00+08:00",
  "answered_at": null,
  "withdraw": null,
  "supersedes": null,
  "superseded_by": null,
  "fingerprint": "9b2f7c4a1e6d8035",
  "asked_session": "session-79c1c4e6-ecf5-40a9-98c2-fd7a373a2a85",
  "asked_turn": 1,
  "created_at": "2026-10-31T09:50:00+08:00",
  "updated_at": "2026-10-31T09:50:00+08:00"
}
```

### 4.7 影响面

| 面 | 变化 | 兼容性 |
|---|---|---|
| `flow.json` | 新增 `decisions.dir` 配置节 | 旧 manifest 缺键由默认值补齐；未知键保留；schema 仍为 2 |
| `lib/core.mjs` | 新增 decisions 读写 API、`checkDecisions`、`summarizeDecisions`、常量 | 只增导出，不改既有函数签名 |
| `bin/flow.mjs` | 新增 `decision` 命令组、`check decisions` 路由、`status` 待决策段 | 既有命令输出不变，只多一段 |
| `index.js` | 新增 `flow_decision` 工具、pre-step 提醒、面板 payload 的 `decisions` 节 | 工具数 +1；旧客户端忽略未知 payload 键 |
| `client.js` | 顶部待决策卡 + 复制回答串 | 无新 HTTP 写端点 |
| `CONTRACT.md` | §2、§3.6、§5.1、§6、§7、§9 增补 | 需与实现同批更新（§10.5） |
| 依赖/网络 | 无 npm 依赖、不联网；`git` 仅用于 `check decisions` 的暂存清单 | 与现有 core/checks 约束一致 |

## 5 生命周期与关闭纪律

### 5.1 纪律（R1–R10）

| # | 纪律 | 规则 |
|---|---|---|
| R1 | 提问即建 | 任何需要用户拍板的问题，必须在**同一轮**先 `flow decision ask`（或 `flow_decision` 工具 ask）建记录，再提问；提问文本带 `[D-<id>]`。先建记录再问，不允许先问后补 |
| R2 | 回答当轮关闭 | 用户回答的同一轮内调用 `answer`；不得留到下一轮，不得由模型代答 |
| R3 | 一条一题 | 多个独立问题拆多条 `D-`；禁止把多问塞进一条记录；一组互斥选项算一条 |
| R4 | 同题去重 | 按 §4.5：open 同指纹复用，已关闭同指纹必须 `--supersedes` |
| R5 | 不猜默认 | `recommendation`/`default` 只是建议；用户明确说"按默认/你定"才可采用 `default` 作为答案（`by: user`），其余情况未回答就不得推进 |
| R6 | 超 N 升级 | 同一会话 `current_turn - asked_turn ≥ 3`，或任意会话挂起 ≥ 24 小时 → 提醒加 `⚠` 并排最前；升级只改展示，不改状态 |
| R7 | 阻塞显式 | 被阻塞的任务写进 `blocks`；`blocks` 非空必须声明 `affects`，否则 `ask` 报 `invalid` |
| R8 | 关闭有据 | `answer` 必带 `choice`；`withdraw` 必带 `reason`；`by` 记录确认者（`user`/`agent`）。模型只能在用户明确说"撤回/不用问了"时 `withdraw` |
| R9 | 恢复先看 | fork、上下文压缩、新主会话的第一轮先 `flow decision list --open`（§6.4） |
| R10 | 同批入 git | `D-` 文件与对应任务在同一提交批次入库；`gc` 删除的记录由 git 历史兜底 |

边界判定三问（任一为"是"才建 `D-`）：① 是否改变用户可见结果、范围或授权？② 是否涉及不可逆动作或任务书范围外动作？③ 若用户不同意，是否会造成返工？事实问答、自查项、实现细节（命名、目录、测试写法）不进 `D-`。

### 5.2 一轮内的节奏

1. 轮开始：`agent/pre-step` 提醒 open 决策（§6.1）；
2. 用户消息含答案 → 当轮 `answer`；
3. 出现新问题 → 当轮 `ask`，提问带 `[D-id]`；
4. 轮结束前自查两件事：没有"已问未建"的问题，没有"已答未关"的决策。

## 6 四个反遗忘表面

### 6.1 pre-step 提醒（`index.js`）

- 触发：`agent/pre-step`，仅主会话（`rootSessionVerdict === true`，与心跳提醒同门控），每轮第一个 step（`step` 为 0 或 1），读 `listDecisions(status=open)`；无 open 则不注入。
- 合并：与心跳提醒合并进**一条** user-role 提醒消息（统一前缀 `【project-flow】`），避免两条重复消息；两者都无内容时不注入。
- 内容上限（中心已裁决，两种轮次同一规则）：总长 ≤800 字符，截断后追加「还有 N 条」——**800 字符上限对首轮与非首轮都生效**；明细条数上限 **3 条只约束非首轮**：首轮（含 fork/恢复）列**全部** open，非首轮最多 3 条（常量 `DECISION_REMIND_MAX = 3`）。
- 文案模板：

```
【project-flow】有 2 个待用户拍板的决策（阻塞 1）：
- D-20261031-01 ⚠ [approval] 是否把 flow check decisions 接入 precommit 门禁？ 阻塞 T-20261030-23；挂起 4 轮
- D-20261031-02 [choice] 面板回答串是否加默认选项？ 挂起 2 小时
回答后当轮调用 flow_decision answer <id> --choice <选项 id>；不要按推荐自行决定。
```

- 挂起计算：`asked_session` 等于当前会话 → `current_turn - asked_turn` 轮；否则按 `asked_at` 年龄（`2 小时` / `3 天`）。跨会话的 turn 不可比，所以只对提问会话显示"轮"，其它会话显示时长。
- 升级：`⚠` 命中任一阈值（同会话 ≥3 轮 / 任意会话 ≥24 小时），升级项排最前；排序规则全局唯一：升级优先，其次 `asked_at` 旧的在前。
- 第一轮（含 fork/恢复）：不受 3 条明细上限约束，明细列出**全部** open，并在尾部追加一句"新会话第一步：运行 flow decision list --open 查看完整清单"；总长仍受 800 字符上限（超出截断后追加「还有 N 条」）。
- 失败降级：读 store 出错时 `try/catch` 跳过提醒，不阻断本轮（与现有心跳提醒一致）。
- 只读：提醒不修改任何记录，避免每轮写盘与 git 噪声。

### 6.2 面板待决策卡

- 投影：`readStoreState` 增加 `decisions: {items, counts:{open,blocking,escalated,answered,withdrawn,superseded,total}}`（与 `summarizeDecisions(root, contract, {limit: DECISION_REMIND_MAX})` 逐字同形；无会话上下文，`turnAge` 恒 null，升级只有 24 小时规则）；HTTP GET state 的 payload 增加同名节；store 存在但不可读或无决策记录 → 空节（`items: []`、`counts` 全 0，键存在不是缺键）；工作区根本没有 store 仍是 `not-initialized` 错误态、不带任何节。
- 位置：TopBar 之下、`project-flow-grid` 之上，整宽卡片；`counts.open > 0` 才渲染，否则整卡不出现（不占位）。
- 内容：标题 `待决策 3（阻塞 1）`；每条显示 id、kind 徽标、question、阻塞任务、挂起时长、升级标记 `⚠`；最多 3 条 + "还有 N 条"（常量与提醒一致）。
- 交互：每条一个「复制回答串」按钮，复制**固定带推荐值**的 `flow decision answer <id> --choice <推荐值>`（取值顺序 `recommendation` → `default` → 首个 option id；`input` 类型用引号包裹自由文本；浏览器端拼接）；面板不提供写入控件，回答由用户粘回会话或直接在 CLI 执行。
- 排序：与提醒完全一致（升级优先，其次 `asked_at` 旧的在前）。
- i18n：`client.js` 消息表新增 `decisions.title`、`decisions.blocking`、`decisions.copy`、`decisions.copyAria`、`decisions.more`、`decisions.empty` 等中英文案（locale 文件只放 meta，不新增键）。

### 6.3 `flow check decisions` 门禁

- 语义（唯一规则）：**`status=open` 且 `blocks` 非空（blocking）且 `affects` 命中本次暂存改动 → 失败（exit 1）**；其余情况通过（exit 0）。
- 本次改动 = `git diff --cached --name-only --diff-filter=ACMR`（相对仓库根、POSIX 路径），检查命令以项目根为 cwd。暂存区为空 → 通过。
- 匹配：暂存文件 `f` 命中 `affects` 项 `a`，当 `f === a` 或 `f` 以 `a + "/"` 开头；`a` 存储时已去尾 `/`、去 `./`、`\` 归一为 `/`。大小写敏感（与 git 路径一致）。
- 退出码沿用 `flow check` 词汇（`CONTRACT.md` §6.2）：0 通过 · 1 检查失败 · 2 用法/配置错误（未 init、manifest 坏） · 3 保留（`check` 的「脚本缺失」语义，本检查不产生） · 4 IO/`git` 失败。
- JSON（成功）：`{"ok":true,"data":{"check":"decisions","exitCode":0,"stdout":"…","stderr":"","durationMs":9,"open":2,"blocking":0,"failed":[]}}`。
- JSON（失败）：`{"ok":false,"error":{"code":"check-failed","message":"检查未通过：decisions（阻塞决策命中暂存文件）","check":"decisions","exitCode":1,"stdout":"…","stderr":"","open":2,"blocking":1,"failed":[{"id":"D-20261031-01","question":"…","blocks":["T-20261030-23"],"affects":["lib/core.mjs"],"matched":["lib/core.mjs"]}]}}`。
- 人类输出：通过 `✓ decisions：open 2 · blocking 0 · 暂存 3 个文件`；失败逐行 `✗ D-20261031-01 阻塞 T-20261030-23：affects 命中 lib/core.mjs`，末行提示 `先回答：flow decision answer D-20261031-01 --choice approve`。
- 实现位置：`bin/flow.mjs` 的 `cmdCheck` 对 `decisions` 特判，路由到 `core.checkDecisions()`（只读，复用 `loadContract`/containment/路径归一）；`lib/checks.mjs` **不**读 store、不 import core，纪律不变；`flow check list` 追加一条内置项（`interpreter: "core"`）。`CONTRACT.md` §6 注明这是 `check` 家族的唯一内置例外。
- 门禁接线：`flow init` 种入的 `precommit` 增加第二步 `decisions=<PLUGIN_BIN> check decisions>>exit 0`；已有项目用 `flow gate update precommit --step '<原步骤>' --step 'decisions=…>>exit 0'` 手动追加（`--step` 是整体替换，必须带上原步骤）。只接 `precommit`；`release`/`manual` 门禁不接，发布前的决策确认仍由中心在发布清单里人工执行。

### 6.4 恢复/fork 的新会话开场

表面四的目标是"任何新会话（含 fork、上下文压缩后恢复）先看到全部 open 决策"。由三处保证，规则只有一条命令：

1. `agent/pre-step` 第一轮列出**全部** open 决策并提示（§6.1）；
2. `flow status` 增加 `待决策 N（阻塞 M）` 段与前 3 条明细（恢复时最常跑的命令）；
3. 技能文案一行：新会话/fork/恢复第一步运行 `flow decision list --open`。该行属于 `skills/`，不在 T-23 写域，随 T-24（技能元数据）一并落地，作为 T-23 的收尾依赖。

`flow decision list --open` 是固定写法（与 `list` 默认输出一致），供脚本与纪律引用，不引入额外开关。

## 7 CLI 与工具

### 7.1 CLI 命令表（`bin/flow.mjs`）

```
flow decision ask      --question Q --kind choice|approval|input
                       [--option 'id=label>>impact']...   # choice 至少两个
                       [--default ID] [--recommendation ID] [--rationale R]
                       [--blocks T-id]... [--affects PATH]...
                       [--supersedes D-id]
flow decision list     [--open] [--all]
flow decision show     <id>
flow decision answer   <id> --choice C [--note N] [--by user|agent]
flow decision withdraw <id> [--reason R] [--by user|agent]
flow decision gc       [--days N] [--dry-run]
flow check decisions
```

- `--option` 格式 `id=label>>impact`，可重复，与 `gate add --step` 风格一致；`--option`/`--blocks`/`--affects` 可重复，加进 `parseArgv` 的 `REPEAT_FLAGS`；`question`/`kind`/`rationale`/`recommendation`/`default`/`choice`/`reason`/`by`/`days` 加进 `VALUE_FLAGS`。
- `list` 默认只列 open；`--open` 是显式同义写法；`--all` 列全部（closed 按 `updated_at` 倒序）。
- `ask` 的 `--recommendation` 在 `choice` 必填、在 `approval` 可省略（省略 = 推荐 `approve`，想推荐拒绝必须显式传 `--recommendation reject`）；`--rationale` 必填。`--by` 默认 `user`；`answer` 的 `--note` 可省略（落盘为空串）。
- `gc` 默认保留 90 天内与全部 open；`--days N` 覆盖保留天数；`--dry-run` 只报告不删除。删除对象仅限 `answered`/`withdrawn`/`superseded` 且关闭时间超过保留期。
- 命令组纳入 `USAGE` 与 `dispatch` 的 `case 'decision'`；`flow check list` 追加 `decisions` 内置项。
- 退出码沿用全局词汇：0 成功 · 1 用法 · 2 校验/冲突 · 3 未找到 · 4 IO。未 `flow init` → `usage`。

### 7.2 人类输出与 `--json`

- `ask` 人类输出：`已创建决策 D-20261031-01  [approval] <question>`；复用已有记录时输出 `已存在 open 决策 D-…（未重复创建）`。
- `list` 人类输出（表格，与 `task list` 同款 `table()`）：

```
ID              类型      状态  阻塞                挂起   问题
D-20261031-01   approval  open  T-20261030-23       4 轮   是否把 flow check decisions 接入 precommit 门禁？
D-20261031-02   choice    open  -                   2 小时 面板回答串是否加默认选项？
```

- `show` 复用 `printRecord`（与 `flow task show` 一致）。
- `flow status --json` 增加 `data.decisions = {items, counts}`，`items` 只放前 3 条 open（与人类输出一致）。
- `--json` 形状：
  - `ask` → `{decision, created}`（`created:false` 表示复用已有 open 记录）；
  - `list` → `{items, counts:{open,blocking,escalated,answered,withdrawn,superseded,total}}`；
  - `show`/`answer`/`withdraw` → 记录本身；
  - `gc` → `{removed:[id…], kept, dryRun}`（与 `gcLegacyHeartbeats` 同形）；
  - 失败信封 `{ok:false,error:{code,message}}`（与全局一致）。

### 7.3 agent 工具 `flow_decision`

- `action`：`ask | list | show | answer | withdraw | gc`，与 CLI 一一对应，同一 `lib/core.mjs`。
- 写动作（`ask`/`answer`/`withdraw`/`gc`）**只在主会话可用**：子会话调用抛错并给可行动提示"在最终报告里列出待决策项，由主会话建 D"（与 `flow_heartbeat` 同门控、同错误风格）；`list`/`show` 只读，任何会话可调用。
- `ask` 的 `asked_session`/`asked_turn` 缺省取当前心跳（`heartbeatStatus`）；返回 `{root, decision, created}`。
- 工具描述必须写清 R1/R2：先建记录再提问；用户回答当轮 `answer`。描述里点名默认值不是答案（R5）。**approval 省略 `recommendation` = 推荐 `approve`**：想推荐拒绝必须显式传 `reject`，`rationale` 仍必填。

### 7.4 面板只读面

- 不新增 HTTP 写端点；GET state payload 增加 `decisions` 节；复制回答串在浏览器端拼接。
- 面板不调用工具、不写 store（`CONTRACT.md` §9 边界不变）。

## 8 与语义台账（T-12）、进度树（T-13）的关系

- 同族：`E-`（实验）、`T-`（任务）、`S-`（语义台账，T-12）、`D-`（决策）都是 `.dsh/flow` 下的记录族：独立目录、`schema: 1`、`PREFIX-YYYYMMDD-NN`、`created_at`/`updated_at`、未知字段保留、同一把锁与原子写、同一 CLI 风格与 `{ok,...}` JSON 信封。
- 独立：`D-` 记录"需要用户拍板的事"；`S-` 记录语义事实与漂移基线；`T-` 记录进度。跨族只存 **id 引用**（`blocks: [T-id]`），不嵌入内容、不双写字段，避免同一事实两处维护。
- schema 3 预留（T-13）：本设计的 `flow.json` `decisions` 配置节与独立目录在 schema 3 中原样保留，进度树只增加投影；届时 `list --open`、门禁匹配、提醒逻辑不变。本期不改 schema 2。
- 顺序：T-22（本设计）→ T-23（实现）；T-12/T-13 定稿时引用本文 §8 作为决策记录的格式依据，不另立一套。

## 9 当前 6 个已确认决策（示例数据）

以下是 2026-10-30 用户一次性确认的 6 个决策，按 `answer` 后的形态录入，作为实现与测试的样例。id 为示意（实际按提问当天序号生成），`fingerprint`/`asked_session` 为示例值。

```json
[
  {
    "schema": 1,
    "id": "D-20261030-01",
    "question": "T-20 与 T-21 的改动怎么合并到主分支？",
    "kind": "choice",
    "options": [
      {"id": "after-t20", "label": "等 T-20 落地后一次性合并", "impact": "主分支只出现一个合并点，T-21 的契约改动与 T-20 同批评审"},
      {"id": "now", "label": "先合并 T-21，再合并 T-20", "impact": "两次合并、两次复跑门禁；T-21 契约会短暂引用尚未落地的 T-20 口径"}
    ],
    "default": null,
    "recommendation": "after-t20",
    "rationale": "T-21 的契约文字引用 T-20 的心跳口径，先合 T-21 会短暂留下不一致的 CONTRACT。",
    "status": "answered",
    "blocks": ["T-20261030-21", "T-20261030-25"],
    "affects": ["CONTRACT.md", "skills/", "index.js"],
    "answer": {"choice": "after-t20", "note": "用户 2026-10-30 确认：等 T-20 后一次性合并。", "at": "2026-10-30T21:10:00+08:00", "by": "user"},
    "asked_at": "2026-10-30T21:00:00+08:00",
    "answered_at": "2026-10-30T21:10:00+08:00",
    "withdraw": null,
    "supersedes": null,
    "superseded_by": null,
    "fingerprint": "4f9c0a1d2b3e5f60",
    "asked_session": "session-79c1c4e6-ecf5-40a9-98c2-fd7a373a2a85",
    "asked_turn": 2,
    "created_at": "2026-10-30T21:00:00+08:00",
    "updated_at": "2026-10-30T21:10:00+08:00"
  },
  {
    "schema": 1,
    "id": "D-20261030-02",
    "question": "项目台账 .dsh/flow 是否随代码一起提交进 git？",
    "kind": "approval",
    "options": [
      {"id": "approve", "label": "同意", "impact": "台账成为 durable 真源，跨会话/跨工作树可恢复"},
      {"id": "reject", "label": "拒绝", "impact": "台账只留在本地，换机器或重建环境即丢失"}
    ],
    "default": null,
    "recommendation": "approve",
    "rationale": "台账是项目状态的真源，提交后与代码同历史、可评审、可回退。",
    "status": "answered",
    "blocks": ["T-20261030-25"],
    "affects": [".dsh/flow/", ".gitignore"],
    "answer": {"choice": "approve", "note": "用户 2026-10-30 确认：台账随代码提交。", "at": "2026-10-30T21:10:00+08:00", "by": "user"},
    "asked_at": "2026-10-30T21:00:00+08:00",
    "answered_at": "2026-10-30T21:10:00+08:00",
    "withdraw": null,
    "supersedes": null,
    "superseded_by": null,
    "fingerprint": "7a1e5d9c3b8f2046",
    "asked_session": "session-79c1c4e6-ecf5-40a9-98c2-fd7a373a2a85",
    "asked_turn": 2,
    "created_at": "2026-10-30T21:00:00+08:00",
    "updated_at": "2026-10-30T21:10:00+08:00"
  },
  {
    "schema": 1,
    "id": "D-20261030-03",
    "question": "Team 任务与项目任务的映射是否按「Team 任务 description 首行写 flow: <T-id>，项目任务 notes 记 team: <taskId>」执行？",
    "kind": "approval",
    "options": [
      {"id": "approve", "label": "同意", "impact": "项目台账为真源、Team 板为执行视图，字段不双写"},
      {"id": "reject", "label": "拒绝", "impact": "两套台账各写各的，会话结束即失去映射"}
    ],
    "default": null,
    "recommendation": "approve",
    "rationale": "映射只走单向引用，能保证会话消失后项目台账仍可独立恢复。",
    "status": "answered",
    "blocks": ["T-20261030-21"],
    "affects": ["skills/", "CONTRACT.md"],
    "answer": {"choice": "approve", "note": "用户 2026-10-30 确认接受映射约定。", "at": "2026-10-30T21:10:00+08:00", "by": "user"},
    "asked_at": "2026-10-30T21:00:00+08:00",
    "answered_at": "2026-10-30T21:10:00+08:00",
    "withdraw": null,
    "supersedes": null,
    "superseded_by": null,
    "fingerprint": "2c8d6f1a9e4b3570",
    "asked_session": "session-79c1c4e6-ecf5-40a9-98c2-fd7a373a2a85",
    "asked_turn": 2,
    "created_at": "2026-10-30T21:00:00+08:00",
    "updated_at": "2026-10-30T21:10:00+08:00"
  },
  {
    "schema": 1,
    "id": "D-20261030-04",
    "question": "三个内嵌技能的 description / when-to-use 元数据是否统一改为中文？",
    "kind": "approval",
    "options": [
      {"id": "approve", "label": "同意", "impact": "三个技能元数据统一中文，index.js 的 SKILL_META 兜底同步中文"},
      {"id": "reject", "label": "拒绝", "impact": "中英混排继续存在，兜底文案与 frontmatter 语言不一致"}
    ],
    "default": null,
    "recommendation": "approve",
    "rationale": "技能主要读者是中文会话；统一语言避免兜底与 frontmatter 混写。",
    "status": "answered",
    "blocks": ["T-20261030-24"],
    "affects": ["skills/", "index.js"],
    "answer": {"choice": "approve", "note": "用户 2026-10-30 确认统一中文。", "at": "2026-10-30T21:10:00+08:00", "by": "user"},
    "asked_at": "2026-10-30T21:00:00+08:00",
    "answered_at": "2026-10-30T21:10:00+08:00",
    "withdraw": null,
    "supersedes": null,
    "superseded_by": null,
    "fingerprint": "e5b3a7d2c9f14608",
    "asked_session": "session-79c1c4e6-ecf5-40a9-98c2-fd7a373a2a85",
    "asked_turn": 2,
    "created_at": "2026-10-30T21:00:00+08:00",
    "updated_at": "2026-10-30T21:10:00+08:00"
  },
  {
    "schema": 1,
    "id": "D-20261030-05",
    "question": "是否删除仓库里旧同名技能包 zip？",
    "kind": "approval",
    "options": [
      {"id": "approve", "label": "同意", "impact": "仓库只剩解包后的技能源码，消除同名两份的歧义"},
      {"id": "reject", "label": "拒绝", "impact": "旧 zip 与源码并存，后续技能加载会读到旧版本"}
    ],
    "default": null,
    "recommendation": "approve",
    "rationale": "zip 与解包源码内容重复且无引用；保留会制造版本歧义。",
    "status": "answered",
    "blocks": [],
    "affects": ["skills/"],
    "answer": {"choice": "approve", "note": "用户 2026-10-30 确认删除；已删除。", "at": "2026-10-30T21:10:00+08:00", "by": "user"},
    "asked_at": "2026-10-30T21:00:00+08:00",
    "answered_at": "2026-10-30T21:10:00+08:00",
    "withdraw": null,
    "supersedes": null,
    "superseded_by": null,
    "fingerprint": "1d7e4b8a2c5f9630",
    "asked_session": "session-79c1c4e6-ecf5-40a9-98c2-fd7a373a2a85",
    "asked_turn": 2,
    "created_at": "2026-10-30T21:00:00+08:00",
    "updated_at": "2026-10-30T21:10:00+08:00"
  },
  {
    "schema": 1,
    "id": "D-20261030-06",
    "question": "剩余任务按什么顺序修：先 T-20/T-21，还是先 T-03/T-04？",
    "kind": "choice",
    "options": [
      {"id": "t20-then-t03", "label": "T-20 → T-21 → T-03/T-04", "impact": "先把心跳与 Team 口径定稿，再改存储健壮性；T-03/T-04 会以新口径重跑测试"},
      {"id": "t03-first", "label": "T-03/T-04 优先", "impact": "先稳存储锁与警告；T-20/T-21 的契约改动需再改一次"}
    ],
    "default": null,
    "recommendation": "t20-then-t03",
    "rationale": "T-03/T-04 的测试基线依赖 T-20 落地后的心跳语义，先改会造成二次返工。",
    "status": "answered",
    "blocks": ["T-20261030-03", "T-20261030-04"],
    "affects": ["lib/core.mjs", "bin/flow.mjs", "index.js"],
    "answer": {"choice": "t20-then-t03", "note": "用户 2026-10-30 确认顺序。", "at": "2026-10-30T21:10:00+08:00", "by": "user"},
    "asked_at": "2026-10-30T21:00:00+08:00",
    "answered_at": "2026-10-30T21:10:00+08:00",
    "withdraw": null,
    "supersedes": null,
    "superseded_by": null,
    "fingerprint": "6f0b9c3e1a7d2548",
    "asked_session": "session-79c1c4e6-ecf5-40a9-98c2-fd7a373a2a85",
    "asked_turn": 2,
    "created_at": "2026-10-30T21:00:00+08:00",
    "updated_at": "2026-10-30T21:10:00+08:00"
  }
]
```

`flow decision list --all` 的人类输出示意（同日、按 `updated_at` 倒序时显示关闭状态）：

```
ID              类型      状态      阻塞                挂起   问题
D-20261030-01   choice    answered  T-20261030-21       3 天   T-20 与 T-21 的改动怎么合并到主分支？
D-20261030-02   approval  answered  T-20261030-25       3 天   项目台账 .dsh/flow 是否随代码一起提交进 git？
D-20261030-03   approval  answered  T-20261030-21       3 天   Team 任务与项目任务的映射是否按约定执行？
D-20261030-04   approval  answered  T-20261030-24       3 天   三个内嵌技能的元数据是否统一改为中文？
D-20261030-05   approval  answered  -                   3 天   是否删除仓库里旧同名技能包 zip？
D-20261030-06   choice    answered  T-20261030-03       3 天   剩余任务按什么顺序修？
```

## 10 实施拆分与顺序

### 10.1 A：core / CLI / 工具（T-23 主体）

| 文件 | 改动 |
|---|---|
| `lib/core.mjs` | 常量（`DECISION_SCHEMA`、`DECISION_STATUS`、`DECISION_KINDS`、`DECISION_ESCALATE_TURNS=3`、`DECISION_ESCALATE_HOURS=24`、`DECISION_GC_DAYS=90`、`DECISION_REMIND_MAX=3`）；`decisions` 配置节 + `storePaths` + containment；`listDecisions`/`getDecision`/`addDecision`/`answerDecision`/`withdrawDecision`/`gcDecisions`/`summarizeDecisions`/`checkDecisions`；`seededGates` 的 `precommit` 增加 decisions 步骤 |
| `bin/flow.mjs` | `decision` 命令组（ask/list/show/answer/withdraw/gc）；`check decisions` 路由；`cmdStatus` 待决策段；`USAGE`/`dispatch`/`REPEAT_FLAGS` 增补 |
| `index.js` | `flow_decision` 工具定义与 action 分发（主会话写入门控） |
| `CONTRACT.md` | §2 配置节、§3.6 记录格式、§5.1 命令表、§6 check 例外、§7 core API、§9 payload |
| `test/core.test.mjs` | 记录读写/校验/去重/状态机/gc/seeded gate |
| `test/checks.test.mjs` | `check decisions`：临时 git 仓库 + 暂存文件，覆盖命中/不命中/已回答；既有「check list 暴露四项检查」断言改为五项 |
| `.selftest/host2-tools.mjs` | `flow_decision` 工具注册与子会话拒绝 |

验收命令：`node --test test/`；`flow init` 后手工跑 §7.1 的 ask/list/answer/withdraw/gc 全链路；`node -e` 校验落盘 JSON 可 `JSON.parse`。

### 10.2 B：提醒 / 门禁（依赖 A）

| 文件 | 改动 |
|---|---|
| `index.js` | `registerHeartbeatReminder` 与决策提醒合并为一条消息；`disciplineText` 或新增 `registerDecisionReminder`；turn 1 全量清单；升级标记与排序 |
| `lib/core.mjs` | 无新增（A 已提供 `summarizeDecisions`，B 只消费） |
| `CONTRACT.md` | §9.2/§9.3 提醒文案与门控说明 |
| `.selftest/harness.mjs` 或新增探针 | pre-step 注入内容与合并行为（无 open 不注入、open 注入、升级排序） |

验收：主会话模拟 pre-step（无 open 不注入；有 open 注入且与心跳提醒同一条）；`flow check decisions` 在暂存命中时 exit 1、回答后 exit 0；种子门禁步骤存在。

### 10.3 C：面板（依赖 A；`client.js` 可与 B 并行，`index.js` 的 payload 改动排在 B 之后）

| 文件 | 改动 |
|---|---|
| `client.js` | TopBar 下「待决策 N」卡、复制回答串、CSS、`decisions.*` 文案 |
| `index.js` | `buildStoreState`/`emptyStoreState` payload 增加 `decisions` 节（用 `summarizeDecisions`） |
| `.selftest/client-render.mjs` / `state-*.json` | 空态/有 open/阻塞/升级渲染；payload 夹具 |

验收：`.selftest/client-render.mjs` 断言卡片显隐与文案；`state-store.json` 夹具含 decisions 节；无 open 时不渲染。

### 10.4 依赖与建议顺序

- 顺序：**A → B → C**。理由：A 决定数据结构与读 API；B（提醒 + 门禁）是反遗忘的核心，先于面板；C 是体验层，依赖 A 的读形状，可在 B 之后同分支完成。
- `index.js` 被三处改（工具/提醒/payload），按 A → B → C 顺序由同一会话改，避免并行写冲突。
- `flow init` 种子门禁的改动属于 A；B 只验证门禁行为，不改种子。

### 10.5 CONTRACT 需要改动的章节

| 章节 | 增补内容 |
|---|---|
| §1 目录布局 | 增加 `decisions/`、`decisions` 配置 |
| §2 `flow.json` | 增加 `decisions` 节默认值与 containment 范围 |
| §3 记录格式 | 新增 §3.6 决策 `D-YYYYMMDD-NN.json`（字段、状态机、指纹） |
| §5 CLI | §5.1 增加 `decision` 命令组与 `check decisions`；§5.3 `flow status` 增加待决策段 |
| §6 机械检查 | 注明 `check decisions` 为唯一内置检查（`bin` 路由到 core，`checks.mjs` 纪律不变） |
| §7 core API | 增加 decisions 读写与 `checkDecisions`/`summarizeDecisions` |
| §9 面板 | payload 增加 `decisions` 节；面板仍只读 |

## 11 风险与缓解

| 风险 | 触发 | 缓解 |
|---|---|---|
| 提醒噪声与重复提问 | 每轮都提醒，模型把"已提醒"当成"要再问" | 合并成一条消息、最多 3 条、answered 立即消失；文案固定"已回答的不再提问"；R2 要求回答即关 |
| 子代理发现的决策丢失 | 子会话不提醒、不能建 D | `flow_decision` 写动作在子会话明确拒绝并提示"写进最终报告由主会话建 D"；Lead 收报告后建 D（R1） |
| 决策根本没建记录 | 模型直接问用户、跳过 ask | 靠技能与工具描述纪律（R1）+ 每轮提醒尾部固定指令；机械门禁只能检查已建记录，无法证明"没建"（已知盲区，记录在此） |
| 门禁误伤 | affects 前缀写宽/写窄；暂存路径格式不一 | 统一归一化（去 `./`、`\`→`/`、去尾 `/`）；`test checks` 覆盖相等/前缀/不命中；只在 `precommit` 接 |
| 门禁漏报 | 改动未暂存就运行检查 | 检查语义固定为暂存区；未暂存时通过是设计行为（门禁只在提交时拦截） |
| 跨会话挂起轮数不可比 | fork/恢复后 turn 重置 | 提醒只对提问会话显示"轮"，其它会话显示时长；升级有两个触发（同会话轮数、任意会话 24 小时），阈值常量集中定义一次 |
| 面板只读导致回答链路断 | 用户想直接点按钮 | 复制完整 `flow decision answer` 命令，用户粘回会话即由模型执行；R2 保证当轮关闭 |
| gc 删除历史 | 误删仍有审计价值的记录 | 默认只删关闭超 90 天的记录；`--dry-run` 先看；删除可由 git 历史恢复（R10） |
| 新配置节兼容性 | 旧 manifest 无 `decisions` 键；自定义 dir 逃逸 | 缺键补默认（既有合并规则）；逃逸按 §2.1 降级默认并 warning，不读取根外内容 |
| 与 T-12/T-13 格式分叉 | 各自定义决策/语义记录 | 本文 §8 约定同族惯例与 id 引用；T-12/T-13 定稿必须引用本文，不另立格式 |
| 每轮 pre-step 增加 IO | 决策数量增长、读 store 变慢 | 记录数量级 <100；提醒只读一次、失败静默；面板沿用现有轮询 |

## 12 验证与验收

### 12.1 本文档自身

- 示例 JSON 可解析：`node -e` 抽取本文所有 ```json 代码块逐个 `JSON.parse`（含 §4.2、§4.6、§9）。
- 命令风格：`decision` 命令组与 `task`/`exp`/`gate`/`heartbeat` 一致（位置参数 id、`--json` 信封、0/1/2/3/4 退出码、`table()`/`printRecord` 风格）。
- 唯一规则自查：全文没有模式开关、没有"可选模式/降级模式"分叉；§14 逐条对照。

### 12.2 T-23 实现验收矩阵

| 编号 | 场景 | 命令/断言 | 期望 |
|---|---|---|---|
| D01 | 新建 approval | `flow decision ask --kind approval --question Q --rationale R --blocks T-… --affects lib/` | 落盘 `D-YYYYMMDD-NN.json`，status=open，exit 0 |
| D02 | choice 缺 recommendation | 同上 `--kind choice --option a=…>>… --option b=…>>…` | exit 2，`invalid` |
| D03 | blocks 指向不存在任务 | `--blocks T-20990101-99` | exit 2，`invalid` |
| D04 | open 同指纹重复 ask | 连续两次同题 ask | 第二次 `created:false`，不新增文件 |
| D05 | 已关闭同指纹 ask | answered 后同题 ask 不带 `--supersedes` | exit 2，`conflict`，回显旧答案 |
| D06 | answer 当轮关闭 | `flow decision answer D-… --choice a` | status=answered，`answered_at` 有值 |
| D07 | answer 非 open | 对 answered 再 answer | exit 2，`conflict` |
| D08 | withdraw | `flow decision withdraw D-… --reason R` | status=withdrawn，`withdraw.reason` 有值 |
| D09 | supersede | 新 ask 带 `--supersedes <open id>`；另测 supersede 一条 answered 记录 | 旧记录 superseded + `superseded_by`，原 answer 保留；新记录写 `supersedes` |
| D10 | 门禁命中 | 临时 git 仓库：open blocking 决策 affects `lib/`，暂存 `lib/x.mjs`，跑 `flow check decisions` | exit 1，`failed[0].matched` 含 `lib/x.mjs` |
| D11 | 门禁不命中 | 暂存 `docs/x.md` | exit 0 |
| D12 | 回答后门禁通过 | 先 answer 再跑 | exit 0 |
| D13 | pre-step 提醒 | 主会话无心跳/有心跳两种，有 open 决策 | 注入一条 `【project-flow】` 消息，含 id 与"回答后当轮 answer" |
| D14 | 无 open 不注入 | 无 open 决策 | 不注入决策内容（心跳提醒照旧） |
| D15 | 种子门禁 | 新项目 `flow init` | `gates/precommit.json` 第二步为 `check decisions` |
| D16 | status 待决策段 | `flow status` | 输出 `待决策 N（阻塞 M）` 且 json 有 `decisions` |
| D17 | 面板 payload | GET state | 有 `decisions.counts.open`；无 open 时计数 0 |
| D18 | 子会话门控 | 子会话调 `flow_decision` ask/answer | 抛错并提示向主会话汇报 |
| D19 | approval 省略 recommendation | `flow decision ask --kind approval --question Q --rationale R`（不带 `--recommendation`） | 落盘 `recommendation:"approve"`、exit 0；显式 `--recommendation reject` → `'reject'` |

## 13 未决问题

| # | 问题 | Owner | 截止 |
|---|---|---|---|
| Q1 | 面板"复制回答串"是否要带推荐选项 id 还是让用户改（当前取 recommendation，缺失时取 default，再缺失时取第一个 option） | 用户 | T-23 开工前 |
| Q2 | 技能恢复文案一行随 T-24 落地，还是单独小卡 | Lead | T-24 开工前 |
| Q3 | `precommit` 种子增加第二步后，已有项目是否统一由中心批量追加 | Lead | T-23 验收前 |

## 14 唯一规则自查

| 检查项 | 结果 |
|---|---|
| 是否有"可选模式/多模式"分叉 | 无。`kind` 是记录类型（choice/approval/input），不是运行模式；提醒、门禁、面板、恢复各自只有一条规则 |
| 同题去重是否唯一 | 是。`open` 复用、`closed` 必须 `supersedes`，见 §4.5 |
| 门禁判定是否唯一 | 是。`open` + `blocks` 非空 + `affects` 命中暂存文件，见 §6.3 |
| 排序是否唯一 | 是。升级优先，其次 `asked_at` 旧的在前，提醒/列表/面板一致 |
| 写入口是否唯一 | 是。core 是唯一写者；CLI/工具/面板都不直写文件，面板只读 |
| 关闭路径是否唯一 | 是。`answer`/`withdraw`/新记录 `supersedes` 三条通道；终态不可回退，重新决策只能新建记录并 supersede 旧记录 |
| 与既有记录族是否同构 | 是。目录、id、schema、锁、原子写、JSON 信封、CLI 风格一致，见 §8 |
