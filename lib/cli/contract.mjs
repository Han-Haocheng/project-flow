// CLI --json 契约的单一真源（T-20261112161101 · 重构⑤）
//
// 为什么需要这个文件
// ------------------
// 用户定的边界是「前端通过 CLI 调用后端」。于是 flow <cmd> --json 的输出就是
// 前后端之间**唯一的**接口。没有冻结的契约，每个前端平台都会各自揣摩字段，
// 结果就是「文档写 A、实现是 B」那类缺陷在 N 个平台上各复发一次。
//
// 本文件只做三件事，不读写台账、不依赖任何第三方库：
//   1. 冻结**信封**：{schemaVersion, ok, data|error, warnings}；
//   2. 登记**每条命令 data 的形状**（records 复用，命令只登记顶层的组合）；
//   3. 提供一个**极小校验器**，让契约测试能对真实 CLI 输出做严格校验
//      （未登记字段即失败 —— 这是「字段增删必须同步改测试」的机械保证）。
//
// 谁在用
// ------
//   - bin/flow.mjs：经 lib/cli/shared.mjs 的 emitJson 统一补 schemaVersion；
//   - test/cli-json-contract.test.mjs：逐命令跑真实 CLI 并校验形状；
//   - 前端（dsh-web / dsh-tui / 其他平台适配层）：可直接 import 本文件拿
//     contractDocument() 的机器可读描述，或用 validateInvocation 做自检。
//
// 兼容性纪律
// ----------
//   - --json 只服务机器，形状**永不**为了好看而改；人类输出随便美化。
//   - 增字段 = 兼容（旧前端忽略未知字段），但**必须**同步这里 + docs/cli-contract.md，
//     否则契约测试红。
//   - 删字段 / 改名 / 改类型 = 破坏性变更，必须提 CLI_CONTRACT_VERSION。
//   - schema:1 的历史记录（experiment / task）只读，前端必须先看记录自己的
//     schema 字段再按对应形状解读；本文件的记录形状描述 schema 2 / 现行记录。

/** --json 信封与 data 形状的契约版本。破坏性变更必须 +1。 */
export const CLI_CONTRACT_VERSION = 1

/** 通用退出码（CONTRACT §5.2）。键是退出码，值是含义。 */
export const CLI_EXIT_CODES = Object.freeze({
  0: '成功（gate run 的门禁失败也算命令成功，用 data.ok 表达）',
  1: '用法错误（未知命令/参数、缺必填参数、未初始化、rm 缺 --yes、check-failed）',
  2: '校验失败（invalid / conflict）',
  3: '未找到（not-found / terminal）',
  4: 'IO 或环境错误',
})

/** flow check 族的退出码（同一组数字，语义按检查归一，CONTRACT §6.2）。 */
export const CHECK_EXIT_CODES = Object.freeze({
  0: '检查通过',
  1: '检查失败（check-failed）',
  2: '用法或配置错误',
  3: '脚本/解释器缺失（check-missing）或未找到',
  4: '启动/IO 失败（含超时）',
})

/** error.code -> 退出码（bin/flow.mjs 的 EXIT_BY_CODE 的契约投影）。 */
export const EXIT_CODE_BY_ERROR_CODE = Object.freeze({
  usage: 1,
  invalid: 2,
  conflict: 2,
  'not-found': 3,
  io: 4,
  'check-failed': 1,
  terminal: 3,
})

/** flow check 族的 error.code -> 退出码（覆盖上面的 usage/check-failed 等）。 */
export const CHECK_EXIT_CODE_BY_ERROR_CODE = Object.freeze({
  usage: 2,
  'check-failed': 1,
  'check-missing': 3,
  'check-io': 4,
  'not-found': 3,
  io: 4,
})

// ---------------------------------------------------------------- 形状 DSL
//
// 形状是**纯数据**（可 JSON.stringify），所以 contractDocument() 能直接序列化
// 给非 JS 的前端平台。kind 的取值：
//   any | string | number | integer | boolean | null | array | object | ref | union
// 额外键：
//   enum      值必须落在给定字面量里（string/number 用）
//   nullable  === true 时允许 null（等价 union(shape, null) 的简写）
//   required  必填字段名（object）
//   open      === true 时允许未登记字段（object）；只用于 core 自有载荷
//   fields    字段名 -> 形状（object）
//   items     元素形状（array）
//   name      记录形状名（ref）
//   of        分支（union）
//   note      人类可读说明（校验器忽略）

const ANY = Object.freeze({ kind: 'any', note: '契约明确允许任意 JSON（逃生口，需登记）' })

function str(options = {}) {
  return { kind: 'string', ...options }
}
function int(options = {}) {
  return { kind: 'integer', ...options }
}
function bool(options = {}) {
  return { kind: 'boolean', ...options }
}
function arr(items, options = {}) {
  return { kind: 'array', items, ...options }
}
/**
 * 对象形状。字段默认必填；options.optional 列出可选字段；
 * options.open === true 时允许未登记字段（只给 core 自有载荷用，并在 note 里写明）。
 */
function obj(fields, options = {}) {
  const optional = Array.isArray(options.optional) ? options.optional : []
  // 显式 required 优先（组合形状时用：把记录的可选字段继续留在可选里）；
  // 否则默认「除了 optional 列表里的都必填」。
  const required = Array.isArray(options.required)
    ? options.required
    : Object.keys(fields).filter((name) => optional.includes(name) === false)
  const shape = { kind: 'object', fields, required }
  if (options.open === true) shape.open = true
  if (typeof options.note === 'string') shape.note = options.note
  return shape
}
function ref(name) {
  return { kind: 'ref', name }
}
function union(...of) {
  return { kind: 'union', of }
}
function maybe(shape) {
  return { kind: 'union', of: [shape, { kind: 'null' }] }
}
function enumOf(values, options = {}) {
  const kind = values.every((value) => Number.isInteger(value)) ? 'integer' : 'string'
  return { kind, enum: values, ...options }
}
function strArr(options = {}) {
  return arr(str(), options)
}

const TASK_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci']
const TASK_STATUS = ['draft', 'active', 'done', 'archived']
const STAGES = [
  'created',
  'queued-analysis',
  'analyzing',
  'queued-implementation',
  'implementing',
  'queued-review',
  'reviewing',
  'done',
  'archived',
]
const EXPERIMENT_STATUS = ['open', 'confirmed', 'refuted', 'abandoned', 'inconclusive', 'pivoted']
const HEARTBEAT_STATUS = ['working', 'idle', 'waiting', 'done', 'missed']
const LIVENESS = ['live', 'stale', 'dead', 'foreign', 'unknown']
const DECISION_STATUS = ['open', 'answered', 'withdrawn', 'superseded']
const DECISION_KIND = ['choice', 'approval', 'input']
const GATE_PHASE = ['commit', 'release', 'manual']

/** 九个阶段各一个计数（status block 与 heartbeat 的 counts）。 */
const STAGE_COUNTS = (() => {
  const fields = {}
  for (const stage of STAGES) fields[stage] = int()
  return obj(fields)
})()

// ---------------------------------------------------------------- 记录形状

/** 实验记录（schema 2，CONTRACT §3.1）。schema:1 只读遗留记录不按此形状解读。 */
const EXPERIMENT = obj({
  schema: int(),
  id: str(),
  title: str(),
  hypothesis: str(),
  direction: str(),
  expected: str(),
  primaryMetric: str(),
  falsify: str(),
  stopLoss: str(),
  guardrails: strArr(),
  windowDays: int(),
  factor: str(),
  parent: maybe(str()),
  scale: str(),
  status: enumOf(EXPERIMENT_STATUS),
  measured: str(),
  metrics: obj({}, { open: true, note: '自由指标表：键名由实验决定' }),
  commits: strArr(),
  notes: str(),
  learned: str(),
  cleanup: obj({ flags: strArr(), code: strArr(), data: strArr() }),
  cleanupAt: maybe(str()),
  productizedAt: maybe(str()),
  productizeGate: maybe(obj({ id: str(), runAt: str(), log: str() })),
  created_at: str(),
  updated_at: str(),
})

/** 任务记录（CONTRACT §3.2）。type/stage 可为缺省（legacy 记录与刚创建的 draft）。 */
const TASK = obj(
  {
    schema: int(),
    id: str(),
    title: str(),
    type: maybe(enumOf(TASK_TYPES)),
    stage: maybe(enumOf(STAGES)),
    status: enumOf(TASK_STATUS),
    parent: maybe(str()),
    owner: str(),
    scope: obj({ allow: strArr(), deny: strArr() }),
    acceptance: arr(union(str(), obj({}, { open: true, note: 'legacy 验收条目：形状自由' }))),
    checkpoints: arr(ANY),
    commits: strArr(),
    notes: str(),
    created_at: str(),
    updated_at: str(),
    done_at: maybe(str()),
    archived_at: maybe(str()),
    experiment: maybe(str()),
    team: maybe(
      obj({
        taskId: str(),
        revision: int(),
        owner: maybe(str()),
        syncedAt: str(),
      }),
    ),
    source: maybe(
      obj({ kind: str(), key: maybe(str()), at: str() }, { open: true, note: '捕获来源：core 可追加键' }),
    ),
    veto: maybe(obj({ by: str(), reason: str(), at: str() })),
    decision: maybe(str()),
    verification: maybe(
      obj({
        ok: bool(),
        at: str(),
        stage: maybe(enumOf(STAGES)),
        signature: str(),
        steps: arr(
          obj(
            {
              index: int(),
              kind: enumOf(['cmd', 'gate']),
              target: str(),
              ok: bool(),
              exit: maybe(int()),
              durationMs: int(),
              tail: str(),
            },
            { optional: ['tail'], note: 'tail 只在有子进程输出时出现（只保留尾部）' },
          ),
        ),
      }),
    ),
  },
  {
    optional: [
      'type',
      'stage',
      'done_at',
      'archived_at',
      'experiment',
      'team',
      'source',
      'veto',
      'decision',
      'verification',
    ],
  },
)

/** 门禁步骤定义（CONTRACT §3.3）。 */
const GATE_STEP = obj(
  { id: str(), run: str(), expect: str(), timeoutSeconds: int(), kind: maybe(enumOf(['structure', 'behavior'])) },
  { optional: ['kind'], note: 'kind 是步骤级分类覆盖；缺省跟随门禁自身的 kind' },
)

/** 一次门禁运行记录（CONTRACT §3.4）。tail 是子进程输出尾部，无输出时为空串。 */
const GATE_SEGMENT = obj({
  kind: enumOf(['structure', 'behavior']),
  total: int(),
  passed: int(),
  failed: int(),
  ok: bool(),
  steps: strArr(),
})

const GATE_RUN = obj(
  {
    gate: str(),
    title: str(),
    kind: maybe(enumOf(['structure', 'behavior'])),
    mount: maybe(obj({ level: enumOf(['layer', 'module', 'feature', 'aspect']), target: str() }, { optional: ['target'] })),
    failFast: maybe(bool()),
    started_at: str(),
    finished_at: str(),
    durationMs: int(),
    ok: bool(),
    segments: obj({ structure: GATE_SEGMENT, behavior: GATE_SEGMENT }),
    steps: arr(
      obj(
        {
          id: str(),
          run: str(),
          expect: str(),
          kind: maybe(enumOf(['structure', 'behavior'])),
          exit: maybe(int()),
          ok: bool(),
          durationMs: int(),
          tail: str(),
        },
        {
          optional: ['tail', 'kind'],
          note: 'readStoreState 的 summarizeRun 省略 tail/kind；CLI 直接读运行记录时带上',
        },
      ),
    ),
  },
  { optional: ['kind', 'mount', 'failFast', 'segments'] },
)

/** 门禁定义（CONTRACT §3.3）。lastRun 只在 gate list 的行里出现。 */
const GATE = obj(
  {
    schema: int(),
    id: str(),
    title: str(),
    phase: enumOf(GATE_PHASE),
    enabled: bool(),
    steps: arr(ref('gateStep')),
    created_at: str(),
    updated_at: str(),
    allowUnknownExpect: bool(),
    kind: maybe(enumOf(['structure', 'behavior'])),
    mount: maybe(obj({ level: enumOf(['layer', 'module', 'feature', 'aspect']), target: str() }, { optional: ['target'] })),
    failFast: maybe(bool()),
    lastRun: maybe(ref('gateRun')),
  },
  { optional: ['allowUnknownExpect', 'kind', 'mount', 'failFast', 'lastRun'] },
)

/** 心跳记录（CONTRACT §3.5）。 */
const HEARTBEAT = obj(
  {
    schema: int(),
    session: str(),
    agent: str(),
    goal: str(),
    title: str(),
    task: maybe(str()),
    claims: strArr(),
    status: enumOf(HEARTBEAT_STATUS),
    turn: int(),
    last_action: str(),
    started_at: str(),
    updated_at: str(),
    ended_at: maybe(str()),
    host: str(),
    // 判活证据（T-20261112202457）：宿主写入 host/boot_id/pid/pid_start；
    // CLI 只保住已有证据、不覆盖（一次性进程不能把活会话写成死的）。
    boot_id: maybe(str()),
    pid: maybe(int()),
    pid_start: maybe(int()),
    branch: maybe(str()),
    worktree: maybe(str()),
    stats: obj({ turns: int(), missed: int() }),
  },
  { optional: ['title', 'boot_id', 'pid', 'pid_start', 'branch', 'worktree'], note: 'title 只在 list 行里出现；证据字段与 branch 只在有值时出现' },
)

/** heartbeat list 的一行：心跳记录 + 判活/文件元信息。 */
const HEARTBEAT_ITEM = obj({
  file: str(),
  session: str(),
  agent: str(),
  legacy: bool(),
  hidden: bool(),
  goal: str(),
  title: str(),
  task: maybe(str()),
  claims: strArr(),
  status: enumOf(HEARTBEAT_STATUS),
  last_action: str(),
  started_at: maybe(str()),
  updated_at: maybe(str()),
  ended_at: maybe(str()),
  ageSeconds: maybe(int()),
  stale: bool(),
  turn: maybe(int()),
  stats: maybe(obj({ turns: int(), missed: int() })),
  mtime: int(),
  liveness: enumOf(LIVENESS),
  reason: str(),
  livenessEvidence: maybe(str()),
  leaseExpiresAt: maybe(str()),
  branch: maybe(str()),
  worktree: maybe(str()),
  pid: maybe(int()),
  taskStage: maybe(enumOf(STAGES)),
  taskStageZh: maybe(str()),
}, { optional: ['branch', 'worktree', 'pid'], note: 'branch/worktree 只在有值时出现；pid 旧记录为 null' })

/** 决策记录（CONTRACT §3.6）。 */
const DECISION = obj({
  schema: int(),
  id: str(),
  question: str(),
  kind: enumOf(DECISION_KIND),
  rationale: str(),
  options: arr(obj({ id: str(), label: str(), impact: str() })),
  recommendation: maybe(str()),
  default: maybe(str()),
  status: enumOf(DECISION_STATUS),
  blocks: strArr(),
  affects: strArr(),
  supersedes: maybe(str()),
  answer: maybe(obj({ choice: str(), note: str(), at: str(), by: str() })),
  answered_at: maybe(str()),
  withdraw: maybe(obj({ reason: str(), at: str(), by: str() })),
  superseded_by: maybe(str()),
  fingerprint: str(),
  asked_at: str(),
  created_at: str(),
  updated_at: str(),
  asked_session: maybe(str()),
  asked_turn: maybe(int()),
})

/** heartbeat start/update 与 flow status 共用的项目状态块。 */
const STATUS_BLOCK = obj({
  stack: arr(
    obj({ id: str(), type: maybe(enumOf(TASK_TYPES)), stage: str(), stageZh: str(), title: str(), created_at: str() }),
  ),
  counts: STAGE_COUNTS,
  team: obj({ available: bool(), members: int(), tasks: int(), linked: int(), missing: int(), orphaned: int() }),
  capture: maybe(obj({}, { open: true, note: '捕获诊断摘要；无捕获服务时为 null' })),
  unfinished: int(),
  recentCaptured: arr(obj({ id: str(), title: str(), at: str(), stage: str(), stageZh: str() })),
})

/** 记录形状表：供 ref 与 contractDocument() 解析。 */
export const RECORD_SHAPES = Object.freeze({
  experiment: EXPERIMENT,
  task: TASK,
  gate: GATE,
  gateStep: GATE_STEP,
  gateRun: GATE_RUN,
  heartbeat: HEARTBEAT,
  heartbeatItem: HEARTBEAT_ITEM,
  decision: DECISION,
  statusBlock: STATUS_BLOCK,
})

// ---------------------------------------------------------------- 命令 data 形状
//
// 键：单命令用命令名（init / status / ...），带子命令用 command.action。
// 这与 test/t-20261030-15-flag-spec.test.mjs 从 bin 源码解析出的 SPEC 一一对应。

const RUN_OUTPUT = obj({ check: str(), exitCode: maybe(int()), stdout: str(), stderr: str(), durationMs: int() })

const STATUS_DATA = obj(
  {
    root: str(),
    name: str(),
    initialized: bool(),
    contractSource: str(),
    schema: int(),
    store: str(),
    counts: obj({
      experiments: obj({
        total: int(),
        open: int(),
        confirmed: int(),
        refuted: int(),
        abandoned: int(),
        inconclusive: int(),
        pivoted: int(),
        unreadable: int(),
      }),
      tasks: obj({ total: int(), draft: int(), active: int(), done: int(), archived: int(), unreadable: int() }),
      gates: obj({ total: int(), enabled: int(), unreadable: int() }),
      description: obj({ files: int(), modules: int(), missingSemantics: int(), plans: int(), described: int() }),
    }),
    heartbeats: obj({
      root: str(),
      dir: str(),
      items: arr(ref('heartbeatItem')),
      counts: obj({ total: int(), active: int(), stale: int(), dead: int(), hidden: int() }),
      hiddenByVisibility: int(),
      livenessEvidence: maybe(str()),
      leaseSeconds: maybe(int()),
    }),
    // 未完成 saga intent（T-20261112183138-02 · concurrency 线）：多步写崩溃后的在途线索。
    // 读不到时整段省略（进 warnings），所以是可选字段。
    intents: obj(
      {
        open: int(),
        items: arr(
          obj({
            id: str(),
            kind: str(),
            target: obj({}, { open: true, note: 'intent 目标（core 自有载荷，如 {task: id}）' }),
            steps: strArr(),
            done: strArr(),
            missing: strArr(),
            updated_at: maybe(str()),
          }),
        ),
      },
      { note: 'open 是全部 open intent 数；items 只放前 10 条（按 updated_at 倒序）' },
    ),
    decisions: obj({
      items: arr(
        obj(
          {
            id: str(),
            question: str(),
            kind: enumOf(DECISION_KIND),
            status: enumOf(DECISION_STATUS),
            recommendation: maybe(str()),
            default: maybe(str()),
            blocks: strArr(),
            affects: strArr(),
            asked_at: str(),
            escalated: bool(),
            turnAge: maybe(int()),
            ageSeconds: int(),
          },
          { open: true, note: '决策投影：在记录字段之外追加判活字段' },
        ),
      ),
      counts: obj({
        open: int(),
        blocking: int(),
        escalated: int(),
        answered: int(),
        withdrawn: int(),
        superseded: int(),
        total: int(),
      }),
    }),
    recent: obj({
      experiments: arr(ref('experiment')),
      tasks: arr(ref('task')),
      gateRuns: arr(ref('gateRun')),
    }),
    status: ref('statusBlock'),
  },
  { optional: ['status'], note: 'status 块只在项目已初始化时出现' },
)

const TASK_NEXT = obj({
  id: str(),
  title: str(),
  stage: str(),
  stageZh: str(),
  owner: str(),
  terminal: bool(),
  actor: str(),
  next: maybe(
    obj({
      stage: str(),
      stageZh: str(),
      actor: str(),
      back: bool(),
      action: str(),
      verify: maybe(str()),
      command: str(),
    }),
  ),
  alternatives: arr(
    obj(
      { stage: str(), stageZh: str(), actor: str(), back: bool(), action: str(), verify: maybe(str()), command: str() },
      { optional: ['verify'] },
    ),
  ),
  acceptance: obj({
    executable: int(),
    cmd: int(),
    gate: int(),
    passed: bool(),
    verified: bool(),
    fresh: bool(),
    at: maybe(str()),
    verifyCommand: maybe(str()),
  }),
})

const ACCEPTANCE_STEP = obj(
  {
    index: int(),
    kind: enumOf(['cmd', 'gate']),
    target: str(),
    ok: bool(),
    exit: maybe(int()),
    durationMs: int(),
    tail: str(),
    repair: str(),
    error: obj({ code: str(), message: str() }, { optional: [], open: false }),
  },
  {
    optional: ['error'],
    note: 'gate 步骤跑不起来（门禁缺失/被禁用）时带 error；tail 恒在（通过时为空串）',
  },
)

const TASK_VERIFY = obj(
  {
    id: str(),
    ok: bool(),
    executed: int(),
    passed: int(),
    failed: strArr(),
    steps: arr(ACCEPTANCE_STEP),
    verification: maybe(TASK.fields.verification),
    // 只有「没有可执行验收项」时才出现 skipped（静默成功比失败更危险，所以显式标记）。
    skipped: str(),
    // 执行路径的修复提示：全部通过时为 null。
    repair: maybe(str()),
  },
  { optional: ['skipped', 'repair'], note: '两种形状：没有可执行条目（skipped）与真的跑了验收（repair/verification）' },
)

const TASK_NORMALIZE = obj({
  fix: bool(),
  dryRun: bool(),
  ok: bool(),
  issues: arr(ANY),
  fixed: strArr(),
  counts: obj({ 'legacy-goal': int(), 'missing-type': int() }),
  remaining: maybe(obj({ 'legacy-goal': int(), 'missing-type': int() })),
  longTitles: arr(ANY),
  typeMap: maybe(str()),
})

const CHECK_LIST = obj({
  checks: arr(obj({ name: str(), interpreter: str(), script: str(), description: str(), args: str() })),
})

const CHECK_DECISIONS = obj({
  check: str(),
  exitCode: int(),
  stdout: str(),
  stderr: str(),
  durationMs: int(),
  open: int(),
  blocking: int(),
  failed: arr(obj({ id: str(), question: str(), blocks: strArr(), affects: strArr(), matched: strArr() })),
})

const CHECK_EXPERIMENTS = obj({
  check: str(),
  exitCode: int(),
  stdout: str(),
  stderr: str(),
  durationMs: int(),
  enabled: bool(),
  checked: int(),
  legacy: int(),
  failed: arr(obj({ id: str(), rule: str(), message: str() })),
  warnings: arr(obj({ id: str(), rule: str(), message: str() }, { open: true })),
})

const CHECK_TASKS = obj({
  check: str(),
  exitCode: int(),
  stdout: str(),
  stderr: str(),
  durationMs: int(),
  ok: bool(),
  counts: obj({ 'legacy-goal': int(), 'missing-type': int() }),
  issues: arr(
    obj({
      id: str(),
      kind: enumOf(['legacy-goal', 'missing-type']),
      title: maybe(str()),
      goal: maybe(str()),
      suggestion: str(),
    }),
  ),
  typeMap: maybe(str()),
})

const CHECK_DESCRIPTION = obj({
  check: str(),
  exitCode: int(),
  stdout: str(),
  stderr: str(),
  durationMs: int(),
  mode: str(),
  counts: obj({
    files: int(),
    modules: int(),
    missingSemantics: int(),
    plans: int(),
    described: int(),
    failed: int(),
    warnings: int(),
  }),
  failed: arr(
    obj(
      { kind: str(), path: str(), detail: str(), hint: str(), level: str(), module: str() },
      { optional: ['module'] },
    ),
  ),
  warnings: arr(obj({ kind: str(), path: str(), detail: str(), hint: str(), level: str() }, { open: true })),
})

const DESC_STATUS = obj({
  established: bool(),
  name: maybe(str()),
  semantics: str(),
  files: int(),
  modules: int(),
  missingSemantics: int(),
  plans: int(),
  described: int(),
  enabled: bool(),
  enforce: str(),
})

const DESC_BUILD = obj({ created: int(), updated: int(), unchanged: int(), pruned: int(), warnings: strArr() })

const DESC_SHOW = union(
  obj({ counts: obj({ files: int(), modules: int() }), files: arr(obj({ path: str(), modules: int() })) }),
  obj({ path: str(), record: maybe(obj({}, { open: true, note: '描述文件记录（CONTRACT §3.7）' })) }),
  obj({ graph: maybe(str()) }),
)

const DESC_SET = union(
  obj({
    schema: int(),
    name: str(),
    semantics: str(),
    revision: str(),
    generated_at: str(),
    updated_at: str(),
    counts: obj({ files: int(), modules: int(), described: int(), missingSemantics: int() }),
  }),
  obj(
    { records: arr(obj({}, { open: true })), changed: bool() },
    { open: true, note: '描述文件补丁回执：records 是写入后的文件记录' },
  ),
)

const DESC_PLAN = union(
  obj(
    { plan: maybe(obj({}, { open: true, note: '描述计划记录（CONTRACT §3.7，core 自有载荷）' })), amended: bool() },
    { open: true, note: '计划提交/查询/--rebase 回执（--rebase 追加 rebased/note）' },
  ),
  obj(
    { files: arr(obj({}, { open: true })) },
    { open: true, note: '--template 打印的计划骨架（只打印，不写盘）' },
  ),
)

const DESC_APPLY = obj({ plan: obj({}, { open: true }), applied: bool(), warnings: strArr() })

const DESC_RENDER = union(
  obj({ checked: maybe(bool()), markdown: str() }),
  obj({ checked: maybe(bool()), path: str(), bytes: int() }),
)

/** 每条命令的 --json data 形状。键与 bin 的 SPEC 一一对应。 */
export const DATA_SHAPES = Object.freeze({
  init: obj({ root: str(), created: strArr(), warnings: strArr(), seededGates: strArr() }, { optional: ['seededGates'] }),
  status: STATUS_DATA,
  // 面板状态快照（T-20261112154725）：前端唯一允许读的台账面，载荷由
  // lib/state-snapshot.mjs 的只读投影产出，属于 core 自有载荷（开放对象）。
  state: obj(
    { ok: bool(), generatedAt: str(), root: str(), roots: arr(obj({ path: str(), name: str() })), error: maybe(obj({ code: str(), message: str() }, { open: true })) },
    { optional: ['error'], open: true, note: '面板快照载荷：顶层四键由契约保证，其余节（contract/experiments/tasks/gates/heartbeats/decisions/description/head）是 core 投影' },
  ),
  backup: obj({ name: str(), path: str(), files: int(), bytes: int(), pruned: strArr() }),
  doctor: obj({
    ok: bool(),
    root: str(),
    findings: arr(obj({ id: str(), level: str(), message: str(), hint: str() }, { optional: ['hint'] })),
  }),

  'exp.list': arr(ref('experiment')),
  'exp.show': ref('experiment'),
  'exp.tree': arr(
    obj(Object.assign({}, EXPERIMENT.fields, { children: arr(ANY) }), {
      required: EXPERIMENT.required.concat(['children']),
      note: '实验记录 + children 子树（递归同构，元素按实验记录解读）',
    }),
  ),
  'exp.add': ref('experiment'),
  'exp.update': ref('experiment'),
  'exp.review': obj({
    id: str(),
    verdict: enumOf(['complete', 'incomplete']),
    branch: enumOf(['success', 'uncertain', 'failure', 'pivot']),
    missing: strArr(),
  }),
  'exp.productize': obj(
    { id: str(), already: bool() },
    { open: true, note: '产品化回执：首调写 productizeGate，重复调用 already:true' },
  ),
  'exp.cleanup': obj({
    id: str(),
    cleanup: obj({ flags: strArr(), code: strArr(), data: strArr() }),
    cleanupAt: str(),
    changed: bool(),
  }),
  'exp.rm': obj({ id: str(), removed: bool() }),

  'task.list': arr(ref('task')),
  'task.show': ref('task'),
  'task.add': ref('task'),
  'task.update': ref('task'),
  'task.link': ref('task'),
  'task.unlink': ref('task'),
  'task.archive': obj(
    { archived: strArr(), candidates: int(), days: int(), cutoff: str(), dryRun: bool(), locked: bool() },
    { optional: ['closed'] },
  ),
  'task.sweep': obj({
    olderThanHours: int(),
    scanned: int(),
    closed: arr(ref('task')),
    skipped: obj({}, { open: true, note: '按跳过原因计数（如 not-utterance）' }),
    dryRun: bool(),
    locked: bool(),
  }),
  'task.normalize': TASK_NORMALIZE,
  'task.next': TASK_NEXT,
  'task.verify': TASK_VERIFY,
  'task.rm': obj({ id: str(), removed: bool() }),

  'gate.list': arr(ref('gate')),
  'gate.show': ref('gate'),
  'gate.add': ref('gate'),
  'gate.update': ref('gate'),
  'gate.enable': ref('gate'),
  'gate.disable': ref('gate'),
  'gate.rm': obj({ id: str(), removed: bool() }),
  'gate.rules': union(
    obj({ files: strArr(), baselineAt: str() }, { open: true, note: '--init：建立基线' }),
    obj({ ok: bool(), baselineAt: str() }, { open: true, note: '默认模式：校验通过（watched 为监视对象清单）' }),
    obj({ changed: bool() }, { open: true, note: '--record：留痕并推进基线（changed=false 时无 entry）' }),
  ),
  'gate.run': union(
    ref('gateRun'),
    obj({
      phase: str(),
      runs: arr(ref('gateRun')),
      skipped: strArr(),
      segments: obj({
        structure: obj({ gates: int(), failed: strArr(), ok: bool() }),
        behavior: obj({ gates: int(), failed: strArr(), ok: bool() }),
      }),
    }),
  ),
  'gate.logs': arr(ref('gateRun')),

  'heartbeat.start': obj(Object.assign({}, HEARTBEAT.fields, STATUS_BLOCK.fields, { createdTask: maybe(str()) }), {
    required: HEARTBEAT.required.concat(STATUS_BLOCK.required),
    optional: ['title', 'createdTask'],
    note: '心跳记录 + 项目状态块（stack/counts/team/capture/unfinished/recentCaptured）；createdTask 只在自动建卡时出现',
  }),
  'heartbeat.update': obj(Object.assign({}, HEARTBEAT.fields, STATUS_BLOCK.fields), {
    required: HEARTBEAT.required.concat(STATUS_BLOCK.required),
    optional: ['title'],
    note: '心跳记录 + 项目状态块',
  }),
  'heartbeat.end': ref('heartbeat'),
  'heartbeat.list': obj({
    root: str(),
    dir: str(),
    items: arr(ref('heartbeatItem')),
    counts: obj({ total: int(), active: int(), stale: int(), dead: int(), hidden: int() }),
    hiddenByVisibility: int(),
    livenessEvidence: maybe(str()),
    leaseSeconds: maybe(int()),
  }),
  'heartbeat.status': obj({
    active: bool(),
    liveness: enumOf(LIVENESS),
    reason: str(),
    ageSeconds: maybe(int()),
    livenessEvidence: maybe(str()),
    leaseExpiresAt: maybe(str()),
    record: maybe(ref('heartbeat')),
    taskStage: maybe(enumOf(STAGES)),
    taskStageZh: maybe(str()),
  }),
  'heartbeat.rm': obj({ session: str(), removed: bool() }),
  'heartbeat.gc': obj({
    root: str(),
    dir: str(),
    removed: strArr(),
    kept: int(),
    dryRun: bool(),
    olderThanHours: maybe(int()),
  }),

  'decision.ask': obj({ decision: ref('decision'), created: bool() }),
  'decision.list': obj({
    items: arr(
      obj(Object.assign({}, DECISION.fields, { escalated: bool(), turnAge: maybe(int()), ageSeconds: int() }), {
        required: Object.keys(DECISION.fields).concat(['escalated', 'turnAge', 'ageSeconds']),
        note: '决策记录 + 判活投影三字段',
      }),
    ),
    counts: obj({
      open: int(),
      blocking: int(),
      escalated: int(),
      answered: int(),
      withdrawn: int(),
      superseded: int(),
      total: int(),
    }),
  }),
  'decision.show': ref('decision'),
  'decision.answer': obj(Object.assign({}, DECISION.fields, { vetoApplied: bool(), vetoWarning: str() }), {
    required: Object.keys(DECISION.fields),
    optional: ['vetoApplied', 'vetoWarning'],
    note: '决策记录；答复触发否决时追加 vetoApplied/vetoWarning',
  }),
  'decision.withdraw': ref('decision'),
  'decision.gc': obj({ removed: strArr(), kept: int(), dryRun: bool() }),

  'desc.status': DESC_STATUS,
  'desc.build': DESC_BUILD,
  'desc.show': DESC_SHOW,
  'desc.set': DESC_SET,
  'desc.plan': DESC_PLAN,
  'desc.apply': DESC_APPLY,
  'desc.render': DESC_RENDER,

  'check.list': CHECK_LIST,
  'check.staged': RUN_OUTPUT,
  'check.release-baseline': RUN_OUTPUT,
  'check.state': RUN_OUTPUT,
  'check.doc': RUN_OUTPUT,
  'check.decisions': CHECK_DECISIONS,
  'check.experiments': CHECK_EXPERIMENTS,
  'check.tasks': CHECK_TASKS,
  'check.description': CHECK_DESCRIPTION,
})

/** 信封里成功/失败两支的字段集（契约文档与前端判据）。 */
export const ENVELOPE_SHAPE = Object.freeze({
  success: ['schemaVersion', 'ok', 'data', 'warnings'],
  failure: ['schemaVersion', 'ok', 'error', 'warnings'],
})

// ---------------------------------------------------------------- 校验器

const INSERTION_HINT = '（新增/改名/删除字段必须同步 lib/cli/contract.mjs 与 docs/cli-contract.md）'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function describeShape(shape) {
  if (shape === null || typeof shape !== 'object') return '（未登记的坏形状）'
  switch (shape.kind) {
    case 'any':
      return 'any'
    case 'ref':
      return 'record:' + String(shape.name)
    case 'array':
      return 'array'
    case 'union':
      return 'union'
    case 'null':
      return 'null'
    default:
      return shape.kind
  }
}

/**
 * 校验一个值是否符合登记的形状。
 *
 * 错误消息以「路径：」开头，前端/测试可直接定位。空数组 = 通过。
 *
 * @returns {string[]}
 */
export function validateShape(shape, value, path = '$', options = {}) {
  const ctx = options !== null && typeof options === 'object' ? options : {}
  const errors = []
  if (shape === null || typeof shape !== 'object') return [path + '：契约里的形状缺失或不是对象']
  if (shape.nullable === true && value === null) return errors
  switch (shape.kind) {
    case 'any':
      return errors
    case 'ref': {
      const target = RECORD_SHAPES[shape.name]
      if (target === undefined) return [path + '：契约引用了未登记的记录形状 ' + String(shape.name)]
      const seen = ctx.seen instanceof Set ? ctx.seen : new Set()
      if (seen.has(shape.name)) return [path + '：记录形状 ' + shape.name + ' 递归引用自己（契约缺陷）']
      const nextSeen = new Set(seen)
      nextSeen.add(shape.name)
      return validateShape(target, value, path, { ...ctx, seen: nextSeen })
    }
    case 'null':
      return value === null ? errors : [path + '：期望 null，实际 ' + typeName(value)]
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean': {
      const expected = shape.kind
      if (expected === 'string' && typeof value !== 'string') {
        return [path + '：期望 string，实际 ' + typeName(value)]
      }
      if (expected === 'number' && (typeof value !== 'number' || Number.isFinite(value) === false)) {
        return [path + '：期望有限 number，实际 ' + typeName(value)]
      }
      if (expected === 'integer' && Number.isInteger(value) === false) {
        return [path + '：期望 integer，实际 ' + typeName(value)]
      }
      if (expected === 'boolean' && typeof value !== 'boolean') {
        return [path + '：期望 boolean，实际 ' + typeName(value)]
      }
      if (Array.isArray(shape.enum) && shape.enum.includes(value) === false) {
        return [path + '：值 ' + JSON.stringify(value) + ' 不在枚举 ' + shape.enum.join('|') + ' 内']
      }
      return errors
    }
    case 'array': {
      if (Array.isArray(value) === false) return [path + '：期望 array，实际 ' + typeName(value)]
      value.forEach((item, index) => {
        errors.push(...validateShape(shape.items, item, path + '[' + index + ']', ctx))
      })
      return errors
    }
    case 'object': {
      if (isPlainObject(value) === false) return [path + '：期望 object，实际 ' + typeName(value)]
      const fields = isPlainObject(shape.fields) ? shape.fields : {}
      const required = Array.isArray(shape.required) ? shape.required : Object.keys(fields)
      for (const name of required) {
        if (Object.hasOwn(value, name) === false) {
          errors.push(path + '.' + name + '：缺少必填字段（契约登记为 ' + describeShape(fields[name]) + '）')
        }
      }
      for (const [name, fieldShape] of Object.entries(fields)) {
        if (Object.hasOwn(value, name) === false) continue
        errors.push(...validateShape(fieldShape, value[name], path + '.' + name, ctx))
      }
      if (shape.open !== true) {
        for (const name of Object.keys(value)) {
          if (Object.hasOwn(fields, name)) continue
          errors.push(path + '.' + name + '：未登记字段' + INSERTION_HINT)
        }
      }
      return errors
    }
    case 'union': {
      const branches = Array.isArray(shape.of) ? shape.of : []
      if (branches.length === 0) return [path + '：union 没有任何分支（契约缺陷）']
      let best = null
      for (const branch of branches) {
        const branchErrors = validateShape(branch, value, path, ctx)
        if (branchErrors.length === 0) return errors
        if (best === null || branchErrors.length < best.length) best = branchErrors
      }
      return [
        path + '：不匹配任何已登记分支（共 ' + branches.length + ' 个）；最接近的分支错误：' + (best ?? []).join('；'),
      ]
    }
    default:
      return [path + '：未知的形状 kind ' + JSON.stringify(shape.kind)]
  }
}

/**
 * 校验 flow --json 信封（不含 data 的具体形状）。
 *
 * @returns {string[]} 错误消息；空数组 = 通过。
 */
export function validateEnvelope(value) {
  if (isPlainObject(value) === false) return ['$：信封期望 JSON 对象，实际 ' + typeName(value)]
  const errors = []
  for (const name of Object.keys(value)) {
    if (['schemaVersion', 'ok', 'data', 'error', 'warnings'].includes(name)) continue
    errors.push('$.' + name + '：信封顶层未登记字段' + INSERTION_HINT)
  }
  if (value.schemaVersion !== CLI_CONTRACT_VERSION) {
    errors.push(
      '$.schemaVersion：期望 ' +
        CLI_CONTRACT_VERSION +
        '，实际 ' +
        JSON.stringify(value.schemaVersion) +
        '（前端按此判断兼容性）',
    )
  }
  if (typeof value.ok !== 'boolean') {
    errors.push('$.ok：期望 boolean，实际 ' + typeName(value.ok))
    return errors
  }
  if (Array.isArray(value.warnings) === false) {
    errors.push('$.warnings：期望 array（可为空），实际 ' + typeName(value.warnings))
  } else {
    value.warnings.forEach((warning, index) => {
      if (typeof warning !== 'string') errors.push('$.warnings[' + index + ']：期望 string，实际 ' + typeName(warning))
    })
  }
  if (value.ok === true) {
    if (Object.hasOwn(value, 'data') === false) errors.push('$.data：成功信封必须带 data 字段（可以为 null）')
    if (Object.hasOwn(value, 'error')) errors.push('$.error：成功信封不得带 error')
  } else {
    if (Object.hasOwn(value, 'data')) errors.push('$.data：失败信封不得带 data')
    if (isPlainObject(value.error) === false) {
      errors.push('$.error：失败信封必须带 error 对象，实际 ' + typeName(value.error))
    } else {
      if (typeof value.error.code !== 'string' || value.error.code === '') {
        errors.push('$.error.code：期望非空 string，实际 ' + typeName(value.error.code))
      }
      if (typeof value.error.message !== 'string') {
        errors.push('$.error.message：期望 string，实际 ' + typeName(value.error.message))
      }
    }
  }
  return errors
}

/**
 * 校验一条命令的 data 形状。
 *
 * @param {string} key 形如 "status" / "task.next" / "check.tasks"
 * @param {unknown} data 已解析的 JSON data
 * @returns {string[]}
 */
export function validateCommandData(key, data) {
  if (typeof key !== 'string' || key === '') return ['命令键为空']
  const shape = DATA_SHAPES[key]
  if (shape === undefined) return ['命令 ' + key + '：契约未登记它的 data 形状' + INSERTION_HINT]
  return validateShape(shape, data, '$.data')
}

/** 信封 + data 一次校验完（契约测试用这个）。 */
export function validateInvocation(key, envelope) {
  const errors = validateEnvelope(envelope)
  if (errors.length > 0) return errors
  if (envelope.ok !== true) return errors
  return validateCommandData(key, envelope.data)
}

/** 已登记的命令键（升序）。前端/测试可据此确认覆盖。 */
export function commandKeys() {
  return Object.keys(DATA_SHAPES).sort()
}

/**
 * 机器可读的契约描述（可 JSON.stringify，供非 JS 前端平台消费）。
 *
 * @returns {object}
 */
export function contractDocument() {
  return {
    schemaVersion: CLI_CONTRACT_VERSION,
    surface: 'flow <command> --json（bin/flow.mjs 的 stdout，单行 JSON）',
    exitCodes: CLI_EXIT_CODES,
    checkExitCodes: CHECK_EXIT_CODES,
    errorCodeToExit: EXIT_CODE_BY_ERROR_CODE,
    checkErrorCodeToExit: CHECK_EXIT_CODE_BY_ERROR_CODE,
    envelope: {
      success: {
        shape: ENVELOPE_SHAPE.success,
        fields: {
          schemaVersion: { kind: 'integer', required: true, note: '契约版本，破坏性变更才 +1' },
          ok: { kind: 'boolean', required: true, note: '恒为 true' },
          data: { required: true, note: '命令各自的 data 形状（见 commands）' },
          warnings: { kind: 'array<string>', required: true, note: '恒为数组，可为空；--json 下不写 stderr' },
        },
      },
      failure: {
        shape: ENVELOPE_SHAPE.failure,
        fields: {
          schemaVersion: { kind: 'integer', required: true },
          ok: { kind: 'boolean', required: true, note: '恒为 false' },
          error: {
            kind: 'object',
            required: true,
            note: 'error.code 是机器判据（见 errorCodeToExit），error.message 是人类文案；check 族额外带 check/exitCode/stdout/stderr',
          },
          warnings: { kind: 'array<string>', required: true },
        },
      },
    },
    records: RECORD_SHAPES,
    commands: DATA_SHAPES,
  }
}

/**
 * 把 bin 传来的信封对象规范化成契约信封（补 schemaVersion、固定字段顺序）。
 * 只处理带布尔 ok 的对象；其它载荷原样返回（emitJson 仍是通用出口）。
 */
export function canonicalEnvelope(payload) {
  if (isPlainObject(payload) === false || typeof payload.ok !== 'boolean') return payload
  const { ok, data, error, warnings, ...rest } = payload
  const envelope = { schemaVersion: CLI_CONTRACT_VERSION, ok }
  if (ok === true) envelope.data = data
  else envelope.error = error
  envelope.warnings = Array.isArray(warnings) ? warnings : []
  return { ...envelope, ...rest }
}
