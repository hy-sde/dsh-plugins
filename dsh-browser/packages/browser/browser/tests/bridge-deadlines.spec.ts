/**
 * Bridge command deadlines (port of oh-my-pi 7f59dbe7a5 + ef3d4491be + 1c45a9113c):
 * a forwarded command dies at the relay's default 20s deadline, but page-bound
 * work — an `awaitPromise` evaluate waiting on the page, `Runtime.awaitPromise`,
 * or a `Page.navigate` the client owns a timeout for — survives to the 180s
 * ceiling Playwright's own protocol timeout uses. A deadline miss names the
 * method and tab instead of a bare rpc timeout.
 *
 * The extension leg is a raw fake socket; the bridge drives it exactly like
 * the real MV3 companion. Deadlines run on fake timers; the extension simply
 * never answers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
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

/** Bridge + extension socket wired with a hello naming `tabs`; a downstream CDP connection attached to tab 1. */
async function withAttachedTab(): Promise<{
  bridge: RelayBridge
  ext: FakeSocket
  cdp: FakeSocket
  conn: number
  session: string
}> {
  const bridge = new RelayBridge()
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
  const id = ++msgSeq
  bridge.cdpMessage(conn, JSON.stringify({ id, method: 'Target.attachToTarget', params: { targetId: 'PAGE1' } }))
  for (const frame of ext.frames) {
    if (frame.t === 'rpc' && frame.op === 'attach') {
      bridge.extMessage(ext, JSON.stringify({ t: 'rpcResult', id: frame.id, ok: true, result: {} }))
    }
  }
  await flush()
  const reply = cdp.replies().find(r => r.id === id)
  const session = (reply?.result as { sessionId?: string } | undefined)?.sessionId
  if (typeof session !== 'string') throw new Error(`attach failed: ${JSON.stringify(reply?.error ?? reply)}`)
  return { bridge, ext, cdp, conn, session }
}

/** Send a command on the page session and never answer it; the deadline must fire alone. */
function sendUnanswered(bridge: RelayBridge, conn: number, session: string, method: string, params: object = {}): number {
  const id = ++msgSeq
  bridge.cdpMessage(conn, JSON.stringify({ id, sessionId: session, method, params }))
  return id
}

/** The error reply for `id`, once its deadline fired. */
function errorFor(cdp: FakeSocket, id: number): string {
  const reply = cdp.replies().find(r => r.id === id)
  expect(reply?.error).toBeDefined()
  return reply?.error?.message ?? ''
}

describe('relay bridge command deadlines', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails a regular command at the default 20s deadline with the method and tab named', async () => {
    const { bridge, cdp, conn, session } = await withAttachedTab()
    vi.useFakeTimers()
    const id = sendUnanswered(bridge, conn, session, 'Input.dispatchMouseEvent', { type: 'mouseMoved' })

    await vi.advanceTimersByTimeAsync(19_999)
    expect(cdp.replies().find(r => r.id === id)?.error).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    expect(errorFor(cdp, id)).toBe('Input.dispatchMouseEvent on tab 1: Chrome sent no answer within 20000ms')
  })

  it.each([
    ['Runtime.callFunctionOn', { awaitPromise: true, functionDeclaration: 'async () => {}' }],
    ['Runtime.evaluate', { awaitPromise: true, expression: 'Promise.resolve(1)' }],
    ['Runtime.awaitPromise', { promiseObjectId: '1' }],
    ['Page.navigate', { url: 'https://example.com/' }],
  ])('keeps a page-bound %s answerable past the default deadline', async (method, params) => {
    const { bridge, cdp, conn, session } = await withAttachedTab()
    vi.useFakeTimers()
    const id = sendUnanswered(bridge, conn, session, method, params)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(cdp.replies().find(r => r.id === id)?.error).toBeUndefined()
  })

  it('fails a page-bound command only at the 180s ceiling', async () => {
    const { bridge, cdp, conn, session } = await withAttachedTab()
    vi.useFakeTimers()
    const id = sendUnanswered(bridge, conn, session, 'Runtime.evaluate', { awaitPromise: true, expression: '1' })

    await vi.advanceTimersByTimeAsync(179_999)
    expect(cdp.replies().find(r => r.id === id)?.error).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    expect(errorFor(cdp, id)).toBe('Runtime.evaluate on tab 1: Chrome sent no answer within 180000ms')
  })
})
