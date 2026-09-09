/**
 * Shared input/result types for the session-signals engine.
 *
 * These mirror the corresponding Go structs in agentsview
 * (`internal/signals/*.go`) field-for-field so the port stays byte-faithful:
 * every computation below is a pure function of these shapes, and the event
 * adapter (DSH session log → these shapes) is the only place that knows
 * about DeepSeek Harness event layout.
 *
 * @module @hy-sde-org/dsh-session-intelligence/engine/types
 */

/** Normalized tool category (see {@link normalizeToolCategory}). */
export type ToolCategory =
  | 'Read'
  | 'Edit'
  | 'Write'
  | 'Bash'
  | 'Grep'
  | 'Glob'
  | 'Task'
  | 'Tool'
  | 'Other'

/**
 * One ordered tool call row. Populated by the adapter from one
 * `tool/call` + its matching `tool/result` events.
 */
export interface ToolCallRow {
  /** Tool name as recorded in the session. */
  readonly toolName: string
  /** Normalized category. */
  readonly category: string
  /** Raw tool arguments JSON string (as recorded). */
  readonly inputJson: string
  /** Result content text ("" when no result was recorded). */
  readonly resultContent: string
  /** Ordinal of the message that issued the call. */
  readonly messageOrdinal: number
  /** Call position within its message. */
  readonly callIndex: number
  /**
   * Latest result status: `""`, `"errored"`, `"cancelled"` ... When empty,
   * content heuristics decide failure. Mirrors agentsview: the last result
   * event wins.
   */
  readonly eventStatus: string
}

/** Computed health metrics for a session's tool calls. */
export interface ToolHealthSignals {
  readonly failureSignalCount: number
  readonly retryCount: number
  readonly editChurnCount: number
  readonly consecutiveFailureMax: number
}

/** The message subset needed by deterministic session-quality heuristics. */
export interface HeuristicMessage {
  readonly role: string
  readonly content: string
  readonly isSystem: boolean
  readonly ordinal: number
  readonly timestamp: string
}

/** Session data for deterministic prompt/workflow quality analysis. */
export interface HeuristicInput {
  readonly messages: readonly HeuristicMessage[]
  readonly toolRows: readonly ToolCallRow[]
}

/** Coach-derived deterministic session signals. */
export interface HeuristicSignals {
  readonly shortPromptCount: number
  readonly unstructuredStart: boolean
  readonly missingSuccessCriteriaCount: number
  readonly missingVerificationCount: number
  readonly duplicatePromptCount: number
  readonly noCodeContextCount: number
  readonly runawayToolLoopCount: number
}

/** Data needed to classify a session's outcome. */
export interface OutcomeInput {
  readonly isAutomated: boolean
  readonly messageCount: number
  /** `"user"` or `"assistant"`. */
  readonly endedWithRole: string
  readonly finalFailureStreak: number
  readonly lastAssistantText: string
  /** Last activity time in epoch milliseconds (0 = unknown). */
  readonly lastActivityMs: number
}

/** Classification result for a session. */
export interface OutcomeResult {
  /** `"completed"`, `"abandoned"`, `"errored"`, `"unknown"`. */
  readonly outcome: string
  /** `"high"`, `"medium"`, `"low"`. */
  readonly confidence: string
  readonly isRecent: boolean
}

/** One message's context-token measurement. */
export interface ContextTokenRow {
  readonly contextTokens: number
  readonly hasContextTokens: boolean
}

/** A tool call paired with the ordinal of the message that emitted it. */
export interface ToolCallOrdinal {
  readonly messageOrdinal: number
  readonly toolName: string
}

/** Computed context-pressure metrics. */
export interface ContextPressureResult {
  readonly compactionCount: number
  /** Peak pressure ratio, or `null` when unavailable. */
  readonly pressureMax: number | null
}

/** All signals needed to compute a health score. */
export interface ScoreInput {
  readonly outcome: string
  readonly outcomeConfidence: string
  readonly hasToolCalls: boolean
  readonly failureSignalCount: number
  readonly retryCount: number
  readonly editChurnCount: number
  readonly consecutiveFailMax: number
  readonly hasContextData: boolean
  readonly compactionCount: number
  readonly midTaskCompactionCount: number
  readonly pressureMax: number | null
  readonly heuristics: HeuristicSignals
}

/** Computed health score and its breakdown. */
export interface ScoreResult {
  /** `null` when the session cannot be scored. */
  readonly score: number | null
  /** `""`, `"A"`, `"B"`, `"C"`, `"D"`, `"F"`. */
  readonly grade: string
  /** Which categories contributed to the score. */
  readonly basis: readonly string[]
  /** Signal name → penalty applied. */
  readonly penalties: Readonly<Record<string, number>>
}
