/**
 * Optional dependency-free bridge from the memory tools to the harness's
 * `ctx.sessionQuery` host service.
 *
 * The memory tools stay buildable and green outside the harness (the
 * standalone `@hy-sde-org/dsh-tool-memory` package has no session-query
 * dependency): every feature here resolves the service with `ctx.get()`,
 * types it structurally, and degrades to a no-op when it is absent. Inside the
 * harness the base bundle mounts `session-query-sqlite`, so recall/reflect can
 * search past sessions as a memory tier and `mine_sessions` can harvest
 * lessons from completed session logs.
 * @module @hy-sde-org/dsh-tool-memory/session-history
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import type { MemorySearchItem } from '@hy-sde-org/dsh-memory'

/** Structural view of the `ctx.sessionQuery` surface this bridge consumes. */
export interface SessionQueryPort {
  searchSessions(input: {
    query: string
    sessionFilters?: readonly { kind: 'cwd'; values: readonly (string | null)[] }[]
    limit?: number
  }): Promise<{ items: readonly SessionHitView[] }>
  filterSessions(
    filters?: readonly { kind: 'cwd'; values: readonly (string | null)[] }[],
    signal?: AbortSignal,
  ): Promise<Array<{ header: SessionHeaderView }>>
  readSession(id: string): Promise<{ session: SessionHeaderView; events: readonly MineEventView[] }>
  readTitle(id: string, signal?: AbortSignal): Promise<string>
}

interface SessionHeaderView { id: string; cwd?: string; createdAt?: number }
interface SessionHitView { header: SessionHeaderView; bestMatch: SessionEventHitView }
interface SessionEventHitView { sessionId: string; seq: number; time: number; snippet: string }
export interface MineEventView { type: string; seq?: number; data?: unknown }

/** Resolve the optional host session-query service, or undefined when absent. */
export function resolveSessionQuery(ctx: Context): SessionQueryPort | undefined {
  const service = (ctx as { get?: (name: string) => unknown }).get?.('sessionQuery')
  if (service === null || service === undefined) return undefined
  return service as SessionQueryPort
}

/**
 * Search past sessions of the calling project (`cwd` filter) and map the
 * strongest matching event of each session into memory-shaped hits.
 */
export async function searchSessionHistory(
  ctx: Context,
  exec: ToolRunContext,
  query: string,
  limit: number,
): Promise<MemorySearchItem[]> {
  const port = resolveSessionQuery(ctx)
  if (port === undefined) return []
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  let page: { items: readonly SessionHitView[] }
  try {
    page = await port.searchSessions({
      query,
      sessionFilters: [{ kind: 'cwd', values: [cwd] }],
      limit,
    })
  } catch {
    // A failed search (index not ready, unexplained engine error) must not
    // take the memory tool down; this tier is best-effort by design.
    return []
  }
  const hits: MemorySearchItem[] = []
  for (const item of page.items) {
    const best = item.bestMatch
    if (best.snippet.length === 0) continue
    hits.push({
      content: best.snippet,
      source: 'session',
      sessionId: best.sessionId,
      seq: best.seq,
      timestamp: new Date(best.time).toISOString(),
      score: 0.75,
      readonly: true,
    })
  }
  return hits
}

/** Short stable display id for a session (8 hex chars). */
export function sessionLabel(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8)
}

/**
 * Canonical session URI, format-compatible with session-reference's
 * `dsh-session:` scheme (base64url of the JSON-encoded id). Duplicated here,
 * dependency-free, so recall output can carry a mention that a session-reference
 * mount (when present) resolves to the full conversation.
 */
export function encodeSessionUri(sessionId: string): string {
  const payload = Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
  return `dsh-session:${payload}`
}

/** Escape a mention label for `\` and `]`, matching session-reference. */
function escapeMentionLabel(label: string): string {
  return label.replace(/[\\\]]/gu, match => `\\${match}`)
}

/**
 * Render a Markdown mention that points at the full conversation of one
 * session. The mention is self-identifying plain text even in presets without
 * a session-reference mount; where session-reference is mounted it resolves
 * to the session snapshot the hit came from.
 * @param sessionId - the session the hit came from.
 * @param label - optional display label (defaults to the short session label).
 * @returns an `@[label](dsh-session:...)` mention.
 */
export function formatSessionMention(sessionId: string, label?: string): string {
  const text = label ?? sessionLabel(sessionId)
  return `@[${escapeMentionLabel(text)}](${encodeSessionUri(sessionId)})`
}

/** One mined lesson candidate from a session event. */
export interface MineCandidate {
  content: string
  context: string
}

const MAX_MINED_CONTENT_CHARS = 1200

function clampText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function blockTexts(block: unknown): string[] {
  if (typeof block !== 'object' || block === null) return []
  const record = block as Record<string, unknown>
  if (record.type === 'text' && typeof record.text === 'string') return [record.text]
  return []
}

/** Extract candidate lessons from one session event, defensively. */
export function mineCandidateOf(event: MineEventView, sessionId: string, title?: string): MineCandidate[] {
  const sessionContext = title === undefined || title.length === 0 ? `session ${sessionLabel(sessionId)}` : title
  const data = event.data
  if (typeof data !== 'object' || data === null) return []

  if (event.type === 'turn/end') {
    const reason = (data as Record<string, unknown>).reason as Record<string, unknown> | undefined
    if (reason?.kind === 'error') {
      const error = reason.error as Record<string, unknown> | undefined
      const message = typeof error?.message === 'string' ? error.message : ''
      if (message.length === 0) return []
      return [{
        content: `Earlier failure: ${clampText(message, 400)}`,
        context: sessionContext,
      }]
    }
    return []
  }

  if (event.type === 'compaction/summary') {
    const summary = (data as Record<string, unknown>).summary
    const texts = Array.isArray(summary) ? summary.flatMap(blockTexts) : []
    const joined = texts.map(text => text.trim()).filter(Boolean).join(' ')
    if (joined.length === 0) return []
    return [{
      content: `Digested summary: ${clampText(joined, MAX_MINED_CONTENT_CHARS)}`,
      context: sessionContext,
    }]
  }

  if (event.type === 'todo/write') {
    const todos = (data as Record<string, unknown>).todos
    if (!Array.isArray(todos) || todos.length === 0) return []
    const entries = todos.flatMap((todo): Array<{ content: string; status: string }> => {
      if (typeof todo !== 'object' || todo === null) return []
      const content = (todo as Record<string, unknown>).content
      const status = (todo as Record<string, unknown>).status
      if (typeof content !== 'string') return []
      return [{ content, status: typeof status === 'string' ? status : '' }]
    })
    if (entries.length === 0 || entries.some(entry => entry.status !== 'completed')) return []
    const contents = entries.map(entry => entry.content).filter(Boolean)
    if (contents.length === 0) return []
    return [{
      content: `Completed outcome: ${clampText(contents.join('; '), 400)}`,
      context: sessionContext,
    }]
  }

  return []
}

/** Content digest used to dedupe mined lessons across sessions. */
export function mineFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}
