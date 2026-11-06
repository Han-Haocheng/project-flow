// lib/checks.mjs —— `flow check` 的检查目录与执行器（只读命令层）
//
// 只做三件事：声明随包分发的机械检查脚本、把 CLI 参数映射成脚本调用、执行脚本并把
// 结果归一化成插件统一的 0/1/2/3/4 退出码语义。
//
// 纪律：
// - 不导入 lib/core.mjs，不读写 .dsh/flow：检查是只读的，不产生任何 store 写入。
// - 不联网、不装依赖；只 spawn 本机 `bash` / `python3` 运行包内脚本。
// - 脚本路径相对于**包根**解析（本文件在 <pkg>/lib/，脚本在
//   <pkg>/skills/ai-collaborative-dev-workflow/scripts/），与用户项目根 `--root` 无关。

import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_TIMEOUT_SECONDS = 120

// win32：taskkill /T /F 之后子进程树可能仍占着 stdio，close 不会来；grace 兜底 resolve。
const WIN32_KILL_GRACE_MS = 2000
// taskkill 自己也要有上限，避免一个卡住的 helper 拖死检查。
const TASKKILL_TIMEOUT_MS = 5000

// 每路输出最多保留最后 8 KiB（JSON 模式与失败诊断用）。
export const MAX_CAPTURE_BYTES = 8 * 1024

const SCRIPTS_REL = 'skills/ai-collaborative-dev-workflow/scripts'
const SCRIPTS_DIR = path.resolve(fileURLToPath(new URL(`../${SCRIPTS_REL}/`, import.meta.url)))

export const DOC_TYPES = Object.freeze(['task', 'design', 'incident', 'release'])

// 退出码：0 通过 · 1 检查失败 · 2 用法/配置错误 · 3 脚本或解释器缺失 · 4 启动/IO 失败
export const CHECK_EXIT_BY_CODE = Object.freeze({
  usage: 2,
  'check-failed': 1,
  'check-missing': 3,
  'check-io': 4,
})

const RAW_CATALOG = [
  {
    name: 'staged',
    interpreter: 'bash',
    file: 'check_staged_files.sh',
    description: '暂存区必须全部落在允许的路径前缀内（提交归属纪律）',
    args: '--allow <path> [--allow <path> ...]',
  },
  {
    name: 'release-baseline',
    interpreter: 'bash',
    file: 'release_baseline.sh',
    description: '数发布基线之后的提交数，达到阈值即可发布',
    args: '--marker <text> [--threshold <N>]',
  },
  {
    name: 'state',
    interpreter: 'bash',
    file: 'check_state.sh',
    description: '校验 COLLAB_STATE.md 的必备字段与敏感信息',
    args: '[--file <path>]（默认 COLLAB_STATE.md）',
  },
  {
    name: 'doc',
    interpreter: 'python3',
    file: 'doc_check.py',
    description: '按文档标准校验任务/设计/事故/发布文档的章节与行数',
    args: '--file <path> --type task|design|incident|release',
  },
]

export const CHECKS = Object.freeze(
  RAW_CATALOG.map((entry) =>
    Object.freeze({
      ...entry,
      script: `${SCRIPTS_REL}/${entry.file}`,
      absPath: path.join(SCRIPTS_DIR, entry.file),
    }),
  ),
)

/** 检查脚本所在目录（绝对路径，包内）。 */
export function scriptsDir() {
  return SCRIPTS_DIR
}

/** CLI `flow check list` 的公开目录（不含绝对路径）。 */
export function listChecks() {
  return CHECKS.map(({ name, interpreter, script, description, args }) => ({
    name,
    interpreter,
    script,
    description,
    args,
  }))
}

export function getCheck(name) {
  return CHECKS.find((entry) => entry.name === name)
}

/** 检查层的错误：code 走 0/1/2/3/4 词汇，payload 直接进 `--json` 的 error 对象。 */
export class CheckError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'CheckError'
    this.code = code
    const { silent = false, ...payload } = extra
    // 纯文本模式下列脚本已经打印了诊断，不再补一条“错误（…）”。
    this.silent = silent === true
    this.payload = payload
  }
}

function usageError(message) {
  // 参数错误是解析器发现的，纯文本模式必须把原因打出来（脚本自己退 2 时才静默）。
  return new CheckError('usage', message, { silent: false })
}

// `check_staged_files.sh` 按「等于前缀」或「前缀/…」匹配，`src/`、`./src` 这种
// 等价写法会匹配不到。这里只做无歧义规范化：去掉开头的 `./` 与结尾的 `/`。
function normalizeAllows(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '')
    .map((item) => item.replace(/^(?:\.\/)+/, '').replace(/\/+$/, ''))
    .filter((item) => item !== '')
}

/**
 * 把 `flow check <name>` 的选项映射成脚本 argv。
 * 只做参数合法性检查，不触碰文件系统。
 */
export function buildInvocation(name, options = {}) {
  const check = getCheck(name)
  if (!check) {
    throw usageError(`未知检查 "${name}"（可用 ${CHECKS.map((entry) => entry.name).join('|')}）`)
  }

  const argv = []
  if (check.name === 'staged') {
    const allows = normalizeAllows(options.allows)
    if (allows.length === 0) {
      throw usageError('flow check staged 至少需要一个 --allow <path>（可重复）')
    }
    argv.push(...allows)
  } else if (check.name === 'release-baseline') {
    const marker = typeof options.marker === 'string' ? options.marker : ''
    if (marker.trim() === '') {
      throw usageError('flow check release-baseline 需要 --marker <text>（发布提交特征）')
    }
    argv.push(marker)
    // 不给 --threshold 时省略，交给脚本自己的默认值（10）。
    if (options.threshold !== undefined && options.threshold !== null) {
      const threshold = Number(options.threshold)
      if (!Number.isInteger(threshold) || threshold < 0) {
        throw usageError('--threshold 需要一个非负整数（达到该提交数即视为可发布）')
      }
      argv.push(String(threshold))
    }
  } else if (check.name === 'state') {
    const file =
      typeof options.file === 'string' && options.file.trim() !== ''
        ? options.file.trim()
        : 'COLLAB_STATE.md'
    argv.push(file)
  } else if (check.name === 'doc') {
    const file = typeof options.file === 'string' ? options.file.trim() : ''
    if (file === '') throw usageError('flow check doc 需要 --file <path>')
    const type = typeof options.type === 'string' ? options.type.trim() : ''
    if (type === '') throw usageError(`flow check doc 需要 --type（${DOC_TYPES.join('|')}）`)
    if (!DOC_TYPES.includes(type)) {
      throw usageError(`--type 只接受 ${DOC_TYPES.join(' | ')}`)
    }
    const root = typeof options.root === 'string' && options.root !== '' ? options.root : process.cwd()
    // doc_check.py 自带 --root：用于定位项目 `gate-config` / `doc-standard`。
    argv.push(file, '--type', type, '--root', root)
  }

  return { check, interpreter: check.interpreter, scriptPath: check.absPath, argv }
}

// ------------------------------------------------------------------ 执行

/** 只保留最后 `limit` 字节的输出（多字节字符被截断时去掉开头的替换符）。 */
function createTail(limit = MAX_CAPTURE_BYTES) {
  const chunks = []
  let total = 0
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      chunks.push(buffer)
      total += buffer.length
      while (total > limit && chunks.length > 1) {
        total -= chunks[0].length
        chunks.shift()
      }
      if (chunks.length === 1 && chunks[0].length > limit) {
        chunks[0] = chunks[0].subarray(chunks[0].length - limit)
        total = limit
      }
    },
    text() {
      if (chunks.length === 0) return ''
      return Buffer.concat(chunks)
        .toString('utf8')
        .replace(/^\uFFFD+/, '')
    },
  }
}

function writeThrough(stream, chunk) {
  try {
    stream.write(chunk)
  } catch {
    // 下游管道已关闭（EPIPE）时静默；退出码仍按检查结果给出。
  }
}

/** 尽力而为的 `taskkill /PID <pid> /T /F`；失败/缺命令返回而不抛，退化为直接杀子进程。 */
function runTaskkillSync(pid) {
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: TASKKILL_TIMEOUT_MS,
      windowsHide: true,
    })
    return { ok: result.status === 0, status: result.status, error: result.error ?? null }
  } catch (error) {
    return { ok: false, status: null, error }
  }
}

/**
 * 杀掉一项检查的子进程树。
 *
 * 非 win32（原有行为）：检查进程以 detached 启动，`kill(-pid, SIGKILL)` 收掉整个
 * 进程组，失败才直接杀子进程。win32：`child.kill()` 只杀 `cmd.exe`，孙进程会占着
 * 管道让 close 永不到来，所以先 `taskkill /T /F`，再直接杀子进程兜底。
 *
 * 非契约 API：导出只为注入 `{platform, killImpl, taskkillImpl}` 覆盖 win32 分支。
 */
export function killProcessTree(child, control = {}) {
  const platform = typeof control.platform === 'string' ? control.platform : process.platform
  const pid = child !== null && child !== undefined ? child.pid : undefined
  if (platform === 'win32') {
    const taskkillImpl = typeof control.taskkillImpl === 'function' ? control.taskkillImpl : runTaskkillSync
    const result = typeof pid === 'number' ? taskkillImpl(pid) : { ok: false, error: null }
    try {
      child?.kill?.('SIGKILL')
    } catch {
      // 已经退出
    }
    return { via: 'taskkill', ok: result?.ok === true, error: result?.error ?? null }
  }
  const killImpl = typeof control.killImpl === 'function' ? control.killImpl : process.kill
  try {
    if (typeof pid === 'number') {
      killImpl(-pid, 'SIGKILL')
      return { via: 'group', ok: true, error: null }
    }
  } catch {
    // 进程组已消失：退回直接杀子进程
  }
  try {
    child?.kill?.('SIGKILL')
    return { via: 'direct', ok: true, error: null }
  } catch (error) {
    return { via: 'direct', ok: false, error }
  }
}

/**
 * 等待检查子进程结束；超时先杀进程树，win32 再给 grace 兜底 resolve。
 * 非 win32 仍然只等 `close`（行为不变）。
 * 非契约 API：`control`（{platform?, killImpl?, taskkillImpl?, graceMs?}）仅供测试注入。
 * @returns {Promise<{code:number|null, signal:string|null, spawnError:Error|null, timedOut:boolean}>}
 */
export function superviseCheckChild(child, timeoutMs, control = {}) {
  const platform = typeof control.platform === 'string' ? control.platform : process.platform
  const graceMs =
    Number.isFinite(control.graceMs) && control.graceMs >= 0 ? control.graceMs : WIN32_KILL_GRACE_MS
  return new Promise((resolvePromise) => {
    let settled = false
    let timedOut = false
    let timer
    let graceTimer
    const finish = (code, signal, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      resolvePromise({ code, signal, spawnError, timedOut })
    }
    timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child, { ...control, platform })
      if (platform === 'win32') {
        graceTimer = setTimeout(() => {
          child?.stdout?.destroy?.()
          child?.stderr?.destroy?.()
          finish(null, null, null)
        }, graceMs)
      }
    }, timeoutMs)
    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal, null))
  })
}

/**
 * 跑一项检查。
 *
 * @param {string} name      目录中的检查名（staged | release-baseline | state | doc）
 * @param {object} options   {root, allows?, marker?, threshold?, file?, type?, timeoutSeconds?, passthrough?}
 * @returns {Promise<{check:string,exitCode:number,stdout:string,stderr:string,durationMs:number}>}
 * @throws {CheckError}      失败时带 code（check-failed|usage|check-missing|check-io）与 payload
 */
export async function runCheck(name, options = {}) {
  const invocation = buildInvocation(name, options)
  const timeoutSeconds =
    options.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : options.timeoutSeconds
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw usageError('--timeout 需要正整数秒（默认 120）')
  }
  // setTimeout 超过 2^31-1 ms 会立刻触发（Node 的溢出行为），这里直接拒绝。
  if (timeoutSeconds > 86400) {
    throw usageError('--timeout 最大 86400 秒（24 小时）')
  }
  const root =
    typeof options.root === 'string' && options.root !== '' ? options.root : process.cwd()
  const passthrough = options.passthrough === true

  let scriptStat = null
  try {
    scriptStat = statSync(invocation.scriptPath)
  } catch {
    scriptStat = null
  }
  if (scriptStat === null || !scriptStat.isFile()) {
    throw new CheckError(
      'check-missing',
      `缺少检查脚本：${invocation.check.script}（期望位于 ${SCRIPTS_DIR}）`,
      { check: invocation.check.name, exitCode: null, silent: false },
    )
  }

  let rootStat = null
  try {
    rootStat = statSync(root)
  } catch {
    rootStat = null
  }
  if (rootStat === null || !rootStat.isDirectory()) {
    // 不存在/非目录的 cwd 会让 spawn 报 ENOENT，看起来像“解释器缺失”，先给出准确原因。
    throw usageError(`项目根不存在或不是目录：${root}（用 --root <dir> 指定项目根）`)
  }

  const started = Date.now()
  const stdout = createTail()
  const stderr = createTail()

  let child
  try {
    child = spawn(invocation.interpreter, [invocation.scriptPath, ...invocation.argv], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
  } catch (error) {
    throw new CheckError(
      'check-io',
      `无法启动检查（${invocation.interpreter}）：${error?.message || String(error)}`,
      { check: invocation.check.name, exitCode: null, silent: false },
    )
  }

  child.stdout?.on('data', (chunk) => {
    stdout.push(chunk)
    if (passthrough) writeThrough(process.stdout, chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr.push(chunk)
    if (passthrough) writeThrough(process.stderr, chunk)
  })

  // 非契约测试注入位：processControl 只用于在非 Windows 上覆盖 win32 分支。
  const outcome = await superviseCheckChild(child, timeoutSeconds * 1000, options.processControl ?? {})

  const durationMs = Date.now() - started
  const exitCode = typeof outcome.code === 'number' ? outcome.code : null
  const captured = {
    check: invocation.check.name,
    exitCode,
    stdout: stdout.text(),
    stderr: stderr.text(),
    durationMs,
  }
  const fail = (code, message, silent) =>
    new CheckError(code, message, {
      check: captured.check,
      exitCode: captured.exitCode,
      stdout: captured.stdout,
      stderr: captured.stderr,
      silent,
    })

  if (outcome.spawnError) {
    const errorCode = outcome.spawnError.code
    if (errorCode === 'ENOENT') {
      throw fail(
        'check-missing',
        `找不到解释器 ${invocation.interpreter}（或脚本 ${invocation.check.script}）：请确认已安装并在 PATH 中`,
        false,
      )
    }
    throw fail(
      'check-io',
      `无法启动检查（${invocation.interpreter}）：${outcome.spawnError.message}`,
      false,
    )
  }
  if (outcome.timedOut) {
    throw fail('check-io', `检查超时（> ${timeoutSeconds}s）：${invocation.check.script}`, false)
  }
  if (outcome.signal) {
    throw fail(
      'check-io',
      `检查进程被信号终止（${outcome.signal}）：${invocation.check.script}`,
      false,
    )
  }
  if (exitCode === 0) {
    return { ...captured }
  }
  // 脚本自己的 usage 分支（check_staged_files.sh / release_baseline.sh / argparse）都退 2。
  if (exitCode === 2) {
    throw fail('usage', `检查脚本报告用法/配置错误（exit 2）：${invocation.check.script}`, true)
  }
  throw fail('check-failed', `检查未通过：${invocation.check.name}（exit ${exitCode}）`, true)
}
