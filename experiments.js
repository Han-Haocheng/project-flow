// project-flow — `experiments` module sub-plugin.
//
// The shared `@local/project-flow` plugin carries the store, the HTTP routes,
// the skills, the system-prompt section, the heartbeat/decision machinery and
// the flow_status / flow_heartbeat / flow_decision tools. Mounting this entry
// adds exactly one more model-facing tool, `flow_exp`, through the same mount
// plumbing (one effect, core-warning wrapper, unload-safe) — it registers
// nothing else and never throws when the `tools` service is absent.
//
// One npm package, several independently mountable entries: a host profile adds
// the line that matches the tool surface it wants.

import { mountModule } from './lib/plugin/mount.mjs'
import { buildDefinition } from './lib/tools/experiments.mjs'

export function apply(ctx, config) {
  mountModule(ctx, { label: 'experiments', buildDefinition })
}
