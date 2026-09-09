/**
 * Unit tests for the P2 push gate: verdict recording identity and the pure
 * decidePushGate matrix (fast posture, missing/stale/reject verdicts, warn
 * degradation). Real-repo integration lives in commit.spec.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearReviewVerdicts,
  decidePushGate,
  latestStagedVerdict,
  recordReviewVerdict,
  type ReviewVerdictRecord,
} from '../src/push-gate.ts'

const ROOT = '/repo/main'
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TREE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function record(overrides: Partial<ReviewVerdictRecord> = {}): ReviewVerdictRecord {
  return {
    root: ROOT,
    target: 'staged',
    verdict: 'ship',
    beforeHead: HEAD,
    indexTree: TREE,
    at: 1,
    ...overrides,
  }
}

beforeEach(() => { clearReviewVerdicts() })

describe('decidePushGate', () => {
  it('skips the gate entirely under an explicit fast posture (with a note)', () => {
    const decision = decidePushGate({
      posture: 'fast',
      record: undefined,
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toContain('push gate skipped')
  })

  it('blocks a gated push with no verdict (fail-closed)', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: undefined,
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('never been reviewed')
    expect(decision.reason).toContain('review --target staged')
  })

  it('degrades to a loud warning under onUnavailable: warn when there is no verdict', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: undefined,
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'warn',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toContain('onUnavailable: warn')
  })

  it('refuses when the latest review targeted worktree, not the staged range', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: record({ target: 'worktree' }),
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('not the staged range')
  })

  it('refuses a stale verdict after HEAD moved', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: record({ beforeHead: 'old-head' }),
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('HEAD moved')
  })

  it('refuses a stale verdict when the staged tree changed after the review', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: record({ indexTree: 'old-tree' }),
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('staged tree changed')
  })

  it('blocks a reject verdict even under onUnavailable: warn', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: record({ verdict: 'reject' }),
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'warn',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('reject')
  })

  it('releases a push when a current ship verdict covers the exact staged range', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: record(),
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toContain('ship')
    expect(decision.reason).toContain('current staged range')
  })
})

describe('verdict recording identity', () => {
  it('keeps one record per target so a worktree review does not shadow a staged verdict', () => {
    recordReviewVerdict(record({ target: 'staged' }))
    recordReviewVerdict(record({ target: 'worktree', at: 2 }))
    expect(latestStagedVerdict(ROOT)?.target).toBe('staged')
    expect(latestStagedVerdict('/repo/other')).toBeUndefined()
    recordReviewVerdict(record({ target: 'staged', beforeHead: 'newer' }))
    expect(latestStagedVerdict(ROOT)?.beforeHead).toBe('newer')
  })

  it('clearReviewVerdicts drops everything', () => {
    recordReviewVerdict(record())
    clearReviewVerdicts()
    expect(latestStagedVerdict(ROOT)).toBeUndefined()
  })
})
