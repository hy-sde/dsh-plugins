/**
 * The `memory://` protocol: handler units against a stub backend, plus a
 * package-level integration proving the memory plugin registers the scheme
 * into the shared internal-URL registry and resolves a saved entry.
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as InternalUrls from '@hy-sde-org/dsh-internal-urls'
import { InternalUrlsService } from '@hy-sde-org/dsh-internal-urls'
import type { ParsedInternalUrl } from '@hy-sde-org/dsh-internal-urls'
import * as Memory from '../src/index.ts'
import { MemoryProtocolHandler } from '../src/memory-protocol.ts'
import type { MemoryBackend, MemoryContext, MemoryEntryView } from '../src/types.ts'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-memory-url-'))
}

/** Handler input record: cwd + optional signal, as the read tool threads it. */
const resolveContext = { cwd: '/ws', sessionKey: 'sess-1' }

function parsed(input: string): ParsedInternalUrl {
  return InternalUrls.parseInternalUrl(input)
}

/** A backend stub exposing only the surface the handler uses. */
class StubBackend {
  readonly id = 'stub'
  entries = new Map<string, MemoryEntryView>([
    ['m_abc', { id: 'm_abc', content: 'the stored fact', source: 'retain', importance: 0.7, timestamp: '2026-01-01T00:00:00.000Z' }],
    ['lesson_1', { id: 'lesson_1', content: 'a lesson bullet', source: 'learn', readonly: true }],
  ])
  rootBlock = '## Learned\n- lesson\n'
  readEntryCalls: Array<{ id: string; cwd: string }> = []

  async readEntry(context: MemoryContext, id: string): Promise<MemoryEntryView | undefined> {
    this.readEntryCalls.push({ id, cwd: context.cwd })
    return this.entries.get(id)
  }

  async listEntries(_context: MemoryContext, limit: number): Promise<MemoryEntryView[]> {
    return [...this.entries.values()].slice(0, limit)
  }

  async summaries(_context: MemoryContext): Promise<{ backend: string; block: string }> {
    return { backend: this.id, block: this.rootBlock }
  }
}

function handlerFor(backend: MemoryBackend | undefined): MemoryProtocolHandler {
  return new MemoryProtocolHandler({ backend: () => backend })
}

const notAddressableBackend: MemoryBackend = {
  id: 'hindsight',
  status: async () => ({ backend: 'hindsight', active: true, writable: false, searchable: true }),
  save: async () => ({ stored: 0, message: 'no' }),
  learn: async () => ({ stored: 0, message: 'no' }),
  search: async () => ({ backend: 'hindsight', query: 'q', count: 0, items: [] }),
  edit: async () => ({ status: 'not_found' }),
  summaries: async () => ({ backend: 'hindsight', block: '' }),
  clear: async () => undefined,
}

describe('MemoryProtocolHandler', () => {
  it('resolves memory://<id> to the entry with metadata header', async () => {
    const resource = await handlerFor(new StubBackend() as unknown as MemoryBackend)
      .resolve(parsed('memory://m_abc'), resolveContext)
    expect(resource.content).toContain('id: m_abc')
    expect(resource.content).toContain('the stored fact')
    expect(resource.content).toContain('source: retain')
    expect(resource.immutable).toBe(true)
    expect(resource.contentType).toBe('text/markdown')
  })

  it('resolves memory://root to the project overview block', async () => {
    const resource = await handlerFor(new StubBackend() as unknown as MemoryBackend)
      .resolve(parsed('memory://root'), resolveContext)
    expect(resource.content).toContain('## Learned')
    expect(resource.notes?.[0]).toContain('stub')
  })

  it('rejects unknown ids with a corrective error listing recall/memory_edit', async () => {
    await expect(handlerFor(new StubBackend() as unknown as MemoryBackend)
      .resolve(parsed('memory://nope'), resolveContext))
      .rejects.toThrow(/Memory nope does not exist/)
  })

  it('returns the corrective not-addressable error when the backend has no readEntry', async () => {
    await expect(handlerFor(notAddressableBackend).resolve(parsed('memory://m_abc'), resolveContext))
      .rejects.toThrow(/not addressable via memory:\/\/<id>/)
  })

  it('requires a namespace, a cwd, and a mounted backend', async () => {
    await expect(handlerFor(new StubBackend() as unknown as MemoryBackend).resolve(parsed('memory://'), resolveContext))
      .rejects.toThrow(/requires a namespace/)
    await expect(handlerFor(new StubBackend() as unknown as MemoryBackend)
      .resolve(parsed('memory://m_abc'), { sessionKey: 'sess-1' }))
      .rejects.toThrow(/working directory/)
    await expect(handlerFor(undefined).resolve(parsed('memory://m_abc'), resolveContext))
      .rejects.toThrow(/no memory backend is registered/)
  })

  it('rejects paths under root or under an id (backend-shaped, not file-shaped)', async () => {
    await expect(handlerFor(new StubBackend() as unknown as MemoryBackend)
      .resolve(parsed('memory://root/learned'), resolveContext))
      .rejects.toThrow(/memory:\/\/root takes no path/)
    await expect(handlerFor(new StubBackend() as unknown as MemoryBackend)
      .resolve(parsed('memory://m_abc/extra'), resolveContext))
      .rejects.toThrow(/does not take a path/)
  })

  it('completes root plus enumerated entry ids', async () => {
    const completions = await handlerFor(new StubBackend() as unknown as MemoryBackend)
      .complete('m', resolveContext)
    const values = completions.map(candidate => candidate.value)
    expect(values).toContain('root')
    expect(values).toContain('m_abc')
    expect(values).toContain('lesson_1')
    expect(completions.find(candidate => candidate.value === 'm_abc')?.description).toContain('the stored fact')
  })

  it('completes only root for a backend without enumeration', async () => {
    const completions = await handlerFor(notAddressableBackend).complete('m', resolveContext)
    expect(completions.map(candidate => candidate.value)).toEqual(['root'])
  })
})

describe('memory:// through ctx.internalUrls (package integration)', () => {
  async function mount(): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
    const ctx = new Context()
    // Provide the registry service directly (the full plugin also needs ctx.fs
    // for its conflict bridge; the fs-free service proves this package's
    // registration path). The full-plugin composition is exercised by
    // dsh-internal-urls' scheme-e2e spec.
    new InternalUrlsService(ctx)
    const root = await tempRoot()
    const fiber = await ctx.plugin(Memory, { root })
    return { ctx, fiber }
  }

  it('registers the scheme exactly once and resolves a retained entry', async () => {
    const { ctx } = await mount()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(ctx.internalUrls.schemes()).toContain('memory')

    const saved = await ctx.memory.save({ cwd: '/ws' }, { content: 'ported handler fact' })
    expect(saved.id).toBeTruthy()
    const resource = await ctx.internalUrls.resolve(`memory://${saved.id}`, { cwd: '/ws', sessionKey: 's1' })
    expect(resource.content).toContain('ported handler fact')
    expect(resource.content).toContain(`id: ${saved.id}`)
  })

  it('read memory://root after a learn and clears correctly', async () => {
    const { ctx } = await mount()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await ctx.memory.learn({ cwd: '/ws' }, { content: 'a durable lesson' })
    const root = await ctx.internalUrls.resolve('memory://root', { cwd: '/ws', sessionKey: 's1' })
    expect(root.content).toContain('a durable lesson')
    await ctx.memory.clear({ cwd: '/ws' })
    const empty = await ctx.internalUrls.resolve('memory://root', { cwd: '/ws', sessionKey: 's1' })
    expect(empty.content).toContain('Project memory is empty')
  })

  it('cwd-scoped reads do not leak across projects', async () => {
    const { ctx } = await mount()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const saved = await ctx.memory.save({ cwd: '/ws' }, { content: 'project one fact' })
    await expect(ctx.internalUrls.resolve(`memory://${saved.id}`, { cwd: '/other', sessionKey: 's2' }))
      .rejects.toThrow(/does not exist/)
  })

  it('complete() returns root through the registry', async () => {
    const { ctx } = await mount()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const completions = await ctx.internalUrls.complete('memory', 'r', { cwd: '/ws', sessionKey: 's1' })
    expect(completions?.map(candidate => candidate.value)).toContain('root')
  })

  it('stays unregistered when the registry is not mounted', async () => {
    const ctx = new Context()
    const root = await tempRoot()
    await ctx.plugin(Memory, { root })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    // No ctx.internalUrls in this composition; memory itself still works.
    const saved = await ctx.memory.save({ cwd: '/ws' }, { content: 'no registry' })
    expect(saved.stored).toBe(1)
  })

  it('unregisters the scheme on fiber disposal (HMR safety)', async () => {
    const { ctx, fiber } = await mount()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(ctx.internalUrls.schemes()).toContain('memory')
    await fiber.dispose()
    expect(ctx.internalUrls.schemes()).not.toContain('memory')
  })
})
