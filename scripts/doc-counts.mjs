#!/usr/bin/env node
// 文档数字同步（2026-11-09，审计项 7）：README 里的「N 用例（M 个文件）」是派生数，
// 以前每加一条测试都要手工改，还写错过一次。这里把「真值推导」收成唯一实现：
//   - `node scripts/doc-counts.mjs`         只读比对，过期 exit 1（可进 CI）
//   - `node scripts/doc-counts.mjs --fix`   就地改写 README 的那一行
// 漂移测试 `test/t-20261106-doc-drift.test.mjs` import 同一个 `countTests()`，两套口径不会再分叉。
//
// 计数口径（与 `node --test` 的用例数逐次吻合）：`test/` 下每个 `*.test.mjs` 里，
// **行首**（无缩进）的 `test(` / `it(` 调用各算一条；helper 里的 `await test(` 不算。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(HERE, '..')

/** README 的声明形状：「1234 用例（56 个文件）」。 */
const README_COUNTS = /(\d+)\s*用例（(\d+)\s*个文件）/
/** 行首的顶层 `test(` / `it(`。 */
const TEST_CALL = /^(?:test|it)\s*\(/

/** `test/` 下的测试文件，按文件名排序（绝对路径）。 */
export function testFiles(root = DEFAULT_ROOT) {
  const dir = path.join(root, 'test')
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    // 与 node --test 的发现规则对齐：`*.test.mjs` 与 `*-test.mjs` 都会被运行。
    // 只认前者会让 `-test.mjs` 文件绕过 README 计数守卫（2026-11-11 审查 P1-4）。
    .filter((name) => /(?:\.test|[-_]test)\.mjs$/.test(name))
    .sort()
    .map((name) => path.join(dir, name))
}

/**
 * 实测用例数与文件数。
 * @returns `{tests, files}`
 */
export function countTests(root = DEFAULT_ROOT) {
  const files = testFiles(root)
  let tests = 0
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    for (const line of source.split('\n')) {
      if (TEST_CALL.test(line)) tests += 1
    }
  }
  return { tests, files: files.length }
}

/** README 里声明的数字；没声明时 `null`（不是 0）。 */
export function readmeCounts(root = DEFAULT_ROOT) {
  let source
  try {
    source = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  } catch {
    return null
  }
  const match = README_COUNTS.exec(source)
  return match === null ? null : { tests: Number(match[1]), files: Number(match[2]) }
}

/**
 * 比对（`fix:true` 时就地改写）。
 *
 * @returns `{ok, changed?, reason?, declared, actual}`
 *   `reason`: `no-declaration`（README 没写）| `stale`（只读模式下的不一致）
 */
export function syncReadmeCounts(root = DEFAULT_ROOT, options = {}) {
  const fix = options !== null && typeof options === 'object' && options.fix === true
  const actual = countTests(root)
  const declared = readmeCounts(root)
  if (declared === null) return { ok: false, reason: 'no-declaration', declared, actual }
  const stale = declared.tests !== actual.tests || declared.files !== actual.files
  if (!stale) return { ok: true, changed: false, declared, actual }
  if (!fix) return { ok: false, reason: 'stale', declared, actual }
  const file = path.join(root, 'README.md')
  const source = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, source.replace(README_COUNTS, `${actual.tests} 用例（${actual.files} 个文件）`))
  return { ok: true, changed: true, declared, actual }
}

function main(argv) {
  const fix = argv.includes('--fix')
  const result = syncReadmeCounts(DEFAULT_ROOT, { fix })
  const { actual, declared } = result
  if (result.reason === 'no-declaration') {
    process.stderr.write('README 里没有「N 用例（M 个文件）」声明，无法同步\n')
    return 1
  }
  if (result.ok === false) {
    process.stderr.write(
      `README 声明 ${declared.tests} 用例（${declared.files} 个文件），实测 ${actual.tests} 用例（${actual.files} 个文件）\n` +
        '修复：node scripts/doc-counts.mjs --fix\n',
    )
    return 1
  }
  process.stdout.write(
    result.changed
      ? `已同步：${declared.tests} 用例（${declared.files} 个文件）→ ${actual.tests} 用例（${actual.files} 个文件）\n`
      : `一致：${actual.tests} 用例（${actual.files} 个文件）\n`,
  )
  return 0
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
