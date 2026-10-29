# 发布节奏（git 层面；脚本实现见项目契约）

## 阈值与基线

- 阈值：dev 自上次发布基线累积 **N 个提交**（默认 10，项目可调）后自动发布下一版。
- 基线定位：`git log --grep '<发布提交特征>' -1`；计数：`git rev-list --count <基线>..HEAD`。
- 可使用 `scripts/release_baseline.sh '<发布提交特征>' [阈值]` 计算并判定是否到达发布点。

## 发布前验证（硬性）

- 契约 build/test/smoke 全绿。
- 冒烟统一采用**环境变量门控探针**模式：程序内埋点只在探针变量置位时输出标记（默认零影响），脚本读到标记判 PASS、**超时判 FAIL**；运行前 `env | grep -i <关键词>` 检查并清理隔离环境注入的变量。

## 版本 bump 脚本化

- 版本串 `<主>.<次>.<补丁>[-<预发布名>.N]` 递增；同步契约列出的**所有版本声明位置**。
- **从正式版基线（无预发布后缀）重新起算 `.1`**——尾段数字直接切分/转数值会把 `1.2.0` 算成 `1.2`（得出版本 `1.2.0-beta.2.2` 这类错误），需按"是否含预发布后缀"分支处理。
- CHANGELOG：Unreleased 归档为新版本段 + 保留空 Unreleased；版本信息文件（如有）旧条目前移入 history。

## 分支合并纪律

- 禁止 `git push origin HEAD:<beta>` 直推（那是非合并操作）。
- 预发布：先 `git push origin dev`，再临时 worktree 合并：`git fetch origin <beta>` → `git worktree add -B <tmp> origin/<beta>` → `git merge --no-edit dev` → `git push <tmp>:<beta>` → `git worktree remove <tmp>`。
- 合并冲突保留现场中止，由协调者处理；不强行清理、不 reset --hard。
- 正式分支用 `git push origin dev:<master>` 快进。
- 禁止 cherry-pick、force 更新或任何非合并操作。

## 发布说明与里程碑

- 发布说明源头是 CHANGELOG：每个用户可见变更必须先写入 `## [Unreleased]` 段，缺段时 Release 说明会降级为提交列表。
- Release 的创建/更新（幂等重跑、latest/prerelease 标记）由发布脚本与 CI 承载，约定见契约。
- 手动里程碑发布：发布脚本支持 `--force` 跳过提交数阈值。

## 停止条件

- 合并冲突、门禁变红、发布脚本中途失败：**保留现场**，不在现场反复重试、不 reset --hard、不强行清理；先读取现状与日志，交给协调者。
- 同一命令连续两次因相同原因失败必须停止并上报，禁止第三次盲目重试。
