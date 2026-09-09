/**
 * The `session://` internal-URL handler: exposes the harness's own recorded
 * history (live + persisted sessions) to the read/grep/write tools as
 * FS-shaped URLs through the shared `ctx.internalUrls` registry.
 *
 * URL surface:
 * - `session://*` (or `session://list`) — directory listing of known sessions.
 * - `session://<id>` — rendered transcript of one session
 *   (`seq | type | time` plus indented semantic text per event).
 * - `session://<id>/event` — directory listing of that session's event seqs.
 * - `session://<id>/event/<seq>` — one exact event as JSON.
 * - `session://search?q=<terms>` — FTS-backed cross-session search hits
 *   (degrades to an explanatory note when the deployment disables content
 *   search via `openAt: 'never'`).
 *
 * Because this registers a scheme in the shared router, internal-URL-aware
 * `read`/`grep` tools reach it without new tool code: `grep session://<id>`
 * materializes the transcript and searches it with the same ripgrep pipeline
 * it uses for any other resource.
 *
 * Every resolved resource is immutable (agents never rewrite history through
 * a file-shaped URL) and is produced from the same live-preferred logical
 * corpus the session-query tools read.
 * @module @hy-sde-org/dsh-session-url/handler
 */

import type {
  InternalResource,
  ParsedInternalUrl,
  ProtocolHandler,
  ResolveContext,
  UrlCompletion,
} from './vendor/internal-urls/types.ts'
import {
  SessionQueryError,
  extractSessionEventText,
  type SessionLogSnapshot,
  type SessionQueryEngine,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** Cap on sessions rendered by one `session://*` listing. */
export const SESSION_LISTING_CAP = 200
/** Cap on events rendered into a displayed transcript (`read`). */
export const TRANSCRIPT_EVENT_CAP = 600
/** Cap on events materialized for a search consumer (`grep`, `pathOnly`). */
export const TRANSCRIPT_PATH_ONLY_EVENT_CAP = 12_000
/** Per-event semantic text length shown in a displayed transcript. */
export const EVENT_TEXT_MAX_CHARS = 400
/** Cap on one event's serialized JSON; oversized events degrade to text. */
export const EVENT_JSON_MAX_BYTES = 128_000
/** Page size for `session://search?q=…`. */
export const SESSION_SEARCH_LIMIT = 25

/** The `SESSION_QUERY_SEARCH_DISABLED` error code carried by SessionQueryError. */
const SEARCH_DISABLED_CODE = 'SESSION_QUERY_SEARCH_DISABLED' as const

function isoTime(value: number): string {
  return new Date(value).toISOString()
}

/** One semantic-text sample for the displays: collapsed whitespace, capped. */
function eventText(event: SessionEvent, maxChars: number): string {
  const text = extractSessionEventText(event).replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

function indented(text: string, prefix: string): string {
  return `${prefix}${text.replaceAll('\n', `\n${prefix}`)}`
}

/** Cap a name for display so one malicious cwd/title cannot break the layout. */
function capLabel(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`
}

function invalidUrl(): Error {
  return new Error('Invalid session:// URL. Expected session://* (listing), session://<id> (transcript), session://<id>/event (seq index), session://<id>/event/<seq> (exact event), or session://search?q=<terms>.')
}

/** `session://` handler with a bound query engine. */
export class SessionProtocolHandler implements ProtocolHandler {
  readonly scheme = 'session'
  readonly immutable = true

  constructor(private readonly query: SessionQueryEngine) {}

  /** Candidate completions for `session://<query>`: `*`, `search`, and session ids. */
  async complete(query?: string): Promise<UrlCompletion[]> {
    const needle = (query ?? '').trim()
    const staticCandidates: UrlCompletion[] = [
      { value: '*', label: 'session://*', description: 'List known sessions' },
      { value: 'search', label: 'session://search?q=…', description: 'Search past session texts' },
    ]
    const records = await this.query.listSessions()
    const sessions: UrlCompletion[] = records
      .sort((a, b) => b.header.createdAt - a.header.createdAt)
      .slice(0, SESSION_LISTING_CAP)
      .map(record => ({
        value: record.header.id,
        label: `session://${record.header.id}`,
        description: `Created ${isoTime(record.header.createdAt)}`,
      }))
    if (needle === '') return [...staticCandidates, ...sessions]
    return [...staticCandidates, ...sessions].filter(candidate => candidate.value.startsWith(needle))
  }

  async resolve(url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource> {
    const host = url.rawHost
    if (host === '' || host === '*' || host === 'list') {
      if (url.pathSegments.length > 0) throw invalidUrl()
      return this.listSessions()
    }
    if (host === 'search') return this.search(url, context)
    return this.session(host as SessionId, url, context)
  }

  /** `session://*` — directory listing of the logical corpus (newest first). */
  private async listSessions(): Promise<InternalResource> {
    const records = (await this.query.listSessions()).slice(0, SESSION_LISTING_CAP)
    const titles = await this.titlesOf(records.map(record => record.header.id))
    const lines = records.length === 0
      ? ['No prior sessions found.']
      : [`Session URL listing (${records.length} session${records.length === 1 ? '' : 's'}, newest first):`]
    for (const record of records) {
      const title = capLabel(titles.get(record.header.id) ?? '', 120)
      const cwd = record.header.cwd === undefined ? '' : ` | cwd ${capLabel(record.header.cwd, 120)}`
      lines.push(`session://${record.header.id} — created ${isoTime(record.header.createdAt)}${cwd}${title === '' ? '' : ` | ${title}`}`)
    }
    if (records.length === SESSION_LISTING_CAP) {
      lines.push('', 'Listing capped. Read session://<id> for a transcript, or search with session://search?q=<terms>.')
    }
    lines.push('', 'Subresources:')
    lines.push('- session://<id> — transcript of one session')
    lines.push('- session://<id>/event — seq index of one session')
    lines.push('- session://<id>/event/<seq> — one exact event as JSON')
    lines.push('- session://search?q=<terms> — FTS-backed cross-session search')
    return {
      url: 'session://*',
      content: lines.join('\n'),
      contentType: 'text/markdown',
      isDirectory: true,
    }
  }

  /** `session://search?q=…` (or `session://search/<terms>`) — FTS-backed hits. */
  private async search(url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource> {
    const trimmed = (url.searchParams.get('q') ?? url.pathSegments.join(' ')).trim()
    if (trimmed.length === 0) {
      throw new Error('session://search needs a query. Use session://search?q=<terms> (URL-encoded) or session://search/<terms>')
    }
    const request: SessionSearchRequest = { query: trimmed.slice(0, 2000), limit: SESSION_SEARCH_LIMIT }
    let result
    try {
      result = await this.query.searchSessions(request, context?.signal !== undefined ? { signal: context.signal } : undefined)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === SEARCH_DISABLED_CODE) {
        return {
          url: url.rawHref,
          content: [
            'session search is disabled in this deployment (the session-query index configures openAt: \'never\').',
            '',
            'The read/list surface still works: session://<id> for a transcript, session://<id>/event/<seq> for one event, session://* for the listing.',
          ].join('\n'),
          contentType: 'text/plain',
          immutable: true,
          notes: ['Content search is a deployment choice; exact reads do not depend on it.'],
        }
      }
      throw error
    }
    const hits = result.items
    const titles = await this.titlesOf(hits.map(hit => hit.header.id))
    const lines = hits.length === 0
      ? [`No prior session matches "${trimmed}".`]
      : [`Session search results (${hits.length}) for "${trimmed}":`]
    for (const [index, hit] of hits.entries()) {
      const title = capLabel(titles.get(hit.header.id) ?? '', 120)
      lines.push('', `${index + 1}. session://${hit.header.id} — ${title}`)
      lines.push(`   Created: ${isoTime(hit.header.createdAt)}`)
      lines.push(`   Best match: seq ${hit.bestMatch.seq} | ${hit.bestMatch.type} | ${hit.bestMatch.snippet}`)
    }
    if (hits.length === SESSION_SEARCH_LIMIT) {
      lines.push('', 'Result page full. Narrow the query for more hits.')
    }
    return {
      url: url.rawHref,
      content: lines.join('\n'),
      contentType: 'text/markdown',
      immutable: true,
      notes: ['Search hits route through the FTS5 index; exact reads use session://<id>.'],
    }
  }

  /** Resolve `session://<id>` / `/event` / `/event/<seq>`; anything else is invalid. */
  private async session(id: SessionId, url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource> {
    const [first, seqRaw] = url.pathSegments
    if (first === undefined) return this.transcript(id, url, context)
    if (first !== 'event') throw invalidUrl()
    if (seqRaw === undefined) return this.eventIndex(id, url)
    if (url.pathSegments.length === 2) return this.eventJson(id, seqRaw, url)
    throw invalidUrl()
  }

  /** `session://<id>` — rendered transcript of the complete raw event log. */
  private async transcript(id: SessionId, url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource> {
    const snapshot = await this.readSessionOrThrow(id)
    const events = snapshot.events
    const cap = context?.pathOnly === true ? TRANSCRIPT_PATH_ONLY_EVENT_CAP : TRANSCRIPT_EVENT_CAP
    const shown = events.length <= cap ? events : events.slice(0, cap)
    const title = await this.titleOf(id)
    const header = snapshot.session
    const lines = [
      `Session ${id} — ${capLabel(title, 160)}`,
      `Created: ${isoTime(header.createdAt)}`,
      ...header.cwd !== undefined ? [`cwd: ${capLabel(header.cwd, 160)}`] : [],
      ...header.parentSession !== undefined ? [`Parent: ${header.parentSession}`] : [],
      `Events (${events.length}, showing ${shown.length}):`,
    ]
    for (const event of shown) {
      const text = eventText(event, EVENT_TEXT_MAX_CHARS)
      lines.push('', `seq ${event.seq} | ${event.type} | ${isoTime(event.time)}`)
      if (text.length > 0) lines.push(indented(text, '  '))
    }
    if (shown.length < events.length) {
      lines.push('', `(${events.length - shown.length} more events omitted; read session://<id>/event/<seq> for one event at a time)`)
    }
    return {
      url: url.rawHref,
      content: lines.join('\n'),
      contentType: 'text/markdown',
      immutable: true,
      notes: [`Read one event: session://${id}/event/<seq>`, 'grep session://<id> searches this transcript.'],
    }
  }

  /** `session://<id>/event` — directory of that session's event seqs (ascending). */
  private async eventIndex(id: SessionId, url: ParsedInternalUrl): Promise<InternalResource> {
    const snapshot = await this.readSessionOrThrow(id)
    const events = snapshot.events
    const lines = events.length === 0
      ? ['No events recorded for this session.']
      : [`Session ${id} — event index (${events.length}):`]
    for (const event of events) {
      const text = eventText(event, 120)
      const suffix = text.length === 0 ? '' : ` | ${text}`
      lines.push(`session://${id}/event/${event.seq} — seq ${event.seq} | ${event.type} | ${isoTime(event.time)}${suffix}`)
    }
    return {
      url: url.rawHref,
      content: lines.join('\n'),
      contentType: 'text/plain',
      isDirectory: true,
      immutable: true,
      notes: [`Read one: session://${id}/event/<seq>`],
    }
  }

  /** `session://<id>/event/<seq>` — one exact event as JSON. */
  private async eventJson(id: SessionId, seqRaw: string, url: ParsedInternalUrl): Promise<InternalResource> {
    if (!/^(0|[1-9][0-9]*)$/.test(seqRaw)) throw invalidUrl()
    const seq = Number.parseInt(seqRaw, 10)
    const snapshot = await this.readSessionOrThrow(id)
    const event = snapshot.events.find(candidate => candidate.seq === seq)
    if (event === undefined) {
      const max = snapshot.events.at(-1)?.seq ?? 0
      throw new Error(`session://${id}/event/${seqRaw}: no such event. This session has ${snapshot.events.length} event${snapshot.events.length === 1 ? '' : 's'} (max seq ${max}).`)
    }
    const json = JSON.stringify(event)
    if (json.length > EVENT_JSON_MAX_BYTES) {
      return {
        url: url.rawHref,
        content: [
          `Event seq ${seq} serializes to ${json.length} bytes (cap ${EVENT_JSON_MAX_BYTES}); not shown in full.`,
          '',
          `Type: ${event.type}`,
          'Read session://<id> for the surrounding transcript instead.',
        ].join('\n'),
        contentType: 'text/plain',
        immutable: true,
        notes: ['Oversized events degrade to text to keep the result bounded.'],
      }
    }
    return { url: url.rawHref, content: json, contentType: 'application/json', immutable: true }
  }

  private async readSessionOrThrow(id: SessionId): Promise<SessionLogSnapshot> {
    return this.query.readSession(id)
  }

  private async titleOf(id: SessionId): Promise<string> {
    const observation = (await this.query.readTitleSnapshots([id]))[0]
    if (observation === undefined || observation.status === 'rejected') return ''
    return observation.value.title?.title ?? ''
  }

  private async titlesOf(ids: readonly SessionId[]): Promise<Map<SessionId, string>> {
    const titles = new Map<SessionId, string>()
    if (ids.length === 0) return titles
    const unique = [...new Set(ids)]
    const observations = await this.query.readTitleSnapshots(unique)
    for (let index = 0; index < unique.length; index++) {
      const observation = observations[index]
      // Never let one failed title projection poison the listing.
      if (observation === undefined || observation.status === 'rejected') continue
      const title = observation.value.title?.title
      if (title !== undefined && title.length > 0) titles.set(unique[index] as SessionId, title)
    }
    return titles
  }
}
