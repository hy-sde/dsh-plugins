/**
 * P2 same-quality gate: no unreviewed change leaves the repository under a
 * `review-gated` posture. `review --target staged` records a verdict over the
 * exact staged range (pre-commit HEAD + index tree identity); `commit_apply
 * --push` consults it before touching `origin` and refuses when the verdict is
 * missing, stale, non-staged, or `reject`. Fail-closed by default.
 *
 * Verdicts live in this process (one host = one tool-git instance). A host
 * restart forgets them — that is deliberately fail-closed: a deployment must
 * re-review after a restart before the gate releases a push.
 * @module @hy-sde-org/dsh-tool-git/push-gate
 */

import type { GitService } from '@hy-sde-org/dsh-git'

/** The review targets that can produce a verdict. */
export type ReviewTarget = 'worktree' | 'staged' | 'commits'

/** One review verdict, keyed by repository root + target. */
export interface ReviewVerdictRecord {
  /** Repository root (`git rev-parse --show-toplevel`) of the reviewed checkout. */
  root: string
  /** Which diff the reviewers actually saw. */
  target: ReviewTarget
  verdict: 'ship' | 'reject'
  /** HEAD hash when the review ran — part of the staged-range identity. */
  beforeHead: string
  /** Index tree (`git write-tree`) when the review ran — null when unreadable. */
  indexTree: string | null
  /** Epoch ms of the review run (diagnostics only; staleness is identity-based). */
  at: number
}

/** Per-root record sets keep one record per target (a later worktree review must not shadow a staged verdict). */
type RecordSet = { [T in ReviewTarget]?: ReviewVerdictRecord }

const verdicts = new Map<string, RecordSet>()

/** Record (or replace) one review verdict. */
export function recordReviewVerdict(record: ReviewVerdictRecord): void {
  const set = verdicts.get(record.root) ?? {}
  set[record.target] = record
  verdicts.set(record.root, set)
}

/** Latest staged-target verdict for a repository root, if any. */
export function latestStagedVerdict(root: string): ReviewVerdictRecord | undefined {
  return verdicts.get(root)?.staged
}

/** Test-only: drop all recorded verdicts. */
export function clearReviewVerdicts(): void {
  verdicts.clear()
}

/** Read the index tree identity; null when the index is unreadable (e.g. conflicts). */
export async function indexTreeOf(git: GitService, cwd: string, signal: AbortSignal | undefined): Promise<string | null> {
  const run = await git.run(['write-tree'], { cwd, signal })
  return run.exitCode === 0 ? run.stdout.trim() : null
}

/** Current HEAD hash identity; '' when unborn. */
export async function headOf(git: GitService, cwd: string, signal: AbortSignal | undefined): Promise<string> {
  // Unborn branches (no commits yet) exit non-zero: report '' so the gate can
  // never match a recorded verdict on a repo that had no HEAD at review time.
  const run = await git.run(['log', '-1', '--format=%H'], { cwd, signal })
  return run.exitCode === 0 ? run.stdout.trim() : ''
}

export interface PushGateDecision {
  allowed: boolean
  /** Success path note (recorded in tool `warnings`) or the refusal reason. */
  reason: string
}

/**
 * Decide whether one `commit_apply --push` may proceed under the review gate.
 * @param posture - the repository's resolved standing posture.
 * @param record - the latest staged review verdict (undefined = never reviewed).
 * @param beforeHead - HEAD identity at `commit_apply` start.
 * @param indexTree - index tree identity at `commit_apply` start (null = unreadable).
 * @param requireVerdict - the verdict that releases a push.
 * @param onUnavailable - `block` (fail-closed) or `warn` (loud degrade) when no
 *                        current `ship` verdict exists. A `reject` verdict or a
 *                        stale/mismatched identity ALWAYS blocks.
 */
export function decidePushGate(args: {
  posture: 'review-gated' | 'fast'
  record: ReviewVerdictRecord | undefined
  beforeHead: string
  indexTree: string | null
  requireVerdict: 'ship'
  onUnavailable: 'block' | 'warn'
}): PushGateDecision {
  const { posture, record, beforeHead, indexTree, requireVerdict, onUnavailable } = args
  if (posture === 'fast') {
    return { allowed: true, reason: 'push gate skipped: this repository has an explicit `fast` posture' }
  }
  if (record === undefined) {
    const reason = 'commit_apply --push is gated but this staged range has never been reviewed — run `review --target staged` first'
    return onUnavailable === 'block'
      ? { allowed: false, reason: `${reason} (or record an explicit \`fast\` posture for this repository)` }
      : { allowed: true, reason: `${reason}; pushing anyway because \`reviewGate.onUnavailable: warn\`` }
  }
  if (record.target !== 'staged') {
    const reason = `the latest review targeted \`${record.target}\`, not the staged range — run \`review --target staged\``
    return onUnavailable === 'block'
      ? { allowed: false, reason }
      : { allowed: true, reason: `${reason}; pushing anyway because \`reviewGate.onUnavailable: warn\`` }
  }
  const stale = record.beforeHead !== beforeHead || record.indexTree !== indexTree
  if (stale) {
    const identity = record.beforeHead !== beforeHead
      ? 'HEAD moved since the review'
      : 'the staged tree changed since the review'
    return { allowed: false, reason: `stale review verdict — ${identity}; re-run \`review --target staged\`` }
  }
  if (record.verdict !== requireVerdict) {
    return {
      allowed: false,
      reason: `the review verdict was \`${record.verdict}\`, not \`${requireVerdict}\` — fix the findings and re-run \`review --target staged\``,
    }
  }
  return {
    allowed: true,
    reason: `push gated: latest staged review returned \`${record.verdict}\` for the current staged range`,
  }
}
