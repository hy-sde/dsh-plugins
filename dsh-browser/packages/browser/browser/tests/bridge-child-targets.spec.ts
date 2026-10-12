/**
 * Bridge behavior for real child targets (OOPIF/worker sessions; port of
 * oh-my-pi faa378dc99 → 55bee59990 → e417486ebd → b00e1f1d52 → 485665ba0b):
 * Chrome reports a real child only to the first session that armed
 * auto-attach, so the bridge must announce it once per connection on that
 * session, route its events and detach there, replay stored children to a
 * connection that arms late, and forget them (telling holders) when the
 * debugger attachment is gone. Also covers `Target.createTarget` background
 * tabs (057de70ca7): `background: true` maps to `createTab { active: false }`.
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
}

/** Let queued microtasks and timer-0 callbacks land. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

/** Answer every unanswered rpc frame with the given op, like the extension would. */
function ackRpcs(bridge: RelayBridge, ext: FakeSocket, op: string, ok = true, result: unknown = {}): void {
  for (const frame of ext.frames) {
    if (frame.t !== 'rpc' || frame.op !== op) continue
    bridge.extMessage(ext, JSON.stringify(
      ok
        ? { t: 'rpcResult', id: frame.id, ok: true, result }
        : { t: 'rpcResult', id: frame.id, ok: false, error: 'Target.setAutoAttach failed' },
    ))
  }
}

let msgSeq = 0

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

/** Wire an extension socket with a hello naming `tabs`. */
async function connect(bridge: RelayBridge, ext: FakeSocket, tabs: TabSnapshot[]): Promise<void> {
  bridge.extConnected(ext)
  bridge.extMessage(ext, hello(tabs))
  await flush()
}

/** Attach a page-level session to a tab, like puppeteer's init does; returns the minted session id. */
async function attachPage(
  bridge: RelayBridge,
  ext: FakeSocket,
  cdp: FakeSocket,
  connId: number,
  tabId: number,
): Promise<string> {
  const id = ++msgSeq
  bridge.cdpMessage(connId, JSON.stringify({ id, method: 'Target.attachToTarget', params: { targetId: `PAGE${tabId}` } }))
  ackRpcs(bridge, ext, 'attach')
  await flush()
  const reply = cdp.replies().find(r => r.id === id)
  const sessionId = (reply?.result as { sessionId?: string } | undefined)?.sessionId
  if (typeof sessionId !== 'string') throw new Error(`attach failed: ${JSON.stringify(reply?.error ?? reply)}`)
  return sessionId
}

/** Arm auto-attach on a session (page or real child); `outcome` simulates the extension's answer. */
async function armAutoAttach(
  bridge: RelayBridge,
  ext: FakeSocket,
  connId: number,
  sessionId: string,
  outcome: 'ok' | 'fail' = 'ok',
): Promise<void> {
  bridge.cdpMessage(connId, JSON.stringify({
    id: ++msgSeq,
    sessionId,
    method: 'Target.setAutoAttach',
    params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
  }))
  ackRpcs(bridge, ext, 'send', outcome === 'ok')
  await flush()
}

const ATTACH = {
  method: 'Target.attachedToTarget',
  params: { sessionId: 'CHILD1', targetInfo: { targetId: 'FRAME1', type: 'iframe' } },
}
const NAVIGATE = { sessionId: 'CHILD1', method: 'Page.frameNavigated', params: {} }
const DETACH = { method: 'Target.detachedFromTarget', params: { sessionId: 'CHILD1' } }
const NESTED_ATTACH = {
  sessionId: 'CHILD1',
  method: 'Target.attachedToTarget',
  params: { sessionId: 'CHILD2', targetInfo: { targetId: 'FRAME2', type: 'iframe' } },
}

/** Feed extension-reported CDP events for tab 1 into the bridge. */
function emit(bridge: RelayBridge, ext: FakeSocket, ...events: object[]): void {
  for (const event of events) bridge.extMessage(ext, JSON.stringify({ t: 'cdpEvent', tabId: 1, ...event }))
}

/** Traffic concerning the CHILD1 session, as [method, sessionId]. */
function childTraffic(socket: FakeSocket): Array<[unknown, unknown]> {
  return socket.frames
    .filter(f => f.sessionId === 'CHILD1' || (f.params as { sessionId?: string } | undefined)?.sessionId === 'CHILD1')
    .map(f => [f.method, f.sessionId])
}

const lifecycleOn = (sessionId: string): Array<[string, string]> => [
  ['Target.attachedToTarget', sessionId],
  ['Page.frameNavigated', 'CHILD1'],
  // The root-reported detach is re-addressed to the session the child was announced on.
  ['Target.detachedFromTarget', sessionId],
]

/** Bridge output from `start` on, as [method or "reply", sessionId, announced child]. */
function trafficSince(socket: FakeSocket, start: number): Array<[unknown, unknown, unknown]> {
  return socket.frames
    .slice(start)
    .map(f => [f.method ?? 'reply', f.sessionId, (f.params as { sessionId?: string } | undefined)?.sessionId])
}

describe('relay bridge — child targets', () => {
  it('announces a real child target only to the page session that armed auto-attach', async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    const armed = await attachPage(bridge, ext, cdp, conn, 1)
    await armAutoAttach(bridge, ext, conn, armed)
    await attachPage(bridge, ext, cdp, conn, 1)
    const otherCdp = new FakeSocket()
    await attachPage(bridge, ext, otherCdp, bridge.cdpConnected(otherCdp), 1)

    emit(bridge, ext, ATTACH, NAVIGATE, DETACH)

    expect(childTraffic(cdp)).toEqual(lifecycleOn(armed))
    expect(childTraffic(otherCdp)).toEqual([])
  })

  it('keeps a child on the first armed session of its connection, even after that session is released', async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    const first = await attachPage(bridge, ext, cdp, conn, 1)
    await armAutoAttach(bridge, ext, conn, first)
    const second = await attachPage(bridge, ext, cdp, conn, 1)
    await armAutoAttach(bridge, ext, conn, second)

    emit(bridge, ext, ATTACH)
    bridge.cdpMessage(conn, JSON.stringify({ id: ++msgSeq, method: 'Target.detachFromTarget', params: { sessionId: first } }))
    await flush()
    emit(bridge, ext, NAVIGATE, DETACH)

    expect(childTraffic(cdp)).toEqual(lifecycleOn(first))
  })

  it('does not report children to a session whose Target.setAutoAttach failed', async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    // Another connection already armed the tab, so Chrome will report children.
    const otherCdp = new FakeSocket()
    const other = bridge.cdpConnected(otherCdp)
    const otherSession = await attachPage(bridge, ext, otherCdp, other, 1)
    await armAutoAttach(bridge, ext, other, otherSession)
    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    await attachPage(bridge, ext, cdp, conn, 1)
    await armAutoAttach(bridge, ext, conn, 'bogus', 'fail')

    emit(bridge, ext, ATTACH, NAVIGATE, DETACH)

    expect(childTraffic(cdp)).toEqual([])
    expect(childTraffic(otherCdp)).toEqual(lifecycleOn(otherSession))
  })

  it('tells a connection that arms auto-attach late about the children Chrome already reported', async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    const firstCdp = new FakeSocket()
    const first = bridge.cdpConnected(firstCdp)
    await armAutoAttach(bridge, ext, first, await attachPage(bridge, ext, firstCdp, first, 1))
    emit(bridge, ext, ATTACH)
    await armAutoAttach(bridge, ext, first, 'CHILD1')
    emit(bridge, ext, NESTED_ATTACH)
    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    const late = await attachPage(bridge, ext, cdp, conn, 1)
    const start = cdp.frames.length

    await armAutoAttach(bridge, ext, conn, late)
    await armAutoAttach(bridge, ext, conn, 'CHILD1')
    emit(bridge, ext, NAVIGATE, DETACH)

    // Each child arrives before the reply to the arm that covers it, as Chrome sends it.
    expect(trafficSince(cdp, start)).toEqual([
      ['Target.attachedToTarget', late, 'CHILD1'],
      ['reply', late, undefined],
      ['Target.attachedToTarget', 'CHILD1', 'CHILD2'],
      ['reply', 'CHILD1', undefined],
      ['Page.frameNavigated', 'CHILD1', undefined],
      ['Target.detachedFromTarget', late, 'CHILD1'],
    ])
  })

  it('does not tell a later connection about children that ended with the debugger attachment', async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    const firstCdp = new FakeSocket()
    const first = bridge.cdpConnected(firstCdp)
    const firstSession = await attachPage(bridge, ext, firstCdp, first, 1)
    await armAutoAttach(bridge, ext, first, firstSession)
    emit(bridge, ext, ATTACH)
    // Releasing the only session drops the attachment, and Chrome ends its children with it.
    bridge.cdpMessage(first, JSON.stringify({ id: ++msgSeq, method: 'Target.detachFromTarget', params: { sessionId: firstSession } }))
    ackRpcs(bridge, ext, 'detach')
    await flush()
    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    const late = await attachPage(bridge, ext, cdp, conn, 1)

    await armAutoAttach(bridge, ext, conn, late)

    expect(childTraffic(cdp)).toEqual([])
  })

  it('detaches children from connections still holding the tab when the extension lost its attachment', async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    const session = await attachPage(bridge, ext, cdp, conn, 1)
    await armAutoAttach(bridge, ext, conn, session)
    emit(bridge, ext, ATTACH)
    await armAutoAttach(bridge, ext, conn, 'CHILD1')
    emit(bridge, ext, NESTED_ATTACH)
    const start = cdp.frames.length

    // A service-worker restart reconnects without the tab's debugger attachment.
    await connect(bridge, new FakeSocket(), [snap(1)])
    await flush()

    expect(trafficSince(cdp, start).filter(([method]) => method === 'Target.detachedFromTarget')).toEqual([
      ['Target.detachedFromTarget', 'CHILD1', 'CHILD2'],
      ['Target.detachedFromTarget', session, 'CHILD1'],
    ])
  })
})

describe('relay bridge — Target.createTarget background tabs', () => {
  it('creates a background tab without selecting it', async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [])
    const connId = bridge.cdpConnected(new FakeSocket())
    bridge.cdpMessage(connId, JSON.stringify({
      id: ++msgSeq,
      method: 'Target.createTarget',
      params: { url: 'https://example.com/', background: true },
    }))
    await flush()
    const create = ext.frames.find(f => f.t === 'rpc' && f.op === 'createTab')
    expect(create).toMatchObject({ url: 'https://example.com/', active: false })
  })

  it.each([{ params: { url: 'https://example.com/' } }, { params: { url: 'https://example.com/', background: false } }])(
    'leaves createTab selection to Chrome for %j',
    async ({ params }) => {
      const bridge = new RelayBridge()
      const ext = new FakeSocket()
      await connect(bridge, ext, [])
      const connId = bridge.cdpConnected(new FakeSocket())
      bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, method: 'Target.createTarget', params }))
      await flush()
      const create = ext.frames.find(f => f.t === 'rpc' && f.op === 'createTab')
      expect(create).toMatchObject({ url: 'https://example.com/' })
      expect(create).not.toHaveProperty('active')
    },
  )
})
