/**
 * Gate-step execution: run one shell command with a timeout, keep a bounded
 * output tail, and decide whether the result satisfies `expect`.
 *
 * The process-tree kill itself lives in `lib/proc.mjs` (shared with the check
 * runner); the injection seams on `runStep` are unchanged, so the win32 branches
 * stay testable off Windows. `runGate`/`listGateRuns` live in
 * `lib/gates/records.mjs` (store paths, lock, log files); `lib/core.mjs` only
 * re-exports the public names.
 *
 * Split out of `lib/core.mjs` (task-52) as a pure move.
 */
import { spawn } from 'node:child_process'

import { WIN32_KILL_GRACE_MS, killProcessTree } from './proc.mjs'
import { noteWarning } from './util.mjs'

const TAIL_LINE_MAX = 400
const OUTPUT_CAP = 512 * 1024

/**
 * 子进程 `exit` 之后的 drain 宽限（非 win32，T-20261113110938 ③）。
 *
 * `close` 要等 stdout/stderr 两个管道**所有写端**关闭；孙进程继承了管道却逃逸时，
 * EOF 可能永远不来（实测 600s 卡死），runStep 就只剩 step 超时一条路。子进程本身已
 * 退出说明它的直接输出到底了，给一个有限宽限按已收集输出结算即可。
 */
const DEFAULT_DRAIN_MS = 2000

function tailText(output, lines) {
  const all = output.split(/\r?\n/)
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  return all
    .slice(Math.max(0, all.length - lines))
    .map((line) => (line.length > TAIL_LINE_MAX ? line.slice(0, TAIL_LINE_MAX) : line))
    .join('\n')
}

const EXPECT_EXIT_RE = /^exit\s+(-?\d+)$/i
const EXPECT_CONTAINS_RE = /^contains\s*[:：]\s*([\s\S]*)$/i

/** 合法 expect 写法清单（错误/警告文案共用，避免两处漂移）。 */
const EXPECT_SYNTAX_HELP = 'exit N（如 exit 0、exit 1）或 contains: TEXT（冒号全/半角均可；留空等价 exit 0）'

/** True for the two documented `expect` forms (`exit N`, `contains: TEXT`) and the empty default. */
function expectSyntaxKnown(expect) {
  const text = typeof expect === 'string' ? expect.trim() : ''
  return text === '' || EXPECT_EXIT_RE.test(text) || EXPECT_CONTAINS_RE.test(text)
}

/**
 * 判定一步是否满足 expect。
 *
 * 未知写法默认**判失败**：手误（`exit:1`、`exit 1` 拼错）绝不能被静默当成
 * exit 0 放行。只有在门禁定义时显式开了 `--allow-unknown-expect`（记录里
 * `step.allowUnknownExpect === true`）才按 exit 0 放行，且每次运行都留警告。
 */
function evaluateExpect(expect, exit, output, timedOut, allowUnknown = false) {
  const text = typeof expect === 'string' ? expect.trim() : ''
  if (timedOut) return false
  const exitMatch = EXPECT_EXIT_RE.exec(text)
  if (exitMatch !== null) return exit === Number(exitMatch[1])
  const containsMatch = EXPECT_CONTAINS_RE.exec(text)
  if (containsMatch !== null) return output.includes(containsMatch[1])
  if (text === '') return exit === 0
  if (allowUnknown === true) {
    noteWarning(`gate-expect-unknown: ${JSON.stringify(expect)} 无法识别，已按 --allow-unknown-expect 放行，该步按 exit 0 判定`)
    return exit === 0
  }
  noteWarning(`gate-expect-invalid: ${JSON.stringify(expect)} 无法识别，该步按失败判定（修正 expect 或显式传 --allow-unknown-expect）`)
  return false
}

/**
 * Run one gate step. `control` ({platform?, spawnImpl?, killImpl?, taskkillImpl?,
 * graceMs?, drainMs?}) is a test seam for the win32 branches and the POSIX drain
 * grace; production leaves it empty.
 * @returns {Promise<object>} the per-step record written into the gate log
 */
export function runStep(root, step, timeoutMs, tailLines, control = {}) {
  const platform = typeof control.platform === 'string' ? control.platform : process.platform
  const spawnImpl = typeof control.spawnImpl === 'function' ? control.spawnImpl : spawn
  const graceMs =
    Number.isFinite(control.graceMs) && control.graceMs >= 0 ? control.graceMs : WIN32_KILL_GRACE_MS
  // POSIX drain 宽限：与 win32 的超时 grace 分开，注入 `drainMs` 只影响 exit 之后这段。
  const drainMs = Number.isFinite(control.drainMs) && control.drainMs >= 0 ? control.drainMs : DEFAULT_DRAIN_MS
  return new Promise((resolvePromise) => {
    const started = Date.now()
    let output = ''
    let timedOut = false
    let settled = false
    const append = (chunk) => {
      output += String(chunk)
      if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP)
    }
    let child
    try {
      child = spawnImpl(step.run, { shell: true, cwd: root, detached: platform !== 'win32' })
    } catch (error) {
      append(error.message)
      resolvePromise({
        id: step.id,
        run: step.run,
        expect: step.expect,
        exit: null,
        ok: false,
        durationMs: Date.now() - started,
        tail: tailText(output, tailLines),
      })
      return
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    let graceTimer
    let drainTimer
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child, { ...control, platform })
      // win32: `taskkill` cannot be awaited and a surviving grandchild can keep
      // the stdio pipes open, so `close` may never fire. Resolve after a bounded
      // grace instead of hanging the runner forever.
      if (platform === 'win32') {
        graceTimer = setTimeout(() => {
          child?.stdout?.destroy?.()
          child?.stderr?.destroy?.()
          finish(null)
        }, graceMs)
      }
    }, timeoutMs)
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      if (drainTimer !== undefined) clearTimeout(drainTimer)
      const exit = typeof code === 'number' ? code : null
      resolvePromise({
        id: step.id,
        run: step.run,
        expect: step.expect,
        exit,
        ok: evaluateExpect(step.expect, exit, output, timedOut, step.allowUnknownExpect === true),
        durationMs: Date.now() - started,
        tail: tailText(output, tailLines),
      })
    }
    child.on('exit', (code) => {
      /* win32 保持原语义（只在超时时 taskkill + grace），POSIX 才在 exit 后起 drain 宽限。 */
      if (platform === 'win32') return
      drainTimer = setTimeout(() => {
        // 管道写端可能握在已逃逸的孙进程里；显式释放句柄，避免 process 残留 fd。
        child?.stdout?.destroy?.()
        child?.stderr?.destroy?.()
        finish(typeof code === 'number' ? code : null)
      }, drainMs)
    })
    child.on('error', (error) => {
      append(`\n${error.message}`)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

export { EXPECT_SYNTAX_HELP, expectSyntaxKnown }
