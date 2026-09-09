/**
 * Session outcome classification.
 *
 * Ported from agentsview (MIT, Kenn Software) `internal/signals/outcome.go`
 * (`ClassifyOutcome`). Pure computation over metadata — no event access.
 *
 * @module @hy-sde-org/dsh-session-intelligence/engine/outcome
 */

import type { OutcomeInput, OutcomeResult } from './types.ts'

/** Duration within which a session is considered still active. */
export const RECENCY_WINDOW_MS = 10 * 60 * 1000

const giveUpPatterns = [
  "i'm unable to",
  "i can't proceed",
  "i don't have access",
  'i cannot proceed',
  'i am unable to',
] as const

/**
 * Classify a session's outcome based on its metadata.
 * @param input - session facts.
 * @returns the classification result.
 */
export function classifyOutcome(input: OutcomeInput): OutcomeResult {
  if (input.isAutomated) {
    return { outcome: 'unknown', confidence: 'low', isRecent: false }
  }

  if (input.endedWithRole === 'assistant' && hasTerminalApiErrorText(input.lastAssistantText)) {
    if (isRecent(input.lastActivityMs)) {
      return { outcome: 'unknown', confidence: 'low', isRecent: true }
    }
    return { outcome: 'errored', confidence: 'medium', isRecent: false }
  }

  if (input.messageCount === 2 && input.endedWithRole === 'assistant') {
    return { outcome: 'completed', confidence: 'medium', isRecent: false }
  }

  if (input.messageCount < 3) {
    return { outcome: 'unknown', confidence: 'low', isRecent: false }
  }

  if (isRecent(input.lastActivityMs)) {
    return { outcome: 'unknown', confidence: 'low', isRecent: true }
  }

  if (input.endedWithRole === 'user') {
    const confidence = input.messageCount >= 10 ? 'high' : 'medium'
    return { outcome: 'abandoned', confidence, isRecent: false }
  }

  if (input.finalFailureStreak >= 3) {
    return { outcome: 'errored', confidence: 'medium', isRecent: false }
  }

  if (input.endedWithRole === 'assistant') {
    const confidence = hasGiveUpPattern(input.lastAssistantText) ? 'low' : 'medium'
    return { outcome: 'completed', confidence, isRecent: false }
  }

  return { outcome: 'unknown', confidence: 'low', isRecent: false }
}

function isRecent(lastActivityMs: number): boolean {
  if (lastActivityMs <= 0) return false
  return Date.now() - lastActivityMs < RECENCY_WINDOW_MS
}

function hasGiveUpPattern(text: string): boolean {
  const lower = text.toLowerCase()
  return giveUpPatterns.some(pattern => lower.includes(pattern))
}

function hasTerminalApiErrorText(text: string): boolean {
  return text.trim().toLowerCase().startsWith('api error:')
}
