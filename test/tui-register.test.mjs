// TUI panel wiring regression: static structure only. This file never imports
// index.js (its ./tui-panel.js sibling may not exist yet), so it stays runnable
// while the panel module lands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'))
}

test('dsh-plugin.json declares a community v0.15 manifest', () => {
  const manifest = readJson('dsh-plugin.json')

  assert.equal(manifest.$schema, 'urn:dsh-std:community-draft:dsh-plugin:0.15')
  assert.equal(manifest.manifestVersion, '0.15')
  assert.equal(typeof manifest.id, 'string')
  assert.equal(typeof manifest.name, 'string')
  assert.equal(typeof manifest.version, 'string')
  assert.ok(manifest.id.length > 0)
  assert.ok(manifest.name.length > 0)

  assert.equal(manifest.facets.host.entry, 'index.js')
  assert.equal(manifest.facets.host.apiVersion, 'v1alpha1')

  assert.ok(Array.isArray(manifest.requires.contracts))
  assert.ok(Array.isArray(manifest.permissions))
  assert.ok(Array.isArray(manifest.contributes.commands))
  assert.ok(Array.isArray(manifest.subscriptions))
  assert.equal(manifest.license, 'MIT')
  assert.equal(typeof manifest.source.repository, 'string')
  assert.ok(manifest.source.repository.length > 0)
})

test('the Component projection takes metadata.name from manifest.id', () => {
  const manifest = readJson('dsh-plugin.json')
  const pkg = readJson('package.json')

  // @dsh-std/manifest projects a v0.15 manifest into
  //   Component.metadata = { name: manifest.id, displayName: manifest.name, version: manifest.version }
  // (node_modules/@dsh-std/manifest/src/index.ts, projectCommunityManifest).
  // dsh-tui binds that name as componentId, and tuiPanels prefixes panel ids with
  // it — so id must be exactly 'project-flow' for the panel to be project-flow:flow.
  assert.equal(manifest.id, 'project-flow')
  assert.equal(manifest.version, pkg.version)
})

test('package.json keeps the web client and publishes the manifest', () => {
  const pkg = readJson('package.json')

  assert.ok(pkg.files.includes('dsh-plugin.json'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.profile, undefined)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')

  // Single package, several independently mountable entries (D-20261105-10):
  // the module sub-plugins are package-root files with their own export paths.
  for (const [subpath, file] of [
    ['./tasks', './tasks.js'],
    ['./gates', './gates.js'],
    ['./experiments', './experiments.js'],
  ]) {
    assert.equal(pkg.exports[subpath], file, `${subpath} 应指向包根入口`)
    assert.ok(pkg.files.includes(file.slice(2)), `${file.slice(2)} 应随包发布`)
  }

  // The bundle patch gains the three rows without dropping or replacing the
  // original two.
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes("name: '@local/project-flow'\n"), '共享层那一行必须保留')
  assert.ok(patch.includes('id: project-flow-tui'), 'TUI 那一行必须保留')
  for (const [id, name] of [
    ['project-flow-tasks', '@local/project-flow/tasks'],
    ['project-flow-gates', '@local/project-flow/gates'],
    ['project-flow-experiments', '@local/project-flow/experiments'],
  ]) {
    assert.ok(patch.includes(`id: ${id}`), `补丁缺少 ${id}`)
    assert.ok(patch.includes(`name: '${name}'`), `补丁缺少 ${name}`)
  }
})

test('the host half exposes the shared state projection and does not mount the panel itself', () => {
  const source = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
  const stateSource = fs.readFileSync(path.join(ROOT, 'lib', 'host', 'state.mjs'), 'utf8')

  // The HTTP route and the panel read path are one projection. Since
  // T-20261104-01 the caller enumerates the registry exactly once and passes
  // the rows in (`collectPanelState(ctx, root, workspaces)`), so the projection
  // never re-reads the registry inside one request.
  assert.match(stateSource, /async function collectPanelState\(ctx, root, workspaces\)/)
  assert.match(stateSource, /sendJson\(response, 200, await collectPanelState\(\w+, root, workspaces\)\)/)
  assert.match(stateSource, /return await collectPanelState\(ctx, root, workspaces\)/)
  assert.match(stateSource, /export function panelStateReader\(ctx\)/)
  // T-20261112154725：前端主读路径走 CLI 契约，进程内读降级为兜底，两者都在入口。
  assert.match(source, /export function cliPanelStateReader\(ctx, options = \{\}\)/)
  // tuiPanels is a hard dependency of the TUI row, so the host half must stay
  // free of it: web and desktop would otherwise wait forever.
  assert.equal(/tui-panel/.test(source), false)
  // 入口不得硬依赖 webServer（TUI 宿主没有该服务，硬 inject 会让整个条目 apply 不了）：
  // HTTP 路由经 provide(ctx, 'webServer', …) 可选装配，工具/技能/守卫照常注册。
  assert.equal(/export const inject = \['webServer'\]/.test(source), false)
  assert.match(source, /provide\(ctx, 'webServer', label,/)

  // The split: the module tools are defined/registered by their own entries, so
  // the shared host half must not define or mount them itself.
  assert.equal(/name: 'flow_exp'/.test(source), false)
  assert.equal(/name: 'flow_task'/.test(source), false)
  assert.equal(/name: 'flow_gate'/.test(source), false)
  for (const file of ['tasks.js', 'gates.js', 'experiments.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), true, `${file} 必须存在`)
  }
})

test('the TUI row is a separate bundle entry with the tuiPanels dependency', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tui-host.js'), 'utf8')
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  const translated = readJson('package.json')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

  assert.match(source, /export const inject = \['tuiPanels'\]/)
  // T-20261112154725：TUI 面板读「后端 CLI --json」契约，CLI 不可用时由
  // cliPanelStateReader 自己降级为进程内只读并标 degraded（不再是裸 panelStateReader）。
  assert.match(source, /import { cliPanelStateReader } from '\.\/index\.js'/)
  assert.match(source, /registerProjectFlowPanel\(ctx, {/)
  assert.match(source, /readState: cliPanelStateReader\(ctx\)/)
  assert.match(patch, /id: project-flow-tui/)
  assert.equal(pkg.exports['./tui-host'], './tui-host.js')
  assert.ok(pkg.files.includes('tui-host.js'))
  assert.ok(translated)
})

test('README documents the TUI side panel', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')

  assert.ok(readme.includes('TUI'))
  assert.ok(readme.includes('/panel'))
  assert.ok(readme.includes('项目流程'))
  assert.ok(readme.includes('3 秒'))
})
