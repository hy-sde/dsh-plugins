/**
 * Tool-health signals for a session's tool calls.
 *
 * Ported from agentsview (MIT, Kenn Software) `internal/signals/toolhealth.go`
 * (`ComputeToolHealth`, `IsFailure`). Pure computation over ordered rows:
 * failures come from the event status OR content heuristics (exit status,
 * command not found, Permission denied, Traceback, goroutine dumps, JS stack
 * traces, edit/write "FAILED"); retries are counted from identical
 * consecutive calls; edit churn is 3+ edits to one file inside a 10-ordinal
 * span.
 *
 * @module @hy-sde-org/dsh-session-intelligence/engine/toolhealth
 */

import type { ToolCallRow, ToolHealthSignals } from './types.ts'

const goRoutineRe = /goroutine \d+/
const exitStatusRe = /exit (?:status|code) ([1-9]\d*)/

/**
 * Compute health metrics from an ordered slice of tool call rows.
 * @param calls - tool calls in chronological order.
 * @returns failure/retry/churn/streak signals.
 */
export function computeToolHealth(calls: readonly ToolCallRow[]): ToolHealthSignals {
  const { failures, maxStreak } = countFailures(calls)
  return {
    failureSignalCount: failures,
    retryCount: countRetries(calls),
    editChurnCount: countEditChurn(calls),
    consecutiveFailureMax: maxStreak,
  }
}

/**
 * Whether a tool call represents a failure, either by event status or by
 * content heuristics.
 * @param call - one tool call row.
 */
export function isFailure(call: ToolCallRow): boolean {
  if (call.eventStatus !== '') {
    return call.eventStatus === 'errored' || call.eventStatus === 'cancelled'
  }
  return isContentFailure(call.category, call.resultContent)
}

function isContentFailure(category: string, content: string): boolean {
  switch (category) {
    case 'Bash':
      return isBashFailure(content)
    case 'Edit':
    case 'Write':
      return content.includes('FAILED')
    default:
      return false
  }
}

function isBashFailure(content: string): boolean {
  if (content.includes('command not found')) return true
  if (content.includes('Permission denied')) return true
  if (content.includes('Traceback (most recent call last)')) return true
  if (goRoutineRe.test(content)) return true
  if (hasJsStackTrace(content)) return true
  if (exitStatusRe.test(content)) return hasErrorCompanion(content)
  return false
}

/**
 * Whether content has 3+ consecutive lines starting with `  at `.
 */
function hasJsStackTrace(content: string): boolean {
  let consecutive = 0
  for (const line of content.split('\n')) {
    if (line.startsWith('  at ')) {
      consecutive++
      if (consecutive >= 3) return true
    } else {
      consecutive = 0
    }
  }
  return false
}

/**
 * Error indicators that elevate a non-zero exit code into a real failure.
 */
function hasErrorCompanion(content: string): boolean {
  const companions = [
    'command not found',
    'No such file',
    'Permission denied',
    'fatal:',
    'panic:',
  ]
  if (companions.some(c => content.includes(c))) return true
  if (content.includes('Traceback (most recent call last)')) return true
  if (goRoutineRe.test(content)) return true
  return hasJsStackTrace(content)
}

function countFailures(calls: readonly ToolCallRow[]): { failures: number; maxStreak: number } {
  let failures = 0
  let streak = 0
  let maxStreak = 0
  for (const call of calls) {
    if (isFailure(call)) {
      failures++
      streak++
      if (streak > maxStreak) maxStreak = streak
    } else {
      streak = 0
    }
  }
  return { failures, maxStreak }
}

/**
 * Count retried calls using a sliding window: 3+ consecutive calls with the
 * same tool name AND identical arguments JSON = (count - 1) retries per group.
 */
function countRetries(calls: readonly ToolCallRow[]): number {
  if (calls.length < 3) return 0

  let total = 0
  let runLen = 1

  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1]!
    const current = calls[i]!
    if (current.toolName === prev.toolName && current.inputJson === prev.inputJson) {
      runLen++
    } else {
      if (runLen >= 3) total += runLen - 1
      runLen = 1
    }
  }
  if (runLen >= 3) total += runLen - 1
  return total
}

/**
 * Count churn events for Edit/Write calls: one churn event = 3+ edits to the
 * same file within a 10-ordinal span.
 */
function countEditChurn(calls: readonly ToolCallRow[]): number {
  const fileOrdinals = new Map<string, number[]>()
  for (const call of calls) {
    if (call.category !== 'Edit' && call.category !== 'Write') continue
    const path = extractFilePath(call.inputJson)
    if (path === '') continue
    const ordinals = fileOrdinals.get(path)
    if (ordinals === undefined) {
      fileOrdinals.set(path, [call.messageOrdinal])
    } else {
      ordinals.push(call.messageOrdinal)
    }
  }

  let churn = 0
  for (const ordinals of fileOrdinals.values()) {
    if (hasChurnWindow(ordinals, 3, 10)) churn++
  }
  return churn
}

/**
 * Extract `file_path` from the arguments JSON via a simple string search
 * (mirrors agentsview: no JSON parse overhead, accepts arbitrary spacing? No
 * — the marker is exact, matching agentsview's `"file_path":"`).
 */
function extractFilePath(input: string): string {
  const marker = '"file_path":"'
  const idx = input.indexOf(marker)
  if (idx < 0) return ''
  const start = idx + marker.length
  const end = input.indexOf('"', start)
  if (end < 0) return ''
  return input.slice(start, end)
}

/**
 * Whether any sliding window of `windowSize` ordinals fits within `maxSpan`
 * ordinals. Ordinals need not be sorted — agentsview checks all combinations
 * of contiguous windows in insertion order.
 */
function hasChurnWindow(ordinals: readonly number[], windowSize: number, maxSpan: number): boolean {
  const n = ordinals.length
  if (n < windowSize) return false
  for (let i = 0; i <= n - windowSize; i++) {
    let lo = ordinals[i]!
    let hi = ordinals[i]!
    for (let j = i + 1; j < i + windowSize; j++) {
      const value = ordinals[j]!
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
    if (hi - lo < maxSpan) return true
  }
  return false
}
