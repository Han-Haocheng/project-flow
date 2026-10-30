# 强制接入规范（精度层）

> 通用契约；配置值由项目 `gate-config` 提供，实现先只读、后阻断。
> 参考实现：`scripts/gate.py`；接入示例见项目 `gate-config`，先 observe 再阻断。改 CI 属敏感操作，需当次确认。

## 1 目标与非目标
目标：让“没跑检查”变成提交/推送/合并过不去，而不是靠提醒。
非目标：不替代构建与测试；不自动修复；不判断设计合理性。

## 2 三层强制
| 层 | 能拦 | 不能拦 | 绕过方式 |
|---|---|---|---|
| pre-commit | staged 越界、task 状态、doc lint、sync 缺项 | 提交信息（还没生成） | `--no-verify` |
| commit-msg | 标题格式、Task/Agent trailer、task 是否存在 | 文件内容 | `--no-verify` |
| pre-push | 非 dev、非 fast-forward、带标签、工作区脏 | 已推送的坏提交 | `--no-verify` |
| CI | 以上全部 + 构建 | 本地未推送的提交 | 无（权威层） |

**结论：CI 才是权威。** 本地 hooks 只负责尽早失败，不能当成最终保证。

## 3 `gate commit` 流水线
协调者用 `gate commit -m ... -- <files>` 包装 `git commit`，按顺序执行：
1. **确定任务**：读 `GATE_TASK_ID` 环境变量；没有则读 `.agents/tasks/.current`；都没有 → 拒绝（observe 模式只告警）。
2. **暂存检查**：暂存区非空；文件全部命中该任务 `scope.allow`，且不命中 `deny`。
3. **task check**：任务存在、`status=active`、preflight 已解决、baseline 非空。
4. **doc check**：仅当 staged 含 `docs/**` 或 `*.md` 时跑，按 `--type` 识别；失败即拒。
5. **sync 检查**：版本 5 处、README jar 名、令牌两侧、schema 双侧、API 契约；按任务 `sync` 声明触发。
6. **构建**：pre-commit 默认不跑（太慢）；`gate commit --build` 或 CI 跑。
7. **提交**：检查通过后调用 `git commit -m ... -- <files>`；任何一步失败都不提交。

## 4 `commit-msg` hook
- 校验标题：`type(scope): 说明`，type 与 scope 在词表内。
- 要求 trailer：`Task: T-YYYYMMDD-NN`、`Agent: <session>`。
- 用 trailer 里的 id 复核任务存在且 active；与 `GATE_TASK_ID` 不一致 → 拒绝。

## 5 `pre-push` hook
调用 `gate push --dry-run`：fetch → 当前分支必须 dev → `origin/dev` 是 HEAD 祖先 → HEAD 无标签 → 工作区干净。任一失败拒绝推送。

## 6 CI（`.github/workflows/discipline.yml`）
触发：push 到 dev、PR 到 dev。权限：只读，`contents: read`。
作业：
1. `static`：跑 `task check --all-active`、变更文档的 `doc check`、版本同步项与令牌同步项。
2. `build`：按改动路径过滤，调用项目命令契约里的构建命令；各域互不阻塞。
3. `audit`：扫描本次推送范围的 `Gate-Override`，输出报告但不阻断。

**前置条件（代码之外）**：仓库分支保护把 `static` 与 `build` 设为 required checks；否则 workflow 红了也能合并，强制力不成立。

## 7 例外与留痕
- 仅 `gate commit --force --reason "<理由>"` 可跳过本地检查；要求当次人工审批。
- 提交 body 写 `Gate-Override: <理由>` 与 `Approved-By: <user>`。
- CI 对 override 只警告不阻断；每周统计次数，连续两周 >3 次则复查规则是否过严。

## 8 灰度与回滚
1. **observe（1 周）**：hooks 只告警，不阻断；收集误报。
2. **pre-commit 阻断**：误报率 >20% 或门禁 >2 分钟则回退到 observe。
3. **pre-push 阻断**：同上。
4. **CI required**：先让 `static` 必过，再让 `build` 必过；构建超时 >10 分钟则拆分缓存。
每步单独提交；回滚只改 hook/CI 开关，不改规则本身。

## 9 测试矩阵
| 编号 | 场景 | 期望 |
|---|---|---|
| T01 | 无任务 id 提交 | 拒绝（observe 警告） |
| T02 | staged 超出 scope | 拒绝，列文件 |
| T03 | task preflight=pending | 拒绝 |
| T04 | 文档缺节/超长 | 拒绝 |
| T05 | 版本 5 处不一致 | 拒绝 |
| T06 | 改令牌文件未跑令牌检查 | 拒绝 |
| T07 | `--no-verify` 绕过本地 | CI 红 |
| T08 | 锁过期并发 new | 清理后成功 |
| T09 | 只改前端 | 只跑前端构建 |
| T10 | override 提交 | 本地放行，CI 警告 + 报告 |

## 10 指标与停止条件
- 指标：override 次数、误报率、门禁耗时、从红到绿的时间。
- 回滚条件：误报率 >20%，或 pre-commit 中位耗时 >2 分钟，或 CI 经常因环境失败。
- 规则调整必须先改测试用例，再改脚本，避免“为了过而放宽”。

## 11 未决问题
- `.current` 指针与 `GATE_TASK_ID` 谁优先；建议 env 优先，便于一次性覆盖。
- `task check --all-active` 在 CI 的耗时；任务多时是否需要缓存。
- 分支保护由谁配置、是否纳入发布检查清单。
- pre-commit 是否默认跑构建；建议不跑，仅 CI 跑。
- override 审批人是否只限协调者。

## 12 Gate CLI 与规则分类

### 2. 规则分类

| 类别 | 规则 | 检查点 |
|---|---|---|
| 机械 | staged 文件在允许域内 | pre-commit / CI |
| 机械 | 提交标题符合 Conventional Commits | commit-msg / CI |
| 机械 | Task/Agent trailer 存在且格式正确 | commit-msg / CI |
| 机械 | 版本 5 处一致 | pre-commit（动版本文件时）/ CI |
| 机械 | README jar 名 = pom 版本 | pre-commit / CI |
| 机械 | 令牌文件与生成值同源 | pre-commit（动令牌文件时）/ CI |
| 机械 | 只推 dev、fast-forward、无标签 | pre-push / CI |
| 机械 | 任务书必填字段完整 | gate task / CI（台账变更时） |
| 半机械 | 改 API 是否伴随前端改动 | gate commit 提示 |
| 半机械 | 改 schema 是否伴随两侧 mapper | gate commit 提示 |
| 判断 | 契约冻结、范围、设计债 | 人 |

### 3. CLI

统一入口 `.agents/scripts/gate`（bash，Git Bash/WSL 可跑）。

~~~
gate commit [--force --reason <txt>]
gate build --scope <scope>|all
gate push [--dry-run]
gate release --dry-run
gate task <TASK-ID>
gate doctor
~~~

退出码：0 通过；1 失败；2 用法/环境错误；3 需要人工裁决（半机械提示）。

### gate commit
1. 暂存区非空；收集 `git diff --cached --name-only`。
2. 读取任务（`GATE_TASK_ID` 或 `.agents/tasks/.current`），跑 `task check`，取 scope；无任务则拒绝（observe 模式只告警）。
3. 归属检查：越界 → 列文件 + 建议 `git restore --staged`。
4. 提交消息检查：`type(scope): 说明`，scope 在词表内（或 `--allow-new-scope`）。
5. trailer：`Task: T-YYYYMMDD-NN`、`Agent: <session>`；缺失 → 失败（文档类可豁免）。
6. 同步推导：
   - 动版本文件 → 校验项目声明的全部版本位置。
   - 动令牌文件 → 跑项目配置的令牌一致性检查。
   - 动 `db/*.sql` → 提示两侧 mapper/entity 影响 + 幂等验证命令。
   - 动 API 文件 → 提示契约影响，要求任务书声明。
   - staged 含 `docs/**` 或 `*.md` → 跑 `doc check`。
7. 输出“通过 / 失败项 / 下一步命令”。

### gate push
1. `git fetch --quiet`。
2. 当前分支必须 dev；`git merge-base --is-ancestor origin/dev HEAD` 必须成立。
3. `git tag --points-at HEAD` 必须为空。
4. 工作区干净（仅允许本地心跳目录）。
5. 打印将推送的提交列表，等待确认（任务书预授权除外）。

### gate build
按 scope 调既有命令；跨域改动要求 all；检测并发（pgrep mvn/vite、产物 mtime）→ 拒绝并提示等待。

### gate task
检查任务书字段：ID、工作目录、基线、文件域、契约影响、验证命令、提交规范、禁止项、停止条件；缺失即失败。

### gate doctor
git 版本、hooks 是否安装、core.hooksPath、工作区状态、远端可达、LFS 状态、工具链版本。

### 4. 配置

`.agents/gate.conf`（入仓，避免路径散落）：

~~~
SCOPES="<scope-1> <scope-2> ..."
VERSION_FILES="<version-file-1> ..."
TOKEN_FILES="<token-file-1> ..."
ALLOWED_DOMAINS="<domain-1> <domain-2> ..."
~~~


## 13 CLI 正反例

### 6. 测试

- 正例：合规提交、合规 push。
- 反例：越界文件、坏标题、缺 trailer、版本不一致、令牌漂移、非 dev push、非 ff、带标签 push。
- 用临时仓库 fixture（参考通用技能 `smoke_test.sh`），不碰真实仓库。
- 脚本改动必须跑正反例；CI 跑同一套。
