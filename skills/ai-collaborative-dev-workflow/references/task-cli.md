# 任务书 CLI 契约（精度层）

> 通用契约；参考实现 `scripts/task`（复制到 `.agents/scripts/`）。先做 `new/show/check`，不接 hooks/CI。
> 配套：字段与校验规则见 `structured-tasks.md`；接线见 `enforcement.md`。

## 1 范围
- 写入仅 `task new`；`show/check` 必须只读，不改文件、不改 mtime。
- 存储：`.agents/tasks/<id>.json`；锁：`.agents/tasks/.lock`（目录锁 + 5 分钟 TTL）。
- 旧 Markdown 任务书不动；关闭时用 `legacy_id` 转换。

## 2 命令
| 命令 | 作用 | 写文件 | 退出码 |
|---|---|---|---|
| `task new` | 分配 ID、套默认值、写 draft JSON | 是 | 0/1/2 |
| `task show <id>` | 读任务；默认摘要，`--json` 原样，`--fields` 投影 | 否 | 0/1/2 |
| `task check <id>` / `--all-active` | 只读校验 schema 与规则 | 否 | 0/1/2 |

## 3 `task new`
参数：`--title`、`--goal`、`--allow`（逗号分隔，必填）、`--deny`、`--invariant`（可重复）、`--acceptance "cmd=>expect"`（可重复）、`--owner`、`--baseline`、`--legacy-id`、`--understanding`、`--json`。
行为：
1. 取锁；锁存在且未过期 → exit 2；过期则删除并告警。
2. 生成 `id=T-<本地日期>-NN`；NN 从 01 起，扫描现有文件取最大+1。
3. 写默认值：`schema=1`、`status=draft`、`preflight.resolution=none`、`forbidden` 默认五项、`sync=[]`。
4. 先写临时文件，`os.replace` 原子落盘；失败清理临时文件并释放锁。
5. 输出 id 与文件路径；`--json` 输出任务对象。

## 4 `task show`
- 默认摘要：id、title、status、owner、goal、scope.allow、acceptance 条数、preflight.resolution、最近检查点。
- `--json`：完整任务对象；`--fields a,b,c`：只输出指定字段（支持点路径，如 `scope.allow`）。
- 未知 id：exit 1，stderr 给可用 id 列表（最多 10 个）。

## 5 `task check`
`--all-active` 遍历所有 active 任务，供 CI/协调者使用；任一失败 exit 1。
校验顺序（遇错继续收集，最后统一输出）：
1. 文件存在、JSON 可解析、`schema=1`。
2. 必填字段；id 与文件名一致；status 枚举。
3. `active/done` 时 baseline 非空；`scope.allow` 非空；路径不含 `..`、不以 `/` 开头。
4. sync 推导：命中版本文件→`version`；README→`readme`；令牌文件→`tokens`；`db/*.sql`→`schema`；API 文件→`api`。缺项报 `SYNC_MISSING`；具体文件清单由项目配置提供。
5. preflight：understanding 非空；`resolution=pending` 不得 active；有 objections 但 resolution=none 失败。
6. acceptance：≥1 条；cmd/expect 非空；expect 仅允许 `exit 0`、`empty`、`>= N`。
7. 限额：invariants ≤5；notes ≤20 行/2000 字。
8. 状态：`done` 需 commits ≥1 且至少一个 checkpoint.gate=pass。
9. 并发：与其它 active 任务的 scope.allow 求交（前缀匹配，deny 优先），非空报 `SCOPE_OVERLAP`。

## 6 输出与退出码
`--json` 统一信封：
~~~json
{ "ok": false, "command": "check", "id": "T-20261021-01",
  "errors": [{ "path": "preflight.resolution", "code": "PREFLIGHT_PENDING", "message": "active 任务不得有未解决异议" }],
  "warnings": [] }
~~~
- exit 0：通过；exit 1：校验失败；exit 2：用法/环境/锁冲突。
- 人类输出：每条错误一行，格式 `字段: 代码: 说明`；最后一行给下一步命令。

## 7 决策
见 `structured-tasks.md` §4。

## 8 校验用例
| 编号 | 场景 | 命令 | 期望 |
|---|---|---|---|
| C01 | 合法新任务 | `task new --title ... --goal ... --allow src/` | exit 0，生成 draft |
| C02 | 缺 goal | `task new --title ... --allow ...` | exit 1，`goal: REQUIRED` |
| C03 | allow 为空 | `task new --title ... --goal ...` | exit 1，`scope.allow: EMPTY` |
| C04 | 路径逃逸 `../x` | `task new ... --allow ../x` | exit 1，`PATH_ESCAPE` |
| C05 | 重复 id | 已存在同 id 文件再 new | exit 1，`ID_EXISTS` |
| C06 | 并发 new ×2 | 同时执行 | 两个不同 id，均 exit 0 |
| C07 | 锁未过期 | 手动建锁后 new | exit 2，`LOCKED` |
| C08 | 锁过期 | 锁 mtime 超 5 分钟 | 清锁后成功，输出 WARN |
| C09 | show 投影 | `task show <id> --fields goal,acceptance` | 仅两字段，exit 0 |
| C10 | show 不存在 | `task show T-20990101-99` | exit 1，列出可用 id |
| C11 | active + preflight pending | fixture | exit 1，`PREFLIGHT_PENDING` |
| C12 | 改样式文件未声明同步项 | fixture | exit 1，`SYNC_MISSING` |
| C13 | 两 active scope 重叠 | fixture | exit 1，`SCOPE_OVERLAP` |
| C14 | acceptance 为空 | fixture | exit 1，`ACCEPTANCE_EMPTY` |
| C15 | notes 超 20 行 | fixture | exit 1，`NOTES_TOO_LONG` |
| C16 | done 无提交 | fixture | exit 1，`DONE_WITHOUT_COMMIT` |
| C17 | done 无 pass 检查点 | fixture | exit 1，`DONE_WITHOUT_GATE` |
| C18 | show/check 只读 | 执行前后比对 sha256 与 mtime | 完全一致 |

## 9 Phase 1 完成标准
- C01–C18 全过；`show/check` 零写入（C18）；并发 new 不撞号（C06）。
- 不接 hooks/CI；不修改任何旧 `.md`；不依赖 jq/yq，项目自选运行时（bash/Node/Python 均可）即可。
- 实现后用一个真实任务样例跑一遍 `check`，结果应为 0 错误。

## 10 实现注意
- 路径统一 POSIX 风格；Windows 下用 `pathlib` 归一，不手拼分隔符。
- 时间用 `datetime.now().astimezone()`；测试可用 `TASK_NOW` 固定时钟。
- 根目录可用 `TASK_ROOT` 覆盖，便于临时仓库 fixture。
- 输出 UTF-8；错误信息中文，代码字段英文。
- 不用第三方库；不引入网络访问。