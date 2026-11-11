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

/** True for the two documented `expect` forms (`exit N`, `contains: TEXT`) and the empty default. */
function expectSyntaxKnown(expect) {
  const text = typeof expect === 'string' ? expect.trim() : ''
  return text === '' || EXPECT_EXIT_RE.test(text) || EXPECT_CONTAINS_RE.test(text)
}

function evaluateExpect(expect, exit, output, timedOut) {
  const text = typeof expect === 'string' ? expect.trim() : ''
  if (timedOut) return false
  const exitMatch = EXPECT_EXIT_RE.exec(text)
  if (exitMatch !== null) return exit === Number(exitMatch[1])
  const containsMatch = EXPECT_CONTAINS_RE.exec(text)
  if (containsMatch !== null) return output.includes(containsMatch[1])
  if (text === '') return exit === 0
  noteWarning(`gate-expect-unknown: ${JSON.stringify(expect)} treated as "exit 0"`)
  return exit === 0
}

/**
 * Run one gate step. `control` ({platform?, spawnImpl?, killImpl?, taskkillImpl?,
 * graceMs?}) is a test seam for the win32 branches; production leaves it empty.
 * @returns {Promise<object>} the per-step record written into the gate log
 */
export function runStep(root, step, timeoutMs, tailLines, control = {}) {
  const platform = typeof control.platform === 'string' ? control.platform : process.platform
  const spawnImpl = typeof control.spawnImpl === 'function' ? control.spawnImpl : spawn
  const graceMs =
    Number.isFinite(control.graceMs) && control.graceMs >= 0 ? control.graceMs : WIN32_KILL_GRACE_MS
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
      const exit = typeof code === 'number' ? code : null
      resolvePromise({
        id: step.id,
        run: step.run,
        expect: step.expect,
        exit,
        ok: evaluateExpect(step.expect, exit, output, timedOut),
        durationMs: Date.now() - started,
        tail: tailText(output, tailLines),
      })
    }
    child.on('error', (error) => {
      append(`\n${error.message}`)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

export { expectSyntaxKnown }
