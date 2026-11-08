// project-flow — Host skill registration: the three embedded skills are read
// from the package (frontmatter is the single metadata source) and registered
// through the shared mount plumbing. Split out of index.js so the skill surface
// has its own write region (docs/module-boundaries.md).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brief } from '../state-snapshot.mjs'
import { provide, service, warnMount } from '../plugin/mount.mjs'
import { PACKAGE_ROOT } from './shared.mjs'
import { captureEnabled } from './session.mjs'

// ------------------------------------------------------------------- skills

const SKILL_META = [
  /* Every skill carries its own metadata in its file frontmatter (flat
     `skills/<name>.md`, or directory `skills/<name>/SKILL.md`); `name` is the
     only field here. Keeping description/whenToUse here too would be a second
     source of truth that silently loses to the frontmatter. */
  { name: 'project-flow-init' },
  { name: 'project-flow-usage' },
  /* Directory layout: skills/<name>/SKILL.md plus references/, assets/, scripts/. */
  { name: 'ai-collaborative-dev-workflow' },
]

/**
 * Read the simple frontmatter of a skill file: the top-level `description` and
 * `when-to-use` inside the `metadata:` block.
 *
 * This is a deliberately minimal YAML subset, NOT a YAML parser, and it fails
 * SILENTLY in two ways that cost a whole debugging session each:
 *  - the key must be exactly `metadata.when-to-use`; a camelCase `whenToUse`
 *    parses to `''` with no error;
 *  - only single-line `key: value` scalars are read. A value wrapped onto
 *    continuation lines keeps its FIRST line and drops the rest, so a nicely
 *    formatted multi-line `description:` silently becomes a truncated one.
 *
 * Every skill, flat or directory, now carries its metadata in its own file, so
 * there is NO SKILL_META fallback left: a frontmatter value missed here reaches
 * the model as `undefined`, not as a default. Keep every value on ONE line.
 */
export function readSkillFrontmatter(content) {
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

export function registerSkills(ctx) {
  provide(ctx, 'skills', 'skills', (scoped) => {
    const skills = service(scoped, 'skills')
    if (skills === undefined || typeof skills.register !== 'function') return () => {}
    const disposers = []
    for (const meta of SKILL_META) {
      // Two layouts: a directory skill (skills/<name>/SKILL.md) may carry
      // references/, assets/ and scripts/, a flat skill (skills/<name>.md) is
      // the instruction file alone. The directory wins when both exist.
      const dir = join(PACKAGE_ROOT, 'skills', meta.name)
      const dirRelative = join('skills', meta.name, 'SKILL.md')
      const flatRelative = join('skills', `${meta.name}.md`)
      const directory = existsSync(join(dir, 'SKILL.md'))
      const relativePath = directory ? dirRelative : flatRelative
      const file = directory ? join(dir, 'SKILL.md') : join(PACKAGE_ROOT, flatRelative)
      let content
      try {
        content = readFileSync(file, 'utf8')
      } catch (error) {
        warnMount(`skills: ${toPosix(relativePath)} not found; ${meta.name} was not registered (${brief(error, 120)})`, scoped)
        continue
      }
      if (typeof content !== 'string' || content.trim().length === 0) {
        warnMount(`skills: ${toPosix(relativePath)} is empty; ${meta.name} was not registered`, scoped)
        continue
      }
      try {
        /* A directory skill is a file the package author can edit: its own
           frontmatter wins over the SKILL_META fallback. */
        const front = readSkillFrontmatter(content)
        const dispose = skills.register({
          name: meta.name,
          description: front.description.length > 0 ? front.description : meta.description,
          whenToUse: front.whenToUse.length > 0 ? front.whenToUse : meta.whenToUse,
          /* SkillSummary requires a string source; these ship with the bundle. */
          source: 'bundled',
          /* The filesystem provider strips the frontmatter from a loaded body;
             do the same, or the model sees the metadata block twice. */
          content: content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trimStart(),
          /* A directory skill renders "Base directory for this skill: <path>" and
             the model resolves relative references against it; the flat layout
             has no resources, so it carries no resourceBase. */
          ...(directory ? { resourceBase: { kind: 'directory', path: dir } } : {}),
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        warnMount(`skills: cannot register ${meta.name}: ${brief(error)}`, scoped)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A skill disposer must never break plugin unload.
        }
      }
    }
  })
}
