// project-flow — Host mounting plumbing.
//
// Every entry point of this package mounts its model-facing tools with exactly
// the same semantics: look the service up defensively, defer through
// `ctx.inject` when the host offers it, register inside one effect so unload
// unregisters, wrap `execute` so core diagnostics reach the caller, and report
// each distinct mount problem once. That logic lives here and nowhere else, so
// `index.js` and the three module sub-plugins (`tasks.js`, `gates.js`,
// `experiments.js`) cannot drift apart.
//
// `warnMount` writes into the one `mountWarnings` list the host payload reports.

import { brief, isPlainObject, takeCoreWarnings } from '../state-snapshot.mjs'
import { makeToolRoot } from './shared.mjs'

/**
 * Read one optional Cordis service. Both the accessor (`ctx.get`) and the plain
 * property are tried; a host that has neither simply yields `undefined`.
 */
export function service(ctx, name) {
  try {
    const value = ctx.get(name)
    if (value !== undefined && value !== null) return value
  } catch {
    // fall through to the property lookup below
  }
  try {
    const value = ctx[name]
    if (value !== undefined && value !== null) return value
  } catch {
    // missing service
  }
  return undefined
}

/** Non-fatal problems detected while mounting; surfaced in every payload's warnings. */
export const mountWarnings = []

/** One warning per distinct mount problem: apply may run more than once per process. */
export function warnMount(message, ctx) {
  if (typeof message !== 'string' || message.length === 0) return
  if (mountWarnings.includes(message) === false) mountWarnings.push(message)
  try {
    if (ctx !== undefined && ctx !== null && ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(`project-flow: ${message}`)
    }
  } catch {
    // Logging is best-effort only.
  }
}

/**
 * Register through an optional service. With Cordis, `ctx.inject` defers the
 * callback until the service exists; registration is an effect so unload
 * unregisters everything. Without an injection facility (plain test doubles or
 * an older host) the service is used only when already present.
 */
export function provide(ctx, name, label, setup) {
  const install = (scoped) => {
    try {
      scoped.effect(() => setup(scoped), `project-flow: ${label}`)
    } catch (error) {
      warnMount(`${label}: registration failed: ${brief(error)}`, ctx)
    }
  }

  if (typeof ctx.inject !== 'function') {
    if (service(ctx, name) === undefined) return
    try {
      ctx.effect(() => setup(ctx), `project-flow: ${label}`)
    } catch (error) {
      warnMount(`${label}: registration failed: ${brief(error)}`, ctx)
    }
    return
  }

  try {
    ctx.effect(() => {
      const fiber = ctx.inject([name], install)
      return () => {
        try {
          if (fiber !== undefined && fiber !== null && typeof fiber.dispose === 'function') {
            const pending = fiber.dispose()
            if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(() => {})
          }
        } catch {
          // Disposal must never throw into the host.
        }
      }
    }, `project-flow: ${label} inject`)
  } catch (error) {
    warnMount(`${label}: injection failed: ${brief(error)}`, ctx)
  }
}

/**
 * Wrap a tool's `execute` so core diagnostics reach the caller. On success they
 * are appended to `warnings`; on failure they go to the logger and the error
 * itself stays untouched (callers match on its message).
 */
export function wrapToolDefinition(definition, ctx) {
  const execute = definition.execute
  if (typeof execute !== 'function') return definition
  const warningSink = () => {
    try {
      if (ctx !== null && ctx !== undefined && ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
        return ctx.logger
      }
    } catch {
      // logging is best-effort
    }
    return null
  }
  return {
    ...definition,
    async execute(args, exec) {
      try {
        const result = await execute.call(this, args, exec)
        const warnings = takeCoreWarnings()
        if (warnings.length === 0 || isPlainObject(result) === false) return result
        const existing = Array.isArray(result.warnings) ? result.warnings : []
        return { ...result, warnings: [...existing, ...warnings] }
      } catch (error) {
        const warnings = takeCoreWarnings()
        if (warnings.length > 0) {
          const logger = warningSink()
          try {
            if (logger !== null) logger.warn(`project-flow: ${definition.name}: ${warnings.join(' | ')}`)
          } catch {
            // logging is best-effort
          }
        }
        throw error
      }
    },
  }
}

/**
 * What one tool definition may receive from its mounting context: the scoped
 * context itself plus the root resolver bound to it. Every other rule (store
 * probe, core accessor, field whitelists, caps) is a module-level import, so
 * passing it would let an entry swap in a divergent copy.
 */
export function toolDeps(ctx) {
  return { ctx, toolRoot: makeToolRoot({ service }) }
}

/**
 * Mount a set of tool definitions behind `provide(ctx, 'tools', ...)`.
 *
 * `build(scoped)` returns the definitions for the scoped context (they capture
 * `scoped` for root resolution); `guard(scoped)` optionally returns the write
 * guard predicate. Both may be omitted/undefined: a host without a `tools`
 * service is a no-op, never an error.
 */
export function registerToolDefinitions(ctx, options = {}) {
  const { label = 'tools', build, guard } = options
  if (typeof build !== 'function') return
  provide(ctx, 'tools', label, (scoped) => {
    const tools = service(scoped, 'tools')
    if (tools === undefined || typeof tools.register !== 'function') return () => {}
    const disposers = []
    for (const definition of build(scoped)) {
      try {
        const dispose = tools.register(wrapToolDefinition(definition, scoped))
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        warnMount(`${label}: cannot register ${definition.name}: ${brief(error)}`, scoped)
      }
    }
    if (typeof guard === 'function') {
      try {
        if (typeof tools.guard === 'function') {
          const check = guard(scoped)
          if (typeof check === 'function') {
            const dispose = tools.guard(check)
            if (typeof dispose === 'function') disposers.push(dispose)
          }
        }
      } catch (error) {
        warnMount(`${label}: heartbeat guard not registered: ${brief(error)}`, scoped)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A tool disposer must never break plugin unload.
        }
      }
    }
  })
}

/**
 * Mount one module sub-plugin: exactly one tool definition, same registration,
 * wrapping and unload semantics as the shared plugin. Never throws into the
 * host, so a missing tools/skills/systemPrompt service just means "no tool".
 */
export function mountModule(ctx, { label, buildDefinition, config }) {
  try {
    registerToolDefinitions(ctx, {
      label,
      build: (scoped) => [buildDefinition(toolDeps(scoped), config)],
    })
  } catch (error) {
    warnMount(`${label}: registration failed: ${brief(error)}`, ctx)
  }
}
