# 提交评审申请模板（中心-贡献者模型）

> 用法：贡献者完成并**已 commit**、门禁跑完后，把下面「模板」整段复制、填好，发给中心（或写进任务 notes 后再发一句指针）。
> 适用：`SKILL.md` §一 与 `references/contribution-flow.md`。**这不是工具调用**——`create_worktree` 只负责创建，合并由中心用 git 手工完成；中心只给三种结论：accept / reject / request-rebase。

## 模板（复制这一段）

```markdown
## 提交评审申请：<task-id> <一句话标题>

- task id：
- 贡献者（谁 / 会话 id）：
- branch：
- worktree path（无工作树时写"同一 checkout"）：
- base commit：
- commits（<n> 个，新→旧）：
  - <sha> <提交信息>
- changed files（应与任务书允许文件域一致）：
  - <path>
- 测试命令与结果：
  - `<命令原文>` → exit 0 / <一句话摘要>
- 影响面（接口 / 台账 / 文档 / CHANGELOG / 版本声明）：
  - <有同步 / 无>
- 风险与未完成：
  - 无 / <具体项>
- 希望中心做什么：
  - merge --no-ff <branch> / cherry-pick <sha> / 先判定；若需 rebase 请给新 base
```

## 示例（填好的样子）

```markdown
## 提交评审申请：T-20261030-99 技能改为贡献流程

- task id：T-20261030-99
- 贡献者：contributor-a（session 1234abcd）
- branch：t-20261030-99-contribution-flow
- worktree path：/repo/.agents/worktrees/t-20261030-99-contribution-flow
- base commit：b78f4390c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6
- commits（2 个，新→旧）：
  - 1a2b3c4 docs(skill): 用贡献流程替换旧隔离文档
  - 5d6e7f8 docs(skill): 新增提交评审申请模板
- changed files：
  - skills/ai-collaborative-dev-workflow/references/contribution-flow.md
  - skills/ai-collaborative-dev-workflow/assets/merge-request-template.md
  - skills/ai-collaborative-dev-workflow/SKILL.md
- 测试命令与结果：
  - `bash skills/ai-collaborative-dev-workflow/scripts/smoke_test.sh` → exit 0，输出 ALL PASS
- 影响面：
  - SKILL.md 的 references 链接已同步；未改台账与版本声明
- 风险与未完成：
  - 无；未改动 index.js / lib/ 等代码文件
- 希望中心做什么：
  - merge --no-ff t-20261030-99-contribution-flow；若 dev 已前进，请给新 base，我先 rebase 再重提
```

## 发送前自检

- [ ] 分支上 `git status` 干净；若未做完，已在「风险与未完成」写明"未提交"及文件
- [ ] `git log --oneline <base commit>..HEAD` 与 commits 列表一致
- [ ] changed files 全部落在任务书允许文件域内，无夹带、无密钥、无生成物
- [ ] 测试命令能原样复跑，结果写的是命令 + 退出码而不是"测试通过"
- [ ] 影响面写了；没有同步的接口/文档/CHANGELOG 已说明
- [ ] branch / path / HEAD 三处一致；不写"工作树里那个分支"这类无法核对的描述
- [ ] 写明了希望中心做什么（merge / cherry-pick / 先判定），没有默认"中心会自己猜"
