// project-flow TUI side panel entry.
//
// A separate Cordis row from the host half because `tuiPanels` is a hard
// dependency: declaring it keeps this row pending in web and desktop hosts,
// where the service never appears, and keeps the host half free of it.
//
// Known upstream limitation: dsh-tui derives the panel-id prefix from the
// calling activation's Component identity, but a Cordis service can only be
// called from an `inject` scope, which carries no identity — so the panel id is
// the session-scoped `session:actN:flow` and temporary panels are enabled by
// default. The manifest (dsh-plugin.json) still admits the package as the
// Component `project-flow`; once the scope inherits its activation identity the
// id becomes `project-flow:flow` without touching this file.

import { panelStateReader } from './index.js'
import { registerProjectFlowPanel } from './tui-panel.js'

export const inject = ['tuiPanels']

const PANEL_REFRESH_MS = 3000

export function apply(ctx) {
  let dispose
  try {
    dispose = registerProjectFlowPanel(ctx, {
      readState: panelStateReader(ctx),
      refreshMs: PANEL_REFRESH_MS,
      log: (message) => {
        try {
          ctx.logger.warn('project-flow: panel: ' + message)
        } catch {
          // Logging must never break the panel.
        }
      },
    })
  } catch (error) {
    try {
      ctx.logger.warn('project-flow: panel registration failed: ' + String(error && error.message ? error.message : error))
    } catch {
      // keep the host alive
    }
    return
  }
  if (typeof dispose !== 'function') return
  const cleanup = () => {
    try {
      dispose()
    } catch {
      // A panel disposer must never break plugin unload.
    }
  }
  try {
    ctx.effect(() => cleanup)
  } catch {
    cleanup()
  }
}
