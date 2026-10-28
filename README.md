# project-flow

用一块只读面板看任意项目的「项目流」：实验树、任务进度、
门禁观察日志、子代理心跳、最近写出的运行输出。实验当前支持两种来源：
带 `Exp-Id` 等 trailer 的 git 提交（默认），或直接读结构化记录（后续版本）。

项目用一份可选的 `flow.json` 声明自己的台账布局；不写也能用——只要目录里有
`.agents/tasks/`、`.agents/gate-observe.log` 或 `.agents/scripts/exp.py`，就按默认布局展示。
契约细节见 [CONTRACT.md](CONTRACT.md)。

## 安装

这是一个本地 DSH bundle（`@local/project-flow`），无 npm 依赖、无构建步骤。

```text
plugin_manager install_bundle  target=.
```

或把本目录作为本地包安装后在 profile 里启用条目 `project-flow`
（`cordis.patch.yml` 会 insert `id: project-flow` → `name: '@local/project-flow'`）。
安装后刷新页面即可。

## 打开方式

三种入口，任选：

1. **右侧栏标签**——面板常驻右侧栏，切换项目不丢状态；
2. **会话头按钮**——顶栏流程图标，点开同一面板；
3. **指南卡**——首次启用时出现的一张说明卡，点「打开」进入面板。

面板每 2.5 秒拉一次 `GET /api/project-flow/state`；页面隐藏时暂停，切回可见立即重拉；
切换项目时也立即重拉。

## 多项目

- 所有「带契约或带默认布局」的已注册 workspace 都会出现在「项目」选择器里；
- 项目选择只保存在当前面板实例里：刷新页面或重开标签会回落到自动选择
  （按 `<root>/.agents/tasks` 的最新修改时间择一）；
- 想固定某个项目，用 `?root=<绝对路径>` 直接请求 Host 端点（该目录自带 `flow.json`
  时即使尚未注册为 workspace 也接受）。

## 自测

`.selftest/` 是可重跑的回归资产（用于验收与后续改动），不属于运行时：

```text
node .selftest/harness.mjs             # Host：契约、发现、适配器、边界（52 断言）
node .selftest/root-explicit.mjs       # Host：显式 root 的 opt-in 规则
node .selftest/client-registration.mjs # Client：座位注册、locale 键、源码卫生（30 断言）
node .selftest/client-render.mjs       # Client：渲染与真实 payload 回放（31 断言）
node .selftest/client-poll.mjs         # Client：轮询/取消/可见性（11 断言）
```

`state-*.json` 是 Host harness 生成的真实快照，`client-render.mjs` 会直接回放它们。

## 卸载

```text
plugin_manager remove_bundle  target=@local/project-flow
```

只想临时关掉而保留包：在插件列表里禁用条目 `project-flow`。卸载只移除面板与那条
`/api/project-flow/state` 路由，不会动任何项目文件——本包从不写文件。

## 边界

- **只读**：Host 半只读文件与 git 元信息，不写、不建目录、不删；没有 watcher，每次请求现算。
- **零依赖**：只用 node 内置模块；不联网；git 调用 4 秒超时。
- **降级不报错**：目录缺失、`flow.json` 坏、非 git 仓库、`webServer` 服务缺失，一律返回结构完整的
  200（或空段），异常只进 `warnings`。
- **安全**：exact GET 路由，非 GET → 405；外站 `origin` → 403；响应 `cache-control: no-store`。
- **不是数据库**：只展示「最近」的切片（实验最近 400 条提交、门禁末 40 行、心跳 20 条、
  运行输出 4 个文件），不做历史归档与检索。需要长期记录请写到项目自己的台账里。
