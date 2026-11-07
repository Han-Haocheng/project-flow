// T-20261107 · 平铺技能的元数据只有**一个**来源：md 自己的 frontmatter。
//
// 背景：`skills/project-flow-init.md` / `skills/project-flow-usage.md` 是**平铺**技能
// （`skills/<name>.md`），元数据一度全写在 `index.js` 的 `SKILL_META` 里。加载器优先级是
// **frontmatter > SKILL_META**（`index.js` 的 `front.description.length > 0 ? front : meta`），
// 所以改 md 的「何时用」**完全不生效**——静默失效，作者以为改了。
//
// 修法（本文件守护）：frontmatter 承载元数据，`SKILL_META` 只留 `name`。
// 三条断言分别防：没 frontmatter / 空 frontmatter 混过 / 双来源回退。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const FLAT_SKILLS = ['project-flow-init', 'project-flow-usage']

/**
 * 与 `index.js` 的 `readSkillFrontmatter` **逐字同形**的副本。
 *
 * 刻意复制而不是 import：那个函数是 index.js 的内部实现（未导出），而本文件要断言的是
 * **文件内容**能否被这套解析规则读出值——这本身就是被测对象。
 * 形状敏感：只认顶层 `description` 与 `metadata:` 块里的 `when-to-use`（连字符，不是
 * `whenToUse`），且只支持单行 `key: value` 标量。
 */
function readSkillFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content)
  if (match === null) return { description: '', whenToUse: '' }
  const seen = {}
  let block = ''
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const pair = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line.trim())
    if (pair === null) continue
    if (/^[ \t]/.test(line)) {
      if (block === 'metadata') seen[`metadata.${pair[1]}`] = pair[2].trim()
    } else {
      block = pair[1]
      seen[block] = pair[2].trim()
    }
  }
  const unquote = (value) => (typeof value === 'string' ? value.replace(/^["']|["']$/g, '').trim() : '')
  return {
    description: unquote(seen.description),
    whenToUse: unquote(seen['metadata.when-to-use']),
  }
}

const readSkill = (name) => fs.readFileSync(path.join(REPO, 'skills', `${name}.md`), 'utf8')

test('平铺技能 A1：两个 md 都有 frontmatter，且解析出 description + metadata.when-to-use', () => {
  for (const name of FLAT_SKILLS) {
    const content = readSkill(name)
    assert.match(content, /^---\r?\n/, `skills/${name}.md 必须以 frontmatter 开头`)
    const front = readSkillFrontmatter(content)
    assert.ok(front.description.length > 0, `skills/${name}.md 的 description 解析为空`)
    assert.ok(front.whenToUse.length > 0, `skills/${name}.md 的 metadata.when-to-use 解析为空`)
  }
})

test('平铺技能 A2：解析结果非空且不是占位符（防空 frontmatter 混过）', () => {
  for (const name of FLAT_SKILLS) {
    const front = readSkillFrontmatter(readSkill(name))
    // 防空串、纯空白、以及 "" 引号被 unquote 掉的空值。
    for (const [key, value] of [['description', front.description], ['when-to-use', front.whenToUse]]) {
      assert.ok(value.trim().length > 0, `skills/${name}.md 的 ${key} 是空白`)
      assert.ok(!/^(tbd|todo|xxx|n\/a)$/i.test(value.trim()), `skills/${name}.md 的 ${key} 是占位符：${value}`)
    }
    // when-to-use 应当说明"何时用"，不是一句 description 的复制粘贴。
    assert.match(front.whenToUse, /[Uu]se when|何时|当项目|when the user/, `${name} 的 when-to-use 不像"何时用"说明`)
  }
})

test('平铺技能 A3：SKILL_META 里这两个技能不再有 description/whenToUse（防双来源）', () => {
  const src = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')
  const start = src.indexOf('const SKILL_META = [')
  assert.ok(start > 0, 'index.js 找不到 SKILL_META')
  const end = src.indexOf('\n]', start)
  const block = src.slice(start, end)
  for (const name of FLAT_SKILLS) {
    // 取该条目所在的 `{ ... }` 片段（对象字面量不嵌套在这里）。
    const at = block.indexOf(`name: '${name}'`)
    assert.ok(at > 0, `SKILL_META 找不到 ${name}`)
    const open = block.lastIndexOf('{', at)
    const close = block.indexOf('}', at)
    const entry = block.slice(open, close + 1)
    assert.doesNotMatch(entry, /\bdescription\s*:/, `SKILL_META.${name} 仍带 description（与 frontmatter 成双来源）`)
    assert.doesNotMatch(entry, /\bwhenToUse\s*:/, `SKILL_META.${name} 仍带 whenToUse（与 frontmatter 成双来源）`)
  }
})

test('平铺技能 A4：目录技能 ai-collaborative-dev-workflow 的 SKILL_META 元数据未被波及', () => {
  const src = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')
  const start = src.indexOf('const SKILL_META = [')
  const block = src.slice(start, src.indexOf('\n]', start))
  const at = block.indexOf("name: 'ai-collaborative-dev-workflow'")
  assert.ok(at > 0, 'SKILL_META 找不到 ai-collaborative-dev-workflow')
  const entry = block.slice(block.lastIndexOf('{', at), block.indexOf('}', at) + 1)
  assert.match(entry, /\bdescription\s*:/, '目录技能的 description 不应被删（它靠 SKILL_META 兜底）')
  assert.match(entry, /\bwhenToUse\s*:/, '目录技能的 whenToUse 不应被删')
})

test('平铺技能 A5：解析规则对形状敏感（whenToUse 驼峰会解析为空）', () => {
  // 守护本文件的解析副本本身没走样：若哪天有人把 A1/A2 改成宽松匹配，
  // 这条会先红，提醒"你改的是断言还是规则"。
  const camel = '---\ndescription: A\nmetadata:\n  whenToUse: B\n---\n# x\n'
  assert.equal(readSkillFrontmatter(camel).whenToUse, '', 'whenToUse（驼峰）不应被识别——那是错误形状')
  const kebab = '---\ndescription: A\nmetadata:\n  when-to-use: B\n---\n# x\n'
  assert.equal(readSkillFrontmatter(kebab).whenToUse, 'B', 'when-to-use（连字符）应被识别')
})
