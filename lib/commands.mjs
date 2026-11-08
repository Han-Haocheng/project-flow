// task-78 · D-20261108-02 = command — **parse only, never execute**.
//
// The user's interface contract: chat is a task, `/command` is not. Capture
// skips command messages (see lib/capture.mjs); this module just recognizes the
// known commands so the per-step reminder can show them to the model. Command
// *semantics* (`/继续` = who continues, `/暂停` = pause what) are deliberately
// not implemented — the user has not defined them yet.

/** The six known commands. Anything else after `/` is an unknown command. */
export const COMMANDS = new Set(['建议', '继续', '暂停', '开始', '决策', '状态'])

/** The command name of one raw message, without the slash; '' when it is not a command. */
export function commandNameOf(text) {
  const value = typeof text === 'string' ? text.trimStart() : ''
  if (value.startsWith('/') === false) return ''
  const body = value.slice(1).trimStart()
  const space = body.search(/\s/)
  return space === -1 ? body : body.slice(0, space)
}

/**
 * Parse one message as a command.
 *
 * @returns `{ name, rest }` for a known command (`/建议 这样做` → `{name:'建议',
 *   rest:'这样做'}`; a bare command has `rest:''`), or `null` when the text is not
 *   a command, is a bare `/`, or names an unknown command.
 *
 * Unknown commands are *not* executed and never touch the ledger; the caller may
 * warn once. Parsing is intentionally side-effect free.
 */
export function parseCommand(text) {
  const value = typeof text === 'string' ? text.trimStart() : ''
  if (value.startsWith('/') === false) return null
  const body = value.slice(1).trimStart()
  if (body === '') return null
  const space = body.search(/\s/)
  const name = space === -1 ? body : body.slice(0, space)
  const rest = space === -1 ? '' : body.slice(space).trim()
  if (COMMANDS.has(name) === false) return null
  return { name, rest }
}
