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
    const entry = skillMetaEntry(name)
    assert.doesNotMatch(entry, /\bdescription\s*:/, `SKILL_META.${name} 仍带 description（与 frontmatter 成双来源）`)
    assert.doesNotMatch(entry, /\bwhenToUse\s*:/, `SKILL_META.${name} 仍带 whenToUse（与 frontmatter 成双来源）`)
  }
})

/** SN `SKILL_META` 里某个技能的条目文本（对象字面量，不嵌套）。 */
function skillMetaEntry(name) {
  const src = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')
  const start = src.indexOf('const SKILL_META = [')
  assert.ok(start > 0, 'index.js 找不到 SKILL_META')
  const block = src.slice(start, src.indexOf('\n]', start))
  const at = block.indexOf(`name: '${name}'`)
  assert.ok(at > 0, `SKILL_META 找不到 ${name}`)
  return block.slice(block.lastIndexOf('{', at), block.indexOf('}', at) + 1)
}

test('平铺技能 A4：目录技能 ai-collaborative-dev-workflow 的元数据也只有一个来源', () => {
  // task-59：这里原先只断言"SKILL_META 里那两条元数据还在（未被波及）"——那是防止误删，
  // 但没有断言**来源是否单一**。当时它实际是混合来源：description 走 SKILL.md 的
  // frontmatter，whenToUse 走 SKILL_META，于是改 SKILL.md 里的"何时用"不生效。
  // 现在两个键都必须在 SKILL.md 的 frontmatter 里，SKILL_META 只剩 name。
  const skillMd = fs.readFileSync(path.join(REPO, 'skills', 'ai-collaborative-dev-workflow', 'SKILL.md'), 'utf8')
  assert.match(skillMd, /^---\r?\n/, 'SKILL.md 必须以 frontmatter 开头')
  const front = readSkillFrontmatter(skillMd)
  assert.ok(front.description.length > 0, 'ai-collaborative-dev-workflow 的 description 必须来自 SKILL.md frontmatter')
  assert.ok(front.whenToUse.length > 0, 'ai-collaborative-dev-workflow 的 when-to-use 必须来自 SKILL.md frontmatter（不是 SKILL_META）')
  // 且 SKILL_META 里不能残留这两个键，否则又是双来源。
  const entry = skillMetaEntry('ai-collaborative-dev-workflow')
  assert.doesNotMatch(entry, /\bdescription\s*:/, 'SKILL_META 里仍有 description（与 frontmatter 成双来源）')
  assert.doesNotMatch(entry, /\bwhenToUse\s*:/, 'SKILL_META 里仍有 whenToUse（与 frontmatter 成双来源）')
})

test('平铺技能 A6：三个技能的 SKILL_META 条目都只剩 name（无兜底残留）', () => {
  // 全量扫而不是逐个点名：将来新增技能时，若有人又想"顺手在 SKILL_META 写一份"，
  // 这条会先红，而不是等到某天发现改 md 不生效。
  for (const name of [...FLAT_SKILLS, 'ai-collaborative-dev-workflow']) {
    const entry = skillMetaEntry(name)
    assert.doesNotMatch(entry, /\bdescription\s*:/, `SKILL_META.${name} 仍有 description`)
    assert.doesNotMatch(entry, /\bwhenToUse\s*:/, `SKILL_META.${name} 仍有 whenToUse`)
  }
})

test('平铺技能 A5：解析规则对形状敏感（whenToUse 驼峰会解析为空）', () => {
  // 守护本文件的解析副本本身没走样：若哪天有人把 A1/A2 改成宽松匹配，
  // 这条会先红，提醒"你改的是断言还是规则"。
  const camel = '---\ndescription: A\nmetadata:\n  whenToUse: B\n---\n# x\n'
  assert.equal(readSkillFrontmatter(camel).whenToUse, '', 'whenToUse（驼峰）不应被识别——那是错误形状')
  const kebab = '---\ndescription: A\nmetadata:\n  when-to-use: B\n---\n# x\n'
  assert.equal(readSkillFrontmatter(kebab).whenToUse, 'B', 'when-to-use（连字符）应被识别')
})
