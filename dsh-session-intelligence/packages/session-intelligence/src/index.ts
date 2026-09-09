/**
 * Model-facing `session_health` tool: per-session health intelligence
 * (outcome classification, tool-health signals, prompt/workflow heuristics,
 * context pressure, A–F health grade) computed in-process from the deployment's
 * session store.
 *
 * The tool reads only the caller workspace's sessions through the deployment's
 * `sessionQuery` service (live-preferred, backend-agnostic, already
 * authorized) — no filesystem access, no realm, no persistence of its own.
 * Unreadable sessions are counted and reported, never fatal. The same engine
 * backs the standalone CLI (`./cli`), so both surfaces report identical
 * numbers.
 *
 * Namespace plugin (named exports, no default export).
 * @module @hy-sde-org/dsh-session-intelligence
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionResultFilter } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { analyzeSession } from './adapter/dsh.ts'
import type { HealthSessionLike } from './adapter/dsh.ts'
import {
  parseRecentEditsArgs,
  parseSessionHealthArgs,
  parseSessionInsightsArgs,
  recentEditsParameters,
  sessionHealthParameters,
  sessionInsightsParameters,
} from './input.ts'
import {
  formatRecentEdits,
  formatRecentHealth,
  formatSessionHealth,
  formatToolFrequency,
} from './presentation.ts'
import { analyzeSessions } from './insights/analyze.ts'
import { collectRecentEdits } from './recentedits.ts'

/** Cordis plugin name for Loader diagnostics. */
export const name = 'tool-session-intelligence'

/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt', 'sessionQuery']

/** Default maximum number of most-recent sessions scanned by one call. */
export const DEFAULT_MAX_SESSIONS = 200

/** Default session-health table size for action `recent`. */
export const DEFAULT_RECENT_LIMIT = 20

/** Default whole-tool-call timeout budget (ms). */
export const DEFAULT_SESSION_HEALTH_TIMEOUT_MS = 60_000

/** The stable system-prompt guidance positioning the intelligence tools. */
export const PROMPT_TEXT =
  'Use session_health to check how past sessions in this workspace went: outcome (completed/abandoned/errored), '
  + 'A–F health grade with basis + penalties, tool failure/retry/churn signals, prompt-quality heuristics, '
  + 'and context-pressure/compaction signals (action "recent" for one table, "session" for the full report). '
  'Use session_recent_edits to list the workspace\'s recently edited files (Edit/Write calls), newest first, '
  + 'with a path filter and per-file recent edits. '
  + 'Use session_insights (action "tool-frequency") to rank the workspace\'s tool calls by frequency with '
  + 'per-tool session coverage and error counts.'

/** Plugin configuration: scan caps and timeout budgets. */
export interface Config {
  /** Maximum sessions scanned per call. Defaults to 200. */
  maxSessions?: number
  /** Default table size for action `recent`. Defaults to 20. */
  recentLimit?: number
  /** Whole-tool-call timeout budget in ms. Defaults to 60000. */
  timeoutMs?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxSessions: z.number().step(1).min(1).default(DEFAULT_MAX_SESSIONS),
  recentLimit: z.number().step(1).min(1).max(200).default(DEFAULT_RECENT_LIMIT),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SESSION_HEALTH_TIMEOUT_MS),
})

interface ResolvedConfig {
  readonly maxSessions: number
  readonly recentLimit: number
  readonly timeoutMs: number
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Register the `session_health` tool and its shared model guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:session-health',
    order: 131,
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'session_health',
    description:
      'Inspect DSH sessions of the caller workspace and report per-session health: outcome classification '
      + '(completed/abandoned/errored/unknown with confidence), A–F health grade with basis categories and '
      + 'penalties, tool failure/retry/edit-churn signals, prompt-quality heuristics (short prompts, '
      + 'unstructured starts, missing criteria, duplicate prompts, runaway tool loops), and context pressure '
      + '(compactions, mid-task compactions, peak tokens vs model window).',
    parameters: sessionHealthParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeSessionHealth(ctx, args, exec, resolved),
    presentCall: () => ({ card: 'generic' as const, kind: 'read' as const, title: 'Analyze session health' }),
  }))

  ctx.tools.register(defineTool({
    name: 'session_recent_edits',
    description:
      'List the caller workspace\'s recently edited files: paths from Edit/Write tool calls across past '
      + 'sessions, grouped per file and sorted by most-recent edit with up to a few inlined edits per file. '
      + 'Optional case-insensitive path substring filter; returns a markdown table plus per-file detail.',
    parameters: recentEditsParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeRecentEdits(ctx, args, exec, resolved),
    presentCall: () => ({ card: 'generic' as const, kind: 'read' as const, title: 'List recent file edits' }),
  }))

  ctx.tools.register(defineTool({
    name: 'session_insights',
    description:
      'Rank the caller workspace\'s tool calls by frequency (highest to lowest) with per-tool session coverage '
      + 'and error counts — answer "which tools are useful". `bash` calls are broken down into the commands they '
      + 'run (e.g. ls, rg, grep, git), so one row per command. Merged from @hy-sde-org/dsh-tool-session-insights.',
    parameters: sessionInsightsParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeSessionInsights(ctx, args, exec, resolved),
    presentCall: () => ({ card: 'generic' as const, kind: 'read' as const, title: 'Analyze session tool call frequency' }),
  }))
}

/** Run `session_health` for the caller workspace. */
async function executeSessionHealth(
  ctx: Context,
  args: unknown,
  exec: ToolRunContext,
  resolved: ResolvedConfig,
): Promise<string> {
  const input = parseSessionHealthArgs(args)
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError(
      'session_health requires an agent-bound caller',
      'SESSION_HEALTH_MISSING_AGENT',
    )
  }
  const callerCwd = agent.session.header.cwd
  if (callerCwd === undefined) {
    throw new HarnessError(
      'session_health is unavailable because the caller session has no workspace',
      'SESSION_HEALTH_NO_WORKSPACE',
    )
  }

  const filters: SessionResultFilter[] = [{ kind: 'cwd', values: [callerCwd] }]
  if (input.sinceMs !== undefined) {
    filters.push({ kind: 'created-at', from: input.sinceMs })
  }
  const records = await ctx.sessionQuery.filterSessions(filters, exec.signal)

  if (input.action === 'session') {
    const record = records.find(r => r.header.id === input.sessionId)
    if (record === undefined) {
      throw new HarnessError(
        `session_health found no session ${input.sessionId} in the caller workspace`,
        'SESSION_HEALTH_SESSION_NOT_FOUND',
      )
    }
    const session = await readSessionOrThrow(ctx, record)
    return formatSessionHealth(analyzeSession(session))
  }

  const selected = records.slice(0, input.limit ?? resolved.recentLimit)
  const { sessions, unreadable } = await loadRecentSessions(ctx, exec, selected)
  return formatRecentHealth(sessions.map(s => analyzeSession(s)), { unreadable })
}

/** Run `session_insights` (tool-frequency) for the caller workspace. */
async function executeSessionInsights(
  ctx: Context,
  args: unknown,
  exec: ToolRunContext,
  resolved: ResolvedConfig,
): Promise<string> {
  const input = parseSessionInsightsArgs(args)
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError(
      'session_insights requires an agent-bound caller',
      'SESSION_HEALTH_MISSING_AGENT',
    )
  }
  const callerCwd = agent.session.header.cwd
  if (callerCwd === undefined) {
    throw new HarnessError(
      'session_insights is unavailable because the caller session has no workspace',
      'SESSION_HEALTH_NO_WORKSPACE',
    )
  }
  if (input.workspace !== undefined && input.workspace !== callerCwd) {
    throw new HarnessError(
      `session_insights may only analyze the caller workspace (${callerCwd})`,
      'SESSION_INSIGHTS_UNAUTHORIZED',
    )
  }

  const filters: SessionResultFilter[] = [{ kind: 'cwd', values: [callerCwd] }]
  if (input.sinceMs !== undefined) {
    filters.push({ kind: 'created-at', from: input.sinceMs })
  }
  const records = await ctx.sessionQuery.filterSessions(filters, exec.signal)
  const selected = records.slice(0, input.limit ?? resolved.maxSessions)
  const { sessions, unreadable } = await loadRecentSessions(ctx, exec, selected)

  const report = analyzeSessions({
    workspace: callerCwd,
    sessions,
    sessionReadFailures: unreadable,
  })
  return formatToolFrequency(report, {
    ...(input.top !== undefined ? { top: input.top } : {}),
  })
}

/** Run `session_recent_edits` for the caller workspace. */
async function executeRecentEdits(
  ctx: Context,
  args: unknown,
  exec: ToolRunContext,
  resolved: ResolvedConfig,
): Promise<string> {
  const input = parseRecentEditsArgs(args)
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError(
      'session_recent_edits requires an agent-bound caller',
      'SESSION_HEALTH_MISSING_AGENT',
    )
  }
  const callerCwd = agent.session.header.cwd
  if (callerCwd === undefined) {
    throw new HarnessError(
      'session_recent_edits is unavailable because the caller session has no workspace',
      'SESSION_HEALTH_NO_WORKSPACE',
    )
  }

  const filters: SessionResultFilter[] = [{ kind: 'cwd', values: [callerCwd] }]
  if (input.sinceMs !== undefined) {
    filters.push({ kind: 'created-at', from: input.sinceMs })
  }
  const records = await ctx.sessionQuery.filterSessions(filters, exec.signal)
  const selected = records.slice(0, resolved.maxSessions)
  const { sessions } = await loadRecentSessions(ctx, exec, selected)

  const files = collectRecentEdits(sessions, {
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.perFile !== undefined ? { perFile: input.perFile } : {}),
  })
  return formatRecentEdits(files, {
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.path !== undefined ? { path: input.path } : {}),
  })
}

/** Read session logs for a batch of records; unreadable ones are skipped. */
async function loadRecentSessions(
  ctx: Context,
  exec: ToolRunContext,
  records: readonly SessionRecord[],
): Promise<{ readonly sessions: HealthSessionLike[]; readonly unreadable: number }> {
  const sessions: HealthSessionLike[] = []
  let unreadable = 0
  for (const record of records) {
    exec.signal.throwIfAborted()
    try {
      const log = await ctx.sessionQuery.readSession(record.header.id)
      sessions.push({
        id: record.header.id,
        createdAt: record.header.createdAt,
        inheritedEventCount: log.inheritedEventCount,
        events: log.events.map((event): HealthSessionLike['events'][number] => ({
          seq: event.seq,
          time: event.time,
          type: event.type,
          data: event.data,
        })),
      })
    } catch {
      // One unreadable session must not abort the whole analysis.
      unreadable += 1
    }
  }
  return { sessions, unreadable }
}

/** One session record from the sessionQuery filter result. */
type SessionRecord = Awaited<ReturnType<Context['sessionQuery']['filterSessions']>>[number]

/** Read one session log through sessionQuery; unreadable → named error. */
async function readSessionOrThrow(ctx: Context, record: SessionRecord): Promise<HealthSessionLike> {
  try {
    const log = await ctx.sessionQuery.readSession(record.header.id)
    return {
      id: record.header.id,
      createdAt: record.header.createdAt,
      inheritedEventCount: log.inheritedEventCount,
      events: log.events.map((event): HealthSessionLike['events'][number] => ({
        seq: event.seq,
        time: event.time,
        type: event.type,
        data: event.data,
      })),
    }
  } catch (error) {
    throw new HarnessError(
      `session_health could not read session ${record.header.id}`,
      'SESSION_HEALTH_UNREADABLE',
      { cause: error },
    )
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS
  const recentLimit = config.recentLimit ?? DEFAULT_RECENT_LIMIT
  const timeoutMs = config.timeoutMs ?? DEFAULT_SESSION_HEALTH_TIMEOUT_MS
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
    throw new TypeError('tool-session-intelligence: maxSessions must be a positive safe integer')
  }
  if (!Number.isSafeInteger(recentLimit) || recentLimit < 1 || recentLimit > 200) {
    throw new TypeError('tool-session-intelligence: recentLimit must be a safe integer between 1 and 200')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `tool-session-intelligence: timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return { maxSessions, recentLimit, timeoutMs }
}

export { analyzeSession } from './adapter/dsh.ts'
export type { HealthSessionLike, SessionSignals } from './adapter/dsh.ts'
export {
  parseRecentEditsArgs,
  parseSessionHealthArgs,
  parseSessionInsightsArgs,
  recentEditsParameters,
  sessionHealthParameters,
  sessionInsightsParameters,
} from './input.ts'
export {
  formatRecentEdits,
  formatRecentHealth,
  formatSessionHealth,
  formatToolFrequency,
} from './presentation.ts'
export { analyzeSessions, bashCommands } from './insights/analyze.ts'
export type {
  SessionEventLike,
  SessionLike,
  ToolFrequencyReport,
  ToolFrequencyRow,
} from './insights/analyze.ts'
export {
  collectRecentEdits,
  resolveFilePath,
} from './recentedits.ts'
export type {
  EditOccurrence,
  RecentEditFile,
  RecentEditsOptions,
} from './recentedits.ts'
export {
  analyzeHeuristics,
  classifyOutcome,
  computeContextPressure,
  computeHealthScore,
  computeToolHealth,
  countMidTaskCompactions,
  isFailure,
  normalizeToolCategory,
} from './engine/index.ts'
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
} from './engine/types.ts'
