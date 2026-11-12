#!/usr/bin/env node
// project-flow MCP 入口（查询 + 完整任务工作流 + 自动编排）。
//
// 协议与工具面全部在 lib/cli/mcp-server.mjs；本文件只负责把退出码交给进程。
// 查询/管理域复用 bin/flow.mjs 的 JSON 信封；任务写路径直接走 core 的锁与校验。

import process from 'node:process'
import { main } from '../lib/cli/mcp-server.mjs'

process.exitCode = await main()
