import { describe, expect, it } from 'vitest'
import { ModelSlotGate, globalModelSlotGate, resetGlobalModelSlotGate } from '../src/index.ts'

/** Observe whether a promise settled and, if rejected, with what error name. */
async function settled(promise: Promise<unknown>): Promise<{ ok: boolean; name?: string }> {
  try {
    await promise
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, name: error instanceof Error ? error.name : String(error) }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('ModelSlotGate', () => {
  it('grants immediately up to capacity and counts acquisitions', async () => {
    const gate = new ModelSlotGate()
    gate.capacity = 2
    await gate.acquire()
    await gate.acquire()
    expect(gate.snapshot().running).toBe(2)
    expect(gate.snapshot().waiting).toBe(0)
    expect(gate.snapshot().acquiredTotal).toBe(2)
    gate.release()
    gate.release()
    expect(gate.snapshot().running).toBe(0)
  })

  it('buffers excess acquirers FIFO and transfers the freed slot', async () => {
    const gate = new ModelSlotGate()
    gate.capacity = 1
    await gate.acquire()
    const second = deferred()
    const acquired = gate.acquire()
    void acquired.then(second.resolve)
    expect(gate.snapshot().waiting).toBe(1)
    gate.release()
    await second.promise
    expect(gate.snapshot().running).toBe(1)
    expect(gate.snapshot().waiting).toBe(0)
    expect(gate.snapshot().acquiredTotal).toBe(2)
    gate.release()
  })

  it('honors arrival order across a queue deeper than the capacity', async () => {
    const gate = new ModelSlotGate()
    gate.capacity = 1
    await gate.acquire()
    const order: string[] = []
    const one = gate.acquire().then(() => { order.push('one') })
    const two = gate.acquire().then(() => { order.push('two') })
    const three = gate.acquire().then(() => { order.push('three') })
    await Promise.resolve()
    gate.release() // lets `one` in; `two`, `three` still queued
    await one
    gate.release() // lets `two` in; `three` still queued
    await two
    gate.release() // lets `three` in
    await three
    expect(order).toEqual(['one', 'two', 'three'])
    gate.release()
  })

  it('drops and rejects an aborted waiter without handing it the freed slot', async () => {
    const gate = new ModelSlotGate()
    gate.capacity = 1
    await gate.acquire()
    const controller = new AbortController()
    const aborted = gate.acquire(controller.signal)
    const waiting = gate.acquire() // the "next in line" after the aborted one
    controller.abort()
    expect(await settled(aborted)).toEqual({ ok: false, name: 'AbortError' })
    expect(gate.snapshot().waiting).toBe(1) // only `waiting` remains queued
    gate.release() // frees the slot -> goes to `waiting`, not the aborted acquire
    await waiting
    gate.release()
    expect(gate.snapshot().acquiredTotal).toBe(2)
  })

  it('is disabled-bypass when disabled and rejects over-release', async () => {
    const gate = new ModelSlotGate()
    gate.enabled = false
    await expect(gate.acquire()).resolves.toBe(false)
    expect(gate.snapshot().running).toBe(0)
    expect(gate.snapshot().acquiredTotal).toBe(0)
    expect(() => { gate.release() }).toThrow(/released with no held slot/)
  })

  it('supports runtime reconfigure through setCapacity semantics', () => {
    const gate = new ModelSlotGate()
    gate.reconfigure({ enabled: true, capacity: 5 })
    gate.reconfigure({ enabled: false, capacity: 2 })
    expect(gate.snapshot()).toEqual({
      enabled: false,
      capacity: 2,
      running: 0,
      waiting: 0,
      acquiredTotal: 0,
    })
  })

  it('globalModelSlotGate is a reset-able singleton', () => {
    const first = globalModelSlotGate()
    const same = globalModelSlotGate()
    expect(same).toBe(first)
    resetGlobalModelSlotGate()
    const second = globalModelSlotGate()
    expect(second).not.toBe(first)
    resetGlobalModelSlotGate()
  })
})
