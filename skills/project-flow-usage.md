# project-flow-usage

技能名：`project-flow-usage`。用 `flow` CLI 维护 `.dsh/flow/` 里的实验、任务与门禁；
面板读同一份 store（唯一写动作是未初始化空态上的「初始化」按钮，同样走 core）。
所有命令都接受全局 `--root <dir>` 与 `--json`。

## 实验：生命周期与谱系

状态：`open`（新建默认）→ `confirmed` | `refuted`，任何阶段可改 `abandoned`。
一次实验一条记录，用 `metrics` 存结构化数字，`measured` 存一句话结论。

```bash
# 新建（id 自动生成 E-YYYYMMDD-NN）
flow exp add --title "focus 归一化降 tie" --hypothesis "归一化后 tie_mean<=1.0" \
  --factor focus/normalize --expected "tie_mean<=1.0" --scale small

# 在父实验下开子实验（parent 必须已存在）
flow exp add --title "调 PI 增益" --parent E-20261028-01 --factor focus/pi

# 记录结果并判定
flow exp update E-20261028-01 --measured "tie_mean=0.4" \
  --metrics '{"tie_mean":0.4,"runs":3}' --status confirmed

# 关联提交（逗号分隔）
flow exp update E-20261028-01 --commits abc1234,def5678

# 查看
flow exp list
flow exp show E-20261028-01
flow exp tree                # 按 parent 缩进；未知 parent / 成环按根显示
```

- `flow exp add` 的 id 固定自动生成，不能指定；`--parent` 指向不存在的实验会直接报
  `invalid`（退出码 2）。
- `update` 不能改 `id`/`schema`/`created_at`，但会自动刷新 `updated_at`。
- 删除需 `--yes`：`flow exp rm E-20261028-01 --yes`（不带 `--yes` 且非交互 → 退出码 1）。

## 任务：状态流转

`draft` → `active` → `done`，废弃用 `archived`。`scope` 用 `--json`/API 维护，
CLI 只暴露常用字段。

```bash
flow task add --title "接 CLI 与面板" --status active --owner agent-a --goal "跑通主链路"
flow task list
flow task show T-20261028-01
flow task update T-20261028-01 --status done --notes "测试全绿"
flow task rm T-20261028-01 --yes
```

## 门禁：定义 + 运行记录

门禁是**定义**（`gates/<id>.json`）加**运行记录**（`logs/<id>/<ts>.json`）。步骤顺序执行，
首个失败即停；命令在项目根执行，`expect` 支持 `exit 0`、`exit N`、`contains:文本`。

```bash
flow gate add --id precommit --title "提交前检查" --phase commit \
  --step 'tests=node --test test/>>exit 0' \
  --step 'diff=git diff --check>>exit 0'

flow gate run precommit
flow gate run precommit --timeout 120      # 覆盖本次所有步骤超时（秒）

flow gate list                             # 每行带最近一次运行结果
flow gate show precommit
flow gate logs precommit --limit 5         # 新→旧；失败步骤打印末尾输出
flow gate update precommit --enabled false
flow gate rm precommit --yes
```

- `gate update --step` 会**整体替换**步骤列表；想追加就把旧步骤一起写上。
- 门禁失败**不是命令失败**：`flow gate run` 仍退出 0，结果看 `data.ok`
  （`--json` 时 `{ok:true,data:{ok:false,...}}`）。脚本里判断：

```bash
flow gate run precommit --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(JSON.parse(s).data.ok?0:1))"
```

- `--json` 输出形状：成功 `{ok:true,data}`，失败 `{ok:false,error:{code,message}}`；
  退出码 0 成功 / 1 用法 / 2 校验 / 3 未找到 / 4 IO。

## 项目状态

```bash
flow status            # 项目名、契约源、计数、最近 3 条实验/任务/门禁运行
flow --json status     # 同上 + data.store 绝对路径
```

## 与 git 的关系

- `.dsh/flow/` 是真相源：可以提交，实验的 `commits` 字段负责回指提交；
- 提交信息里的 `Exp-Id`/`Verdict` trailer **不再被读取或迁移**；实验与提交的关联改用
  `flow exp update <id> --commits <sha>` 维护。
- 写锁 `.dsh/flow/.lock` 不要提交；并发写会得到 `conflict`（退出码 2），重试即可；
- 需要给面板/他人看时不用导出：面板直接读同一份 store。

## 分支/工作树与台账

中心-贡献者模型下（贡献者在自己分支提交、中心唯一合并与写台账；协议见
`ai-collaborative-dev-workflow/references/contribution-flow.md`）：

- **台账真源在主工作区**：`.dsh/flow/` 只在主工作区初始化与提交；工作树继承已提交的
  台账，**不要**在工作树里 `flow init` 或另建 store，否则会出现两份互不相认的卡片。
- **中心唯一写台账**：贡献者不 init、不建卡；需要更新状态时经中心，或用 `--root` 显式
  指向主工作区（且需中心同意）。
- **子会话写卡必须 `--root` 主工作区**：面板只按**当前工作区**查找 `.dsh/flow/`，而且
  **看不到某会话在哪条分支**。在子 worktree 里直接 `flow task add` 会把卡写进工作树，
  主面板看不到，合并时才变成"多出来的文件"。正确写法：

  ```bash
  flow --root /path/to/main-workspace task update T-20261030-02 --status active --notes "..."
  ```

- **分支信息写进文字**：心跳 `last_action`、任务 `notes`、提交评审申请三处都写
  `branch` + `worktree path` + `commit`；这些不会自动出现在面板上。
- 心跳可留在各自工作树（运行态、不入台账），但不要靠心跳在工作区自动建卡，也不登记
  文件锁。
- 提交评审申请模板：`ai-collaborative-dev-workflow/assets/merge-request-template.md`。

## 排错

| 现象 | 原因与处理 |
|---|---|
| `错误（usage）：run flow init first ...` | store 未初始化，先 `flow init` |
| `错误（conflict）：store is locked ...` | 另一个写者持有锁，等它结束或等 30 秒过期后重试 |
| `错误（invalid）：parent experiment does not exist` | 先建父实验，或确认 id 拼写 |
| `错误（not-found）：experiment E-... not found` | id 不存在：`flow exp list` 核对 |
| `gate run` 退出 0 但结果失败 | 门禁本身失败，检查 `data.steps[].tail` |
| 记录读不出来 | `--json` 会带 warning；删除坏 JSON 前先备份，别手改 id |
