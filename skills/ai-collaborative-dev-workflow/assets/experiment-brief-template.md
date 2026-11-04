# 实验简报（实验型项目开工前复制）

> 实验是任务的外围功能（`SKILL.md` §十二）：**先把这个简报填满，再建实现卡**。七项假设字段缺任一，中心拒绝建实验/建卡，退回分析者补全。
> 填完随任务书一起下发；结果判定与清理清单在收尾时回填，并由中心回记项目任务 `notes`。

## 1 实验身份

- 实验 id（`E-YYYYMMDD-NN`）：
- 实验标题（≤60 字符）：
- 父实验（`parent`，无则 `null`）：
- 关联项目任务（`experiment` 单向引用，不从实验侧记 tasks）：
- 实现分支（`exp/<E-id>/<topic>`）：

## 2 假设七字段（缺一即拒）

| 字段 | 填写 | 自检 |
|---|---|---|
| `direction` 方向 |  | 方向措辞（自由文本 ≤120 字符，不设枚举） |
| `expected` 验证目标 |  | 一句话、可判真假，不写"体验更好" |
| `primaryMetric` 主指标 |  | **唯一**；写清怎么量、从哪取数 |
| `guardrails[]` 护栏指标 |  | ≥1 条不可退化的约束（时延 / 错误率 / 体积 / 兼容性） |
| `falsify` 证伪条件 |  | 什么观测结果说明假设错了；与 `expected` 同义由审查把关 |
| `windowDays` 观测周期 |  | 正整数天数；**起算点 = `created_at`**（超期据此判） |
| `stopLoss` 止损线 |  | 到什么程度立即停并回滚（可判定性由审查把关） |

## 3 设计与观测

- 改动面（文件 / 接口 / 开关名）：
- 验证命令（引用项目命令契约）：
- 观测方式（数据来源、采样窗口、谁来判读）：
- 回滚方式（开关默认值 / 分支丢弃 / 数据回退）：
- 影响域与不变量（不可破坏什么）：

## 4 结果判定（收尾回填，四选一）

- 判定：`成功` / `不确定` / `失败` / `转向`
- 主指标实测：
- 护栏指标实测：
- 是否命中 `falsify` / `stopLoss`：

## 5 分支动作（按判定只做一支；**B1 落地前按人工执行**）

- **成功**：`flow exp productize`（release 最近一次 `ok` 的 `finished_at` ≥ 进入 `confirmed` 的 `updated_at`）→ 合并 / 上线 → `productizedAt` 与 commits。
- **不确定**：置 `inconclusive` + 写 `learned`（**建议写、不硬拦**；`open` 只表示进行中）→ 延长 `windowDays` 或派生 `parent` 子实验；**不产品化**。
- **失败**：`learned`（学到什么）+ `flow exp cleanup --flag/--code/--data` 写 `cleanup{flags[],code[],data[]}`（各 ≤20 项）与 `cleanupAt` + 清理证据（命令与输出）；`exp update --status refuted` 不拦，`check experiments` 硬拦。
- **转向**：`learned`（保留什么、为什么换假设）+ 复用资产清单 + 子实验 id。

## 6 收尾自检

- [ ] 七字段在实验记录里齐全 + `title`/`hypothesis` 非空（新实验；旧 `schema:1` 记录只读不补）
- [ ] 判定只选一支，且 `confirmed` / `refuted` / `pivoted` / `inconclusive` 与判定对得上
- [ ] `refuted` 有 `learned` + `cleanupAt`（`cleanup` 三数组可空）；`pivoted` 有 `learned` + 后继实验
- [ ] 失败分支清理后**没有死开关**残留（开关删除或标注已停用）
- [ ] 结论已回记项目任务 `notes`，分支按中心决定保留或清理
