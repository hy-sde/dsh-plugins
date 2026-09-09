import { describe, expect, it, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import plugin, { resetGlobalModelSlotGate } from '../src/index.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const options: GenerateOptions = { provider: 'mock', model: 'mock', messages: [] }

async function* source(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* chunks
}

function textDelta(index = 0, text = 'x'): StreamChunk {
  return { type: 'text-delta', index, text }
}

const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

/** A source that stalls mid-stream until `trigger` resolves — the admission
 * states are observable only while such a call is still in flight. */
function blockedSource(trigger: Promise<void>): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    yield textDelta(0, 'held')
    await trigger
    yield finish
  })()
}

/** Run one model call through the waterfall and collect its chunks. */
async function consume(ctx: Context, chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const stream = ctx.waterfall(ctx as never, 'llm/stream', options, () => chunks)
  const consumed: StreamChunk[] = []
  for await (const chunk of stream) consumed.push(chunk)
  return consumed
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** A deferred trigger resolved manually by the test. */
function trigger(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((r) => { release = r })
  return { promise, release }
}

describe('llm-slots admission plugin', () => {
  beforeEach(() => {
    resetGlobalModelSlotGate()
  })

  it('passes a single call through unchanged and releases the slot on finish', async () => {
    const ctx = new Context()
    await ctx.plugin(plugin, { capacity: 1 })
    const chunks = [textDelta(), finish]
    await expect(consume(ctx, source(chunks))).resolves.toEqual(chunks)
    expect(ctx.modelSlots.stats()).toEqual({
      enabled: true,
      capacity: 1,
      running: 0,
      waiting: 0,
      acquiredTotal: 1,
    })
  })

  it('queues excess calls FIFO and grants them as slots free', async () => {
    const ctx = new Context()
    await ctx.plugin(plugin, { capacity: 1 })
    const gate = trigger()
    const first = consume(ctx, blockedSource(gate.promise))
    await tick()
    expect(ctx.modelSlots.stats().running).toBe(1)

    const second = consume(ctx, source([textDelta(0, '2'), finish]))
    const third = consume(ctx, source([textDelta(0, '3'), finish]))
    await tick()
    expect(ctx.modelSlots.stats().waiting).toBe(2)

    gate.release() // `first` finishes and hands its slot to `second`
    const results = await Promise.all([first, second, third])
    expect(results.map(r => r.map(c => c.type))).toEqual([
      ['text-delta', 'finish'],
      ['text-delta', 'finish'],
      ['text-delta', 'finish'],
    ])
    expect(ctx.modelSlots.stats().running).toBe(0)
    expect(ctx.modelSlots.stats().waiting).toBe(0)
    expect(ctx.modelSlots.stats().acquiredTotal).toBe(3)
  })

  it('surfaces caller cancellation while queued as an AbortError without leaking the slot', async () => {
    const ctx = new Context()
    await ctx.plugin(plugin, { capacity: 1 })
    const holder = trigger()
    const holding = consume(ctx, blockedSource(holder.promise))
    await tick()
    expect(ctx.modelSlots.stats().running).toBe(1)

    const controller = new AbortController()
    const aborted = consumeWithSignal(ctx, controller)
    await tick()
    expect(ctx.modelSlots.stats().waiting).toBe(1)

    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(ctx.modelSlots.stats().waiting).toBe(0)

    holder.release()
    await holding
    expect(ctx.modelSlots.stats().running).toBe(0)
  })

  it('releases the slot when the downstream stream throws mid-way', async () => {
    const ctx = new Context()
    await ctx.plugin(plugin, { capacity: 1 })
    const throwing = {
      async *[Symbol.asyncIterator](): AsyncIterableIterator<StreamChunk> {
        yield textDelta(0, 'boom')
        throw new Error('downstream exploded')
      },
    }
    const stream = ctx.waterfall(ctx as never, 'llm/stream', options, () => throwing)
    await expect((async () => {
      const out: StreamChunk[] = []
      for await (const chunk of stream) out.push(chunk)
      return out
    })()).rejects.toThrow('downstream exploded')
    expect(ctx.modelSlots.stats().running).toBe(0)
  })

  it('bypasses admission entirely when disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(plugin, { enabled: false, capacity: 1 })
    await consume(ctx, source([textDelta(), finish]))
    expect(ctx.modelSlots.stats().running).toBe(0)
    expect(ctx.modelSlots.stats().waiting).toBe(0)
    expect(ctx.modelSlots.stats().acquiredTotal).toBe(0)
  })

  it('supports runtime capacity changes through ctx.modelSlots.setCapacity', async () => {
    const ctx = new Context()
    await ctx.plugin(plugin, { capacity: 2 })
    ctx.modelSlots.setCapacity(1)
    expect(ctx.modelSlots.stats().capacity).toBe(1)
    const holder = trigger()
    const first = consume(ctx, blockedSource(holder.promise))
    await tick()
    expect(ctx.modelSlots.stats().running).toBe(1)
    const second = consume(ctx, source([textDelta(0, '2'), finish]))
    await tick()
    expect(ctx.modelSlots.stats().waiting).toBe(1)
    holder.release()
    await Promise.all([first, second])
    expect(ctx.modelSlots.stats().running).toBe(0)
  })
})

/** Like {@link consume} but cancels the caller's request via `signal`. */
async function consumeWithSignal(ctx: Context, controller: AbortController): Promise<StreamChunk[]> {
  const stream = ctx.waterfall(
    ctx as never,
    'llm/stream',
    { ...options, signal: controller.signal },
    () => source([textDelta(0, 'cancel'), finish]),
  )
  const consumed: StreamChunk[] = []
  for await (const chunk of stream) consumed.push(chunk)
  return consumed
}
