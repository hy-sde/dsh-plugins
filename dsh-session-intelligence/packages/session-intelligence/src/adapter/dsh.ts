/**
 * DSH session-log → engine input adapter.
 *
 * Reduces one DeepSeek Harness session event stream (the same
 * `session.jsonl.zstd` shape the harness writes: `user/message`,
 * `assistant/message`, `tool/call`, `tool/result`, `compaction/*`, ...) into
 * the pure engine input shapes. The mapping mirrors agentsview's
 * `internal/sync/signal_compute.go` (`computeSignalsFromMessages`) as closely
 * as the DSH event model allows; the only DSH-specific judgment calls are
 * documented inline.
 *
 * @module @hy-sde-org/dsh-session-intelligence/adapter/dsh
 */

import {
  analyzeHeuristics,
  classifyOutcome,
  computeContextPressure,
  computeHealthScore,
  computeToolHealth,
  countMidTaskCompactions,
  isFailure,
  normalizeToolCategory,
} from '../engine/index.ts'
import type {
  ContextTokenRow,
  HeuristicMessage,
  OutcomeInput,
  ScoreInput,
  ToolCallOrdinal,
  ToolCallRow,
  ToolHealthSignals,
} from '../engine/types.ts'

/** One raw session event as read from the log artifact. */
export interface HealthSessionEventLike {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

/** Session facts + event stream (the reduced shape shared with the CLI). */
export interface HealthSessionLike {
  readonly id: string
  readonly createdAt: number
  readonly inheritedEventCount?: number
  readonly events: readonly HealthSessionEventLike[]
}

/** All session-intelligence signals for one session. */
export interface SessionSignals {
  readonly sessionId: string
  readonly startedAt: number
  /** Last event time, or `startedAt` when the session has no events. */
  readonly endedAt: number
  readonly messageCount: number
  readonly outcome: ReturnType<typeof classifyOutcome>
  readonly finalFailureStreak: number
  readonly toolHealth: ToolHealthSignals
  readonly heuristics: ReturnType<typeof analyzeHeuristics>
  readonly contextTokens: readonly ContextTokenRow[]
  readonly peakContextTokens: number
  readonly hasContextData: boolean
  readonly compactionCount: number
  /** `null` when no explicit compaction boundary was recorded. */
  readonly explicitCompactionBoundaries: readonly number[]
  readonly midTaskCompactionCount: number
  readonly model: string
  readonly pressureMax: number | null
  readonly score: ReturnType<typeof computeHealthScore>
}

/**
 * Reduce one DSH session event stream into all engine signals.
 * @param session - the session's header facts + events.
 */
export function analyzeSession(session: HealthSessionLike): SessionSignals {
  const messages = extractMessages(session)
  const toolRows = extractToolCallRows(session)
  const contextTokens = extractContextTokens(session)
  const boundaries = extractCompactBoundaryOrdinals(session)
  const model = extractMostCommonModel(session)
  const endedAt = lastEventTime(session) ?? session.createdAt

  const heuristics = analyzeHeuristics({ messages, toolRows })
  const toolHealth = computeToolHealth(toolRows)
  const pressure = computeContextPressure(contextTokens, peakContextTokens(contextTokens), model)
  const compactionCount = boundaries.length > 0 ? boundaries.length : pressure.compactionCount

  const midTaskCalls: ToolCallOrdinal[] = toolRows.map(call => ({
    messageOrdinal: call.messageOrdinal,
    toolName: call.toolName,
  }))
  const midTaskCompactionCount = countMidTaskCompactions(boundaries, midTaskCalls)

  const last = lastNonSystemMessage(messages)
  const outcome = classifyOutcome({
    isAutomated: false,
    messageCount: messages.length,
    endedWithRole: last?.role ?? '',
    finalFailureStreak: finalFailureStreak(toolRows),
    lastAssistantText: last?.role === 'assistant' ? last.content : '',
    lastActivityMs: endedAt,
  } satisfies OutcomeInput)

  const hasContextData = contextTokens.some(row => row.hasContextTokens)

  const score = computeHealthScore({
    outcome: outcome.outcome,
    outcomeConfidence: outcome.confidence,
    hasToolCalls: toolRows.length > 0,
    failureSignalCount: toolHealth.failureSignalCount,
    retryCount: toolHealth.retryCount,
    editChurnCount: toolHealth.editChurnCount,
    consecutiveFailMax: toolHealth.consecutiveFailureMax,
    hasContextData,
    compactionCount,
    midTaskCompactionCount,
    pressureMax: pressure.pressureMax,
    heuristics,
  } satisfies ScoreInput)

  return {
    sessionId: session.id,
    startedAt: session.createdAt,
    endedAt,
    messageCount: messages.length,
    outcome,
    finalFailureStreak: finalFailureStreak(toolRows),
    toolHealth,
    heuristics,
    contextTokens,
    peakContextTokens: peakContextTokens(contextTokens),
    hasContextData,
    compactionCount,
    explicitCompactionBoundaries: boundaries,
    midTaskCompactionCount,
    model,
    pressureMax: pressure.pressureMax,
    score,
  }
}

/* ------------------------------------------------------------------ */
/* Event-level extraction helpers                                      */
/* ------------------------------------------------------------------ */

/**
 * Build user/assistant messages in event order. The ordinal of each message
 * is its index here (agentsview's `Message.Ordinal`). Only `user/message` and
 * `assistant/message` events produce messages; content is the concatenation
 * of text blocks (reasoning blocks are not user-visible message content).
 */
function extractMessages(session: HealthSessionLike): HeuristicMessage[] {
  const messages: HeuristicMessage[] = []
  for (const event of session.events) {
    if (event.seq < (session.inheritedEventCount ?? 0)) continue
    if (event.type === 'user/message') {
      const payload = asRecord(event.data)
      if (payload === undefined) continue
      const role = typeof payload.role === 'string' ? payload.role : 'user'
      const content = contentText(payload.content)
      if (content === '') continue
      messages.push({
        role,
        content,
        isSystem: false,
        ordinal: messages.length,
        timestamp: iso(event.time),
      })
    } else if (event.type === 'assistant/message') {
      const payload = asRecord(event.data)
      const message = asRecord(payload?.message)
      if (message === undefined) continue
      const role = typeof message.role === 'string' ? message.role : 'assistant'
      const content = contentText(message.content)
      if (content === '') continue
      messages.push({
        role,
        content,
        isSystem: false,
        ordinal: messages.length,
        timestamp: iso(event.time),
      })
    }
  }
  return messages
}

/**
 * Build tool call rows from `tool/call` + `tool/result` events. Each call is
 * attributed to the most recent message ordinal (the assistant message that
 * issued it, matching agentsview's message-block attribution). `eventStatus`
 * is `"errored"` when the latest matching result carries an error/isError,
 * else `""` so the engine's content heuristics still apply.
 */
function extractToolCallRows(session: HealthSessionLike): ToolCallRow[] {
  const rows: ToolCallRow[] = []
  // callId -> index into rows; the latest result overwrites the row.
  const byCallId = new Map<string, { rowIndex: number; errored: boolean }>()
  let lastMessageOrdinal = -1
  let ordinalCounter = 0

  for (const event of session.events) {
    if (event.seq < (session.inheritedEventCount ?? 0)) continue
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      lastMessageOrdinal = ordinalCounter
      ordinalCounter++
      continue
    }
    if (event.type === 'tool/call') {
      const payload = asRecord(event.data)
      if (payload === undefined) continue
      const name = typeof payload.name === 'string' ? payload.name : ''
      const argumentsJson = typeof payload.arguments === 'string' ? payload.arguments : ''
      if (name === '') continue
      const row: ToolCallRow = {
        toolName: name,
        category: normalizeToolCategory(name),
        inputJson: argumentsJson,
        resultContent: '',
        messageOrdinal: Math.max(lastMessageOrdinal, 0),
        // CallIndex is its position among this message's calls.
        callIndex: rows.filter(r => r.messageOrdinal === Math.max(lastMessageOrdinal, 0)).length,
        eventStatus: '',
      }
      const rowIndex = rows.length
      rows.push(row)
      byCallId.set(`call:${String(payload.callId ?? '')}`, { rowIndex, errored: false })
      continue
    }
    if (event.type === 'tool/result') {
      const payload = asRecord(event.data)
      if (payload === undefined) continue
      const message = asRecord(payload.message)
      const source = asRecord(message?.source)
      const callId = typeof source?.callId === 'string' ? source.callId : undefined
      if (callId === undefined) continue
      const errored = payload.error !== undefined || contentHasError(message?.content)
      const text = contentText(message?.content)
      const entry = byCallId.get(`call:${callId}`)
      if (entry !== undefined) {
        // Latest result wins (events are stored in order).
        const current = rows[entry.rowIndex]!
        rows[entry.rowIndex] = {
          ...current,
          resultContent: text,
          eventStatus: errored ? 'errored' : '',
        }
        entry.errored = errored
      }
    }
  }
  return rows
}

/** Context-token measurements for assistant messages in event order. */
function extractContextTokens(session: HealthSessionLike): ContextTokenRow[] {
  const rows: ContextTokenRow[] = []
  for (const event of session.events) {
    if (event.seq < (session.inheritedEventCount ?? 0)) continue
    if (event.type !== 'assistant/message') continue
    const payload = asRecord(event.data)
    const usage = asRecord(payload?.usage)
    if (usage === undefined) {
      rows.push({ contextTokens: 0, hasContextTokens: false })
      continue
    }
    rows.push({
      contextTokens: sumTokens(usage),
      hasContextTokens: true,
    })
  }
  return rows
}

/**
 * Ordinals of messages that directly follow a compaction event
 * (`compaction/end` or `compaction/summary`), in ascending order. Mirrors
 * agentsview's explicit compact-boundary messages; DSH records the boundary
 * as its own event rather than flagging a message, so the boundary ordinal is
 * the first message after the event.
 */
function extractCompactBoundaryOrdinals(session: HealthSessionLike): number[] {
  const boundaries: number[] = []
  const messageSeqs: Array<{ seq: number; ordinal: number }> = []
  let ordinal = 0
  for (const event of session.events) {
    if (event.seq < (session.inheritedEventCount ?? 0)) continue
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      messageSeqs.push({ seq: event.seq, ordinal })
      ordinal++
    }
  }
  const seenCompactionIds = new Set<string>()
  for (const event of session.events) {
    if (event.seq < (session.inheritedEventCount ?? 0)) continue
    if (event.type === 'compaction/end' || event.type === 'compaction/summary') {
      const payload = asRecord(event.data)
      const compactionId = typeof payload?.compactionId === 'string' ? payload.compactionId : undefined
      // `compaction/end` re-fires per compaction? No: each compaction emits
      // start, summary and end with the SAME id, so dedupe by id; logs
      // without ids fall back to a seq-keyed dedupe.
      if (compactionId !== undefined) {
        if (seenCompactionIds.has(compactionId)) continue
        seenCompactionIds.add(compactionId)
      } else if (seenCompactionIds.has(`seq:${event.seq}`)) {
        continue
      } else {
        seenCompactionIds.add(`seq:${event.seq}`)
      }
      const next = messageSeqs.find(m => m.seq > event.seq)
      if (next !== undefined) boundaries.push(next.ordinal)
    }
  }
  return boundaries
}

/** Most common assistant/compaction model; ties broken by first appearance. */
function extractMostCommonModel(session: HealthSessionLike): string {
  const counts = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  let index = 0
  for (const event of session.events) {
    if (event.seq < (session.inheritedEventCount ?? 0)) continue
    const payload = asRecord(event.data)
    let model = ''
    if (event.type === 'assistant/message') {
      const message = asRecord(payload?.message)
      model = typeof message?.model === 'string' ? message.model : ''
    } else if (event.type === 'compaction/summary') {
      model = typeof payload?.model === 'string' ? payload.model : ''
    }
    if (model !== '') {
      counts.set(model, (counts.get(model) ?? 0) + 1)
      if (!firstSeen.has(model)) firstSeen.set(model, index)
    }
    index++
  }
  let best = ''
  let bestCount = -1
  for (const [model, count] of counts) {
    if (count > bestCount || (count === bestCount && (firstSeen.get(model) ?? 0) < (firstSeen.get(best) ?? 0))) {
      best = model
      bestCount = count
    }
  }
  return best
}

/** Count trailing failures in the ordered tool rows. */
function finalFailureStreak(rows: readonly ToolCallRow[]): number {
  let streak = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (isFailure(row)) streak++
    else break
  }
  return streak
}

function peakContextTokens(rows: readonly ContextTokenRow[]): number {
  let peak = 0
  for (const row of rows) {
    if (row.hasContextTokens && row.contextTokens > peak) peak = row.contextTokens
  }
  return peak
}

function lastEventTime(session: HealthSessionLike): number | undefined {
  let last: number | undefined
  for (const event of session.events) {
    if (event.seq < (session.inheritedEventCount ?? 0)) continue
    last = event.time
  }
  return last
}

function lastNonSystemMessage(messages: readonly HeuristicMessage[]): HeuristicMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i]!.isSystem) return messages[i]
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Narrowing helpers (mirror the insights package conventions)         */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Concatenate the `text` field of every text block in a content array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record !== undefined && record['type'] === 'text' && typeof record['text'] === 'string') {
      parts.push(record['text'])
    }
  }
  return parts.join('\n')
}

/** Whether a content array carries a `tool-result` block with isError. */
function contentHasError(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    const record = asRecord(block)
    if (record !== undefined && record['isError'] === true) return true
  }
  return false
}

/** Context tokens = inputTokens + cacheReadTokens + cacheWriteTokens. */
function sumTokens(usage: Record<string, unknown>): number {
  const tokens = (key: string): number => {
    const value = usage[key]
    return typeof value === 'number' ? value : 0
  }
  return tokens('inputTokens') + tokens('cacheReadTokens') + tokens('cacheWriteTokens')
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString()
}
