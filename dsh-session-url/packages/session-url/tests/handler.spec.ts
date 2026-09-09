/**
 * The `session://` handler surface: listing, transcript, event JSON, seq
 * index, search routing, and the disabled-search degradation — each against a
 * stub query engine (no real corpus/context needed).
 */

import { describe, expect, it } from 'vitest'
import { parseInternalUrl } from '../src/vendor/internal-urls/parse.ts'
import type {
  InternalResource,
  ParsedInternalUrl,
  ResolveContext,
} from '../src/vendor/internal-urls/types.ts'
import type {
  SessionLogSnapshot,
  SessionQueryEngine,
  SessionSearchPage,
  SessionSearchRequest,
  SessionSearchHit,
  SessionTitleObservation,
  SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionProtocolHandler,
  SESSION_LISTING_CAP,
  TRANSCRIPT_EVENT_CAP,
  EVENT_JSON_MAX_BYTES,
} from '../src/handler.ts'

/** Minimal raw events for a stub session. */
function event(seq: number, type: SessionEvent['type'], data: unknown, time = 1000 + seq): SessionEvent {
  return { type, seq, time, sessionId: 'sess_stub' as SessionId, data } as unknown as SessionEvent
}

interface StubOptions {
  sessions?: Map<string, SessionEvent[]>
  headers?: Map<string, Partial<SessionHeader>>
  titles?: Map<string, string>
  searchDisabled?: boolean
  searchHits?: Array<{
    header: { id: string; createdAt: number }
    live: boolean
    persisted: boolean
    bestMatch: { sessionId: string; seq: number; type: string; time: number; surface: string; snippet: string }
  }>
}

/** Build a stub engine satisfying the handler's call surface. */
function stubEngine(options: StubOptions = {}): SessionQueryEngine {
  const sessions = options.sessions ?? new Map<string, SessionEvent[]>()
  const headers = options.headers ?? new Map<string, Partial<SessionHeader>>()
  const titles = options.titles ?? new Map<string, string>()
  return {
    async listSessions() {
      const records = [...sessions.keys()].map(id => ({
        header: { id, createdAt: 0, ...headers.get(id) } as SessionHeader,
        live: true,
        persisted: false,
      }))
      return records
    },
    async readSession(id: SessionId): Promise<SessionLogSnapshot> {
      const log = sessions.get(id)
      if (log === undefined) throw new SessionQueryError(`session not found: ${id}`, 'SESSION_QUERY_SESSION_NOT_FOUND')
      return {
        session: { id, createdAt: 0, ...headers.get(id) } as SessionHeader,
        inheritedEventCount: SessionLogOffset(0),
        events: log.map(item => ({ ...item, sessionId: id })),
      }
    },
    async readTitleSnapshots(ids: readonly SessionId[]): Promise<SessionTitleObservationResult[]> {
      return ids.map((id) => {
        const value = { session: { id, createdAt: 0 } as SessionHeader } as SessionTitleObservation
        if (titles.has(id)) value.title = { title: titles.get(id)! } as SessionTitleSnapshot
        return { sessionId: id, status: 'fulfilled' as const, value }
      })
    },
    async searchSessions(request: SessionSearchRequest): Promise<SessionSearchPage<SessionSearchHit>> {
      if (options.searchDisabled === true) {
        throw new SessionQueryError('disabled', 'SESSION_QUERY_SEARCH_DISABLED')
      }
      const hits = (options.searchHits ?? []) as unknown as SessionSearchHit[]
      return { items: hits.slice(0, request.limit ?? 25) }
    },
    async searchEvents() {
      throw new Error('not used by the session:// handler')
    },
  } as unknown as SessionQueryEngine
}

function parse(schemeUrl: string): ParsedInternalUrl {
  return parseInternalUrl(schemeUrl)
}

async function resolve(engine: SessionQueryEngine, schemeUrl: string, context?: ResolveContext): Promise<InternalResource> {
  const handler = new SessionProtocolHandler(engine)
  return handler.resolve(parse(schemeUrl), context)
}

describe('session:// handler', () => {
  const log = new Map<string, SessionEvent[]>([
    ['sess_alpha', [
      event(1, 'user/message', { content: [{ type: 'text', text: 'hello world decision tsconfig' }] }),
      event(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'sure, the tsconfig file lives at tsconfig.base.json' }] } }),
      event(3, 'tool/result', { message: { content: [{ type: 'text', text: 'no error' }] }, error: null }),
    ]],
    ['sess_beta', [event(1, 'user/message', { content: [{ type: 'text', text: 'unrelated topic' }] })]],
  ])

  it('lists sessions with subresource hints (session://*)', async () => {
    const engine = stubEngine({ sessions: log })
    const resource = await resolve(engine, 'session://*')
    expect(resource.isDirectory).toBe(true)
    expect(resource.content).toContain('session://sess_alpha')
    expect(resource.content).toContain('session://sess_beta')
    expect(resource.content).toContain('session://<id>/event/<seq>')
  })

  it('renders a transcript (session://<id>) with per-event lines', async () => {
    const headers = new Map<string, Partial<SessionHeader>>([['sess_alpha', { cwd: '/project/a', parentSession: 'sess_parent' as SessionId }]])
    const engine = stubEngine({
      sessions: log,
      headers,
      titles: new Map([['sess_alpha', 'Alpha decision session']]),
    })
    const resource = await resolve(engine, 'session://sess_alpha')
    expect(resource.immutable).toBe(true)
    expect(resource.content).toContain('Session sess_alpha — Alpha decision session')
    expect(resource.content).toContain('cwd: /project/a')
    expect(resource.content).toContain('Parent: sess_parent')
    expect(resource.content).toContain('seq 1 | user/message')
    expect(resource.content).toContain('hello world decision tsconfig')
    expect(resource.content).toContain('seq 3 | tool/result')
  })

  it('returns one exact event as JSON (session://<id>/event/<seq>)', async () => {
    const engine = stubEngine({ sessions: log })
    const resource = await resolve(engine, 'session://sess_alpha/event/2')
    expect(resource.contentType).toBe('application/json')
    const parsed = JSON.parse(resource.content) as { seq: number; type: string }
    expect(parsed.seq).toBe(2)
    expect(parsed.type).toBe('assistant/message')
  })

  it('rejects an unknown event seq with guidance', async () => {
    const engine = stubEngine({ sessions: log })
    await expect(resolve(engine, 'session://sess_alpha/event/99')).rejects.toThrow(/no such event/)
  })

  it('rejects malformed URLs with the surface summary', async () => {
    const engine = stubEngine({ sessions: log })
    await expect(resolve(engine, 'session://sess_alpha/nope')).rejects.toThrow(/Invalid session:\/\/ URL/)
    await expect(resolve(engine, 'session://*/extra')).rejects.toThrow(/Invalid session:\/\/ URL/)
    await expect(resolve(engine, 'session://sess_alpha/event/1/too/many')).rejects.toThrow(/Invalid session:\/\/ URL/)
    await expect(resolve(engine, 'session://sess_alpha/event/abc')).rejects.toThrow(/Invalid session:\/\/ URL/)
  })

  it('lists event seqs in a directory (session://<id>/event)', async () => {
    const engine = stubEngine({ sessions: log })
    const resource = await resolve(engine, 'session://sess_alpha/event')
    expect(resource.isDirectory).toBe(true)
    expect(resource.content).toContain('session://sess_alpha/event/1')
    expect(resource.content).toContain('session://sess_alpha/event/3')
  })

  it('routes search through the FTS engine and renders hits', async () => {
    const engine = stubEngine({
      sessions: log,
      searchHits: [{ header: { id: 'sess_alpha', createdAt: 123 }, live: true, persisted: false, bestMatch: { sessionId: 'sess_alpha', seq: 1, type: 'user/message', time: 100, surface: 'current', snippet: 'hello world decision' } }],
      titles: new Map([['sess_alpha', 'Alpha']]),
    })
    const resource = await resolve(engine, 'session://search?q=tsconfig')
    expect(resource.content).toContain('1. session://sess_alpha — Alpha')
    expect(resource.content).toContain('Best match: seq 1 | user/message')
  })

  it('degrades gracefully when content search is disabled', async () => {
    const engine = stubEngine({ sessions: log, searchDisabled: true })
    const resource = await resolve(engine, 'session://search?q=anything')
    expect(resource.content).toContain('session search is disabled')
    expect(resource.content).toContain('read/list surface still works')
  })

  it('honors pathOnly with a much larger event cap for grep', async () => {
    const many = new Map<string, SessionEvent[]>([['sess_big', Array.from({ length: TRANSCRIPT_EVENT_CAP + 5 }, (_, index) => event(index + 1, 'user/message', { content: [{ type: 'text', text: `line ${index}` }] }))]])
    const engine = stubEngine({ sessions: many })
    const displayed = await resolve(engine, 'session://sess_big')
    expect(displayed.content).toContain('more events omitted')
    const searched = await resolve(engine, 'session://sess_big', { pathOnly: true, cwd: '/project/a' })
    expect(searched.content).not.toContain('more events omitted')
    expect(searched.content).toContain(`seq ${TRANSCRIPT_EVENT_CAP + 5} | user/message`)
  })

  it('caps a single listing to SESSION_LISTING_CAP sessions', async () => {
    const many = new Map<string, SessionEvent[]>()
    for (let index = 0; index < SESSION_LISTING_CAP + 10; index++) {
      many.set(`sess_${index}`, [event(1, 'user/message', { content: [{ type: 'text', text: 'x' }] })])
    }
    const engine = stubEngine({ sessions: many })
    const resource = await resolve(engine, 'session://*')
    expect(resource.content).toContain('Listing capped')
    expect((resource.content.match(/session:\/\/sess_/g) ?? []).length).toBe(SESSION_LISTING_CAP)
  })

  it('degrades an oversized event to text', async () => {
    const huge = `tool result ${'x'.repeat(EVENT_JSON_MAX_BYTES)}`
    const engine = stubEngine({ sessions: new Map([['sess_huge', [event(1, 'tool/result', { message: { content: [{ type: 'text', text: huge }] } }, 1)]]]) })
    const resource = await resolve(engine, 'session://sess_huge/event/1')
    expect(resource.contentType).toBe('text/plain')
    expect(resource.content).toContain('serializes to')
  })

  it('completes session ids and static candidates', async () => {
    const engine = stubEngine({ sessions: log })
    const handler = new SessionProtocolHandler(engine)
    const empty = await handler.complete('')
    expect(empty.map(c => c.value)).toContain('*')
    expect(empty.map(c => c.value)).toContain('search')
    expect(empty.map(c => c.value)).toContain('sess_alpha')
    const filtered = await handler.complete('sess_b')
    expect(filtered.map(c => c.value)).toEqual(['sess_beta'])
  })

  it('routes through the internal-URL registry like read/grep would', async () => {
    const { InternalUrlRouter } = await import('../src/vendor/internal-urls/router.ts')
    const router = new InternalUrlRouter()
    const engine = stubEngine({ sessions: log, titles: new Map([['sess_alpha', 'Alpha']]) })
    const dispose = router.register(new SessionProtocolHandler(engine))
    try {
      expect(router.canHandle('session://sess_alpha')).toBe(true)
      expect(router.canHandle('session://*')).toBe(true)
      expect(router.canHandle('/project/a/file.ts')).toBe(false)
      const resource = await router.resolve('session://sess_alpha')
      expect(resource.content).toContain('Session sess_alpha — Alpha')
      // The router stamps immutability from the handler as well.
      expect(resource.immutable).toBe(true)
    } finally {
      dispose()
    }
    expect(router.canHandle('session://sess_alpha')).toBe(false)
  })
})
