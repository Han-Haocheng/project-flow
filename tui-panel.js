// project-flow TUI side panel: pure view model + host registration.
//
// The panel is a read-only view of GET /api/project-flow/state. panelModel turns
// one payload into plain strings (testable without React); the registered
// component only lays those strings out through the host ui kit.

const GUIDE = 'r 刷新 · j/k 滚动 · 只读'
const HEADER = '项目流程 · project-flow'
const DEFAULT_REFRESH_MS = 3000
const MAX_ACTIVE_ROWS = 4
const MAX_DRAFT_ROWS = 3
const MAX_DONE_ROWS = 2
const MAX_EXP_ROWS = 3
const MAX_GATE_ROWS = 6
const MAX_BEAT_ROWS = 3
const MAX_DECISION_ROWS = 4
const MAX_WARNING_ROWS = 5

function isObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

function asObject(value) {
  return isObject(value) ? value : null
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function asNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** One display line, clipped to the panel width (CJK counted as one cell). */
function clip(value, width) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  const limit = Math.max(1, Math.floor(width))
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  if (limit === 1) return '…'
  return chars.slice(0, limit - 1).join('') + '…'
}

function row(text, tone = 'normal') {
  return { text, tone }
}

function section(title, rows) {
  return { title, rows }
}

/** Relative age of a gate run; short enough for a 28-column panel. */
function shortTime(value, now) {
  const stamp = typeof value === 'number' ? value : Date.parse(typeof value === 'string' ? value : '')
  if (Number.isFinite(stamp) === false) return ''
  const delta = Math.max(0, now - stamp)
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return Math.floor(delta / 60_000) + 'm 前'
  if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + 'h 前'
  const date = new Date(stamp)
  const pad = (value) => String(value).padStart(2, '0')
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function shortAgo(seconds) {
  if (typeof seconds !== 'number' || Number.isFinite(seconds) === false) return ''
  if (seconds < 60) return Math.max(0, Math.floor(seconds)) + 's'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm'
  return Math.floor(seconds / 3600) + 'h'
}

function dirtyText(head) {
  if (head.dirty === true) return '有改动'
  if (typeof head.dirty === 'number' && Number.isFinite(head.dirty)) {
    return head.dirty > 0 ? head.dirty + ' 处改动' : '干净'
  }
  return ''
}

function headMeta(head) {
  const value = asObject(head) || {}
  return [asText(value.branch), asText(value.sha).slice(0, 7), dirtyText(value)].filter(Boolean).join(' · ')
}

function taskTitle(task) {
  if (isObject(task) === false) return ''
  return asText(task.title) || asText(task.id)
}

function taskMark(task) {
  const gate = asText(task.gate)
  if (gate === 'pass') return ' ✓'
  if (gate === 'fail') return ' ×'
  return ''
}

function buildTaskRows(tasks) {
  const rows = []
  const current = tasks.current
  if (typeof current === 'string' && current !== '') {
    rows.push(row('当前 · ' + current, 'accent'))
  } else if (isObject(current)) {
    rows.push(row('当前 · ' + (asText(current.title) || asText(current.id) || '未命名'), 'accent'))
  }

  const active = asArray(tasks.active)
  const drafts = asArray(tasks.draft)
  const done = asArray(tasks.recentDone)

  for (const task of active.slice(0, MAX_ACTIVE_ROWS)) {
    const title = taskTitle(task)
    if (title !== '') rows.push(row('▶ ' + title + taskMark(task), 'accent'))
  }
  for (const task of drafts.slice(0, MAX_DRAFT_ROWS)) {
    const title = taskTitle(task)
    if (title !== '') rows.push(row('· ' + title, 'normal'))
  }
  for (const task of done.slice(0, MAX_DONE_ROWS)) {
    const title = taskTitle(task)
    if (title === '') continue
    /* The checkpoint mark replaces the glyph instead of repeating it. */
    const failed = asText(task.gate) === 'fail'
    rows.push(row((failed ? '× ' : '✓ ') + title, failed ? 'error' : 'success'))
  }

  const hiddenDrafts = drafts.length - MAX_DRAFT_ROWS
  if (hiddenDrafts > 0) rows.push(row('…另有 ' + hiddenDrafts + ' 条草稿', 'dim'))
  const hiddenDone = done.length - MAX_DONE_ROWS
  if (hiddenDone > 0) rows.push(row('…另有 ' + hiddenDone + ' 条已完成', 'dim'))

  if (rows.length === 0) {
    rows.push(row('还没有任务；运行 flow init 或 flow task add <标题>', 'dim'))
  }
  return rows
}

function experimentTone(status) {
  if (status === 'confirmed') return 'success'
  if (status === 'refuted') return 'error'
  if (status === 'abandoned') return 'dim'
  return 'accent'
}

function buildExperimentRows(experiments) {
  const items = asArray(experiments.items).filter(isObject)
  const total = asNumber(experiments.total, items.length)
  const shown = items.slice(0, MAX_EXP_ROWS)
  const rows = []
  for (const item of shown) {
    const title = asText(item.title) || asText(item.id)
    if (title === '') continue
    const status = asText(item.status)
    rows.push(row('· ' + title + (status === '' ? '' : '（' + status + '）'), experimentTone(status)))
  }
  if (rows.length === 0) {
    rows.push(row(total > 0 ? '共 ' + total + ' 条实验（负载未提供明细）' : '还没有实验记录 · flow exp add', 'dim'))
  } else if (total > rows.length) {
    rows.push(row('…另有 ' + (total - rows.length) + ' 条实验', 'dim'))
  }
  return rows
}

function buildGateRows(gates, now) {
  const list = asArray(gates).filter(isObject)
  if (list.length === 0) return [row('还没有门禁定义 · flow gate add', 'dim')]
  const rows = []
  for (const gate of list.slice(0, MAX_GATE_ROWS)) {
    const id = asText(gate.id)
    const title = asText(gate.title) || id
    if (title === '') continue
    const run = asObject(gate.lastRun)
    const enabled = gate.enabled !== false
    const mark = run ? (run.ok === true ? '✓' : '×') : '·'
    const when = run ? shortTime(run.started_at !== undefined ? run.started_at : run.startedMs, now) : ''
    const idPart = title !== id && id !== '' ? ' · ' + id : ''
    const tone = enabled === false ? 'dim' : run ? (run.ok === true ? 'success' : 'error') : 'dim'
    rows.push(row((enabled ? '' : '○ ') + mark + ' ' + title + idPart + (when === '' ? '' : ' ' + when), tone))
  }
  if (list.length > MAX_GATE_ROWS) rows.push(row('…另有 ' + (list.length - MAX_GATE_ROWS) + ' 个门禁', 'dim'))
  return rows
}

function buildHeartbeatRows(heartbeats) {
  const list = asArray(heartbeats).filter(isObject)
  const working = list.filter((beat) => asText(beat.status) === 'working')
  const rows = [
    row(list.length === 0 ? '没有心跳文件' : 'working ' + working.length + ' / 共 ' + list.length, working.length > 0 ? 'normal' : 'dim'),
  ]
  const ordered = working.concat(list.filter((beat) => asText(beat.status) !== 'working'))
  for (const beat of ordered.slice(0, MAX_BEAT_ROWS)) {
    const status = asText(beat.status)
    const goal = asText(beat.goal) || asText(beat.title) || asText(beat.statusLine) || asText(beat.session)
    if (goal === '') continue
    const age = shortAgo(beat.ageSeconds)
    const glyph = status === 'working' ? '▶' : status === 'done' ? '✓' : '·'
    const tone = beat.stale === true ? 'warning' : status === 'working' ? 'accent' : 'dim'
    rows.push(row(glyph + ' ' + goal + (age === '' ? '' : ' · ' + age), tone))
  }
  const hidden = list.length - Math.min(list.length, MAX_BEAT_ROWS)
  if (hidden > 0) rows.push(row('…另有 ' + hidden + ' 条心跳', 'dim'))
  return rows
}

function decisionTone(item) {
  if (item.escalated === true) return 'warning'
  if (asArray(item.blocks).length > 0) return 'warning'
  return 'normal'
}

function buildDecisionSection(decisions) {
  const counts = asObject(decisions.counts) || {}
  const open = asNumber(counts.open, 0)
  const blocking = asNumber(counts.blocking, 0)
  const items = asArray(decisions.items).filter(isObject)
  /* The web panel hides an idle decisions card entirely; keep the same rule. */
  if (open === 0 && items.length === 0) return null

  const rows = [row('待决策 ' + open + ' · 阻塞 ' + blocking, open > 0 ? 'warning' : 'dim')]
  for (const item of items.slice(0, MAX_DECISION_ROWS)) {
    const question = asText(item.question) || asText(item.kind) || asText(item.id) || '未命名决策'
    const id = asText(item.id)
    const mark = item.escalated === true ? '⚠ ' : ''
    const suffix = id === '' ? '' : '（' + id + '）'
    rows.push(row(mark + question + suffix, decisionTone(item)))
  }
  const hidden = Math.max(0, open - items.length)
  if (hidden > 0) rows.push(row('…另有 ' + hidden + ' 条待决策', 'dim'))
  return section('决策', rows)
}

function buildWarningSection(warnings) {
  const list = asArray(warnings).map((warning) => asText(warning)).filter(Boolean)
  if (list.length === 0) return null
  const rows = list.slice(0, MAX_WARNING_ROWS).map((warning) => row('⚠ ' + warning, 'warning'))
  if (list.length > MAX_WARNING_ROWS) {
    rows.push(row('…另有 ' + (list.length - MAX_WARNING_ROWS) + ' 条警告', 'dim'))
  }
  return section('警告', rows)
}

function readyModel(payload, now) {
  const contract = asObject(payload.contract) || {}
  const tasks = asObject(payload.tasks) || {}
  const experiments = asObject(payload.experiments) || {}
  const decisions = asObject(payload.decisions) || {}
  const counts = asObject(tasks.counts) || {}
  const decisionCounts = asObject(decisions.counts) || {}
  const gates = asArray(payload.gates)

  const counters = [
    '任务 ' + asNumber(tasks.total, 0)
      + '（草稿 ' + asNumber(counts.draft, 0)
      + ' / 进行 ' + asNumber(counts.active, 0)
      + ' / 完成 ' + asNumber(counts.done, 0) + '）',
    '实验 ' + asNumber(experiments.total, 0),
    '门禁 ' + gates.length,
  ]
  const openDecisions = asNumber(decisionCounts.open, 0)
  if (openDecisions > 0) counters.push('待决策 ' + openDecisions)

  const sections = [
    section('任务', buildTaskRows(tasks)),
    section('实验', buildExperimentRows(experiments)),
    section('门禁', buildGateRows(gates, now)),
    section('心跳', buildHeartbeatRows(payload.heartbeats)),
  ]
  const decisionSection = buildDecisionSection(decisions)
  if (decisionSection !== null) sections.push(decisionSection)
  const warningSection = buildWarningSection(payload.warnings)
  if (warningSection !== null) sections.push(warningSection)

  return {
    header: '项目流程 · ' + (asText(contract.name) || 'project-flow'),
    meta: headMeta(payload.head),
    counters,
    sections,
    footer: GUIDE,
  }
}

function uninitializedModel(root) {
  const where = asText(root) || '（当前工作区）'
  return {
    header: '项目流程 · 未初始化',
    meta: '',
    counters: [],
    sections: [],
    footer: '未初始化：' + where + '\n运行 flow init 初始化台账\n' + GUIDE,
  }
}

function errorModel(message) {
  return {
    header: HEADER,
    meta: '',
    counters: [],
    sections: [],
    footer: '读取失败：' + (asText(message) || '未知错误') + '\n' + GUIDE,
  }
}

/** Apply the width budget once, so no renderer path can overflow the panel. */
function finish(model, width) {
  return {
    header: clip(model.header, width),
    meta: clip(model.meta, width),
    counters: model.counters.map((counter) => clip(counter, width)),
    sections: model.sections.map((item) => ({
      title: clip(item.title, width),
      rows: item.rows.map((entry) => ({ text: clip(entry.text, width), tone: entry.tone })),
    })),
    footer: model.footer.split('\n').map((line) => clip(line, width)).join('\n'),
  }
}

/**
 * Pure payload -> display model for the TUI panel.
 *
 * options: { width, height, now }. Payload is the /api/project-flow/state JSON;
 * a host error object (ok:false) and the uninitialized shape both degrade to an
 * empty section list instead of throwing.
 */
export function panelModel(payload, options = {}) {
  const settings = asObject(options) || {}
  const width = Math.max(1, Math.floor(asNumber(settings.width, 80)))
  const now = asNumber(settings.now, Date.now())
  const state = asObject(payload)

  let model
  if (state === null) {
    model = errorModel('没有状态数据')
  } else if (state.ok === false) {
    const error = state.error
    const code = asText(isObject(error) ? error.code : '')
    const message = isObject(error) ? asText(error.message) || asText(error.code) : asText(error)
    if (code === 'not-initialized' || code === 'no-project') model = uninitializedModel(state.root)
    else model = errorModel(message || '读取状态失败')
  } else if (state.contract === undefined || state.contract === null || state.tasks === null) {
    model = uninitializedModel(state.root)
  } else {
    model = readyModel(state, now)
  }

  return finish(model, width)
}

/** Flatten the model into render lines; the component slices this by offset. */
function panelLines(model) {
  const lines = [{ text: model.header, tone: 'normal', bold: true }]
  if (model.meta !== '') lines.push({ text: model.meta, tone: 'dim' })
  for (const counter of model.counters) lines.push({ text: counter, tone: 'normal' })
  for (const item of model.sections) {
    lines.push({ kind: 'divider' })
    lines.push({ text: item.title, tone: 'accent', bold: true })
    for (const entry of item.rows) lines.push({ text: entry.text, tone: entry.tone })
  }
  if (model.footer !== '') {
    if (model.sections.length > 0) lines.push({ kind: 'divider' })
    for (const text of model.footer.split('\n')) {
      if (text === '') continue
      const tone = text.startsWith('读取失败：') ? 'error' : text.startsWith('未初始化：') ? 'warning' : 'dim'
      lines.push({ text, tone })
    }
  }
  return lines
}

function textProps(line) {
  const props = {}
  if (line.bold === true) props.bold = true
  if (line.tone === 'dim') props.dimColor = true
  else if (line.tone === 'accent') props.color = 'cyan'
  else if (line.tone === 'success') props.color = 'green'
  else if (line.tone === 'warning') props.color = 'yellow'
  else if (line.tone === 'error') props.color = 'red'
  return props
}

/** Build the panel component closed over one registration's reader options. */
function createPanelComponent(options) {
  const readState = typeof options.readState === 'function' ? options.readState : null
  const refreshMs = asNumber(options.refreshMs, DEFAULT_REFRESH_MS) > 0
    ? Math.floor(asNumber(options.refreshMs, DEFAULT_REFRESH_MS))
    : DEFAULT_REFRESH_MS
  const log = typeof options.log === 'function' ? options.log : null

  function ProjectFlowPanel(props) {
    const React = props.React
    const ui = props.ui
    const host = props.host
    const [payload, setPayload] = React.useState(null)
    const [phase, setPhase] = React.useState('loading')
    const [offset, setOffset] = React.useState(0)
    const [reloadSeq, setReloadSeq] = React.useState(0)
    const offsetLimit = React.useRef(0)
    const lastError = React.useRef('')

    let snapshot = {}
    try {
      snapshot = typeof host.snapshot === 'function' ? host.snapshot() : {}
    } catch {
      snapshot = {}
    }
    const cwd = typeof snapshot.cwd === 'string' ? snapshot.cwd : ''
    // Only legal timer source; null pauses while the panel is hidden.
    const tick = ui.useAnimationTime(props.visible === true ? refreshMs : null)

    React.useEffect(() => {
      let cancelled = false
      if (readState === null) {
        setPayload({ ok: false, error: 'readState 未提供' })
        setPhase('error')
        return () => { cancelled = true }
      }
      if (cwd === '') {
        setPayload({ ok: false, error: '宿主未提供工作目录' })
        setPhase('error')
        return () => { cancelled = true }
      }
      Promise.resolve()
        .then(() => readState(cwd))
        .then((raw) => {
          if (cancelled) return
          const value = typeof raw === 'string' ? JSON.parse(raw) : raw
          setPayload(value === undefined ? null : value)
          setPhase('ready')
          lastError.current = ''
        })
        .catch((error) => {
          if (cancelled) return
          const message = error instanceof Error ? error.message : String(error)
          setPayload({ ok: false, error: message })
          setPhase('error')
          if (log !== null && lastError.current !== message) {
            lastError.current = message
            try {
              log('panel read failed: ' + message)
            } catch {
              // logging must never break the panel
            }
          }
        })
      return () => { cancelled = true }
    }, [cwd, tick, reloadSeq])

    React.useEffect(() => {
      if (typeof host.onKey !== 'function') return undefined
      if (props.focused !== true || props.visible !== true) return undefined
      const unsubscribe = host.onKey((event) => {
        if (!event || !event.key) return
        const key = event.key
        if (key.ctrl === true || key.meta === true || key.escape === true) return
        const input = typeof event.input === 'string' ? event.input : ''
        if (input === 'r' || input === 'R') {
          event.preventDefault()
          setReloadSeq((value) => value + 1)
          return
        }
        if (input === 'j' || key.downArrow === true) {
          event.preventDefault()
          setOffset((value) => Math.min(value + 1, offsetLimit.current))
          return
        }
        if (input === 'k' || key.upArrow === true) {
          event.preventDefault()
          setOffset((value) => Math.max(0, value - 1))
        }
      })
      return typeof unsubscribe === 'function' ? unsubscribe : undefined
    }, [host, props.focused, props.visible])

    const panelWidth = asNumber(props.width, 0) > 0 ? Math.floor(props.width) : 40
    const panelHeight = asNumber(props.height, 0) > 0 ? Math.floor(props.height) : 24
    const model = panelModel(payload, { width: panelWidth, height: panelHeight, now: Date.now() })
    const lines = panelLines(model)

    if (phase === 'loading' && payload === null) {
      lines.length = 0
      lines.push({ text: model.header, tone: 'normal', bold: true })
      lines.push({ text: '读取中…', tone: 'dim' })
      lines.push({ text: GUIDE, tone: 'dim' })
    }

    const maxOffset = Math.max(0, lines.length - panelHeight)
    offsetLimit.current = maxOffset
    const start = Math.min(Math.max(0, offset), maxOffset)
    const visibleLines = lines.slice(start, start + panelHeight)

    if (typeof ui.Box !== 'function' || typeof ui.Text !== 'function') return null

    const children = []
    for (let index = 0; index < visibleLines.length; index += 1) {
      const line = visibleLines[index]
      const key = String(start + index)
      if (line.kind === 'divider') {
        if (typeof ui.Divider === 'function') {
          children.push(React.createElement(ui.Divider, { key: 'divider-' + key, width: panelWidth }))
        }
        continue
      }
      children.push(React.createElement(ui.Text, { key: 'line-' + key, ...textProps(line) }, line.text))
    }

    return React.createElement(ui.Box, { flexDirection: 'column', width: panelWidth }, children)
  }

  ProjectFlowPanel.displayName = 'ProjectFlowPanel'
  return ProjectFlowPanel
}

/**
 * Register the read-only flow panel on the host's tuiPanels service.
 *
 * options: { readState(cwd), refreshMs, log }. Missing or rejecting services
 * return undefined; registration is never allowed to throw into the host.
 */
export function registerProjectFlowPanel(ctx, options = {}) {
  let panels
  try {
    panels = ctx.tuiPanels
  } catch {
    panels = undefined
  }
  if (panels === undefined || panels === null) {
    try {
      panels = ctx.get('tuiPanels')
    } catch {
      return undefined
    }
  }
  if (panels === null || panels === undefined || typeof panels.register !== 'function') return undefined

  const settings = asObject(options) || {}
  const component = createPanelComponent(settings)
  try {
    const result = panels.register({
      apiVersion: 1,
      id: 'flow',
      title: '项目流程',
      icon: '◈',
      order: 40,
      minColumns: 28,
      component,
    })
    return result
  } catch {
    return undefined
  }
}
