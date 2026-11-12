#!/usr/bin/env node
// project-flow MCP 兼容入口（T-20261112154655：后端收敛为单一可执行）。
//
// 后端现在只有一个可执行 `flow`，MCP 是它的 `mcp-serve` 子命令：
//
//   flow mcp-serve [--root <dir>] [--timeout <seconds>] ...
//
// 本文件保留为旧入口的**兼容别名**（已有 MCP 客户端配置里写着 flow-mcp 的
// 不必立刻改），不是第二份实现：
//   - 弃用提示只写 stderr，stdout 全程留给 JSON-RPC；
//   - 直接复用 lib/cli/mcp-server.mjs 的 `main`，与 `flow mcp-serve` 是同一
//     函数、同一份 core —— 不做「spawn 一个 flow 子进程」的二次转调，避免多
//     一层进程与 stdio 转发失败面。
//
// 选「保留兼容转发」而非「直接删除」的理由：删掉会让现有 flow-mcp 配置在升级
// 后静默失效（MCP 客户端只看到子进程退出），而兼容转发只多一行弃用提示。

import process from 'node:process'
import { main } from '../lib/cli/mcp-server.mjs'

process.stderr.write(
  'project-flow: bin/mcp.mjs / `flow-mcp` 已弃用，请改用 `flow mcp-serve`（同一实现、同一份 core）\n',
)

process.exitCode = await main()
