/**
 * Group reconcile after an in-flight group RPC (port of oh-my-pi f33fb1f5a7):
 * a claim can close while the group RPC is in flight, and the result then
 * marks the tab grouped though no connection claims it any more — the settle
 * path re-checks worthiness and undoes the grouping.
 */

import { describe, expect, it } from 'vitest'
import { RelayBridge, type RelaySocket } from '../src/relay/bridge.ts'
import type { TabSnapshot } from '../src/relay/protocol.ts'

class FakeSocket implements RelaySocket {
  readonly frames: Array<Record<string, unknown>> = []

  send(text: string): void {
    this.frames.push(JSON.parse(text) as Record<string, unknown>)
  }

  close(): void {
    // Not used: the bridge never closes the extension leg in these tests.
  }

  /** CDP reply frames (have an id, no method). */
  replies(): Array<{ id: number; error?: { message: string }; result?: unknown }> {
    return this.frames.filter(f => typeof f.id === 'number' && f.method === undefined) as Array<{
      id: number
      error?: { message: string }
      result?: unknown
    }>
  }
}

/** Let queued microtasks and timer-0 callbacks land. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

const snap = (tabId: number): TabSnapshot => ({
  tabId,
  url: `https://example.com/${tabId}`,
  title: `t${tabId}`,
  active: false,
  windowId: 1,
  pinned: false,
  groupId: -1,
})

describe('relay bridge grouping', () => {
  it('ungroups a tab whose claiming client closed while its group RPC was in flight', async () => {
    const bridge = new RelayBridge({ group: { title: 'omp', color: 'cyan' } })
    const ext = new FakeSocket()
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

    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    bridge.cdpMessage(conn, JSON.stringify({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'PAGE1' } }))
    for (const frame of ext.frames) {
      if (frame.t === 'rpc' && frame.op === 'attach') {
        bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: frame.id, ok: true, result: {} }))
      }
    }
    await flush()
    const session = (cdp.replies().find(r => r.id === 1)?.result as { sessionId?: string } | undefined)?.sessionId
    expect(typeof session).toBe('string')

    // The claim starts the group RPC; leave it unanswered.
    bridge.cdpMessage(conn, JSON.stringify({ id: 2, sessionId: session, method: 'OMP.claimTarget', params: {} }))
    await flush()
    const groupRpcs = ext.frames.filter(f => f.t === 'rpc' && f.op === 'group')
    expect(groupRpcs.map(f => f.tabIds)).toEqual([[1]])

    // The client closes before the group RPC answers: nothing to undo yet.
    bridge.cdpClosed(conn)
    expect(ext.frames.filter(f => f.t === 'rpc' && f.op === 'ungroup')).toHaveLength(0)

    // The result settles and marks the tab grouped — the claim is already
    // gone, so the drain re-checks worthiness and ungroups.
    const group = groupRpcs[0]!
    bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: group.id, ok: true, result: { grouped: { '1': 42 } } }))
    await flush()
    expect(ext.frames.filter(f => f.t === 'rpc' && f.op === 'ungroup').map(f => f.tabIds)).toEqual([[1]])
  })
})
