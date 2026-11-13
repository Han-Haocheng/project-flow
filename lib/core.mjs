/**
 * project-flow core (schema 2) — 契约装配与对外门面。
 *
 * Phase 1（2026-11-11）把各业务域从本文件按物理目录拆出：store / gates /
 * heartbeats / tasks / experiments / decisions / description 各自实现，core 只保留
 * 三件事——default gate seeds、`initProject` 装配、只读聚合 `readStoreState`；
 * 其余 API 在这里 import 后原样 re-export，所以既有 import 路径与导出名不变。
 *
 * 每个域仍共用同一把 store 锁与同一套原子写（`lib/store/`、`lib/atomic.mjs`），
 * core 因此仍是"唯一写者"的装配点。域模块之间不 import core：能单向成边的直接
 * import（experiments/decisions/description → tasks 等），会成环的用注入
 * （`configureTasks` / `configureHeartbeats`）。
 *
 * Layout (root-relative, fixed unless the contract says otherwise):
 *   .agents/flow/flow.json
 *   .agents/experiments/<id>.json
 *   .agents/tasks/<id>.json
 *   .agents/gates/<id>.json
 *   .agents/decisions/<id>.json
 *   .agents/flow/logs/<gateId>/<timestamp>.json
 *   .agents/flow/.lock   (temporary, never committed or displayed)
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Split modules（task-49/task-52 起，2026-11-11 Phase 1 完成按域拆分）：每个域在
// 自己的 `lib/<domain>/` 里实现，本文件只 import 自己用到的名字并原样 re-export。
// 依赖对象是域模块而不是 core，所以各域都不会反向 import 本文件。
import { FlowError, toPosix } from './util.mjs'
import { containedPath, pathMemoOf } from './paths.mjs'
import { ensureDir, writeJsonAtomic } from './atomic.mjs'
import { TASK_STATUS, buildTask, configureTasks, listTasks, taskIds } from './tasks/records.mjs'
import { configureHeartbeats, readHeartbeatSection } from './heartbeats/records.mjs'
import { buildGate, gateIds, listGateRuns, listGates } from './gates/records.mjs'
import { EXPERIMENT_STATUS, experimentIds, listExperiments } from './experiments/records.mjs'
import { DECISION_REMIND_MAX, summarizeDecisions } from './decisions/records.mjs'
import { assertDescriptionGate } from './description/gate.mjs'
import {
  CONTRACT_REL,
  defaultContract,
  initLockContract,
  loadContract,
  normalizeContract,
  resolveDir,
  storePaths,
  withLock,
} from './store/contract.mjs'
import { resolveProjectRoot } from './store/git-root.mjs'
import { statusCounts } from './store/records.mjs'

export { drainWarnings, FlowError, noteWarning } from './util.mjs'
export { containedPath } from './paths.mjs'
export { renameWithRetrySync, writeJsonAtomic } from './atomic.mjs'
export { releaseTakeoverClaim } from './lock.mjs'
export { killProcessTree } from './proc.mjs'
export { runStep } from './runner.mjs'

export { resolveProjectRoot } from './store/git-root.mjs'
export {
  TASK_STATUS,
  TASK_TYPES,
  addTask,
  archiveTasks,
  getTask,
  listTasks,
  normalizeOwnerInput,
  normalizeParentInput,
  normalizeTaskFormat,
  releaseDeadSessionTasks,
  removeTask,
  sweepUtteranceTasks,
  taskRevision,
  taskRevisionOf,
  updateTask,
} from './tasks/records.mjs'
export {
  HEARTBEAT_SCHEMA,
  HEARTBEAT_STALE_SECONDS,
  MAX_HEARTBEAT_CLIP,
  endHeartbeat,
  gcLegacyHeartbeats,
  gitBranchOf,
  heartbeatStatus,
  livenessOf,
  readHeartbeatSection,
  readHeartbeats,
  removeHeartbeat,
  resolveHeartbeatWorkspace,
  startHeartbeat,
  updateHeartbeat,
} from './heartbeats/records.mjs'
export {
  addGate, getGate, listGateRuns, listGates, removeGate, runGate, runGatesByPhase, updateGate,
} from './gates/records.mjs'
export {
  SCHEMA_VERSION,
  TASK_ARCHIVE_AFTER_DAYS,
  assertInitialized,
  loadContract,
  saveContract,
  storePaths,
  withLock,
} from './store/contract.mjs'

// ---------------------------------------------------------------- decisions
//
// A `D-` record is a question that needs the user to decide. Storage is the
// same independent family as experiments/tasks/gates: schema 1, the store lock,
// atomic writes and `PREFIX-YYYYMMDD-NN` ids. `fingerprint` dedupes one question
// (kind + normalized text) across time; terminal states never mutate again —
// re-deciding creates a new record that supersedes the old one.
//
// 2026-11-11 Phase 1：决策实现（CRUD / 答案 / GC / 提醒 / 否决联动）已迁至
// `lib/decisions/records.mjs`；本段只保留公共常量与 re-export。紧跟其后的
// `initProject` 是 core 自己的装配代码，沿用原区段位置、未额外挪动。

export {
  DECISION_SCHEMA,
  DECISION_STATUS,
  DECISION_KINDS,
  DECISION_ESCALATE_TURNS,
  DECISION_ESCALATE_HOURS,
  DECISION_GC_DAYS,
  DECISION_REMIND_MAX,
} from './decisions/records.mjs'

/**
 * Absolute path of this package's CLI. Seeded gates run with the *project* root
 * as cwd, so a project-local `bin/flow.mjs` cannot be assumed.
 */
const PLUGIN_BIN = fileURLToPath(new URL('../bin/flow.mjs', import.meta.url))

export function initProject(root, options = {}) {
  // 在 worktree 里 init 也必须落在项目主工作区：台账是项目级的，不是检出版的。
  const absRoot = resolveProjectRoot(root)
  const created = []
  ensureDir(absRoot)
  const requestedName = typeof options.name === 'string' && options.name.trim() !== '' ? options.name.trim() : null

  // The whole bootstrap is one critical section: members and the seeded gates
  // must not race `task add` / `gate update` / another init. The lock lives in
  // the store declared by the *current* manifest (`store.root` may be custom),
  // so read the manifest first, lock there, and re-validate under the lock: if
  // another writer changed `store.root` while we were acquiring, release and
  // retry boundedly instead of writing through the wrong lock.
  const MAX_INIT_LOCK_ROUNDS = 5
  for (let round = 1; round <= MAX_INIT_LOCK_ROUNDS; round += 1) {
    const lockContract = initLockContract(absRoot)
    const lockStore = storePaths(absRoot, lockContract).store
    let retry = false
    const result = withLock(absRoot, lockContract, () => {
      const live = initLockContract(absRoot)
      if (storePaths(absRoot, live).store !== lockStore) {
        retry = true
        return null
      }
      const warnings = []
      let contract = null
      let seededGates = []
      // Recompute under the lock: another init may have won the race.
      const contractFile = join(absRoot, CONTRACT_REL)
      const alreadyExists = existsSync(contractFile)
      if (alreadyExists && options.force !== true) {
        contract = loadContract(absRoot).contract
        warnings.push(`already-initialized: ${CONTRACT_REL} (use force to rewrite)`)
      } else {
        // A fresh write and `--force` both build from the schema defaults plus
        // `--name`; records and other on-disk state are left untouched.
        contract = defaultContract(absRoot)
        if (requestedName !== null) contract.name = requestedName
        ensureDir(dirname(contractFile))
        writeJsonAtomic(contractFile, contract)
        created.push(CONTRACT_REL)
      }

      // Missing directories of a pre-existing (possibly partial) ledger are
      // repaired under the same lock. A forced rewrite does NOT keep the loaded
      // (old) config: it writes defaults above; existing record dirs stay as-is.
      const paths = storePaths(absRoot, contract)
      // 心跳目录也在这里建：刚 init 的项目若缺目录，status/doctor 的健康项会把
      // 「目录不可读」报成 warn（空目录无害；读路径仍走同一 containment）。
      const heartbeats = resolveDir(absRoot, contract.heartbeats && contract.heartbeats.dir, 'heartbeats.dir', 'heartbeat', paths.store)
      for (const dir of [paths.experiments, paths.tasks, paths.gates, paths.logs, paths.decisions, paths.description, heartbeats]) ensureDir(dir)

      // Bootstrap gates only help an empty gates directory; seeding is best-effort
      // and never fails the init itself (every failure becomes a warning). It runs
      // inside this lock, so reading the gate directory and writing the seeds are
      // one critical section with respect to `gate run/update` (N3 documented:
      // moving the seed out of the lock would need a second lock round and is not
      // worth the write-path risk).
      if (options.noGates !== true) {
        try {
          seededGates = seedDefaultGates(absRoot, contract, warnings)
        } catch (error) {
          warnings.push(`default-gate-failed: seed: ${error?.message ?? String(error)}`)
        }
      }
      return { root: absRoot, created, warnings, seededGates }
    }, { sweep: false })
    if (retry === false) return result
  }
  throw new FlowError('conflict', 'init: store.root kept changing while acquiring the lock; retry')
}

// ------------------------------------------------------ default gate seeds

/**
 * The gates `flow init` seeds into an empty gates directory. Steps that call
 * this plugin use the runtime-resolved absolute CLI path because a gate runs
 * with the project root as cwd (which need not contain `bin/flow.mjs`).
 */
function defaultGateSeeds() {
  const cli = `"${PLUGIN_BIN}"`
  return [
    {
      id: 'session-open',
      title: '会话心跳检查',
      phase: 'manual',
      enabled: true,
      steps: [{ id: 'heartbeat', run: `${cli} heartbeat status --require-active`, expect: 'exit 0' }],
    },
    {
      id: 'precommit',
      title: '提交前暂存区检查',
      phase: 'commit',
      enabled: true,
      steps: [
        { id: 'whitespace', run: 'git diff --cached --check', expect: 'exit 0' },
        { id: 'decisions', run: `${cli} check decisions`, expect: 'exit 0' },
        // Explicit sweep, not a read-path side effect: a commit is the natural
        // point to retire finished tasks. `--json` is for programmatic callers.
        { id: 'tasks-archive', run: `${cli} task archive`, expect: 'exit 0' },
        // Description-ledger drift (spec §9). Appended last on purpose: a dirty
        // stage or a blocking decision still fails first, and the earlier step
        // indices (`steps[1]`/`steps[2]`) stay put for existing assertions. It is
        // read-only, and `enforce: auto` keeps it green on a project that has not
        // built a description yet — otherwise every old store would start red.
        { id: 'description', run: `${cli} check description`, expect: 'exit 0' },
      ],
    },
    {
      id: 'tests',
      title: '单元测试（默认关闭，按项目自填命令）',
      phase: 'commit',
      enabled: false,
      steps: [{ id: 'unit', run: 'node --test test/', expect: 'exit 0' }],
    },
    {
      id: 'staged-files',
      title: '暂存文件归属检查（占位，需项目自填 --allow 路径）',
      phase: 'commit',
      enabled: false,
      steps: [{ id: 'staged', run: `${cli} check staged --allow src`, expect: 'exit 0' }],
    },
    {
      id: 'release',
      title: '发布基线检查（占位，需项目自填 --marker）',
      phase: 'release',
      enabled: false,
      steps: [
        { id: 'baseline', run: `${cli} check release-baseline --marker RELEASE`, expect: 'exit 0' },
        { id: 'experiments', run: `${cli} check experiments`, expect: 'exit 0' },
        // Release keeps the strict form: `undescribed-file` graduates from warning
        // to failure, so a release cannot ship files nobody described.
        { id: 'description-strict', run: `${cli} check description --strict`, expect: 'exit 0' },
      ],
    },
  ]
}

/**
 * Seed the default gates when the gates directory holds no gate yet.
 * Idempotent: any existing gate skips seeding entirely. Every failure only
 * appends a warning, so `flow init` never fails because of a seed.
 */
function seedDefaultGates(absRoot, contract, warnings) {
  const paths = storePaths(absRoot, contract)
  let names
  try {
    names = readdirSync(paths.gates)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new FlowError('io', `cannot read ${toPosix(paths.gates)}: ${error.message}`)
  }
  // "empty" means no gate file at all, readable or not.
  if (names.some((name) => name.toLowerCase().endsWith('.json'))) return []
  const existing = gateIds(paths)
  const seeded = []
  for (const input of defaultGateSeeds()) {
    try {
      const record = buildGate(input, { existingIds: existing })
      writeJsonAtomic(join(paths.gates, `${record.id}.json`), record)
      existing.add(record.id)
      seeded.push(record.id)
    } catch (error) {
      warnings.push(`default-gate-failed: ${input.id ?? '?'}: ${error?.message ?? String(error)}`)
    }
  }
  return seeded
}

// ---------------------------------------------------------- experiments
//
// 实验域（实验树 / schema2 七字段 / 分流 / `check experiments`）已迁至
// `lib/experiments/records.mjs`。本段只做 re-export：公共 API 一个不少，core
// 自身只 import `listExperiments`（聚合）、`experimentIds`（装配）与
// `EXPERIMENT_STATUS`（计数的状态全集）。

export {
  EXPERIMENT_SCHEMA,
  isLegacyExperiment,
  listExperiments,
  getExperiment,
  addExperiment,
  updateExperiment,
  cleanupExperiment,
  productizeExperiment,
  reviewExperimentRecord,
  checkExperiments,
  removeExperiment,
  experimentTree,
} from './experiments/records.mjs'

// ------------------------------------------------------------- decisions
//
// 决策 API 的 re-export（公共常量在上方第一个 decisions 区段）。
// `listDecisions`/`getDecision` 等读接口与 `addDecision`/`answerDecision` 等写接口
// 全部实现在 `lib/decisions/records.mjs`，本文件不再持有决策逻辑。

export {
  listDecisions,
  getDecision,
  addDecision,
  answerDecision,
  withdrawDecision,
  gcDecisions,
  purgeArchivedDecisions,
  summarizeDecisions,
  checkDecisions,
} from './decisions/records.mjs'

// ------------------------------------------------------------- aggregate

function summarizeRun(record) {
  const steps = Array.isArray(record.steps) ? record.steps : []
  return {
    gate: record.gate,
    title: record.title,
    started_at: record.started_at,
    finished_at: record.finished_at,
    durationMs: record.durationMs,
    ok: record.ok === true,
    steps: steps.map((step) => ({
      id: step.id,
      run: step.run,
      expect: step.expect,
      exit: typeof step.exit === 'number' ? step.exit : null,
      ok: step.ok === true,
      durationMs: step.durationMs,
    })),
  }
}

/**
 * Read-only aggregate for the panel: experiments/tasks/gates, the heartbeat
 * section and the decision projection. Never touches git or run output.
 *
 * @param {string} root project root
 * @param {object} contract flow contract
 * @param {{pathMemo?: Map<string,string|Error>}} [options] per-request realpath memo:
 *   one HTTP request / one TUI read shares it, so the same root or manifest path
 *   is resolved once instead of once per section. Omitted (CLI, tools), every
 *   containment check resolves again, exactly as before.
 */
export function readStoreState(root, contract, options = {}) {
  const memo = pathMemoOf(options)
  const c = normalizeContract(root, contract)
  const currentTask = typeof c.tasks.current === 'string' ? c.tasks.current : null
  // `tasks.current` names a file; an unsafe value is hidden from API consumers
  // just like an unreadable one (the Host validates it again for its payload).
  const current =
    currentTask !== null && containedPath(root, currentTask, 'tasks.current', { pathMemo: memo }) !== undefined
      ? currentTask
      : null
  // Broken records never vanish from the counts: they are skipped from `items`
  // (panel rows must stay valid) but reported next to the status counts.
  const unreadable = { experiments: [], tasks: [], gates: [] }
  const experiments = listExperiments(root, c, { unreadable: unreadable.experiments, pathMemo: memo })
  const tasks = listTasks(root, c, { unreadable: unreadable.tasks, pathMemo: memo })
  const gates = listGates(root, c, { unreadable: unreadable.gates, pathMemo: memo }).map((gate) => {
    const runs = listGateRuns(root, c, gate.id, 1, { pathMemo: memo })
    const last = runs.length > 0 ? runs[0] : null
    return { ...gate, lastRun: last === null ? null : summarizeRun(last) }
  })
  return {
    experiments: {
      source: c.experiments.source,
      items: experiments,
      counts: { ...statusCounts(experiments, EXPERIMENT_STATUS), unreadable: unreadable.experiments.length },
    },
    tasks: {
      source: c.tasks.source,
      current,
      items: tasks,
      counts: { ...statusCounts(tasks, TASK_STATUS), unreadable: unreadable.tasks.length },
    },
    gates: {
      items: gates,
      counts: {
        total: gates.length,
        enabled: gates.filter((gate) => gate.enabled !== false).length,
        unreadable: unreadable.gates.length,
      },
    },
    heartbeats: readHeartbeatSection(root, c, { pathMemo: memo }),
    // 决策投影与提醒/`flow status`/面板共用同一个 summarizeDecisions（同一排序、
    // 同一截断上限）；这里不带 session/turn，所以 turnAge 恒为 null，升级只看 24 小时。
    decisions: summarizeDecisions(root, c, { limit: DECISION_REMIND_MAX, pathMemo: memo }),
  }
}

// ------------------------------------------------------------ description
//
// The description ledger (CONTRACT §3.7). Everything computable without touching
// the store lives in `lib/desc.mjs`; the lock-scoped orchestration, contract
// normalization and the stage gate live in `lib/description/`
// (`records.mjs` + `gate.mjs`). This section is the re-export seam only, so the
// public API and every existing import path stay unchanged.

export {
  DESCRIPTION_SCHEMA,
  DESCRIPTION_ENFORCE_MODES,
  readDescriptionProject,
  listDescriptionFiles,
  getDescriptionFile,
  getDescriptionPlan,
  descriptionStatus,
  renderDescription,
  checkDescription,
  buildDescription,
  setDescriptionFile,
  setDescriptionProject,
  setDescriptionPlan,
  applyDescriptionPlan,
} from './description/records.mjs'

// ------------------------------------------------- description stage gate
//
// 阶段门适配器单独成文件（同域 `lib/description/gate.mjs`）：它是 tasks ↔
// description 之间唯一的方向性接缝，core 把它注入任务域
// （`configureTasks({ descriptionGate: assertDescriptionGate })`，见文件末尾装配）。

export { assertDescriptionGate } from './description/gate.mjs'

// 心跳域需要"没有任务时建卡"的能力：在模块加载完成后把任务侧实现接过去。
configureHeartbeats({ buildTask, taskIds })

// 任务域需要描述门的判定：装配完成后把描述侧实现接过去（避免 tasks ↔ description 成环）。
configureTasks({ descriptionGate: assertDescriptionGate, experimentIds })
