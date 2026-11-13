// project-flow — 描述阶段门适配器（description 域，2026-11-11 Phase 1 拆分）。
//
// `updateTask` 推进阶段时经 core 装配的钩子调用本模块：同步、只读、**绝不取锁**，
// 按 spec §7 判定门槛：**哪一档由 `DESCRIPTION_STAGE_POLICY[stage].gate` 决定**，
// 本文件不再自己列阶段名单，也不再硬编码「哪档要测试证据」——两者都从同域的
// 单表派生（见 `./records.mjs` 的 `DESCRIPTION_STAGE_POLICY`）。
// 依赖方向：gate → ./records.mjs（同域的台账检查）+ util + store/contract，
// **不 import core**。
//
// 单独成文件的理由：这是 tasks ↔ description 之间唯一的方向性接缝。tasks 通过
// `configureTasks({ descriptionGate })` 注入本函数（见 lib/tasks/records.mjs 的
// HOOKS），所以 tasks 不 import 描述域、描述域也不 import core，两边都不成环。
//
// 门槛判定复用 `./records.mjs` 的内部件（`descriptionIssue` 等），不复制一份规则：
// 阶段门与 `flow check description` 必须给出同形状的失败项。

import { join, resolve } from 'node:path'

import { invalid, isPlainObject } from '../util.mjs'
import { normalizeContract } from '../store/contract.mjs'
import {
  checkDescription,
  descriptionConfigOf,
  descriptionEnforce,
  descriptionFilesAt,
  descriptionIssue,
  descriptionPaths,
  descriptionStagePolicy,
  readJsonRecord,
} from './records.mjs'

/** `description gate: <to>: <kind> <path>[:<module>] … — <hint>` 的失败清单段。 */
function descriptionGateFailure(failed) {
  const shown = failed
    .slice(0, 3)
    .map((item) => `${item.kind} ${item.path}${item.module === undefined ? '' : `:${item.module}`}`)
    .join(' ')
  return failed.length > 3 ? `${shown} …（共 ${failed.length} 项）` : shown
}

/** 修复命令：按失败 kind 选一条（spec §7 只认这三种入口）。 */
function descriptionGateHint(failed, taskId, config) {
  const kinds = new Set(failed.map((item) => item.kind))
  const testGate = typeof config.testGate === 'string' ? config.testGate.trim() : ''
  if (kinds.has('tests-missing') && testGate !== '') return `flow gate run ${testGate}`
  if (kinds.has('plan-missing') || kinds.has('plan-invalid')) return `flow desc plan ${taskId} --input <json>`
  return `flow desc apply ${taskId}`
}

/** `gate:'plan'` 档（`queued-implementation`）的门槛：计划存在且（files 非空 xor noSemanticChange+reason）。 */
function planGateItems(plan, taskId) {
  if (plan === null) {
    return [
      descriptionIssue(
        'plan-missing',
        '.',
        `task ${taskId} 没有语义变更计划`,
        `flow desc plan ${taskId} --input <json>`,
        { level: 'fail' }
      ),
    ]
  }
  const hasFiles = Array.isArray(plan.files) && plan.files.length > 0
  const reason = typeof plan.reason === 'string' ? plan.reason.trim() : ''
  const noChange = plan.noSemanticChange === true && reason !== ''
  if (hasFiles === noChange) {
    return [
      descriptionIssue(
        'plan-invalid',
        '.',
        hasFiles
          ? 'noSemanticChange 与 files 不能同时给出'
          : '计划必须给出 files，或 noSemanticChange:true 加非空 reason',
        `flow desc plan ${taskId} --input <json>`,
        { level: 'fail' }
      ),
    ]
  }
  return []
}

/**
 * 阶段门（spec §7，唯一实现点 `updateTask`）：同步、只读、**绝不取锁**。
 *
 * 豁免顺序即语义：内部写（`internal`）/ 汇总轮（`aggregate`，只豁免描述门，验收门
 * 照常）→ 非目标阶段 → 幂等重写 → 子任务 → `enabled:false` →
 * `enforce=off` → `auto` 且台账为空。
 *
 * 目标阶段与档位**全部来自 `DESCRIPTION_STAGE_POLICY`**：`gate === null` 不设门；
 * `gate === 'plan'` 只看计划形状（`queued-implementation`，不改代码，也就不查漂移）；
 * `gate === 'full'` 跑完整 `checkDescription`（含计划项 / 未计划改动 / 测试证据），
 * 其中 `requireTests === true` 的阶段（`done`）额外要求测试证据。
 *
 * 两种调用形态都支持：`(root, contract, nextTask, {source, from, to})`（spec §8 +
 * `updateTask` 的实际形状）与 `(root, contract, {task, from, to, source})`。
 *
 * @returns {undefined} 通过时返回 `undefined`
 * @throws {FlowError} code=`invalid`
 */
export function assertDescriptionGate(root, contract, nextTask, options = {}) {
  const absRoot = resolve(root)
  const c = normalizeContract(absRoot, contract)
  let bag = isPlainObject(options) ? options : {}
  let task = isPlainObject(nextTask) ? nextTask : null
  // 第二形态：第三参本身就是选项包（含 `task` 而不是 `id`）。
  if (
    task !== null &&
    !Object.hasOwn(task, 'id') &&
    !Object.hasOwn(task, 'stage') &&
    (Object.hasOwn(task, 'task') || Object.hasOwn(task, 'to'))
  ) {
    bag = task
    task = isPlainObject(bag.task) ? bag.task : null
  }

  const source = typeof bag.source === 'string' ? bag.source : undefined
  // `internal`：插件收口/迁移，连验收门一起豁免（不是语义完成）。
  // `aggregate`：**汇总轮**（T-20261111170544）——分析者核对完子任务的审查结论后收口
  // 父任务。汇总不产生新的语义变更，所以没有计划可看；但它**是**语义完成，验收门必须
  // 照常判定，因此这里只豁免描述门，不能复用 `internal`。
  if (source === 'internal' || source === 'aggregate') return
  if (task === null || typeof task.id !== 'string' || task.id === '') return

  const to = typeof bag.to === 'string' ? bag.to : (typeof task.stage === 'string' ? task.stage : '')
  // 未知阶段 / 不设门的阶段：本适配器不判定（阶段合法性是阶段机的事）。
  const policy = descriptionStagePolicy(to)
  if (policy === null || policy.gate === null) return

  const from = typeof bag.from === 'string' ? bag.from : null
  // 同一阶段的重写是合法幂等（`canTransition` 也这么定义）：重试不该先过门。
  if (from !== null && from === to) return

  // 子任务不承担项目级语义（spec §7 豁免一）。`parent: null` / `''` 都是根任务。
  if (typeof task.parent === 'string' && task.parent.trim() !== '') return

  const config = descriptionConfigOf(c)
  if (config.enabled === false) return
  const mode = descriptionEnforce(config)
  if (mode === 'off') return

  const records = descriptionFilesAt(descriptionPaths(absRoot, c))
  // `auto` 只约束「已经有描述的 store」：老项目 / 新项目第一次推阶段不能红。
  if (mode === 'auto' && records.length === 0) return

  let failed
  if (policy.gate === 'plan') {
    const plan = readJsonRecord(join(descriptionPaths(absRoot, c).tasks, `${task.id}.json`), 'description plan')
    failed = planGateItems(plan, task.id)
  } else {
    // `done` 要测试证据 `requireTests:true`；`queued-review` 不要求（apply/回归可能还没跑完）。
    // 这一位同样来自表，不在调用点写死阶段名。
    const result = checkDescription(absRoot, c, {
      taskId: task.id,
      stage: to,
      requireTests: policy.requireTests === true,
    })
    failed = result.failed
  }
  if (failed.length === 0) return

  throw invalid(`description gate: ${to}: ${descriptionGateFailure(failed)} — ${descriptionGateHint(failed, task.id, config)}`)
}
