/**
 * Bridge behavior for Chrome-discarded tabs (port of oh-my-pi 2e79772ddb /
 * e441796894): a discarded tab cannot answer debugger calls, so the bridge
 * must never attach it, never let puppeteer's init wait on it, and must
 * retire + reannounce it across a discard/revival cycle — including clearing
 * a ban that the discard (not the debugger) caused. Also covers the
 * detaching-serialization rule (78d44fea92): a new attach waits out an
 * in-flight detach instead of being undone by it.
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

/** Ack every attach/detach RPC the extension has (not yet) answered. */
function ackRpcs(bridge: RelayBridge, ext: FakeSocket, op: 'attach' | 'detach', ok = true): void {
  for (const frame of ext.frames) {
    if (frame.t !== 'rpc' || frame.op !== op) continue
    const id = frame.id as number
    bridge.extMessage(ext, JSON.stringify(
      ok
        ? { t: 'rpcResult', id, ok: true, result: {} }
        : { t: 'rpcResult', id, ok: false, error: 'Another debugger is already attached' },
    ))
  }
}

/** Bridge + extension socket wired with a hello naming `tabs`. */
async function withHello(tabs: TabSnapshot[]): Promise<{ bridge: RelayBridge; ext: FakeSocket }> {
  const bridge = new RelayBridge()
  const ext = new FakeSocket()
  bridge.extConnected(ext)
  bridge.extMessage(ext, JSON.stringify({
    t: 'hello',
    userAgent: 'ua',
    browserVersion: 'Chrome/1',
    discardedTabsProtocol: 1,
    tabs,
    attachedTabIds: [],
  }))
  return { bridge, ext }
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

const hello = (tabs: TabSnapshot[]): string =>
  JSON.stringify({ t: 'hello', userAgent: 'ua', browserVersion: 'Chrome/1', discardedTabsProtocol: 1, tabs, attachedTabIds: [] })

describe('relay bridge — discarded tabs', () => {
  it('never announces or attaches a discarded tab (puppeteer init cannot hang)', async () => {
    const { bridge, ext } = await withHello([snap(1, { discarded: true })])
    const cdp = new FakeSocket()
    const connId = bridge.cdpConnected(cdp)
    bridge.cdpMessage(connId, JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }))
    bridge.cdpMessage(connId, JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    await flush()
    expect(ext.ops()).not.toContain('attach')
    expect(cdp.methods()).not.toContain('Target.targetCreated')
    expect(cdp.methods()).not.toContain('Target.attachedToTarget')
  })

  it('fails an attach to a discarded tab immediately, without an attach RPC', async () => {
    const { bridge, ext } = await withHello([snap(1, { discarded: true })])
    const cdp = new FakeSocket()
    const connId = bridge.cdpConnected(cdp)
    bridge.cdpMessage(connId, JSON.stringify({ id: 3, method: 'Target.attachToTarget', params: { targetId: 'PAGE1' } }))
    await flush()
    const reply = cdp.replies().find(r => r.id === 3)
    expect(reply?.error?.message).toContain('discarded')
    expect(ext.ops()).not.toContain('attach')
  })

  it('retires a held tab when hello reports it discarded, then reannounces + reattaches on revival', async () => {
    const { bridge, ext } = await withHello([snap(1)])
    const cdp = new FakeSocket()
    const connId = bridge.cdpConnected(cdp)
    bridge.cdpMessage(connId, JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }))
    bridge.cdpMessage(connId, JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    await flush()
    ackRpcs(bridge, ext, 'attach')
    await flush()
    expect(cdp.methods().filter(m => m === 'Target.attachedToTarget')).toHaveLength(1)

    // Extension restart (or fresh snapshot): the tab is now discarded.
    bridge.extMessage(ext, hello([snap(1, { discarded: true })]))
    await flush()
    expect(cdp.methods()).toContain('Target.detachedFromTarget')
    expect(cdp.methods()).toContain('Target.targetDestroyed')

    // User clicks the tab: Chrome revives it, onActivated refetches → revival.
    bridge.extMessage(ext, JSON.stringify({ t: 'tabUpdated', tab: snap(1) }))
    await flush()
    ackRpcs(bridge, ext, 'attach')
    await flush()
    expect(ext.ops()).toEqual(['attach', 'attach'])
    expect(cdp.methods().filter(m => m === 'Target.attachedToTarget')).toHaveLength(2)
    expect(cdp.methods().filter(m => m === 'Target.targetCreated')).toHaveLength(4)
  })

  it('drops the stranded debugger and retracts a tab that turns discarded mid-life', async () => {
    const { bridge, ext } = await withHello([snap(1)])
    const cdp = new FakeSocket()
    const connId = bridge.cdpConnected(cdp)
    bridge.cdpMessage(connId, JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }))
    bridge.cdpMessage(connId, JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    await flush()
    ackRpcs(bridge, ext, 'attach')
    await flush()

    bridge.extMessage(ext, JSON.stringify({ t: 'tabUpdated', tab: snap(1, { discarded: true }) }))
    await flush()
    // The stranded debugger attachment is dropped, the target retracted.
    expect(ext.ops()).toEqual(['attach', 'detach'])
    expect(cdp.methods()).toContain('Target.targetDestroyed')
  })

  it('clears a refused attach on revival (the ban was the discard, not the debugger)', async () => {
    const { bridge, ext } = await withHello([snap(1)])
    const cdp = new FakeSocket()
    const connId = bridge.cdpConnected(cdp)
    bridge.cdpMessage(connId, JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }))
    bridge.cdpMessage(connId, JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    await flush()
    // The attach fails while the tab is alive (say DevTools was open).
    ackRpcs(bridge, ext, 'attach', false)
    await flush()
    expect(cdp.methods()).toContain('Target.targetDestroyed')

    // The tab gets discarded (ban is moot), then the user revives it.
    bridge.extMessage(ext, JSON.stringify({ t: 'tabUpdated', tab: snap(1, { discarded: true }) }))
    bridge.extMessage(ext, JSON.stringify({ t: 'tabUpdated', tab: snap(1) }))
    await flush()
    // Without the revival ban-clear, eligible would stay false and no attach
    // would ever be attempted again.
    ackRpcs(bridge, ext, 'attach')
    await flush()
    expect(ext.ops()).toEqual(['attach', 'attach'])
    expect(cdp.methods().filter(m => m === 'Target.attachedToTarget')).toHaveLength(1)
  })

  it('waits out an in-flight detach before reattaching (78d44 ordering)', async () => {
    const { bridge, ext } = await withHello([snap(1)])
    const cdp = new FakeSocket()
    const first = bridge.cdpConnected(cdp)
    bridge.cdpMessage(first, JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    await flush()
    ackRpcs(bridge, ext, 'attach')
    await flush()

    // The only driver disconnects: detach lands asynchronously.
    bridge.cdpClosed(first)
    expect(ext.ops()).toEqual(['attach', 'detach'])

    // A new puppeteer connects before the detach is answered.
    const second = bridge.cdpConnected(new FakeSocket())
    bridge.cdpMessage(second, JSON.stringify({ id: 10, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    await flush()
    // No second attach yet — it waits for the tracked detach.
    expect(ext.ops()).toEqual(['attach', 'detach'])

    ackRpcs(bridge, ext, 'detach')
    await flush()
    // The attach fires only after the detach settled.
    expect(ext.ops()).toEqual(['attach', 'detach', 'attach'])
  })

  it('aborts a pending attach when the tab turns discarded while the detach lands', async () => {
    const { bridge, ext } = await withHello([snap(1)])
    const cdp = new FakeSocket()
    const first = bridge.cdpConnected(cdp)
    bridge.cdpMessage(first, JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    await flush()
    ackRpcs(bridge, ext, 'attach')
    await flush()

    bridge.cdpClosed(first)
    const second = bridge.cdpConnected(new FakeSocket())
    bridge.cdpMessage(second, JSON.stringify({ id: 10, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    await flush()
    // The discard arrives while the reattach still waits on the detach.
    bridge.extMessage(ext, JSON.stringify({ t: 'tabUpdated', tab: snap(1, { discarded: true }) }))
    ackRpcs(bridge, ext, 'detach')
    await flush()
    // The resumed attach sees `discarded` and gives up — no second attach.
    expect(ext.ops()).toEqual(['attach', 'detach'])
  })

  it('drops attachment state on extension disconnect and reattaches after a re-hello', async () => {
    const { bridge, ext } = await withHello([snap(1)])
    const cdp = new FakeSocket()
    const connId = bridge.cdpConnected(cdp)
    bridge.cdpMessage(connId, JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    await flush()
    ackRpcs(bridge, ext, 'attach')
    await flush()

    bridge.extClosed(ext)
    const ext2 = new FakeSocket()
    bridge.extConnected(ext2)
    bridge.extMessage(ext2, hello([snap(1)]))
    bridge.cdpMessage(connId, JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    await flush()
    ackRpcs(bridge, ext2, 'attach')
    await flush()
    // The re-hello re-established the chrome.debugger attach; the surviving
    // connection keeps its minted tab session, so no duplicate attachedToTarget.
    expect(ext2.ops()).toEqual(['attach'])
  })
})
