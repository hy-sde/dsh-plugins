/**
 * Foreign-frame clearing is asked per tab, from the bridge (port of
 * oh-my-pi ddc72a7436): Chrome refuses the debugger over another extension's
 * frames, and emptying them in the user's other tabs would wipe their menus,
 * so only a tab a downstream connection claims gets the flag.
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

describe('relay bridge foreign-frame clearing', () => {
  it('flags attach and send RPCs to claimed tabs only', async () => {
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
    await flush()
    const attachRpcs = ext.frames.filter(f => f.t === 'rpc' && f.op === 'attach')
    expect(attachRpcs.map(f => f.clearForeignFrames)).toEqual([false])
    for (const frame of attachRpcs) {
      bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: frame.id, ok: true, result: {} }))
    }
    await flush()
    const session = (cdp.replies().find(r => r.id === 1)?.result as { sessionId?: string } | undefined)?.sessionId
    expect(typeof session).toBe('string')

    // A command to a tab nobody claims keeps its foreign frames.
    bridge.cdpMessage(conn, JSON.stringify({ id: 2, sessionId: session, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed' } }))
    await flush()
    const unclaimedSends = ext.frames.filter(f => f.t === 'rpc' && f.op === 'send')
    expect(unclaimedSends.map(f => f.clearForeignFrames)).toEqual([false])
    for (const frame of unclaimedSends) {
      bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: frame.id, ok: true, result: {} }))
    }

    bridge.cdpMessage(conn, JSON.stringify({ id: 3, sessionId: session, method: 'OMP.claimTarget', params: {} }))
    await flush()
    // The claim starts the group RPC; other ops carry no clearing flag.
    const groupRpcs = ext.frames.filter(f => f.t === 'rpc' && f.op === 'group')
    expect(groupRpcs.length).toBeGreaterThan(0)
    for (const frame of groupRpcs) expect('clearForeignFrames' in frame).toBe(false)
    for (const frame of groupRpcs) {
      bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: frame.id, ok: true, result: { grouped: { '1': 42 } } }))
    }
    await flush()

    bridge.cdpMessage(conn, JSON.stringify({ id: 4, sessionId: session, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased' } }))
    await flush()
    const claimedSends = ext.frames.filter(f => f.t === 'rpc' && f.op === 'send').slice(-1)
    expect(claimedSends.map(f => f.clearForeignFrames)).toEqual([true])
  })
})
