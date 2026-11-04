// T-20261104-12（task-125）：`reviewExperimentRecord` 的 core 单一实现。
//
// review 曾经在 bin/index 各有一份副本，规则比 core 的 checkExperiments 松；
// 这里钉死：七字段完整校验（guardrails 每项非空、windowDays 1..3650）+ 终态
// 硬规则，且与 `checkExperiments` 的 failed 判定一致；四类 verdict/branch 不变。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  checkExperiments,
  initProject,
  loadContract,
  reviewExperimentRecord,
  saveContract,
} from '../lib/core.mjs'

const TEMP_ROOTS = []

after(() => {
  for (const dir of TEMP_ROOTS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function freshProject(label, { experimentsEnabled = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-review-${label}-`))
  TEMP_ROOTS.push(root)
  initProject(root, { name: label, noGates: true })
  const loaded = loadContract(root)
  if (experimentsEnabled) {
    saveContract(root, { ...loaded.contract, experiments: { ...loaded.contract.experiments, enabled: true } })
  }
  return { root, contract: loadContract(root).contract }
}

const BASE = {
  schema: 2,
  id: 'E-20261104-01',
  title: '实验',
  hypothesis: 'H',
  direction: 'D',
  expected: 'E',
  primaryMetric: 'M',
  guardrails: ['G'],
  falsify: 'F',
  windowDays: 7,
  stopLoss: 'S',
  status: 'open',
  factor: '',
  parent: null,
  scale: 'small',
  measured: '',
  metrics: {},
  commits: [],
  notes: '',
  learned: '',
  cleanup: { flags: [], code: [], data: [] },
  cleanupAt: null,
  productizedAt: null,
  productizeGate: null,
  created_at: '2026-11-01T09:00:00+08:00',
  updated_at: '2026-11-01T09:00:00+08:00',
}

function record(overrides = {}) {
  return { ...BASE, ...overrides }
}

test('review 与 check 一致：guardrails 含空串 + windowDays 超上限 → missing 两项且 check failed 两条', () => {
  const { root, contract } = freshProject('counterexample', { experimentsEnabled: true })
  const bad = record({ guardrails: [''], windowDays: 4001 })
  fs.writeFileSync(path.join(root, '.dsh', 'flow', 'experiments', 'E-20261104-01.json'), JSON.stringify(bad))

  const review = reviewExperimentRecord(bad, { hasSuccessor: () => false })
  assert.equal(review.verdict, 'incomplete')
  assert.ok(review.missing.includes('guardrails'), JSON.stringify(review))
  assert.ok(review.missing.includes('windowDays'), JSON.stringify(review))

  const checked = checkExperiments(root, contract)
  assert.equal(checked.ok, false)
  assert.equal(checked.failed.length, 2, JSON.stringify(checked.failed))
  const fields = checked.failed.map((item) => item.rule)
  assert.deepEqual(fields, ['experiment-fields', 'experiment-fields'])
})

test('review 四类 verdict/branch：complete/open、confirmed、refuted、pivoted、legacy', () => {
  // open + 七字段齐全 → complete / uncertain
  assert.deepEqual(reviewExperimentRecord(record(), { hasSuccessor: () => false }), {
    id: 'E-20261104-01',
    verdict: 'complete',
    branch: 'uncertain',
    missing: [],
  })

  // confirmed 未产品化 → incomplete / success，只缺 productizedAt
  const confirmed = record({ status: 'confirmed', measured: 'ok', metrics: { tie: 0.9 } })
  const confirmedReview = reviewExperimentRecord(confirmed, { hasSuccessor: () => false })
  assert.equal(confirmedReview.verdict, 'incomplete')
  assert.equal(confirmedReview.branch, 'success')
  assert.deepEqual(confirmedReview.missing, ['productizedAt'])
  assert.equal(reviewExperimentRecord({ ...confirmed, productizedAt: '2026-11-02T00:00:00+08:00' }).verdict, 'complete')

  // refuted 缺 learned/cleanupAt → failure
  const refuted = record({ status: 'refuted' })
  const refutedReview = reviewExperimentRecord(refuted, { hasSuccessor: () => false })
  assert.equal(refutedReview.branch, 'failure')
  assert.deepEqual(refutedReview.missing, ['learned', 'cleanupAt'])
  assert.equal(
    reviewExperimentRecord({ ...refuted, learned: '不成立', cleanupAt: '2026-11-02T00:00:00+08:00' }).verdict,
    'complete',
  )

  // pivoted 缺 learned/successor → pivot
  const pivoted = record({ status: 'pivoted' })
  const pivotedReview = reviewExperimentRecord(pivoted, { hasSuccessor: () => false })
  assert.equal(pivotedReview.branch, 'pivot')
  assert.deepEqual(pivotedReview.missing, ['learned', 'successor'])
  const pivotComplete = reviewExperimentRecord({ ...pivoted, learned: '换方向' }, { hasSuccessor: () => true })
  assert.equal(pivotComplete.verdict, 'complete')

  // legacy schema1 → incomplete / uncertain，missing 标 schema2
  const legacyReview = reviewExperimentRecord({ schema: 1, id: 'E-20260101-99', status: 'refuted' })
  assert.equal(legacyReview.verdict, 'incomplete')
  assert.equal(legacyReview.branch, 'uncertain')
  assert.match(JSON.stringify(legacyReview.missing), /schema2/)
})
