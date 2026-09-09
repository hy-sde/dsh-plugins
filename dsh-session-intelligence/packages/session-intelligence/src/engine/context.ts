/**
 * Context-pressure signals: mid-task compaction detection and token-pressure
 * ratio against known model context windows.
 *
 * Ported from agentsview (MIT, Kenn Software) `internal/signals/context.go`
 * (`CountMidTaskCompactions`, `ComputeContextPressure`). Pure computation.
 *
 * @module @hy-sde-org/dsh-session-intelligence/engine/context
 */

import type { ContextPressureResult, ContextTokenRow, ToolCallOrdinal } from './types.ts'

/** Count of tools immediately before a boundary considered for overlap. */
const midTaskWindowBefore = 10

/** Count of tools immediately after a boundary checked for overlap. */
const midTaskWindowAfter = 5

/** Shared tool names that flag a boundary as mid-task. */
const midTaskOverlapThreshold = 2

/**
 * Count compact boundaries where the first few tool calls after the boundary
 * share names with the tool calls immediately before it. A boundary
 * surrounded by overlapping tool work strongly suggests compaction
 * interrupted active work and the agent is repeating itself.
 *
 * @param boundaryOrdinals - boundary ordinals, sorted ascending.
 * @param toolCalls - each call's message ordinal + tool name, chronological.
 */
export function countMidTaskCompactions(
  boundaryOrdinals: readonly number[],
  toolCalls: readonly ToolCallOrdinal[],
): number {
  if (boundaryOrdinals.length === 0 || toolCalls.length === 0) return 0
  let count = 0
  for (const boundary of boundaryOrdinals) {
    const before = toolWindowBefore(toolCalls, boundary, midTaskWindowBefore)
    const after = toolWindowAfter(toolCalls, boundary, midTaskWindowAfter)
    if (before.length === 0 || after.length === 0) continue
    const beforeSet = new Set(before)
    // Count DISTINCT shared names so a single tool repeated many times after
    // the boundary doesn't inflate the overlap into a false mid-task signal.
    const matched = new Set<string>()
    for (const name of after) {
      if (beforeSet.has(name)) matched.add(name)
    }
    if (matched.size >= midTaskOverlapThreshold) count++
  }
  return count
}

/** Up to `n` tool names from calls strictly before the ordinal, most recent. */
function toolWindowBefore(calls: readonly ToolCallOrdinal[], ordinal: number, n: number): string[] {
  const names: string[] = []
  for (const call of calls) {
    if (call.messageOrdinal < ordinal) names.push(call.toolName)
  }
  if (names.length > n) return names.slice(names.length - n)
  return names
}

/**
 * Up to `n` tool names from calls at-or-after the ordinal, earliest. The
 * boundary ordinal is the first message AFTER the compaction, so its own
 * tool calls are the agent resuming the same work — they belong to the
 * after-window (mirrors agentsview's windowAfter semantics).
 */
function toolWindowAfter(calls: readonly ToolCallOrdinal[], ordinal: number, n: number): string[] {
  const names: string[] = []
  for (const call of calls) {
    if (call.messageOrdinal >= ordinal) {
      names.push(call.toolName)
      if (names.length >= n) break
    }
  }
  return names
}

/** Model name prefixes → context window sizes in tokens. */
const contextWindowSizes: Readonly<Record<string, number>> = {
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-haiku': 200_000,
  'gpt-4o-mini': 128_000,
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  o3: 200_000,
  'o4-mini': 200_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
}

/** Prefixes sorted longest-first so `gpt-4o-mini` matches before `gpt-4o`. */
const sortedPrefixes = Object.keys(contextWindowSizes)
  .sort((left, right) => right.length - left.length)

/**
 * Compute compaction count and peak context pressure from an ordered slice of
 * token rows.
 * @param tokens - context-token rows in chronological order.
 * @param peakContextTokens - peak context tokens observed.
 * @param model - model name ("" when unknown).
 */
export function computeContextPressure(
  tokens: readonly ContextTokenRow[],
  peakContextTokens: number,
  model: string,
): ContextPressureResult {
  return {
    compactionCount: countCompactions(tokens),
    pressureMax: computePressure(peakContextTokens, model),
  }
}

/** Count >30% drops between consecutive entries that both have tokens. */
function countCompactions(tokens: readonly ContextTokenRow[]): number {
  let count = 0
  let prevTokens = -1
  for (const row of tokens) {
    if (!row.hasContextTokens) continue
    if (prevTokens > 0) {
      const threshold = prevTokens * 0.7
      if (row.contextTokens < threshold) count++
    }
    prevTokens = row.contextTokens
  }
  return count
}

/** Ratio of peak tokens to the model's window, or null when unknown. */
function computePressure(peakContextTokens: number, model: string): number | null {
  if (peakContextTokens <= 0 || model === '') return null
  const windowSize = lookupWindowSize(model)
  if (windowSize === 0) return null
  return peakContextTokens / windowSize
}

/** Find the window size for a model: exact match, then longest prefix. */
function lookupWindowSize(model: string): number {
  const exact = contextWindowSizes[model]
  if (exact !== undefined) return exact
  for (const prefix of sortedPrefixes) {
    if (model.startsWith(prefix) && (model.length === prefix.length || model[prefix.length] === '-')) {
      return contextWindowSizes[prefix]!
    }
  }
  return 0
}
