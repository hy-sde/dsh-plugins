/**
 * Tool argument schema and validation for `session_health`.
 *
 * @module @hy-sde-org/dsh-session-intelligence/input
 */

/** Actions the `session_health` tool supports today. */
export const SESSION_HEALTH_ACTIONS = ['session', 'recent'] as const

export type SessionHealthAction = typeof SESSION_HEALTH_ACTIONS[number]

/** Canonical JSON-schema parameters for the `session_health` tool. */
export const sessionHealthParameters = {
  action: {
    type: 'string',
    required: true,
    enum: [...SESSION_HEALTH_ACTIONS],
    description:
      '`session` = one session\'s full health report (requires `sessionId`); `recent` = most-recent sessions of the caller workspace as a health table.',
  },
  sessionId: {
    type: 'string',
    description: 'Session id for action `session` (from `session list` or the generated health table).',
  },
  limit: {
    type: 'number',
    description: 'Maximum number of most-recent sessions for action `recent` (default 20).',
  },
  since: {
    type: 'string',
    description: 'Only sessions created at or after this ISO-8601 timestamp (e.g. 2026-09-01T00:00:00Z).',
  },
} as const

export interface SessionHealthArgs {
  readonly action: SessionHealthAction
  readonly sessionId?: string
  readonly limit?: number
  readonly since?: string
  readonly sinceMs?: number
}

/** Validate raw model arguments and normalize them for execution. */
export function parseSessionHealthArgs(args: unknown): SessionHealthArgs {
  if (args === null || typeof args !== 'object') {
    throw new Error('session_health arguments must be an object')
  }
  const raw = args as Record<string, unknown>
  const action = raw.action
  if (action !== 'session' && action !== 'recent') {
    throw new Error(`session_health action must be one of: ${SESSION_HEALTH_ACTIONS.join(', ')}`)
  }
  const sessionId = raw.sessionId !== undefined ? assertString('sessionId', raw.sessionId) : undefined
  const limit = raw.limit !== undefined ? assertPositiveInteger('limit', raw.limit) : undefined
  const since = raw.since !== undefined ? assertString('since', raw.since) : undefined
  if (action === 'session' && sessionId === undefined) {
    throw new Error('session_health action "session" requires a sessionId')
  }
  return {
    action,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(since !== undefined ? { since, sinceMs: parseSinceMs(since) } : {}),
  }
}

/** Reject a non-string argument value. */
function assertString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`session_health ${name} must be a non-empty string`)
  }
  return value
}

/** Reject a non-positive-safe-integer argument value. */
function assertPositiveInteger(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`session_health ${name} must be a positive integer`)
  }
  return value
}

/** Parse an ISO-8601 timestamp into epoch milliseconds. */
export function parseSinceMs(value: string): number {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new Error(`session_health since must be a parseable ISO-8601 timestamp, got ${value}`)
  }
  return ms
}

/* ------------------------------------------------------------------ */
/* session_recent_edits arguments                                      */
/* ------------------------------------------------------------------ */

/** Canonical JSON-schema parameters for the `session_recent_edits` tool. */
export const recentEditsParameters = {
  path: {
    type: 'string',
    description: 'Case-insensitive substring filter on file paths (e.g. "src/engine").',
  },
  limit: {
    type: 'number',
    description: 'Maximum number of files to return (default 50).',
  },
  perFile: {
    type: 'number',
    description: 'Maximum recent edits inlined per file (default 3).',
  },
  since: {
    type: 'string',
    description: 'Only sessions created at or after this ISO-8601 timestamp (e.g. 2026-09-01T00:00:00Z).',
  },
} as const

export interface RecentEditsArgs {
  readonly path?: string
  readonly limit?: number
  readonly perFile?: number
  readonly since?: string
  readonly sinceMs?: number
}

/* ------------------------------------------------------------------ */
/* session_insights arguments (merged from dsh-tool-session-insights)  */
/* ------------------------------------------------------------------ */

/** Actions the `session_insights` tool supports today. */
export const SESSION_INSIGHTS_ACTIONS = ['tool-frequency'] as const

export type SessionInsightsAction = typeof SESSION_INSIGHTS_ACTIONS[number]

/** Canonical JSON-schema parameters for the `session_insights` tool. */
export const sessionInsightsParameters = {
  action: {
    type: 'string',
    required: true,
    enum: [...SESSION_INSIGHTS_ACTIONS],
    description:
      'The analysis to run. `tool-frequency` ranks the workspace\'s tool calls by frequency (highest to lowest) '
      + 'with per-tool session coverage and error counts.',
  },
  workspace: {
    type: 'string',
    description:
      'Absolute path of the workspace whose sessions to analyze. Must equal the caller workspace; defaults to it.',
  },
  limit: {
    type: 'number',
    description: 'Maximum number of most-recent sessions to scan (default 200).',
  },
  top: {
    type: 'number',
    description: 'Return only the top N tools by frequency. Omit to return all.',
  },
  since: {
    type: 'string',
    description: 'Only sessions created at or after this ISO-8601 timestamp (e.g. 2026-09-01T00:00:00Z).',
  },
} as const

export interface SessionInsightsArgs {
  readonly action: SessionInsightsAction
  readonly workspace?: string
  readonly limit?: number
  readonly top?: number
  readonly since?: string
  readonly sinceMs?: number
}

/** Validate raw `session_insights` arguments and normalize them. */
export function parseSessionInsightsArgs(args: unknown): SessionInsightsArgs {
  if (args === null || typeof args !== 'object') {
    throw new Error('session_insights arguments must be an object')
  }
  const raw = args as Record<string, unknown>
  if (raw.action !== 'tool-frequency') {
    throw new Error(`session_insights action must be one of: ${SESSION_INSIGHTS_ACTIONS.join(', ')}`)
  }
  const workspace = raw.workspace !== undefined ? assertString('workspace', raw.workspace) : undefined
  const limit = raw.limit !== undefined ? assertPositiveInteger('limit', raw.limit) : undefined
  const top = raw.top !== undefined ? assertPositiveInteger('top', raw.top) : undefined
  const since = raw.since !== undefined ? assertString('since', raw.since) : undefined
  return {
    action: 'tool-frequency',
    ...(workspace !== undefined ? { workspace } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(top !== undefined ? { top } : {}),
    ...(since !== undefined ? { since, sinceMs: parseSinceMs(since) } : {}),
  }
}

/** Validate raw `session_recent_edits` arguments and normalize them. */
export function parseRecentEditsArgs(args: unknown): RecentEditsArgs {
  if (args === null || typeof args !== 'object') {
    throw new Error('session_recent_edits arguments must be an object')
  }
  const raw = args as Record<string, unknown>
  const path = raw.path !== undefined ? assertString('path', raw.path) : undefined
  const limit = raw.limit !== undefined ? assertPositiveInteger('limit', raw.limit) : undefined
  const perFile = raw.perFile !== undefined ? assertPositiveInteger('perFile', raw.perFile) : undefined
  const since = raw.since !== undefined ? assertString('since', raw.since) : undefined
  return {
    ...(path !== undefined ? { path } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(perFile !== undefined ? { perFile } : {}),
    ...(since !== undefined ? { since, sinceMs: parseSinceMs(since) } : {}),
  }
}
