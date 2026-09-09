/**
 * The `agent://` protocol: handler units against a stub output store, plus a
 * registration integration proving the plugin mounts the scheme into the
 * shared internal-URL registry (with a stubbed sessionQuery service for a
 * real resolve) and unregisters it on fiber disposal.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { parseInternalUrl } from '../src/parse.ts'
import { apply } from '../src/index.ts'
import { AgentProtocolHandler } from '../src/agent-protocol.ts'
import type {
  AgentOutputStore,
  AgentSessionEvent,
  AgentSessionHeader,
} from '../src/agent-protocol.ts'
import type { ParsedInternalUrl } from '../src/types.ts'

function url(input: string): ParsedInternalUrl {
  return parseInternalUrl(input)
}

function header(partial: Partial<AgentSessionHeader>): AgentSessionHeader {
  return {
    id: 'x',
    createdAt: 1_700_000_000_000,
    ...partial,
  }
}

function textEvent(text: string): AgentSessionEvent {
  return {
    type: 'assistant/message',
    sessionId: 'x',
    data: { message: { content: [{ type: 'text', text }] } },
  }
}

interface StubSession {
  session: AgentSessionHeader
  events: AgentSessionEvent[]
}

/** Stub store: child-1 under root-0, grand-1 under child-1, child-2 under root-0. */
function stubStore(sessionsMap?: Map<string, StubSession>): AgentOutputStore {
  const sessions = sessionsMap ?? new Map<string, StubSession>()
  if (sessionsMap === undefined) {
    sessions.set('root-0', { session: header({ id: 'root-0' }), events: [] })
    sessions.set('child-1', {
      session: header({ id: 'child-1', origin: 'subagent', parentSession: 'root-0' }),
      events: [textEvent('THE CHILD OUTPUT')],
    })
    sessions.set('child-2', {
      session: header({ id: 'child-2', origin: 'subagent', parentSession: 'root-0' }),
      events: [textEvent('CHILD TWO OUTPUT')],
    })
    sessions.set('grand-1', {
      session: header({ id: 'grand-1', origin: 'subagent', parentSession: 'child-1' }),
      events: [textEvent('GRANDCHILD OUTPUT')],
    })
  }
  return {
    async listSessions() {
      return [...sessions.values()].map(record => ({ header: record.session }))
    },
    async readSession(id) {
      const record = sessions.get(id)
      if (record === undefined) throw new Error(`session ${id} not found`)
      return { session: record.session, events: record.events }
    },
  }
}

function handlerFor(store: AgentOutputStore | undefined): AgentProtocolHandler {
  return new AgentProtocolHandler({ outputStore: () => store })
}

describe('AgentProtocolHandler', () => {
  it('resolves agent://<id> to the child final assistant output', async () => {
    const resource = await handlerFor(stubStore()).resolve(url('agent://child-1'), { cwd: '/ws', sessionKey: 'root-0' })
    expect(resource.content).toContain('THE CHILD OUTPUT')
    expect(resource.immutable).toBe(true)
    expect(resource.contentType).toBe('text/markdown')
  })

  it('rejects non-subagent sessions with a session:// pointer', async () => {
    await expect(handlerFor(stubStore()).resolve(url('agent://root-0'), { cwd: '/ws' }))
      .rejects.toThrow(/not a subagent output/)
    await expect(handlerFor(stubStore()).resolve(url('agent://root-0'), { cwd: '/ws' }))
      .rejects.toThrow(/session:\/\/root-0/)
  })

  it('resolves nested agent://<parent>/<child> through the parentSession chain', async () => {
    const resource = await handlerFor(stubStore()).resolve(url('agent://root-0/child-1/grand-1'), { cwd: '/ws' })
    expect(resource.content).toContain('GRANDCHILD OUTPUT')
    expect(resource.notes?.join(' ')).toContain('root-0 / child-1 / grand-1')
  })

  it('rejects a path segment that is not a direct child', async () => {
    await expect(handlerFor(stubStore()).resolve(url('agent://child-1/child-2'), { cwd: '/ws' }))
      .rejects.toThrow(/no subagent 'child-2' under 'child-1'/)
    await expect(handlerFor(stubStore()).resolve(url('agent://child-1/child-2'), { cwd: '/ws' }))
      .rejects.toThrow(/Direct children of 'child-1': grand-1/)
  })

  it('rejects unknown ids listing known outputs', async () => {
    await expect(handlerFor(stubStore()).resolve(url('agent://missing'), { cwd: '/ws' }))
      .rejects.toThrow(/unknown output id 'missing'/)
    await expect(handlerFor(stubStore()).resolve(url('agent://missing'), { cwd: '/ws' }))
      .rejects.toThrow(/child-1, child-2, grand-1/)
  })

  it('explains ?q= extraction is not supported, and requires an id', async () => {
    await expect(handlerFor(stubStore()).resolve(url('agent://child-1?q=.result'), { cwd: '/ws' }))
      .rejects.toThrow(/JSON extraction is not supported/)
    await expect(handlerFor(stubStore()).resolve(url('agent://'), { cwd: '/ws' }))
      .rejects.toThrow(/requires a subagent output id/)
  })

  it('reports when the output store is not mounted', async () => {
    await expect(handlerFor(undefined).resolve(url('agent://child-1'), { cwd: '/ws' }))
      .rejects.toThrow(/session-query service is not mounted/)
    expect(await handlerFor(undefined).complete('ch', { cwd: '/ws' })).toEqual([])
  })

  it('completes subagent ids only, capped', async () => {
    const completions = await handlerFor(stubStore()).complete('ch', { cwd: '/ws' })
    const values = completions.map(candidate => candidate.value).sort()
    expect(values).toEqual(['child-1', 'child-2', 'grand-1'])
    expect(completions[0]?.label).toBe('agent://child-1')
  })

  it('renders a placeholder when the child produced no final output', async () => {
    const map = new Map<string, StubSession>()
    map.set('quiet-1', { session: header({ id: 'quiet-1', origin: 'subagent' }), events: [] })
    const resource = await handlerFor(stubStore(map)).resolve(url('agent://quiet-1'), { cwd: '/ws' })
    expect(resource.content).toContain('No final assistant output yet')
  })
})

describe('agent:// through ctx.internalUrls (package integration)', () => {
  it('registers the scheme and resolves a stub session-query service', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(apply)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    // The service is provided by the plugin fiber, so capture it before
    // disposal (disposing the fiber removes the service provision too); the
    // handler registration itself is an effect on the same fiber.
    const service = ctx.internalUrls
    expect(service.schemes()).toContain('agent')

    // Simulate a deployment with a session-query engine: the handler reads
    // ctx.get('sessionQuery') lazily at resolve time.
    await ctx.plugin({ name: 'stub-session-query', apply: (c: Context) => { c.provide('sessionQuery', stubStore() as never) } })
    const resource = await service.resolve('agent://child-1', { cwd: '/ws', sessionKey: 'root-0' })
    expect(resource.content).toContain('THE CHILD OUTPUT')

    await fiber.dispose()
    expect(service.schemes()).not.toContain('agent')
  })

  it('reports a friendly error when the session-query engine is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(apply)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await expect(ctx.internalUrls.resolve('agent://child-1', { cwd: '/ws' }))
      .rejects.toThrow(/session-query service is not mounted/)
  })
})
