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

/** ext 'send' RPC frames, in order — the wire Chrome would receive. */
function sendRpcs(ext: FakeSocket): Array<Record<string, unknown>> {
  return ext.frames.filter(f => f.t === 'rpc' && f.op === 'send')
}

/** Send one Target.setAutoAttach command without acking or flushing. */
function sendAutoAttach(bridge: RelayBridge, connId: number, sessionId: string, params: Record<string, unknown>): void {
  bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: 'Target.setAutoAttach', params }))
}

/** Send one Runtime.evaluate command; returns the command id for reply lookup. */
function sendEvaluate(bridge: RelayBridge, connId: number, sessionId: string, expression = '1'): number {
  const id = ++msgSeq
  bridge.cdpMessage(connId, JSON.stringify({ id, sessionId, method: 'Runtime.evaluate', params: { expression } }))
  return id
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

describe('relay bridge — auto-attach ownership', () => {
  const DISABLE = { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }
  const ENABLE = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }

  it.each(['disconnect', 'release'] as const)(
    'isolates opt-out and disarms Chrome when the final armed holder leaves by %s',
    async (leave) => {
      const bridge = new RelayBridge()
      const ext = new FakeSocket()
      await connect(bridge, ext, [snap(1)])
      const firstCdp = new FakeSocket()
      const first = bridge.cdpConnected(firstCdp)
      const firstSession = await attachPage(bridge, ext, firstCdp, first, 1)
      await armAutoAttach(bridge, ext, first, firstSession)
      const secondCdp = new FakeSocket()
      const second = bridge.cdpConnected(secondCdp)
      const secondSession = await attachPage(bridge, ext, secondCdp, second, 1)
      await armAutoAttach(bridge, ext, second, secondSession)
      if (leave === 'disconnect') {
        await armAutoAttach(bridge, ext, second, await attachPage(bridge, ext, secondCdp, second, 1))
      }
      emit(bridge, ext, ATTACH)
      const thirdCdp = new FakeSocket()
      const third = bridge.cdpConnected(thirdCdp)
      await armAutoAttach(bridge, ext, third, await attachPage(bridge, ext, thirdCdp, third, 1))

      // The remaining two holders keep the tab armed, so Chrome hears nothing.
      let sends = sendRpcs(ext).length
      bridge.cdpClosed(third)
      await flush()
      expect(sendRpcs(ext)).toHaveLength(sends)

      emit(bridge, ext, NAVIGATE)
      expect(childTraffic(secondCdp)).toContainEqual(['Page.frameNavigated', 'CHILD1'])

      sends = sendRpcs(ext).length
      sendAutoAttach(bridge, first, firstSession, DISABLE)
      await flush()
      // The second holder still arms the tab, so the opt-out stays local.
      expect(sendRpcs(ext)).toHaveLength(sends)
      expect(childTraffic(firstCdp)).toEqual([
        ['Target.attachedToTarget', firstSession],
        ['Page.frameNavigated', 'CHILD1'],
        ['Target.detachedFromTarget', firstSession],
      ])
      const probe = sendEvaluate(bridge, first, 'CHILD1')
      await flush()
      expect(firstCdp.replies().find(r => r.id === probe)).toMatchObject({ error: { message: 'Unknown session id CHILD1' } })
      expect(sendRpcs(ext)).toHaveLength(sends)

      const optedOut = firstCdp.frames.length
      emit(bridge, ext, NAVIGATE, NESTED_ATTACH)
      expect(firstCdp.frames).toHaveLength(optedOut)
      expect(childTraffic(secondCdp)).toContainEqual(['Page.frameNavigated', 'CHILD1'])
      emit(bridge, ext, DETACH, ATTACH)
      expect(firstCdp.frames).toHaveLength(optedOut)

      // The opted-out connection still holds the tab, so losing the last armed holder must disarm Chrome.
      sends = sendRpcs(ext).length
      if (leave === 'disconnect') {
        bridge.cdpClosed(second)
      } else {
        bridge.cdpMessage(second, JSON.stringify({ id: ++msgSeq, method: 'Target.detachFromTarget', params: { sessionId: secondSession } }))
      }
      await flush()
      const wire = sendRpcs(ext)
      expect(wire).toHaveLength(sends + 1)
      expect(wire[wire.length - 1]).toMatchObject({ method: 'Target.setAutoAttach', params: DISABLE })
      ackRpcs(bridge, ext, 'send')
      await flush()
      expect(sendRpcs(ext)).toHaveLength(sends + 1)
    },
  )

  it("disarms Chrome after another holder's in-flight enable fails", async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    const firstCdp = new FakeSocket()
    const first = bridge.cdpConnected(firstCdp)
    const session = await attachPage(bridge, ext, firstCdp, first, 1)
    await armAutoAttach(bridge, ext, first, session)
    const secondCdp = new FakeSocket()
    const second = bridge.cdpConnected(secondCdp)
    const other = await attachPage(bridge, ext, secondCdp, second, 1)
    sendAutoAttach(bridge, second, other, ENABLE)
    // Queue the opt-out behind the in-flight enable before either resolves.
    sendAutoAttach(bridge, first, session, DISABLE)
    // The enable fails; its rollback leaves nobody armed, so the opt-out reaches Chrome.
    ackRpcs(bridge, ext, 'send', false)
    await flush()
    const wire = sendRpcs(ext)
    expect(wire).toHaveLength(3)
    expect(wire[2]).toMatchObject({ method: 'Target.setAutoAttach', params: DISABLE })
    ackRpcs(bridge, ext, 'send')
    await flush()
  })

  it.each(['disconnect', 'release'] as const)('retries a failed disable after its holder leaves by %s', async (leave) => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    const session = await attachPage(bridge, ext, cdp, conn, 1)
    await armAutoAttach(bridge, ext, conn, session)
    // A second connection keeps the tab attached without arming auto-attach.
    const registryCdp = new FakeSocket()
    await attachPage(bridge, ext, registryCdp, bridge.cdpConnected(registryCdp), 1)
    sendAutoAttach(bridge, conn, session, DISABLE)
    if (leave === 'disconnect') bridge.cdpClosed(conn)
    else bridge.cdpMessage(conn, JSON.stringify({ id: ++msgSeq, method: 'Target.detachFromTarget', params: { sessionId: session } }))
    // The disable failed; the departure's reconcile must retry it for the remaining holder.
    ackRpcs(bridge, ext, 'send', false)
    await flush()
    const wire = sendRpcs(ext)
    expect(wire).toHaveLength(3)
    expect(wire[2]).toMatchObject({ method: 'Target.setAutoAttach', params: DISABLE })
    ackRpcs(bridge, ext, 'send')
    await flush()
  })

  it('rejects a queued auto-attach after its page session is released', async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    const first = await attachPage(bridge, ext, cdp, conn, 1)
    const queued = await attachPage(bridge, ext, cdp, conn, 1)
    sendAutoAttach(bridge, conn, first, ENABLE)
    const queuedId = ++msgSeq
    bridge.cdpMessage(conn, JSON.stringify({ id: queuedId, sessionId: queued, method: 'Target.setAutoAttach', params: ENABLE }))
    // The queued session dies while its enable still waits behind the first one.
    bridge.cdpMessage(conn, JSON.stringify({ id: ++msgSeq, method: 'Target.detachFromTarget', params: { sessionId: queued } }))
    ackRpcs(bridge, ext, 'send')
    await flush()
    expect(cdp.replies().find(r => r.id === queuedId)).toMatchObject({ error: { message: `Unknown session id ${queued}` } })
    expect(sendRpcs(ext)).toHaveLength(1)
  })

  it('owns an explicitly attached child without arming auto-attach', async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    const page = await attachPage(bridge, ext, cdp, conn, 1)
    const otherCdp = new FakeSocket()
    const other = bridge.cdpConnected(otherCdp)
    const otherPage = await attachPage(bridge, ext, otherCdp, other, 1)

    const attachId = ++msgSeq
    bridge.cdpMessage(conn, JSON.stringify({
      id: attachId,
      sessionId: page,
      method: 'Target.attachToTarget',
      params: { targetId: 'FRAME1', flatten: true },
    }))
    emit(bridge, ext, ATTACH)
    ackRpcs(bridge, ext, 'send', true, { sessionId: 'CHILD1' })
    await flush()
    expect(cdp.replies().find(r => r.id === attachId)).toMatchObject({ result: { sessionId: 'CHILD1' } })

    // Only the owning connection may drive the explicit child.
    const own = sendEvaluate(bridge, conn, 'CHILD1')
    const foreign = sendEvaluate(bridge, other, 'CHILD1')
    ackRpcs(bridge, ext, 'send', true, { result: { type: 'number', value: 1 } })
    await flush()
    expect(cdp.replies().find(r => r.id === own)).toMatchObject({ result: { result: { type: 'number', value: 1 } } })
    expect(otherCdp.replies().find(r => r.id === foreign)).toMatchObject({ error: { message: 'Unknown session id CHILD1' } })

    await armAutoAttach(bridge, ext, conn, 'CHILD1')
    emit(bridge, ext, NESTED_ATTACH)
    await armAutoAttach(bridge, ext, conn, page)
    await armAutoAttach(bridge, ext, other, otherPage)
    emit(bridge, ext, {
      method: 'Target.attachedToTarget',
      params: { sessionId: 'AUTOMATIC', targetInfo: { targetId: 'FRAME2', type: 'iframe' } },
    })

    sendAutoAttach(bridge, conn, page, DISABLE)
    await flush()
    // The opt-out only revokes automatic children; explicit ones stay owned.
    expect(cdp.frames).toContainEqual({ sessionId: page, method: 'Target.detachedFromTarget', params: { sessionId: 'AUTOMATIC' } })
    const afterOptOut = sendEvaluate(bridge, conn, 'CHILD1')
    ackRpcs(bridge, ext, 'send', true, { result: { type: 'number', value: 1 } })
    await flush()
    expect(cdp.replies().find(r => r.id === afterOptOut)).toMatchObject({ result: { result: { type: 'number', value: 1 } } })
    const descendant = sendEvaluate(bridge, conn, 'CHILD2')
    ackRpcs(bridge, ext, 'send', true, { result: { type: 'number', value: 1 } })
    await flush()
    expect(cdp.replies().find(r => r.id === descendant)).toMatchObject({ result: { result: { type: 'number', value: 1 } } })

    emit(bridge, ext, NAVIGATE, DETACH)
    expect(childTraffic(cdp).filter(([method]) => method !== undefined)).toEqual([
      ['Target.attachedToTarget', 'CHILD1'],
      ['Page.frameNavigated', 'CHILD1'],
      ['Target.detachedFromTarget', page],
    ])
    expect(childTraffic(otherCdp).filter(([method]) => method !== undefined)).toEqual(lifecycleOn(otherPage))
  })

  it('revokes automatic children when the last local page is released while another connection remains armed', async () => {
    const bridge = new RelayBridge()
    const ext = new FakeSocket()
    await connect(bridge, ext, [snap(1)])
    const cdp = new FakeSocket()
    const conn = bridge.cdpConnected(cdp)
    const page = await attachPage(bridge, ext, cdp, conn, 1)
    await armAutoAttach(bridge, ext, conn, page)
    const otherCdp = new FakeSocket()
    const other = bridge.cdpConnected(otherCdp)
    const otherPage = await attachPage(bridge, ext, otherCdp, other, 1)
    await armAutoAttach(bridge, ext, other, otherPage)
    emit(bridge, ext, ATTACH)

    bridge.cdpMessage(conn, JSON.stringify({ id: ++msgSeq, method: 'Target.detachFromTarget', params: { sessionId: page } }))
    await flush()
    const probe = sendEvaluate(bridge, conn, 'CHILD1')
    await flush()
    expect(cdp.replies().find(r => r.id === probe)).toMatchObject({ error: { message: 'Unknown session id CHILD1' } })
    expect(sendRpcs(ext)).toHaveLength(2)

    emit(bridge, ext, NAVIGATE)
    expect(childTraffic(cdp).filter(([method]) => method !== undefined)).toEqual([
      ['Target.attachedToTarget', page],
      ['Target.detachedFromTarget', page],
    ])
    expect(childTraffic(otherCdp)).toEqual([
      ['Target.attachedToTarget', otherPage],
      ['Page.frameNavigated', 'CHILD1'],
    ])
  })
})
