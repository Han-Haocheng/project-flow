// project-flow — `flow state`：面板状态快照的 CLI 契约面（T-20261112154725）。
//
// 前端（dsh-web 面板 / dsh-tui）从此不再 import 后端代码、也不再自己嗅探
// `.agents/`：它们 spawn `flow state --json --root <dir>`，读同一个 `--json` 信封。
// 数据由 lib/state-snapshot.mjs 的只读投影产出 —— 与原先宿主 fork worker 用的
// 是**同一份实现**，所以这次迁移不会长出第二套投影逻辑。
//
// 与宿主 `collectPanelState()` 的差别只在「宿主侧富化」这三项：
//   - heartbeat 行的 agent 存活标注（要宿主会话注册表）；
//   - 团队板摘要（要宿主 board 服务）；
//   - 心跳可见性过滤（宿主配置）。
// CLI 进程拿不到这些服务，所以它们由前端在拿到 payload 后自己补（index.js 的
// `readStateViaCli`）。本命令只负责「store → 快照」这一段，和 HTTP 读路由同源。
//
// 原生单文件（bin/flow.mjs 用动态 import 调它）：CLI 其余命令保持惰性加载 core，
// 不能因为加了 state 子命令就让每个 `flow <cmd>` 都先付一次 core import。

import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import { buildSnapshot, isoLocal, storeContractPath } from '../state-snapshot.mjs'
import { out } from './shared.mjs'

/**
 * `flow state [--root <dir>] --json`
 *
 * 返回面板 payload（与 `GET /api/project-flow/state` 的 200 响应同形）。未初始化
 * 的工作区返回 `{ ok:false, error:{ code:"not-initialized" } }`——和 HTTP 读路由
 * 一样是**正常状态**而不是命令失败，所以退出码仍是 0。
 *
 * @param {{core:object, root:string}} ctx CLI 上下文（root 已由 bin 解析为绝对路径）
 */
export async function cmdState(ctx) {
  const root = ctx.root
  const payload = await buildSnapshot({ root, entry: { path: root, name: basename(root) } })
  // 「未初始化」的唯一判据 = 台账契约文件不存在（与 HTTP 读路由的 hasStoreAsync 同源），
  // 不是 loadContract 的 source：坏 manifest 也会回退 defaults，但那是「有台账、配置坏了」，
  // 必须保留 ok:true + defaults + manifest-invalid warning —— 读路径不能把配置错误伪装成
  // 「没初始化」，也不能把它当降级成功（见 .selftest/harness.mjs 的 broken 三条）。
  const ledgerRoot =
    typeof payload.ledgerRoot === 'string' && payload.ledgerRoot !== '' ? payload.ledgerRoot : root
  if (existsSync(storeContractPath(ledgerRoot)) === false) {
    const empty = {
      ok: false,
      generatedAt: isoLocal(new Date()),
      root,
      roots: [],
      error: { code: 'not-initialized', message: `no flow store in ${root}; run: node bin/flow.mjs init` },
    }
    if (ctx.json !== true) out(`未初始化：${root}（运行 node bin/flow.mjs init 创建台账）`)
    return empty
  }

  // buildSnapshot 已经做了「worktree → 项目主工作区台账」的解析；这里只把 payload
  // 对外的 root/roots 钉回调用方要的那个工作区（与 collectPanelState 的收尾一致）。
  const name = payload.contract !== null && typeof payload.contract === 'object' && typeof payload.contract.name === 'string'
    ? payload.contract.name
    : basename(root)
  payload.root = root
  payload.roots = [{ path: root, name }]
  if (ctx.json !== true) printSummary(payload)
  return payload
}

/** 人读摘要：面板快照命令在非 --json 下也不该静默（机器面走 --json 信封）。 */
function printSummary(payload) {
  const tasks = payload.tasks !== null && typeof payload.tasks === 'object' ? payload.tasks.total : 0
  const experiments = payload.experiments !== null && typeof payload.experiments === 'object' ? payload.experiments.total : 0
  const gates = Array.isArray(payload.gates) ? payload.gates.length : 0
  const heartbeats = Array.isArray(payload.heartbeats) ? payload.heartbeats.length : 0
  out(`面板快照：${payload.root}`)
  out(`  任务 ${tasks} · 实验 ${experiments} · 门禁 ${gates} · 心跳 ${heartbeats}`)
  for (const warning of Array.isArray(payload.warnings) ? payload.warnings : []) out(`  警告：${warning}`)
}

/** 契约源不是默认脚手架即视为已初始化（与 `flow status` 同一判据）。 */
function storeInitialized(core, root) {
  try {
    const loaded = core.loadContract(root)
    return loaded.source !== 'defaults'
  } catch {
    // 契约损坏时 loadContract 抛错：按「没有台账」回答，面板显示未初始化而不是白屏。
    return false
  }
}