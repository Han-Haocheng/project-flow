// 模块语义层守卫（2026-11-12，语义层 ST1）：aspects / roles / unmanaged / 严格归属 / 锚点诊断。
//
// 阶段 1 把「谁能改」（owns/shared/sections）与「改它要谁知道」（aspects）放进同一张图。
// 本文件守三件事：
//   ① 真实数据自洽：aspect 的文件真实存在且在归属宇宙内、ownerRole 可解析、unmanaged 覆盖宇宙外文件；
//   ② 新检查真的会咬人：aspect 悬空文件 / ownerRole 悬空 / 数量超限 / 孤儿区段 / shared 无区段 /
//      写域外声明区段 —— 每一种都必须 exit 1；
//   ③ 锚点失配必须可读：打印期望行、最接近的实际行与逐码点差异（全角括号事故的根因是不可读）。
//
// 负面用例通过 --data 指向临时副本，不改仓库真源；输出格式断言只认新检查的文案。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(REPO, 'scripts', 'module-domain.mjs')
const DATA_FILE = path.join(REPO, 'docs', 'module-domain.json')
const TEMP_DIRS = []
const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))

after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

/** 跑哨兵脚本，返回 { status, stdout, stderr }（永远不抛）。 */
function run(args, input) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', input: input })
  if (result.error) return { status: -1, stdout: '', stderr: String(result.error.message) }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 复制真源到临时目录并就地变异，返回临时数据文件路径。 */
function withData(mutator) {
  const copy = JSON.parse(JSON.stringify(data))
  mutator(copy)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-module-aspects-'))
  TEMP_DIRS.push(dir)
  const file = path.join(dir, 'module-domain.json')
  fs.writeFileSync(file, JSON.stringify(copy, null, 2))
  return file
}

test('aspects 声明完整：id 形态、语义、ownerRole 可解析、文件非空', () => {
  assert.equal(data.schema, 1)
  const aspects = data.aspects ?? {}
  const roles = data.roles ?? {}
  assert.ok(Object.keys(aspects).length >= 3, 'aspect 至少要有 3 条（横切面不是装饰）')
  for (const [id, aspect] of Object.entries(aspects)) {
    assert.match(id, /^[a-z][a-z0-9-]{2,40}$/, 'aspect id 形态：' + id)
    assert.ok(typeof aspect.semantics === 'string' && aspect.semantics.trim().length >= 10, 'aspect ' + id + ' 缺一句话语义')
    assert.ok(typeof aspect.rationale === 'string' && aspect.rationale.trim().length >= 20, 'aspect ' + id + ' 缺增删理由')
    assert.ok(Object.prototype.hasOwnProperty.call(roles, aspect.ownerRole), 'aspect ' + id + ' 的 ownerRole 未在 roles 里定义')
    assert.ok(Array.isArray(aspect.files) && aspect.files.length > 0, 'aspect ' + id + ' 必须显式声明文件')
    for (const file of aspect.files) assert.ok(fs.existsSync(path.join(REPO, file)), 'aspect ' + id + ' 的文件不存在：' + file)
  }
})

test('roles 声明完整：modules 都指向已知模块，且被至少一个 aspect 使用', () => {
  const roles = data.roles ?? {}
  const used = new Set(Object.values(data.aspects ?? {}).map((aspect) => aspect.ownerRole))
  for (const [id, role] of Object.entries(roles)) {
    assert.match(id, /^[a-z][a-z0-9-]{2,40}$/, 'role id 形态：' + id)
    assert.ok(Array.isArray(role.modules) && role.modules.length > 0, 'role ' + id + ' 必须声明负责哪些模块')
    for (const moduleName of role.modules) assert.ok(Object.prototype.hasOwnProperty.call(data.modules, moduleName), 'role ' + id + ' 指向未知模块：' + moduleName)
    assert.ok(used.has(id), 'role ' + id + ' 未被任何 aspect 使用（要么删掉，要么在 aspect 里引用）')
  }
})

test('unmanaged 覆盖归属宇宙之外的仓库文件，且不与模块归属冲突', () => {
  const unmanaged = data.unmanaged ?? []
  assert.ok(Array.isArray(unmanaged) && unmanaged.length >= 17, 'unmanaged 至少覆盖 .selftest/ 13 个探针 + 4 个仓库元数据文件')
  const seen = new Set()
  for (const item of unmanaged) {
    assert.ok(typeof item.path === 'string' && item.path !== '', 'unmanaged 条目缺 path')
    assert.ok(typeof item.reason === 'string' && item.reason !== '', 'unmanaged 条目缺 reason：' + item.path)
    assert.ok(fs.existsSync(path.join(REPO, item.path)), 'unmanaged 条目不存在：' + item.path)
    assert.equal(seen.has(item.path), false, 'unmanaged 重复登记：' + item.path)
    seen.add(item.path)
  }
})

test('真实数据 verify 通过，且 --json 形状稳定', () => {
  const result = run(['verify', '--json'])
  assert.equal(result.status, 0, 'verify --json 失败：' + result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.problems, [])
  assert.ok(Array.isArray(payload.warnings))
})

test('aspect 指向不存在的文件必须报红', () => {
  const file = withData((copy) => {
    copy.aspects['state-machine'].files = copy.aspects['state-machine'].files.concat('lib/does-not-exist.mjs')
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /aspect 文件不存在/)
})

test('aspect 指向归属宇宙之外的文件必须报红', () => {
  const file = withData((copy) => {
    copy.aspects['state-machine'].files = copy.aspects['state-machine'].files.concat('.gitignore')
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未被任何模块归属/)
})

test('aspect 的 ownerRole 未定义必须报红', () => {
  const file = withData((copy) => {
    copy.aspects['state-machine'].ownerRole = 'nobody-owner'
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ownerRole 未定义/)
})

test('aspect 数量超过上限 6 必须报红（刹车不是目标）', () => {
  const file = withData((copy) => {
    for (const id of ['extra-one', 'extra-two', 'extra-three']) {
      copy.aspects[id] = JSON.parse(JSON.stringify(copy.aspects['state-machine']))
    }
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /aspect 数量超限/)
})

test('孤儿区段必须报红：定义了却没有任何模块引用', () => {
  const file = withData((copy) => {
    delete copy.modules.framework.sections['index.js']
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /孤儿区段/)
  assert.match(result.stderr, /index\.js/)
})

test('shared 文件未登记区段必须报红（整文件共享 = 没有边界）', () => {
  const file = withData((copy) => {
    delete copy.modules.tasks.sections['client.js']
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /共享未登记区段/)
  assert.match(result.stderr, /client\.js/)
})

test('在自己的写域之外声明区段必须报红', () => {
  const file = withData((copy) => {
    copy.modules.store.sections['client.js'] = ['styles']
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /在自己的写域之外声明了区段/)
})

test('unmanaged 条目与模块归属冲突必须报红（不许当逃生舱）', () => {
  const file = withData((copy) => {
    copy.unmanaged[0] = { path: 'lib/stage.mjs', reason: '偷渡测试：这个文件其实归 tasks' }
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unmanaged 条目与模块归属冲突/)
})

test('锚点失配要打印期望行、最接近实际行与逐码点差异（全角括号事故）', () => {
  const anchor = data.sections['CONTRACT.md'].c6.from
  const halfwidth = anchor.replace(/\uFF08/g, '(').replace(/\uFF09/g, ')')
  assert.notEqual(halfwidth, anchor, 'CONTRACT.md 的 c6 锚点必须含全角括号，否则本用例失去意义')
  const file = withData((copy) => {
    copy.sections['CONTRACT.md'].c6.from = halfwidth
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /的 from 锚点匹配 0 行/)
  assert.match(result.stderr, /期望: /)
  assert.match(result.stderr, /最接近: CONTRACT\.md:\d+/)
  assert.match(result.stderr, /实际: /)
  assert.match(result.stderr, /U\+FF08/)
  assert.match(result.stderr, /U\+0028/)
  assert.match(result.stderr, /只差不可见\/全角字符/)
})

test('锚点多次命中要列出全部命中行号', () => {
  const file = withData((copy) => {
    copy.sections['CONTRACT.md'].c6.from = '\u0060\u0060\u0060'
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /的 from 锚点匹配 [2-9]\d* 行/)
  assert.match(result.stderr, /CONTRACT\.md:\d+: /)
})

test('区段顺序漂移必须报红并打印前后行号', () => {
  const file = withData((copy) => {
    const sections = copy.sections['lib/core.mjs']
    const keys = Object.keys(sections)
    const swapped = {}
    swapped[keys[1]] = sections[keys[1]]
    swapped[keys[0]] = sections[keys[0]]
    for (const key of keys.slice(2)) swapped[key] = sections[key]
    copy.sections['lib/core.mjs'] = swapped
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /顺序漂移/)
})

test('to 锚点不在 from 之后必须报红', () => {
  const file = withData((copy) => {
    copy.sections['CONTRACT.md'].c6.to = copy.sections['CONTRACT.md']['c1.1'].from
  })
  const result = run(['verify', '--data', file])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /to 不在 from 之后/)
})
