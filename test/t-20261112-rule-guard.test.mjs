// T-20261112183139（阶段 3）：规则文件校验和基线 + 改规则留痕（裁定 1）。
//
// 被监视的规则文件：docs/module-domain.json（写域真源，全文）、CONTRACT.md 的锚点
// 区段（只算 from..to 之间的正文）、<store>/flow.json（流程契约开关，缺失则跳过）。
// 改了但没留痕 → 红；flow gate rules record --reason ... 后才推进基线转绿。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', 'bin', 'flow.mjs')

function runCli(cwd, args) {
  const env = { ...process.env }
  delete env.DSH_SESSION_ID
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

import { initProject, loadContract } from '../lib/core.mjs'
import {
  MIN_REASON_CHARS,
  RULE_GUARD_FILE,
  checkRules,
  diffRuleSnapshot,
  initRules,
  readRuleGuard,
  recordRuleChange,
  ruleGuardPath,
  snapshotRules,
} from '../lib/gates/rules.mjs'

const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

const CONTRACT_TEXT = [
  '# 契约',
  '',
  '## 1 总则',
  '正文一',
  '',
  '## 2 门禁',
  '正文二',
  '',
  '## 3 附录',
  '附录正文（区段外，改它不需要留痕）',
  '',
].join('\n')

function writeRuleFiles(root, { domain, contract } = {}) {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  const moduleDomain = domain ?? {
    schema: 1,
    modules: {},
    sections: {
      'CONTRACT.md': {
        c1: { from: '## 1 总则', to: '## 2 门禁' },
        c2: { from: '## 2 门禁', to: '## 3 附录' },
      },
    },
  }
  fs.writeFileSync(path.join(root, 'docs/module-domain.json'), `${JSON.stringify(moduleDomain, null, 2)}\n`)
  fs.writeFileSync(path.join(root, 'CONTRACT.md'), contract ?? CONTRACT_TEXT)
}

function freshRulesProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-rules-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  writeRuleFiles(root)
  const { contract } = loadContract(root)
  return { root, contract }
}

test('init 建基线后 check 绿；快照覆盖三个监视对象', () => {
  const { root, contract } = freshRulesProject('init')
  const init = initRules(root, contract)
  assert.equal(init.files.length, 3)
  assert.deepEqual([...init.files].sort(), ['.agents/flow/flow.json', 'CONTRACT.md', 'docs/module-domain.json'])
  assert.ok(fs.existsSync(ruleGuardPath(root, contract)), '基线文件应落在 store 根')

  const result = checkRules(root, contract)
  assert.equal(result.ok, true)
  assert.equal(result.code, 'unchanged')
  const snapshot = snapshotRules(root, contract)
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.files['CONTRACT.md'].scope, 'sections')
  assert.deepEqual(Object.keys(snapshot.files['CONTRACT.md'].sections).sort(), ['c1', 'c2'])
})

test('未建基线 → guard-missing 红；重复 init → conflict', () => {
  const { root, contract } = freshRulesProject('missing')
  const before = checkRules(root, contract)
  assert.equal(before.ok, false)
  assert.equal(before.code, 'guard-missing')
  assert.match(before.hint, /rules init/)

  initRules(root, contract)
  let caught = null
  try {
    initRules(root, contract)
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== null)
  assert.equal(caught.code, 'conflict')
  assert.match(caught.message, /规则基线已存在/)
})

test('改规则区段外的正文不需要留痕；改区段内正文 → 红并点名区段', () => {
  const { root, contract } = freshRulesProject('section')
  initRules(root, contract)

  // 区段外（附录之后）改动：不监视，不红。
  fs.writeFileSync(path.join(root, 'CONTRACT.md'), CONTRACT_TEXT.replace('附录正文（区段外，改它不需要留痕）', '附录正文已改'))
  assert.equal(checkRules(root, contract).ok, true, '锚点区段之外的编辑不应触发留痕要求')

  // 区段内（c2 的正文）改动：红，且精确点名 CONTRACT.md#c2。
  fs.writeFileSync(path.join(root, 'CONTRACT.md'), CONTRACT_TEXT.replace('正文二', '正文二（被改）'))
  const changed = checkRules(root, contract)
  assert.equal(changed.ok, false)
  assert.equal(changed.code, 'unrecorded-change')
  assert.equal(changed.changed.length, 1)
  assert.equal(changed.changed[0].path, 'CONTRACT.md')
  assert.equal(changed.changed[0].unit, 'section')
  assert.equal(changed.changed[0].key, 'c2')
  assert.match(changed.hint, /rules record --reason/)
})

test('改 module-domain.json 全文 → 红；record 后转绿并留下带理由的 trail', () => {
  const { root, contract } = freshRulesProject('record')
  initRules(root, contract)

  writeRuleFiles(root, {
    domain: {
      schema: 1,
      modules: { gates: { title: '门禁' } },
      sections: { 'CONTRACT.md': { c1: { from: '## 1 总则', to: '## 2 门禁' }, c2: { from: '## 2 门禁', to: '## 3 附录' } } },
    },
  })
  const red = checkRules(root, contract)
  assert.equal(red.ok, false)
  assert.equal(red.changed.some((diff) => diff.path === 'docs/module-domain.json'), true)

  // 理由太短 → usage，且不写盘。
  let caught = null
  try {
    recordRuleChange(root, contract, { reason: '改规则' })
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== null)
  assert.equal(caught.code, 'usage')
  assert.match(caught.message, new RegExp(`至少 ${MIN_REASON_CHARS} 个字`))

  const recorded = recordRuleChange(root, contract, { reason: '新增 gates 模块的写域声明', by: 'user' })
  assert.equal(recorded.changed, true)
  assert.equal(recorded.entry.reason, '新增 gates 模块的写域声明')
  assert.equal(recorded.entry.by, 'user')
  assert.equal(recorded.entry.changes.length, 1)
  assert.equal(checkRules(root, contract).ok, true)

  const guard = readRuleGuard(root, contract)
  assert.equal(guard.trail.length, 1)
  assert.equal(guard.trail[0].reason, '新增 gates 模块的写域声明')

  // 没有实际变化时 record 不重复写记录。
  const again = recordRuleChange(root, contract, { reason: '重复留痕应当被忽略' })
  assert.equal(again.changed, false)
  assert.equal(readRuleGuard(root, contract).trail.length, 1)
})

test('锚点定位失败 → rule-anchor 红（不静默跳过）', () => {
  const { root, contract } = freshRulesProject('anchor')
  initRules(root, contract)
  fs.writeFileSync(path.join(root, 'CONTRACT.md'), CONTRACT_TEXT.replace('## 2 门禁', '## 2 门禁（改名）'))
  const result = checkRules(root, contract)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'rule-anchor')
  assert.ok(result.issues.some((issue) => issue.kind === 'anchor-missing'))
  assert.ok(result.issues.some((issue) => issue.section === 'c1' || issue.section === 'c2'))
})

test('optional 的 flow.json 缺失不算篡改；必需规则文件缺失 → 红', () => {
  const { root, contract } = freshRulesProject('optional')
  initRules(root, contract)
  fs.rmSync(path.join(root, '.agents/flow/flow.json'))
  assert.equal(checkRules(root, contract).ok, true, 'flow.json 是 optional：缺失不算篡改')

  fs.rmSync(path.join(root, 'docs/module-domain.json'))
  const result = checkRules(root, contract)
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.kind === 'rule-file-missing' && issue.path === 'docs/module-domain.json'))
})

test('diffRuleSnapshot：section 级差异只报变化的那一格', () => {
  const diffs = diffRuleSnapshot(
    { 'CONTRACT.md': { scope: 'sections', sections: { a: '1', b: '2' } } },
    { 'CONTRACT.md': { scope: 'sections', sections: { a: '1', b: '3' } } },
  )
  assert.equal(diffs.length, 1)
  assert.equal(diffs[0].key, 'b')
  assert.equal(diffs[0].from, '2')
  assert.equal(diffs[0].to, '3')
})

test('CLI：gate rules --init/--record/check 的退出码与 --json 错误形状', () => {
  const { root } = freshRulesProject('cli')
  const init = runCli(root, ['gate', 'rules', '--init', '--json'])
  assert.equal(init.code, 0, init.stdout + init.stderr)
  assert.equal(JSON.parse(init.stdout).data.files.length, 3)

  const green = runCli(root, ['gate', 'rules', '--json'])
  assert.equal(green.code, 0)
  assert.equal(JSON.parse(green.stdout).data.ok, true)

  // 改锚点区段内正文（不是区段外）→ 检查失败 exit 1，error.check = rules。
  fs.writeFileSync(path.join(root, 'CONTRACT.md'), CONTRACT_TEXT.replace('正文一', '正文一（无留痕篡改）'))
  const red = runCli(root, ['gate', 'rules', '--json'])
  assert.equal(red.code, 1, red.stdout + red.stderr)
  const redJson = JSON.parse(red.stdout)
  assert.equal(redJson.ok, false)
  assert.equal(redJson.error.check, 'rules')
  assert.equal(redJson.error.code, 'check-failed')
  assert.equal(redJson.error.guardCode, 'unrecorded-change')
  // 人类输出点名区段与修复命令。
  const human = runCli(root, ['gate', 'rules'])
  assert.equal(human.code, 1)
  assert.match(human.stdout, /CONTRACT\.md#c1/)
  assert.match(human.stdout, /flow gate rules record --reason/)

  // 理由缺失/过短：usage（exit 1），不推进基线。
  const short = runCli(root, ['gate', 'rules', '--record', '--reason', '改了'])
  assert.equal(short.code, 1)
  assert.match(short.stderr, /至少 4 个字/)

  const recorded = runCli(root, ['gate', 'rules', '--record', '--reason', '契约 §1 正文措辞修订', '--by', 'user', '--json'])
  assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr)
  assert.equal(JSON.parse(recorded.stdout).data.changed, true)
  assert.equal(runCli(root, ['gate', 'rules', '--json']).code, 0)
})

test('自定义 store.root 不改变 manifest 位置：仍监视 .agents/flow/flow.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-rules-custom-store-'))
  TEMP_ROOTS.push(root)
  // 先落一份指向自定义 store 的 manifest，再 init（init 会沿用已有 manifest）。
  fs.mkdirSync(path.join(root, '.agents/flow'), { recursive: true })
  fs.writeFileSync(
    path.join(root, '.agents/flow/flow.json'),
    JSON.stringify({ schema: 2, name: 'custom-store', store: { root: '.agents/custom-store' } }, null, 2),
  )
  initProject(root, { name: 'custom-store', noGates: true })
  writeRuleFiles(root)
  const { contract } = loadContract(root)
  const init = initRules(root, contract)
  // storePaths 只重定向子目录；loadContract 始终读 <root>/.agents/flow/flow.json，
  // 所以监视路径不能按 store.root 拼接（拼了会静默漏看真正的 manifest）。
  assert.ok(init.files.includes('.agents/flow/flow.json'), `监视清单应含真实 manifest：${init.files.join(', ')}`)
  assert.equal(init.files.includes('.agents/custom-store/flow.json'), false)
  assert.equal(checkRules(root, contract).ok, true)
})

test('规则基线与 trail 落在 store 根，文件名固定（可被 flow doctor / 备份看见）', () => {
  const { root, contract } = freshRulesProject('path')
  assert.equal(path.basename(ruleGuardPath(root, contract)), RULE_GUARD_FILE)
  assert.equal(ruleGuardPath(root, contract), path.join(root, '.agents/flow', RULE_GUARD_FILE))
})
