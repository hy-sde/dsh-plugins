/**
 * Penalty-based health scoring.
 *
 * Ported from agentsview (MIT, Kenn Software) `internal/signals/score.go`
 * (`ComputeHealthScore`). Starts at 100, subtracts penalty terms, floors at
 * 0; grades A–F; reports contributing basis categories and per-signal
 * penalties. Pure computation over pre-computed signals.
 *
 * @module @hy-sde-org/dsh-session-intelligence/engine/score
 */

import type { HeuristicSignals, ScoreInput, ScoreResult } from './types.ts'

/**
 * Compute a penalty-based health score from session signals.
 * @param input - all signals.
 * @returns score + breakdown; empty result when not scorable.
 */
export function computeHealthScore(input: ScoreInput): ScoreResult {
  const basis = buildBasis(input)

  if (!canScore(input, basis)) {
    return { score: null, grade: '', basis, penalties: {} }
  }

  const penalties = computePenalties(input)

  let score = 100
  for (const penalty of Object.values(penalties)) {
    score -= penalty
  }
  if (score < 0) score = 0

  return {
    score,
    grade: gradeFromScore(score),
    basis,
    penalties,
  }
}

function buildBasis(input: ScoreInput): string[] {
  const basis = ['outcome']
  if (input.hasToolCalls) basis.push('tool_health')
  if (input.hasContextData) basis.push('context_pressure')
  if (hasPromptQualitySignals(input.heuristics)) basis.push('prompt_quality')
  if (input.heuristics.noCodeContextCount > 0) basis.push('context_quality')
  if (input.heuristics.runawayToolLoopCount > 0) basis.push('workflow_quality')
  return basis
}

/**
 * Whether there is enough data for a meaningful score: only unknown/low
 * outcome with no other signals is unscorable.
 */
function canScore(input: ScoreInput, basis: readonly string[]): boolean {
  if (input.outcome !== 'unknown' || input.outcomeConfidence !== 'low') return true
  return basis.length > 1
}

function computePenalties(input: ScoreInput): Record<string, number> {
  const penalties: Record<string, number> = {}
  applyOutcomePenalty(input.outcome, penalties)
  applyToolPenalties(input, penalties)
  applyContextPenalties(input, penalties)
  applyHeuristicPenalties(input, penalties)
  return penalties
}

function hasPromptQualitySignals(heuristics: HeuristicSignals): boolean {
  return heuristics.shortPromptCount > 0
    || heuristics.unstructuredStart
    || heuristics.missingSuccessCriteriaCount > 0
    || heuristics.missingVerificationCount > 0
    || heuristics.duplicatePromptCount > 0
}

function applyOutcomePenalty(outcome: string, penalties: Record<string, number>): void {
  switch (outcome) {
    case 'errored':
      penalties['outcome_errored'] = 30
      break
    case 'abandoned':
      penalties['outcome_abandoned'] = 15
      break
    default:
      break
  }
}

function applyToolPenalties(input: ScoreInput, penalties: Record<string, number>): void {
  const failurePenalty = capPenalty(input.failureSignalCount * 3, 30)
  if (failurePenalty > 0) penalties['tool_failure_signals'] = failurePenalty
  const retryPenalty = capPenalty(input.retryCount * 5, 25)
  if (retryPenalty > 0) penalties['tool_retries'] = retryPenalty
  const churnPenalty = capPenalty(input.editChurnCount * 4, 20)
  if (churnPenalty > 0) penalties['edit_churn'] = churnPenalty
  if (input.consecutiveFailMax >= 3) penalties['consecutive_failures'] = 10
}

function applyContextPenalties(input: ScoreInput, penalties: Record<string, number>): void {
  if (input.compactionCount >= 2) {
    const extra = input.compactionCount - 1
    const penalty = capPenalty(extra * 5, 15)
    if (penalty > 0) penalties['compactions'] = penalty
  }
  // Mid-task compactions are weighted heavier than ordinary boundaries.
  if (input.midTaskCompactionCount > 0) {
    const penalty = capPenalty(input.midTaskCompactionCount * 8, 18)
    if (penalty > 0) penalties['mid_task_compactions'] = penalty
  }
  if (input.pressureMax !== null && input.pressureMax > 0.9) {
    penalties['context_pressure_high'] = 10
  }
}

function applyHeuristicPenalties(input: ScoreInput, penalties: Record<string, number>): void {
  const heuristics = input.heuristics
  if (heuristics.unstructuredStart) penalties['constraintless_first_prompt'] = 1
  if (heuristics.missingSuccessCriteriaCount > 0 && heuristics.unstructuredStart) {
    penalties['missing_success_criteria'] = 1
  }
  if (isStuckReask(input)) {
    const penalty = capPenalty(heuristics.duplicatePromptCount * 2, 4)
    if (penalty > 0) penalties['stuck_repeated_prompts'] = penalty
  }
  if (heuristics.noCodeContextCount > 0) penalties['code_task_without_context'] = 4
  const loopPenalty = capPenalty(heuristics.runawayToolLoopCount * 5, 5)
  if (loopPenalty > 0) penalties['repeated_failing_tool_cycles'] = loopPenalty
}

function isStuckReask(input: ScoreInput): boolean {
  if (input.heuristics.duplicatePromptCount <= 0) return false
  return input.outcome === 'errored'
    || input.outcome === 'abandoned'
    || input.failureSignalCount > 0
    || input.retryCount > 0
    || input.consecutiveFailMax >= 3
    || input.heuristics.runawayToolLoopCount > 0
}

function capPenalty(raw: number, max: number): number {
  if (raw > max) return max
  return raw
}

function gradeFromScore(score: number): string {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  if (score >= 40) return 'D'
  return 'F'
}
