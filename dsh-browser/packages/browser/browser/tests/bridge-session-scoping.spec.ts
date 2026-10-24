/**
 * Relay target-id scoping to the browser session (port of oh-my-pi
 * 6d667e5d29): Chrome reuses tab ids across restarts, so a hello from a new
 * browser session retires every recorded target and the hello carries the
 * session id. Extensions without a session degrade safely.
 *
 * Also covers the confirmed closeTarget reply (upstream closeRelayTarget
 * semantics): success only when the extension confirmed the close, where an
 * already-gone tab counts as success and any other failure reports an error.
 *
 * The extension leg is a raw fake socket; the bridge drives it exactly like
 * the real MV3 companion.
 */

import { describe, expect, it } from 'vitest'
import { RelayBridge, type RelaySocket } from '../src/relay/bridge.ts'
import type { TabSnapshot } from '../src/relay/protocol.ts'

/** Collects parsed frames; also acks the bridge's RPCs like the extension would. */
class FakeSocket implements RelaySocket {
  readonly frames: Array<Record<string, unknown>> = []
  closed = false

  send(text: string): void {
    this.frames.push(JSON.parse(text) as Record<string, unknown>)
  }

  close(): void {
    this.closed = true
  }

  /** Ops of the RPC requests seen on this socket, in order. */
  ops(): string[] {
    return this.frames.filter(f => f.t === 'rpc').map(f => String(f.op))
  }

  /** CDP reply frames (have an id, no method). */
  replies(): Array<{ id: number; error?: { message: string }; result?: unknown }> {
    return this.frames.filter(f => typeof f.id === 'number' && f.method === undefined) as Array<{
      id: number
      error?: { message: string }
      result?: unknown
    }>
  }

  /** CDP event frames (have a method, no id). */
  methods(): string[] {
    return this.frames.filter(f => typeof f.method === 'string').map(f => String(f.method))
  }
}

/** Let queued microtasks and timer-0 callbacks land. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

const snap = (tabId: number, extra: Partial<TabSnapshot> = {}): TabSnapshot => ({
  tabId,
  url: `https://example.com/${tabId}`,
  title: `t${tabId}`,
  active: false,
  windowId: 1,
  pinned: false,
  groupId: -1,
  ...extra,
})

const hello = (tabs: TabSnapshot[], browserSession?: string): string =>
  JSON.stringify({
    t: 'hello',
    userAgent: 'ua',
    browserVersion: 'Chrome/1',
    discardedTabsProtocol: 1,
    ...(browserSession !== undefined ? { browserSession } : {}),
    tabs,
    attachedTabIds: [],
  })

/** Bridge + extension socket wired with a hello naming `tabs` and `browserSession`. */
async function withHello(tabs: TabSnapshot[], browserSession?: string): Promise<{ bridge: RelayBridge; ext: FakeSocket }> {
  const bridge = new RelayBridge()
  const ext = new FakeSocket()
  bridge.extConnected(ext)
  bridge.extMessage(ext, hello(tabs, browserSession))
  return { bridge, ext }
}

/** Discovering downstream connection over which target lifecycles are observed. */
async function discovering(bridge: RelayBridge): Promise<{ cdp: FakeSocket; connId: number }> {
  const cdp = new FakeSocket()
  const connId = bridge.cdpConnected(cdp)
  bridge.cdpMessage(connId, JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }))
  await flush()
  return { cdp, connId }
}

describe('relay bridge — browser session scoping', () => {
  it('retires every target when a hello names a different browser session', async () => {
    const { bridge, ext } = await withHello([snap(1), snap(2)], 'session-a')
    const { cdp } = await discovering(bridge)
    expect(cdp.methods().filter(m => m === 'Target.targetCreated')).toHaveLength(4)

    // Chrome restarted: same tab ids come back but under a new session.
    bridge.extMessage(ext, hello([snap(1), snap(2)], 'session-b'))
    await flush()
    // The old session's four targets are destroyed...
    expect(cdp.methods().filter(m => m === 'Target.targetDestroyed')).toHaveLength(4)
    // ...and nothing is re-announced: the snapshot re-upserts tabs silently,
    // discovery announces on setDiscoverTargets only.
    expect(cdp.methods().filter(m => m === 'Target.targetCreated')).toHaveLength(4)
  })

  it('retires targets when a session-scoped hello is followed by a session-less one (scope changed)', async () => {
    const { bridge, ext } = await withHello([snap(1)], 'session-a')
    const { cdp } = await discovering(bridge)
    bridge.extMessage(ext, hello([snap(1)]))
    await flush()
    expect(cdp.methods().filter(m => m === 'Target.targetDestroyed')).toHaveLength(2)

    // And a later session-scoped hello retires again — the first retirement
    // already emptied the registry, so this one destroys nothing new; the
    // hello's own snapshot re-records the tab as a fresh unannounced entry.
    bridge.extMessage(ext, hello([snap(1)], 'session-b'))
    await flush()
    expect(cdp.methods().filter(m => m === 'Target.targetDestroyed')).toHaveLength(2)
  })

  it('never arms retirement when no session was ever reported', async () => {
    const { bridge, ext } = await withHello([snap(1)])
    const { cdp } = await discovering(bridge)
    bridge.extMessage(ext, hello([snap(1)]))
    await flush()
    expect(cdp.methods().filter(m => m === 'Target.targetDestroyed')).toHaveLength(0)
  })
})

describe('relay bridge — confirmed closeTarget reply', () => {
  it('replies success when the extension confirms the close', async () => {
    const { bridge, ext } = await withHello([snap(1)])
    const { cdp, connId } = await discovering(bridge)
    bridge.cdpMessage(connId, JSON.stringify({ id: 7, method: 'Target.closeTarget', params: { targetId: 'PAGE1' } }))
    await flush()
    const rpc = ext.frames.find(f => f.t === 'rpc' && f.op === 'removeTab')
    expect(rpc).toBeDefined()
    bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: rpc?.id, ok: true, result: {} }))
    await flush()
    expect(cdp.replies().find(r => r.id === 7)?.result).toEqual({ success: true })
    expect(cdp.replies().find(r => r.id === 7)?.error).toBeUndefined()
  })

  it('counts an already-gone tab ("No tab with id") as a successful close', async () => {
    const { bridge, ext } = await withHello([snap(1)])
    const { cdp, connId } = await discovering(bridge)
    bridge.cdpMessage(connId, JSON.stringify({ id: 7, method: 'Target.closeTarget', params: { targetId: 'PAGE1' } }))
    await flush()
    const rpc = ext.frames.find(f => f.t === 'rpc' && f.op === 'removeTab')
    bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: rpc?.id, ok: false, error: 'No tab with id: 1' }))
    await flush()
    expect(cdp.replies().find(r => r.id === 7)?.result).toEqual({ success: true })
  })

  it('replies an error when the close failed for any other reason', async () => {
    const { bridge, ext } = await withHello([snap(1)])
    const { cdp, connId } = await discovering(bridge)
    bridge.cdpMessage(connId, JSON.stringify({ id: 7, method: 'Target.closeTarget', params: { targetId: 'PAGE1' } }))
    await flush()
    const rpc = ext.frames.find(f => f.t === 'rpc' && f.op === 'removeTab')
    bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: rpc?.id, ok: false, error: 'cannot remove pinned tab' }))
    await flush()
    const reply = cdp.replies().find(r => r.id === 7)
    expect(reply?.result).toBeUndefined()
    expect(reply?.error?.message).toContain('Failed to close tab 1')
    expect(reply?.error?.message).toContain('cannot remove pinned tab')
  })
})
