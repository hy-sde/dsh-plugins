/**
 * Session-signals engine: pure, deterministic health/outcome computation
 * ported from agentsview (MIT, Kenn Software) `internal/signals`.
 *
 * @module @hy-sde-org/dsh-session-intelligence/engine
 */

export { classifyOutcome, RECENCY_WINDOW_MS } from './outcome.ts'
export { computeToolHealth, isFailure } from './toolhealth.ts'
export { analyzeHeuristics, isFrustrationMarker, countFrustrationMarkers } from './heuristics.ts'
export {
  computeContextPressure,
  countMidTaskCompactions,
} from './context.ts'
export { computeHealthScore } from './score.ts'
export { normalizeToolCategory } from './taxonomy.ts'

export type {
  ContextPressureResult,
  ContextTokenRow,
  HeuristicInput,
  HeuristicMessage,
  HeuristicSignals,
  OutcomeInput,
  OutcomeResult,
  ScoreInput,
  ScoreResult,
  ToolCallOrdinal,
  ToolCallRow,
  ToolCategory,
  ToolHealthSignals,
} from './types.ts'
