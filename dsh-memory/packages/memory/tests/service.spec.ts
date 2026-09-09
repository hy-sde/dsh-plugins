/**
 * The `ctx.memory` service over a live Cordis context: registry semantics,
 * delegation to the local backend, and the `memory/change` mutation event.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Memory from '../src/index.ts'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-memory-'))
}

async function mount(root: string) {
  const ctx = new Context()
  const events: string[] = []
  ctx.on('memory/change', (payload) => { events.push(payload.cwd) })
  await ctx.plugin(Memory, { root })
  return { ctx, events }
}

describe('MemoryService registry', () => {
  it('registers the local backend, delegates operations, and emits memory/change', async () => {
    const root = await tempRoot()
    const { ctx, events } = await mount(root)
    const service = ctx.memory
    expect(service.backendIds()).toEqual(['local'])
    expect(service.resolve()?.id).toBe('local')

    const status = await service.status({ cwd: '/ws' })
    expect(status.backend).toBe('local')
    expect(status.writable).toBe(true)

    const saved = await service.save({ cwd: '/ws' }, { content: 'delegated fact' })
    expect(saved.stored).toBe(1)
    expect(events).toContain('/ws')

    const found = await service.search({ cwd: '/ws' }, 'delegated fact')
    expect(found.count).toBe(1)
    await service.edit({ cwd: '/ws' }, 'forget', { id: saved.id ?? '' })
  })

  it('missing backend surfaces a clear error', async () => {
    const ctx = new Context()
    // Mounting with a backend id no shipped provider satisfies leaves the
    // service with zero registered backends.
    await ctx.plugin(Memory, { backend: 'hindsight' })
    await expect(ctx.memory.status({ cwd: '/ws' })).rejects.toThrow(/no memory backend is registered/)
  })

  it('unregister and disposer remove the backend', async () => {
    const root = await tempRoot()
    const ctx = new Context()
    await ctx.plugin(Memory, { root })
    const service = ctx.memory
    const dispose = service.register({ ...service.resolve()!, id: 'spare' })
    expect(service.backendIds().sort()).toEqual(['local', 'spare'])
    dispose()
    expect(service.backendIds()).toEqual(['local'])
  })
})
