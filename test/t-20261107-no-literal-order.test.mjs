// 通用守卫：禁止「用数组字面量的**顺序长相**去断言源码」。
//
// 背景（本会话第 3 次踩坑）：`test/t-20261105-task-type.test.mjs` 曾用
//   assert.match(BIN_SOURCE, /update: \{ flags: \['id', 'title', 'type', 'status', .../)
// 钉死 SPEC 的 flags 数组长相。task-63 给 flags 插入 'stage' 时它红了，实现者于是把
// 'stage' 追加到**末尾**——一条测试改变了实现的设计，还留下「flags 只能往末尾追加」
// 这条没人写下来的隐式规则。
//
// 这类断言错在两个地方：
//   1. 它保护的不是**性质**（`type` 被声明了 / handler 读得到），而是**长相**（顺序）；
//      而数组顺序在这些位置对行为零影响（VALUE_FLAGS 是集合语义，`input[key]=` 是赋值）。
//   2. 它把「谁写错了」指向了排序的人，而真正该红的是删掉成员的人。
//
// 为什么做成断言而不是纪律：本会话已三次证明「靠记得别这么写」会失效。能用红字防住的，
// 就不要靠纪律。
//
// 本守卫只抓**顺序敏感**的字面量：正则里两个以上带引号的条目之间，除了逗号/空白没有
// 别的通配符。`/flags: \[[^\]]*'stage'[^\]]*\]/` 这种写法中间有 `[^\]]*`，刻意允许任意
// 位置，**不属于**本守卫的对象。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TEST_DIR = path.join(ROOT, 'test')

/**
 * Every `assert.match(<target>, /<regex>/)` (and `.ok(...test(...))` lookalikes are
 * out of scope on purpose — only `assert.match` is the reported pattern) whose
 * REGEX SOURCE pins a run of quoted members in a specific order.
 *
 * Detection works on the regex source text, not on a hand-written list of file
 * names: a new offender in any test file is caught without teaching the guard
 * about it.
 */
function orderedArrayLiteralFindings(source) {
  const findings = []
  const patterns = [
    // assert.match(TARGET, /.../flags?)  —— 第二个实参是正则字面量。
    /assert\.match\(\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*(?:\s*,\s*)\/((?:[^/\\\n]|\\.)+)\/g?/g,
    // const loops = SOURCE.match(/.../g) —— 同一类耦合换了写法：先 match 再 assert 长度。
    // 不写这一条就会漏掉 `test/t-20261107-stage-cli.test.mjs:177` 那种 handler 循环断言。
    /[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.match\(\s*\/((?:[^/\\\n]|\\.)+)\/g?/g,
  ]
  for (const call of patterns) {
    let match
    while ((match = call.exec(source)) !== null) {
      const regexSource = match[1]
      // 关键：违规样本常常**不写闭合的 `\]`**（旧断言是前缀匹配 `/…flags: \['id', 'title', 'type'/`），
      // 所以不能等一个闭合括号出现；从 `\[` 之后一直吃到正则结尾即可。
      const open = regexSource.indexOf('\\[')
      if (open < 0) {
        // 也接受不转义的形式，但要避开字符类 `[...]` 本身
        continue
      }
      const inner = regexSource.slice(open + 2)
      const members = [...inner.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)].map((entry) => entry[1] ?? entry[2])
      if (members.length < 2) continue
      // 顺序无关写法（刻意允许任意间隔）：条目之间出现 `[^…]`、`(.*)` 一类的通配结构。
      const wildcard = /\[\^|\]\+|\.\*|\?\+|\(\?/.test(inner)
      if (wildcard) continue
      findings.push({ regexSource, members })
    }
  }
  return findings
}

/**
 * 已知的、属于**别人写域**的违规：本守卫只上报，不替人改。
 *
 * 每条都要写清「谁该改、为什么还没改、改法是什么」，并在此文件里保持可见——一旦对应
 * 文件被修好，这条豁免就该被删掉（下面的自检会在豁免项已不存在时报错，防止它变成
 * 永久免死金牌）。
 */
const KNOWN_OFFENDERS = Object.freeze([])

test('守卫：test/ 下不得用数组字面量的顺序去断言源码（顺序不是值得保护的属性）', () => {
  const offenders = []
  for (const file of fs.readdirSync(TEST_DIR).sort()) {
    if (file.endsWith('.test.mjs') === false) continue
    // 守卫自己不扫自己：本文件的示例正则就是"坏样本"。
    if (file === path.basename(fileURLToPath(import.meta.url))) continue
    const full = path.join(TEST_DIR, file)
    const source = fs.readFileSync(full, 'utf8')
    for (const finding of orderedArrayLiteralFindings(source)) {
      const waived = KNOWN_OFFENDERS.some(
        (entry) => entry.file === file && entry.regex.test(finding.regexSource),
      )
      if (waived) continue
      offenders.push(`${file}: /${finding.regexSource}/ —— 钉了 [${finding.members.join(', ')}] 的顺序`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `发现顺序敏感的字面量断言（应改为验成员资格）：\n${offenders.join('\n')}`,
  )
})

test('守卫：豁免清单里的条目若已被修好，必须删掉豁免（不留永久免死金牌）', () => {
  const stale = []
  for (const entry of KNOWN_OFFENDERS) {
    const full = path.join(TEST_DIR, entry.file)
    if (fs.existsSync(full) === false) {
      stale.push(`${entry.file} 已不存在`)
      continue
    }
    const source = fs.readFileSync(full, 'utf8')
    const stillThere = orderedArrayLiteralFindings(source).some((finding) => entry.regex.test(finding.regexSource))
    if (stillThere === false) stale.push(`${entry.file} 的违规已被修好，请删掉这条豁免`)
  }
  assert.deepEqual(stale, [], `豁免清单过期：\n${stale.join('\n')}`)
})

test('守卫自检：能抓到坏样本，也能放行顺序无关的写法', () => {
  const bad = `assert.match(SRC, /update: \\{ flags: \\['id', 'title', 'type'\\]/)`
  assert.equal(orderedArrayLiteralFindings(bad).length, 1, '顺序敏感样本必须被抓到')

  // 中间带通配符 = 作者刻意允许任意位置，放行。
  const wild = `assert.match(SRC, /add: \\{ flags: \\[[^\\]]*'stage'[^\\]]*\\] \\}/)`
  assert.equal(orderedArrayLiteralFindings(wild).length, 0, '含通配符的顺序无关写法必须放行')

  // 单条目没有「顺序」可言。
  const single = `assert.match(SRC, /inject = \\['webServer'\\]/)`
  assert.equal(orderedArrayLiteralFindings(single).length, 0, '单元素数组不存在顺序问题')
})
