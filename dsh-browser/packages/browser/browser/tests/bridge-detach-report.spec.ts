/**
 * Detach-report overtaking (port of oh-my-pi f04b9ee9a2 + f15fe85d60, adapted
 * to the fork's bridge): Chrome answers a command in flight with
 * "Detached while handling command." before the extension reports the detach.
 * A failure reply must not overtake that report — the client otherwise sees a
 * bare error with no hint that the debugger is gone.
 *
 * The extension leg is a raw fake socket; frames land in a shared sequence so
 * the tests can assert report-before-reply ordering.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayBridge, type RelaySocket } from '../src/relay/bridge.ts'
import type { TabSnapshot } from '../src/relay/protocol.ts'

/** Collects parsed frames in arrival order, tagged by leg (extension or downstream CDP). */
class FakeSocket implements RelaySocket {
  closed = false

  constructor(
    readonly leg: 'ext' | 'cdp',
    readonly sequence: Array<{ leg: string; frame: Record<string, unknown> }>,
  ) {}

  send(text: string): void {
    this.sequence.push({ leg: this.leg, frame: JSON.parse(text) as Record<string, unknown> })
  }

  close(): void {
    this.closed = true
  }

  /** CDP reply frames (have an id, no method). */
  replies(): Array<{ id: number; error?: { message: string }; result?: unknown }> {
    return this.sequence
      .filter(s => s.leg === 'cdp' && typeof s.frame.id === 'number' && s.frame.method === undefined)
      .map(s => s.frame) as Array<{ id: number; error?: { message: string }; result?: unknown }>
  }
}

/** Let queued microtasks and timer-0 callbacks land. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

let msgSeq = 0

const snap = (tabId: number): TabSnapshot => ({
  tabId,
  url: `https://example.com/${tabId}`,
  title: `t${tabId}`,
  active: false,
  windowId: 1,
  pinned: false,
  groupId: -1,
})

/** Bridge with tab 1 announced and a downstream connection attached to its page session. */
async function withAttachedTab(): Promise<{
  bridge: RelayBridge
  ext: FakeSocket
  cdp: FakeSocket
  sequence: Array<{ leg: string; frame: Record<string, unknown> }>
  conn: number
  session: string
}> {
  const sequence: Array<{ leg: string; frame: Record<string, unknown> }> = []
  const bridge = new RelayBridge()
  const ext = new FakeSocket('ext', sequence)
  bridge.extConnected(ext)
  bridge.extMessage(ext, JSON.stringify({
    t: 'hello',
    userAgent: 'ua',
    browserVersion: 'Chrome/1',
    discardedTabsProtocol: 1,
    tabs: [snap(1)],
    attachedTabIds: [],
  }))
  await flush()
  const cdp = new FakeSocket('cdp', sequence)
  const conn = bridge.cdpConnected(cdp)
  const id = ++msgSeq
  bridge.cdpMessage(conn, JSON.stringify({ id, method: 'Target.attachToTarget', params: { targetId: 'PAGE1' } }))
  for (const { frame } of ext.sequence) {
    if (frame.t === 'rpc' && frame.op === 'attach') {
      bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: frame.id, ok: true, result: {} }))
    }
  }
  await flush()
  const reply = cdp.replies().find(r => r.id === id)
  const session = (reply?.result as { sessionId?: string } | undefined)?.sessionId
  if (typeof session !== 'string') throw new Error(`attach failed: ${JSON.stringify(reply?.error ?? reply)}`)
  return { bridge, ext, cdp, sequence, conn, session }
}

/** Send a command on `session` and capture its id. */
function sendCmd(bridge: RelayBridge, conn: number, session: string, method: string, params: object = {}): number {
  const id = ++msgSeq
  bridge.cdpMessage(conn, JSON.stringify({ id, sessionId: session, method, params }))
  return id
}

/** The extension answers relay rpc `rpcId` with an error (or a result when `result` is given). */
function ackRpc(bridge: RelayBridge, ext: FakeSocket, rpcId: number, error?: string, result?: unknown): void {
  if (error !== undefined) {
    bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: rpcId, ok: false, error }))
  } else {
    bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: rpcId, ok: true, result: result ?? {} }))
  }
}

/** The extension's pending rpc requests, in arrival order. */
function pendingRpcs(ext: FakeSocket): Array<{ id: number; op: string; method?: string }> {
  return ext.sequence
    .map(s => s.frame)
    .filter(f => f.t === 'rpc')
    .map(f => f as unknown as { id: number; op: string; method?: string })
}

describe('relay bridge detach reporting', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('replies to a root-session detach failure only after the extension reports the detach', async () => {
    const { bridge, ext, cdp, sequence, conn, session } = await withAttachedTab()
    vi.useFakeTimers()
    const id = sendCmd(bridge, conn, session, 'Runtime.evaluate', { expression: '1' })

    // Chrome's real order: the in-flight command fails FIRST, the detach report follows.
    const rpcId = pendingRpcs(ext).at(-1)?.id
    expect(rpcId).toBeDefined()
    ackRpc(bridge, ext, rpcId!, 'Detached while handling command.')
    await vi.advanceTimersByTimeAsync(1)
    expect(cdp.replies().find(r => r.id === id)?.error).toBeUndefined()

    // The extension's own report lands while the bridge holds the failure reply.
    bridge.extMessage(ext, JSON.stringify({ t: 'detached', tabId: 1, reason: 'target_closed' }))
    await vi.advanceTimersByTimeAsync(1)

    const detachEventIndex = sequence.findIndex(
      s => s.leg === 'cdp' && s.frame.method === 'Target.detachedFromTarget',
    )
    const replyIndex = sequence.findIndex(s => s.leg === 'cdp' && (s.frame as { id?: number }).id === id)
    expect(detachEventIndex).toBeGreaterThanOrEqual(0)
    expect(replyIndex).toBeGreaterThan(detachEventIndex)
    expect(cdp.replies().find(r => r.id === id)?.error?.message).toBe(
      'Chrome detached the debugger from tab 1 (target_closed) during this command',
    )
  })

  it('replies to a root-session detach failure within 1s when no report ever comes', async () => {
    const { bridge, ext, cdp, conn, session } = await withAttachedTab()
    vi.useFakeTimers()
    const id = sendCmd(bridge, conn, session, 'Runtime.evaluate', { expression: '1' })

    const rpcId = pendingRpcs(ext).at(-1)?.id
    expect(rpcId).toBeDefined()
    ackRpc(bridge, ext, rpcId!, 'Detached while handling command.')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(cdp.replies().find(r => r.id === id)?.error?.message).toBe('Detached while handling command.')
  })

  it('probes the tab once for a child-session detach failure and reports the detach the probe flushed', async () => {
    const { bridge, ext, cdp, conn, session } = await withAttachedTab()

    // Arm auto-attach on the page session, then let Chrome report a cross-site frame.
    bridge.cdpMessage(conn, JSON.stringify({
      id: ++msgSeq,
      sessionId: session,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    }))
    await flush()
    for (const frame of ext.sequence.map(s => s.frame)) {
      if (frame.t === 'rpc' && frame.op === 'send') {
        ackRpc(bridge, ext, frame.id as number)
      }
    }
    bridge.extMessage(ext, JSON.stringify({
      t: 'cdpEvent',
      tabId: 1,
      method: 'Target.attachedToTarget',
      params: { sessionId: 'CHILD1', targetInfo: { targetId: 'FRAME1', type: 'iframe', attached: true } },
    }))
    await flush()
    const rpcsBeforeChild = pendingRpcs(ext).length

    // The child command fails with the in-flight detach answer while the attachment still reads alive.
    const id = sendCmd(bridge, conn, 'CHILD1', 'Runtime.evaluate', { expression: '1' })
    const childRpc = pendingRpcs(ext).slice(rpcsBeforeChild).at(-1)
    expect(childRpc?.method).toBe('Runtime.evaluate')
    ackRpc(bridge, ext, childRpc!.id, 'Detached while handling command.')
    await flush()

    // The bridge probes the tab root once; Chrome reports the detach before answering it.
    const probe = pendingRpcs(ext).at(-1)
    expect(probe?.op).toBe('send')
    expect(probe?.method).toBe('Target.getTargetInfo')
    bridge.extMessage(ext, JSON.stringify({ t: 'detached', tabId: 1, reason: 'target_closed' }))
    ackRpc(bridge, ext, probe!.id)
    await flush()
    expect(cdp.replies().find(r => r.id === id)?.error?.message).toBe(
      'Chrome detached the debugger from tab 1 (target_closed) during this command',
    )
  })

  it('replies to a non-detach failure immediately', async () => {
    const { bridge, ext, cdp, conn, session } = await withAttachedTab()
    vi.useFakeTimers()
    const id = sendCmd(bridge, conn, session, 'Runtime.evaluate', { expression: '1' })

    const rpcId = pendingRpcs(ext).at(-1)?.id
    expect(rpcId).toBeDefined()
    ackRpc(bridge, ext, rpcId!, 'Some other failure')

    await vi.advanceTimersByTimeAsync(0)
    expect(cdp.replies().find(r => r.id === id)?.error?.message).toBe('Some other failure')
  })

  it('rewrites a detach failure whose report already landed while the command was in flight', async () => {
    const { bridge, ext, cdp, conn, session } = await withAttachedTab()
    vi.useFakeTimers()
    const id = sendCmd(bridge, conn, session, 'Runtime.evaluate', { expression: '1' })

    // The report and the failure answer share one socket flush, report first:
    // by the time the rejection resumes, the detach is already recorded.
    const rpcId = pendingRpcs(ext).at(-1)?.id
    expect(rpcId).toBeDefined()
    bridge.extMessage(ext, JSON.stringify({ t: 'detached', tabId: 1, reason: 'target_closed' }))
    ackRpc(bridge, ext, rpcId!, 'Detached while handling command.')

    await vi.advanceTimersByTimeAsync(0)
    expect(cdp.replies().find(r => r.id === id)?.error?.message).toBe(
      'Chrome detached the debugger from tab 1 (target_closed) during this command',
    )
  })

  it('keeps an earlier detach reason out of a later relay-initiated detach failure', async () => {
    const { bridge, ext, cdp, conn, session } = await withAttachedTab()

    // Cycle 1: the detach is reported and named target_closed; its session dies with it.
    const firstId = sendCmd(bridge, conn, session, 'Runtime.evaluate', { expression: '1' })
    const firstRpc = pendingRpcs(ext).at(-1)?.id
    expect(firstRpc).toBeDefined()
    bridge.extMessage(ext, JSON.stringify({ t: 'detached', tabId: 1, reason: 'target_closed' }))
    ackRpc(bridge, ext, firstRpc!, 'Detached while handling command.')
    await flush()
    expect(cdp.replies().find(r => r.id === firstId)?.error?.message).toBe(
      'Chrome detached the debugger from tab 1 (target_closed) during this command',
    )

    // A different-url hello clears the ban the detach left; the tab attaches again.
    bridge.extMessage(ext, JSON.stringify({
      t: 'hello',
      userAgent: 'ua',
      browserVersion: 'Chrome/1',
      discardedTabsProtocol: 1,
      tabs: [{ ...snap(1), url: 'https://example.com/1-after-detach' }],
      attachedTabIds: [],
    }))
    await flush()
    const mark = ext.sequence.length
    const id = ++msgSeq
    bridge.cdpMessage(conn, JSON.stringify({ id, method: 'Target.attachToTarget', params: { targetId: 'PAGE1' } }))
    for (const { frame } of ext.sequence.slice(mark)) {
      if (frame.t === 'rpc' && frame.op === 'attach') ackRpc(bridge, ext, frame.id as number)
    }
    await flush()
    const session2 = (
      cdp.replies().find(r => r.id === id)?.result as { sessionId?: string } | undefined
    )?.sessionId
    expect(typeof session2).toBe('string')

    // Cycle 2: a command in flight while the relay itself releases the session.
    const secondId = sendCmd(bridge, conn, session2!, 'Runtime.evaluate', { expression: '1' })
    bridge.cdpMessage(conn, JSON.stringify({ id: ++msgSeq, method: 'Target.detachFromTarget', params: { sessionId: session2 } }))
    await flush()
    const detachRpcs = pendingRpcs(ext).filter(f => f.op === 'detach')
    expect(detachRpcs.length).toBeGreaterThan(0)
    ackRpc(bridge, ext, detachRpcs.at(-1)!.id)

    // The failure answers detach-shaped, but this detach has no reported reason:
    // the reply must not borrow cycle 1's target_closed.
    ackRpc(bridge, ext, pendingRpcs(ext).filter(f => f.op === 'send').at(-1)!.id, 'Detached while handling command.')
    await flush()
    expect(cdp.replies().find(r => r.id === secondId)?.error?.message).toBe('Detached while handling command.')
  })
})
