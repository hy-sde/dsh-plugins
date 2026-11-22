/**
 * Ported from oh-my-pi (MIT — see LICENSE).
 */
/**
 * CDP façade over `chrome.debugger`.
 *
 * Puppeteer clients (the omp browser tool: one supervisor connection plus one
 * per tab worker) connect to this bridge as if it were Chrome's browser
 * debugging endpoint. Chrome only allows a single debugger attachment per tab,
 * so the bridge owns ONE `chrome.debugger` attachment per tab (via the
 * extension) and multiplexes every downstream connection over it with minted
 * per-connection session ids.
 *
 * Emulated surface (everything else is forwarded to `chrome.debugger`):
 * - the browser target (`/json/version` handshake, `Browser.getVersion`)
 * - the `Target.*` domain, including puppeteer's tab → page auto-attach
 *   hierarchy (see puppeteer-core `cdp/ExtensionTransport.ts`, the reference
 *   implementation for this emulation)
 *
 * Session id namespaces seen by a downstream connection:
 * - minted tab pseudo-sessions (`ST<tab>.<conn>.<n>`) — Target emulation only
 * - minted page pseudo-sessions (`SP<tab>.<conn>.<n>`) — forwarded to the
 *   tab's root debugger session
 * - real child session ids (OOPIFs, workers) — created by Chrome under the
 *   shared root session and passed through verbatim
 */
import type { ExtToRelayMessage, RelayRpcRequest, RelayToExtMessage, TabSnapshot } from './protocol'
import { DSH_RELAY_PROTOCOL } from './protocol'

/** Transport-agnostic websocket surface the bridge writes to. */
export interface RelaySocket {
  send(text: string): void
  close(): void
}

interface CdpCommand {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

interface SessionRef {
  kind: 'tab' | 'page'
  tabId: number
  /**
   * This session sent `Target.setAutoAttach`. Chrome reports a real child
   * target (OOPIF, worker) only on the session that asked; announcing it on
   * every page session would hand puppeteer one child id twice, and puppeteer
   * replaces the first session object, dropping every reply bound for it.
   */
  autoAttach: boolean
}

interface TargetInfo {
  targetId: string
  type: 'tab' | 'page' | 'browser'
  title: string
  url: string
  attached: boolean
  canAccessOpener: boolean
}

class CdpConnection {
  discover = false
  autoAttach = false
  /** Minted pseudo-sessions owned by this connection. */
  readonly sessions = new Map<string, SessionRef>()
  /** Tabs this connection claimed as drive targets (`OMP.claimTarget` / `Target.createTarget`). */
  readonly claims = new Set<number>()
  /** Real child session id → the session it was announced on; its events and detach go there. */
  readonly childParents = new Map<string, string>()
  /** Real children this connection attached itself (`Target.attachToTarget`); their ownership survives an auto-attach opt-out. */
  readonly explicitChildren = new Set<string>()

  constructor(
    readonly id: number,
    readonly socket: RelaySocket,
  ) {}

  sessionsForTab(tabId: number, kind?: 'tab' | 'page'): string[] {
    const out: string[] = []
    for (const [sessionId, ref] of this.sessions) {
      if (ref.tabId === tabId && (!kind || ref.kind === kind)) out.push(sessionId)
    }
    return out
  }

  /** This tab's first page session that armed auto-attach; one per connection so no child is announced twice. */
  childTargetSessionForTab(tabId: number): string | undefined {
    for (const [sessionId, ref] of this.sessions) {
      if (ref.tabId === tabId && ref.kind === 'page' && ref.autoAttach) return sessionId
    }
    return undefined
  }
}

class TabState {
  url = ''
  title = ''
  active = false
  /** Chrome discarded this tab (memory saver); it cannot answer debugger calls until reactivated. */
  discarded = false
  windowId = 0
  pinned = false
  /** Chrome tab group id from the last snapshot; -1 when ungrouped. */
  groupId = -1
  /** Whether `chrome.debugger` is currently attached to this tab. */
  attached = false
  /** Set when attach failed or the user cancelled the debugger; cleared on navigation (and on revival from a discard). */
  banned = false
  /** Whether targets for this tab were announced to discovering connections. */
  announced = false
  attaching: Promise<boolean> | null = null
  /** Detach RPC still landing; a new attach must wait it out or the late detach undoes it. */
  detaching: Promise<void> | null = null

  /**
   * Settled by the tab's next extension-reported detach — the report a
   * detach-killed command waits for before its failure reply. Replaced once
   * settled so the next detach gets its own settlement.
   */
  chromeDetach = Promise.withResolvers<void>()
  /** Reason the tab's last extension-reported detach named; undefined until then. */
  detachReason: string | undefined
  /** True after the relay put this tab in the omp group; `ompGroupId` holds that group. */
  grouped = false
  /** Group RPC in flight — suppresses duplicate requests from load-time tabUpdated bursts. */
  grouping = false
  ompGroupId: number | undefined
  /** User pulled the tab out of the omp group — never re-group it. */
  groupOptOut = false
  /**
   * Real Chrome sessions (OOPIF/worker children) under this tab's attachment: the child session
   * that reported each (none for the root) and its `Target.attachedToTarget` params.
   */
  readonly realSessions = new Map<string, { parent: string | undefined; event: Record<string, unknown> }>()

  constructor(
    readonly tabId: number,
    snap: TabSnapshot,
  ) {
    this.apply(snap)
  }

  apply(snap: TabSnapshot): void {
    this.url = snap.url
    this.title = snap.title
    this.active = snap.active
    // undefined (extension predating the field) degrades to false.
    this.discarded = snap.discarded === true
    this.windowId = snap.windowId
    this.pinned = snap.pinned
    this.groupId = snap.groupId
  }
}

/** URLs `chrome.debugger` cannot attach to; hidden from downstream discovery entirely. */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search):/i

const RPC_TIMEOUT_MS = 20_000
/**
 * Deadline for page-bound work that legitimately outlives the default: an
 * `awaitPromise` evaluate that waits on the page, or a navigation the client
 * owns a timeout for. Matches Playwright's 180s protocol timeout, so the
 * relay's deadline never cuts a command Playwright would still wait for.
 */
const PAGE_BOUND_RPC_TIMEOUT_MS = 180_000
const CDP_ERROR_METHOD_NOT_FOUND = -32601
const CDP_ERROR_SERVER = -32000

/** Chrome's answer to a command in flight when it ends the debugger attachment. */
const DETACHED_COMMAND_ERROR = /Detached while handling command/
/**
 * How long a root-session command Chrome killed with its in-flight detach
 * answer waits for the extension's own detach report before the failure
 * reply; bounded so a detach Chrome never reports still replies.
 */
const CHROME_DETACH_REPORT_MS = 1_000
/**
 * Deadline for the page command that lets Chrome's detach report overtake a
 * child-session failure reply: Chrome ends a cross-site frame's session the
 * moment it detaches the debugger, ahead of the report.
 */
const DETACH_REPORT_PROBE_MS = 500

/** A relay RPC the bridge gave up on at its own deadline; Chrome never answered it. */
class RpcTimeoutError extends Error {}

/** Resolves after `ms`; deadline for waits that have no in-flight rpc to time out. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function tabTargetId(tabId: number): string {
  return `TAB${tabId}`
}

function pageTargetId(tabId: number): string {
  return `PAGE${tabId}`
}

/** Reverse of {@link tabTargetId}/{@link pageTargetId}; null for foreign ids. */
function parseTargetId(targetId: string): { kind: 'tab' | 'page'; tabId: number } | null {
  const match = /^(TAB|PAGE)(\d+)$/.exec(targetId)
  if (!match) return null
  return { kind: match[1] === 'TAB' ? 'tab' : 'page', tabId: Number(match[2]) }
}

/**
 * Multiplexing CDP bridge between downstream puppeteer connections and the
 * relay extension. One instance per relay server; all state lives here so an
 * extension service-worker restart only has to re-handshake.
 */
export class RelayBridge {
  #tabs = new Map<number, TabState>()
  #conns = new Map<number, CdpConnection>()
  #connSeq = 0
  #sessionSeq = 0
  #rpcSeq = 0
  #ext: RelaySocket | null = null
  #extInfo: { userAgent: string; browserVersion: string; discardedTabsProtocol?: number } | null = null
  /**
   * Browser session named by the last hello, or undefined when the extension
   * predates the field. A hello from a different session (including one that
   * stops naming one) retires every known target: Chrome reuses tab ids
   * across restarts, so a stale target id could otherwise resolve onto a new
   * tab.
   */
  #extBrowserSession: string | undefined = undefined
  /** True after the first hello; retirement compares scopes only between hellos. */
  #helloSeen = false
  #pendingRpc = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >()
  /** Real child session id → owning tab, learned from `Target.attachedToTarget` events. */
  #realSessionTabs = new Map<string, number>()
  /**
   * Each tab's last auto-attach transition, keyed by tab id: the extension
   * starts RPCs independently, so overlapping transitions on one tab must
   * settle in order, or a failed one's rollback would restore a state another
   * transition had already changed.
   */
  #autoAttachTransitions = new Map<number, Promise<void>>()
  /** `Date.now()` when the last ready extension socket closed; null while one is ready or none ever was. */
  #extensionGoneSince: number | null = null
  #log: (message: string, data?: Record<string, unknown>) => void
  /** Tab-group appearance for driven tabs; null disables grouping. */
  #group: { title: string; color: string } | null
  /** Tabs awaiting the next group RPC; drained one batch at a time. */
  #groupQueue: TabState[] = []
  /** True while {@link #drainGroupQueue} runs — group RPCs must never overlap. */
  #groupDraining = false

  constructor(
    opts: {
      log?: (message: string, data?: Record<string, unknown>) => void
      /** Group tabs the agent actively drives under one per-window Chrome tab group. */
      group?: { title: string; color: string } | null
    } = {},
  ) {
    this.#log = opts.log ?? (() => {})
    this.#group = opts.group ?? null
  }

  /** True once the extension has completed its hello handshake. */
  get ready(): boolean {
    return this.#ext !== null && this.#extInfo !== null
  }
  /** Milliseconds since the last ready extension disconnected, or null while one is connected or none ever was. */
  get extensionGoneForMs(): number | null {
    return this.#extensionGoneSince === null ? null : Date.now() - this.#extensionGoneSince
  }

  /** Payload for `GET /json/version`. */
  versionInfo(wsUrl: string): Record<string, string> {
    const ua = this.#extInfo?.userAgent ?? ''
    return {
      Browser: this.#extInfo?.browserVersion ?? 'Chrome/unknown',
      'Protocol-Version': '1.3',
      'User-Agent': ua,
      'V8-Version': '',
      'WebKit-Version': '',
      // Build marker: lets callers tell a stale relay from an unconnected
      // extension (oh-my-pi b4c96b126e — diagnosed stale relay after upgrades).
      dshRelayProtocol: String(DSH_RELAY_PROTOCOL),
      webSocketDebuggerUrl: wsUrl,
    }
  }

  /** Payload for `GET /json/list` (debugging aid; per-target endpoints are not served). */
  listTargets(): Array<Record<string, string>> {
    const out: Array<Record<string, string>> = []
    for (const tab of this.#tabs.values()) {
      if (!this.#eligible(tab) || tab.discarded) continue
      out.push({ id: pageTargetId(tab.tabId), type: 'page', title: tab.title, url: tab.url })
    }
    return out
  }

  // ---- extension lifecycle -------------------------------------------------

  /** A new extension socket connected; replaces any previous one. */
  extConnected(socket: RelaySocket): void {
    if (this.#ext && this.#ext !== socket) {
      this.#log('replacing extension socket')
      this.#ext.close()
    }
    this.#ext = socket
  }

  extClosed(socket: RelaySocket): void {
    if (this.#ext !== socket) return
    this.#ext = null
    this.#extInfo = null
    for (const pending of this.#pendingRpc.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('relay extension disconnected'))
    }
    this.#pendingRpc.clear()
    for (const tab of this.#tabs.values()) {
      tab.attached = false
      tab.attaching = null
      tab.detaching = null
      // The extension dissolves omp groups on disconnect (or died along
      // with them); grouping state is unknowable until the next hello.
      // Without this reset, the next hello's groupId=-1 snapshots would
      // read as the user dragging every tab out (permanent opt-out).
      tab.grouped = false
      tab.grouping = false
      tab.ompGroupId = undefined
    }
    this.#groupQueue.length = 0
    if (!this.ready) this.#extensionGoneSince ??= Date.now()
  }

  extMessage(socket: RelaySocket, raw: string): void {
    if (socket !== this.#ext) return
    let msg: ExtToRelayMessage
    try {
      msg = JSON.parse(raw) as ExtToRelayMessage
    } catch {
      this.#log('dropping malformed extension message')
      return
    }
    switch (msg.t) {
      case 'hello':
        this.#onHello(msg)
        return
      case 'rpcResult': {
        const pending = this.#pendingRpc.get(msg.id)
        if (!pending) return
        this.#pendingRpc.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.ok) pending.resolve(msg.result)
        else pending.reject(new Error(msg.error ?? 'extension rpc failed'))
        return
      }
      case 'cdpEvent':
        this.#onCdpEvent(msg.tabId, msg.sessionId, msg.method, msg.params)
        return
      case 'detached':
        this.#onTabDetached(msg.tabId, msg.reason)
        return
      case 'tabCreated':
      case 'tabUpdated':
        this.#onTabUpsert(msg.tab)
        return
      case 'tabRemoved':
        this.#onTabRemoved(msg.tabId)
        return
      case 'ping':
        socket.send(JSON.stringify({ t: 'pong' } satisfies RelayToExtMessage))
        return
    }
  }

  #onHello(msg: Extract<ExtToRelayMessage, { t: 'hello' }>): void {
    // A hello from a different browser session means Chrome restarted (or the
    // extension first reported a session): every recorded tab id belongs to
    // the dead browser and can name a different tab now. Retire them before
    // the snapshot runs, so nothing keeps driving or closing by an old id.
    // Extensions without a session degrade safely (no retirement).
    if (this.#helloSeen && msg.browserSession !== this.#extBrowserSession) {
      this.#log('extension browser session changed; retiring targets', {
        from: this.#extBrowserSession,
        to: msg.browserSession,
      })
      for (const tabId of [...this.#tabs.keys()]) this.#onTabRemoved(tabId)
    }
    this.#helloSeen = true
    this.#extBrowserSession = msg.browserSession
    this.#extInfo = {
      userAgent: msg.userAgent,
      browserVersion: msg.browserVersion,
      ...(msg.discardedTabsProtocol !== undefined ? { discardedTabsProtocol: msg.discardedTabsProtocol } : {}),
    }
    this.#extensionGoneSince = null
    const seen = new Set<number>()
    const attachedNow = new Set(msg.attachedTabIds)
    for (const snap of msg.tabs) {
      seen.add(snap.tabId)
      this.#onTabUpsert(snap, { silent: true })
    }
    for (const tabId of [...this.#tabs.keys()]) {
      if (!seen.has(tabId)) this.#onTabRemoved(tabId)
    }
    for (const tab of this.#tabs.values()) {
      const wasAttached = tab.attached
      tab.attached = attachedNow.has(tab.tabId)
      tab.attaching = null
      // Chrome ends a tab's real child sessions with its debugger attachment,
      // so a hello that reports the attachment gone forgets them (and tells
      // connections still holding the tab).
      if (!tab.attached) this.#forgetChildren(tab)
      if (tab.discarded) {
        // A discarded tab cannot answer debugger calls: retire held sessions
        // now so its revival reannounces and re-attaches the tab.
        this.#retractTab(tab)
        this.#detachIfUnheld(tab.tabId)
        continue
      }
      // A service-worker restart can drop attachments while downstream
      // connections still hold sessions: restore them best-effort.
      if (wasAttached && !tab.attached && this.#sessionHolders(tab.tabId).length > 0) {
        void this.#ensureAttached(tab).then((ok) => {
          if (!ok) this.#onTabDetached(tab.tabId, 'reattach_failed')
        })
      }
    }
    this.#syncGrouping()
    this.#log('extension connected', { tabs: this.#tabs.size, version: msg.browserVersion })
  }

  // ---- downstream (puppeteer) lifecycle -------------------------------------

  /** Register a downstream CDP websocket; returns the connection id. */
  cdpConnected(socket: RelaySocket): number {
    const conn = new CdpConnection(++this.#connSeq, socket)
    this.#conns.set(conn.id, conn)
    this.#log('cdp client connected', { conn: conn.id })
    return conn.id
  }

  cdpClosed(connId: number): void {
    const conn = this.#conns.get(connId)
    if (!conn) return
    this.#conns.delete(connId)
    const touched = new Set<number>()
    for (const ref of conn.sessions.values()) touched.add(ref.tabId)
    // Collect the departing holder's armed tabs before its sessions go, then
    // disarm Chrome once they no longer count toward {@link #autoAttaches}.
    const armedTabs = new Set<number>()
    for (const ref of conn.sessions.values()) {
      if (ref.autoAttach) armedTabs.add(ref.tabId)
    }
    conn.sessions.clear()
    for (const tabId of armedTabs) this.#releaseAutoAttach(tabId)
    // Tabs this client claimed leave the omp group unless another claimant
    // remains — session holders don't count: the long-lived registry
    // connection holds sessions on every tab without driving any of them.
    for (const tabId of conn.claims) {
      const tab = this.#tabs.get(tabId)
      if (tab) this.#syncTabGrouping(tab)
    }
    conn.claims.clear()
    // Drop the debugger (and its infobar) from tabs nobody drives anymore.
    for (const tabId of touched) this.#detachIfUnheld(tabId)
    this.#log('cdp client closed', { conn: connId })
  }

  cdpMessage(connId: number, raw: string): void {
    const conn = this.#conns.get(connId)
    if (!conn) return
    let msg: CdpCommand
    try {
      msg = JSON.parse(raw) as CdpCommand
    } catch {
      return
    }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return
    void this.#handleCdpCommand(conn, msg).catch((err: unknown) => {
      this.#replyError(conn, msg, err instanceof Error ? err.message : String(err))
    })
  }

  // ---- command routing -------------------------------------------------------

  async #handleCdpCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) {
      await this.#handleBrowserCommand(conn, msg)
      return
    }
    const ref = conn.sessions.get(sessionId)
    if (ref?.kind === 'tab') {
      this.#handleTabSessionCommand(conn, msg, ref)
      return
    }
    if (ref?.kind === 'page') {
      if (msg.method === 'Target.setAutoAttach') {
        // Serialized per tab: the extension starts RPCs independently, so two
        // transitions must not interleave — see {@link #serializeAutoAttach}.
        await this.#serializeAutoAttach(ref.tabId, async () => {
          // The session may have been released while this transition queued
          // behind an earlier one on the tab.
          if (conn.sessions.get(sessionId) !== ref) {
            this.#replyError(conn, msg, `Unknown session id ${sessionId}`)
            return
          }
          // Armed while in flight (Chrome reports existing children before it
          // answers); a failed request restores the previous state.
          const previous = ref.autoAttach
          ref.autoAttach = msg.params?.autoAttach === true
          const announce = () => {
            const parent = conn.childTargetSessionForTab(ref.tabId)
            if (parent) this.#announceChildren(conn, ref.tabId, undefined, parent)
          }
          if (!ref.autoAttach && this.#autoAttaches(ref.tabId)) {
            // One debugger attachment backs every connection: with another
            // holder still armed, keep Chrome armed and report success to
            // this connection only.
            this.#reply(conn, msg, {})
          } else if (!(await this.#forwardToTab(conn, msg, ref.tabId, undefined, ref.autoAttach ? announce : undefined))) {
            ref.autoAttach = previous
            // A holder that departed while its arm was in flight must still
            // reconcile Chrome after the failed enable rolls back.
            if (previous && conn.sessions.get(sessionId) !== ref) this.#releaseAutoAttach(ref.tabId)
            return
          }
          // With no armed session left on this connection, its automatic
          // children are gone for it — announce their detaches locally.
          const tab = this.#tabs.get(ref.tabId)
          if (tab && !conn.childTargetSessionForTab(ref.tabId)) this.#forgetConnectionChildren(conn, tab, true)
        })
        return
      }
      await this.#forwardToTab(conn, msg, ref.tabId, undefined)
      return
    }
    const realTab = this.#realSessionTabs.get(sessionId)
    // Only a connection that was told about the child may drive it: Chrome's
    // session ids are unguessable, so anything else is a stale or foreign id.
    if (realTab !== undefined && conn.childParents.has(sessionId)) {
      const announce =
        msg.method === 'Target.setAutoAttach' && msg.params?.autoAttach === true
          ? () => { this.#announceChildren(conn, realTab, sessionId, sessionId) }
          : undefined
      await this.#forwardToTab(conn, msg, realTab, sessionId, announce)
      return
    }
    this.#replyError(conn, msg, `Unknown session id ${sessionId}`)
  }

  /**
   * Chrome reports a child target once, to the first auto-attach armed over it, so a connection
   * arming later (a tab worker after the registry connection) is told here of the children already
   * reported under `parent` (the tab's root when undefined) that it has not heard of.
   */
  #announceChildren(conn: CdpConnection, tabId: number, parent: string | undefined, sessionId: string): void {
    const tab = this.#tabs.get(tabId)
    if (!tab) return
    for (const [child, known] of tab.realSessions) {
      if (known.parent !== parent || conn.childParents.has(child)) continue
      conn.childParents.set(child, sessionId)
      conn.socket.send(JSON.stringify({ sessionId, method: 'Target.attachedToTarget', params: known.event }))
    }
  }

  /**
   * Forward a command to the tab and reply to it; resolves whether the command succeeded.
   * `beforeReply` runs on success ahead of the reply.
   */
  async #forwardToTab(
    conn: CdpConnection,
    msg: CdpCommand,
    tabId: number,
    realSessionId: string | undefined,
    beforeReply?: () => void,
  ): Promise<boolean> {
    // Guard rail: a page session must never take the whole browser down.
    if (msg.method === 'Browser.close') {
      this.#reply(conn, msg, {})
      return true
    }
    // Relay-private claim: the omp tab worker marks the page it was spawned
    // to drive. Never forwarded — real Chrome rejects the unknown method.
    if (msg.method === 'OMP.claimTarget') {
      this.#claimTab(conn, tabId)
      this.#reply(conn, msg, {})
      return true
    }
    try {
      const result = await this.#send(tabId, msg.method, msg.params, realSessionId)
      const response = (result as Record<string, unknown> | undefined) ?? {}
      // An explicit attach grants ownership even when this connection did not
      // arm auto-attach: it drives the child directly.
      if (msg.method === 'Target.attachToTarget' && msg.sessionId && typeof response.sessionId === 'string') {
        conn.childParents.set(response.sessionId, msg.sessionId)
        conn.explicitChildren.add(response.sessionId)
      }
      beforeReply?.()
      this.#reply(conn, msg, response)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const tab = this.#tabs.get(tabId)
      await this.#overtakeDetachReport(tab, realSessionId, message)
      this.#replyError(conn, msg, this.#detachReport(tab, message))
      return false
    }
  }

  /**
   * Give Chrome's detach report a chance to overtake a command failure, so the
   * downstream client learns why the session died before the error reply:
   * Chrome answers a command in flight with {@link DETACHED_COMMAND_ERROR}
   * ahead of the extension's detach report. A root-session failure waits for
   * that report ({@link CHROME_DETACH_REPORT_MS}); a child-session failure
   * sends one page command Chrome answers only after reporting the detach
   * ({@link DETACH_REPORT_PROBE_MS}).
   */
  async #overtakeDetachReport(tab: TabState | undefined, realSessionId: string | undefined, message: string): Promise<void> {
    if (!tab?.attached || !DETACHED_COMMAND_ERROR.test(message)) return
    if (realSessionId === undefined) {
      await Promise.race([tab.chromeDetach.promise, sleep(CHROME_DETACH_REPORT_MS)])
      return
    }
    try {
      await this.#rpc({ op: 'send', tabId: tab.tabId, method: 'Target.getTargetInfo' }, DETACH_REPORT_PROBE_MS)
    } catch {
      // The probe itself failing is fine: its deadline fired or the tab is gone.
    }
  }

  /**
   * The text a failed command replies with: Chrome's in-flight detach answer
   * names nothing, so once the tab's detach is reported the reply says what
   * happened to the tab instead.
   */
  #detachReport(tab: TabState | undefined, message: string): string {
    if (!tab || tab.attached || tab.detachReason === undefined) return message
    if (!DETACHED_COMMAND_ERROR.test(message)) return message
    return `Chrome detached the debugger from tab ${tab.tabId} (${tab.detachReason}) during this command`
  }

  /**
   * Record `conn` as a driver of the tab and reconcile grouping. Claims are
   * explicit (worker adoption or tab creation) rather than inferred from
   * command traffic: target discovery scans every page with the same
   * commands a driver sends, so inference would sweep all tabs.
   */
  #claimTab(conn: CdpConnection, tabId: number): void {
    const tab = this.#tabs.get(tabId)
    if (!tab) return
    if (!conn.claims.has(tabId)) {
      conn.claims.add(tabId)
      this.#log('tab claimed', { conn: conn.id, tabId })
    }
    this.#syncTabGrouping(tab)
  }

  /** True while any downstream connection claims the tab as its drive target. */
  #claimed(tabId: number): boolean {
    for (const conn of this.#conns.values()) {
      if (conn.claims.has(tabId)) return true
    }
    return false
  }

  /** Tab pseudo-sessions only exist to satisfy puppeteer's Target hierarchy. */
  #handleTabSessionCommand(conn: CdpConnection, msg: CdpCommand, ref: SessionRef): void {
    switch (msg.method) {
      case 'Target.setAutoAttach': {
        const tab = this.#tabs.get(ref.tabId)
        if (!tab) {
          this.#replyError(conn, msg, `Tab ${ref.tabId} is gone`)
          return
        }
        // Emit before replying: puppeteer's TargetManager counts page
        // children attached before the setAutoAttach response resolves.
        const pageSession = this.#mintSession(conn, 'page', tab.tabId)
        this.#emit(
          conn,
          'Target.attachedToTarget',
          {
            sessionId: pageSession,
            targetInfo: this.#pageInfo(tab, true),
            waitingForDebugger: false,
          },
          msg.sessionId,
        )
        this.#reply(conn, msg, {})
        return
      }
      case 'Runtime.runIfWaitingForDebugger':
        this.#reply(conn, msg, {})
        return
      case 'Target.detachFromTarget': {
        const child = typeof msg.params?.sessionId === 'string' ? msg.params.sessionId : undefined
        if (child) this.#releaseSession(conn, child, msg.sessionId)
        this.#reply(conn, msg, {})
        return
      }
      default:
        this.#replyError(conn, msg, `'${msg.method}' is not supported on a tab target`, CDP_ERROR_METHOD_NOT_FOUND)
    }
  }

  async #handleBrowserCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
    switch (msg.method) {
      case 'Browser.getVersion': {
        this.#reply(conn, msg, {
          protocolVersion: '1.3',
          product: this.#extInfo?.browserVersion ?? 'Chrome/unknown',
          revision: '',
          userAgent: this.#extInfo?.userAgent ?? '',
          jsVersion: '',
        })
        return
      }
      case 'Target.getBrowserContexts':
        this.#reply(conn, msg, { browserContextIds: [] })
        return
      case 'Target.setDiscoverTargets': {
        conn.discover = true
        for (const tab of this.#tabs.values()) {
          // Discarded tabs are never announced: a target that cannot attach
          // must not reach downstream discovery.
          if (!this.#eligible(tab) || tab.discarded) continue
          tab.announced = true
          this.#emit(conn, 'Target.targetCreated', { targetInfo: this.#tabInfo(tab, tab.attached) })
          this.#emit(conn, 'Target.targetCreated', { targetInfo: this.#pageInfo(tab, tab.attached) })
        }
        this.#reply(conn, msg, {})
        return
      }
      case 'Target.setAutoAttach': {
        conn.autoAttach = true
        const tabs = [...this.#tabs.values()].filter(tab => this.#eligible(tab))
        // Discarded tabs cannot attach; leave them out so puppeteer's init
        // never waits on a target that will not attach.
        await Promise.all(tabs.filter(tab => !tab.discarded).map(tab => this.#ensureAttached(tab)))
        for (const tab of tabs) {
          // Retract what cannot be attached — including a tab that turned
          // discarded while the attaches above were landing — so puppeteer's
          // init never waits on it.
          if (!tab.attached || tab.discarded) {
            this.#retractTab(tab)
            continue
          }
          this.#emitTabAttached(conn, tab)
        }
        this.#reply(conn, msg, {})
        return
      }
      case 'Target.attachToTarget': {
        const parsed = typeof msg.params?.targetId === 'string' ? parseTargetId(msg.params.targetId) : null
        const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined
        if (!parsed || !tab) {
          this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`)
          return
        }
        if (tab.discarded) {
          // Fail now rather than burning the RPC timeout on a tab Chrome
          // discarded; activating it reloads it, then the retry attaches.
          this.#replyError(conn, msg, `Cannot attach to tab ${tab.tabId}: discarded by Chrome; activate it to reload, then retry`)
          return
        }
        if (!(await this.#ensureAttached(tab))) {
          this.#replyError(conn, msg, `Cannot attach to tab ${tab.tabId} (${tab.url})`)
          return
        }
        const sessionId = this.#mintSession(conn, parsed.kind, tab.tabId)
        const info = parsed.kind === 'tab' ? this.#tabInfo(tab, true) : this.#pageInfo(tab, true)
        this.#emit(conn, 'Target.attachedToTarget', { sessionId, targetInfo: info, waitingForDebugger: false })
        this.#reply(conn, msg, { sessionId })
        return
      }
      case 'Target.detachFromTarget': {
        const sessionId = typeof msg.params?.sessionId === 'string' ? msg.params.sessionId : undefined
        if (sessionId) this.#releaseSession(conn, sessionId, undefined)
        this.#reply(conn, msg, {})
        return
      }
      case 'Target.createTarget': {
        const url =
          typeof msg.params?.url === 'string' && msg.params.url.length > 0 ? msg.params.url : 'about:blank'
        // CDP `background: true` creates the tab without selecting it; an
        // extension that predates `active` ignores it.
        const result = (await this.#rpc({
          op: 'createTab',
          url,
          ...(msg.params?.background === true ? { active: false } : {}),
        })) as { tab: TabSnapshot }
        this.#onTabUpsert(result.tab)
        // Creating a tab is an explicit act of driving it.
        this.#claimTab(conn, result.tab.tabId)
        this.#reply(conn, msg, { targetId: pageTargetId(result.tab.tabId) })
        return
      }
      case 'Target.closeTarget': {
        const parsed = typeof msg.params?.targetId === 'string' ? parseTargetId(msg.params.targetId) : null
        if (!parsed) {
          this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`)
          return
        }
        try {
          await this.#rpc({ op: 'removeTab', tabId: parsed.tabId })
          this.#reply(conn, msg, { success: true })
        } catch (err) {
          // "No tab with id" — the tab was already closed, which is the
          // outcome the close asked for, so report success like the
          // extension's own semantics; any other failure reports an error.
          const message = err instanceof Error ? err.message : String(err)
          if (/No tab with id/i.test(message)) {
            this.#reply(conn, msg, { success: true })
          } else {
            this.#replyError(conn, msg, `Failed to close tab ${parsed.tabId}: ${message}`)
          }
        }
        return
      }
      case 'Target.activateTarget': {
        const parsed = typeof msg.params?.targetId === 'string' ? parseTargetId(msg.params.targetId) : null
        if (parsed) await this.#rpc({ op: 'activateTab', tabId: parsed.tabId })
        this.#reply(conn, msg, {})
        return
      }
      case 'Target.getTargetInfo': {
        const raw = typeof msg.params?.targetId === 'string' ? msg.params.targetId : undefined
        const parsed = raw ? parseTargetId(raw) : null
        const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined
        if (parsed && tab) {
          const info =
            parsed.kind === 'tab' ? this.#tabInfo(tab, tab.attached) : this.#pageInfo(tab, tab.attached)
          this.#reply(conn, msg, { targetInfo: info })
          return
        }
        this.#reply(conn, msg, {
          targetInfo: {
            targetId: 'relay-browser',
            type: 'browser',
            title: '',
            url: '',
            attached: true,
            canAccessOpener: false,
          } satisfies TargetInfo,
        })
        return
      }
      case 'Browser.close':
        // Never close the user's browser; acknowledge and ignore.
        this.#log('refusing Browser.close from downstream client', { conn: conn.id })
        this.#reply(conn, msg, {})
        return
      case 'Browser.setDownloadBehavior':
        this.#reply(conn, msg, {})
        return
      case 'Target.createBrowserContext':
        this.#replyError(conn, msg, 'Browser contexts are not supported by the omp browser relay')
        return
      default:
        this.#replyError(conn, msg, `'${msg.method}' wasn't found`, CDP_ERROR_METHOD_NOT_FOUND)
    }
  }

  // ---- extension events -------------------------------------------------------

  #onCdpEvent(
    tabId: number,
    sourceSessionId: string | undefined,
    method: string,
    params?: Record<string, unknown>,
  ): void {
    const tab = this.#tabs.get(tabId)
    if (!tab) return
    // Track real child sessions so downstream commands can route back.
    if (method === 'Target.attachedToTarget') {
      const child = params?.sessionId
      if (typeof child === 'string' && params) {
        tab.realSessions.set(child, { parent: sourceSessionId, event: params })
        this.#realSessionTabs.set(child, tabId)
      }
    } else if (method === 'Target.detachedFromTarget') {
      const child = params?.sessionId
      if (typeof child === 'string') {
        tab.realSessions.delete(child)
        this.#realSessionTabs.delete(child)
      }
    }
    if (sourceSessionId) {
      // Event from a real child session: pass through verbatim to every
      // connection that was told about the child, tracking nested children.
      const nested = typeof params?.sessionId === 'string' ? params.sessionId : undefined
      const payload = JSON.stringify({ sessionId: sourceSessionId, method, params })
      for (const conn of this.#conns.values()) {
        if (!conn.childParents.has(sourceSessionId)) continue
        conn.socket.send(payload)
        if (nested && method === 'Target.attachedToTarget') {
          // First teller owns the child; a later report does not re-own it.
          if (!conn.childParents.has(nested)) conn.childParents.set(nested, sourceSessionId)
        } else if (nested && method === 'Target.detachedFromTarget') {
          conn.childParents.delete(nested)
          conn.explicitChildren.delete(nested)
        }
      }
      return
    }
    // A real child is announced once per connection, on a session that armed
    // auto-attach (Chrome reports it only to the first armed session, so
    // announcing on every page session would hand puppeteer the same id
    // twice), and its detach goes to that same session. Children reported
    // before any session armed stay stored for a later arming connection
    // ({@link #announceChildren}).
    if (method === 'Target.attachedToTarget' || method === 'Target.detachedFromTarget') {
      const child = params?.sessionId
      if (typeof child !== 'string') return
      for (const conn of this.#conns.values()) {
        let parent: string | undefined
        if (method === 'Target.attachedToTarget') {
          parent = conn.childTargetSessionForTab(tabId)
          if (parent && !conn.childParents.has(child)) conn.childParents.set(child, parent)
        } else {
          parent = conn.childParents.get(child)
          conn.childParents.delete(child)
          conn.explicitChildren.delete(child)
        }
        if (parent) conn.socket.send(JSON.stringify({ sessionId: parent, method, params }))
      }
      return
    }
    // Other root-session events fan out once per minted page session.
    for (const conn of this.#conns.values()) {
      for (const pageSession of conn.sessionsForTab(tabId, 'page')) {
        conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }))
      }
    }
  }

  #onTabDetached(tabId: number, reason: string): void {
    const tab = this.#tabs.get(tabId)
    if (!tab) return
    this.#log('tab detached', { tabId, reason })
    tab.attached = false
    tab.attaching = null
    tab.banned = true
    tab.detachReason = reason
    // A detach-killed command may be holding for this report; swap in a fresh
    // settlement so the tab's next detach gets its own.
    tab.chromeDetach.resolve()
    tab.chromeDetach = Promise.withResolvers<void>()
    // A detached tab is no longer a group candidate — no claim holds it — so release its omp-group membership too.
    this.#syncTabGrouping(tab)
    this.#retractTab(tab)
  }

  #onTabRemoved(tabId: number): void {
    const tab = this.#tabs.get(tabId)
    if (!tab) return
    this.#retractTab(tab)
    this.#tabs.delete(tabId)
    for (const conn of this.#conns.values()) conn.claims.delete(tabId)
  }

  #onTabUpsert(snap: TabSnapshot, opts: { silent?: boolean } = {}): void {
    let tab = this.#tabs.get(snap.tabId)
    if (!tab) {
      tab = new TabState(snap.tabId, snap)
      this.#tabs.set(snap.tabId, tab)
    } else {
      // A revived tab's earlier attach failure was the discarded state, not a
      // debugger refusal: it may attach again.
      const revived = tab.discarded && snap.discarded !== true
      if (tab.url !== snap.url) tab.banned = false
      if (revived) tab.banned = false
      // The user dragging a tab out of the omp group is an opt-out; the
      // relay never fights the user over grouping.
      if (tab.grouped && tab.ompGroupId !== undefined && snap.groupId !== tab.ompGroupId) {
        tab.grouped = false
        tab.groupOptOut = true
      }
      tab.apply(snap)
    }
    if (opts.silent) return
    const eligible = this.#eligible(tab)
    this.#syncTabGrouping(tab)
    if (eligible && !tab.discarded && !tab.announced) {
      tab.announced = true
      for (const conn of this.#conns.values()) {
        if (!conn.discover) continue
        this.#emit(conn, 'Target.targetCreated', { targetInfo: this.#tabInfo(tab, tab.attached) })
        this.#emit(conn, 'Target.targetCreated', { targetInfo: this.#pageInfo(tab, tab.attached) })
      }
      for (const conn of this.#conns.values()) {
        if (!conn.autoAttach) continue
        void this.#ensureAttached(tab).then((ok) => {
          if (ok) this.#emitTabAttached(conn, tab)
        })
      }
      return
    }
    if ((!eligible || tab.discarded) && tab.announced) {
      // Discarding a tab strands its debugger attachment: drop it so revival
      // starts clean instead of the attach result racing the discard.
      this.#retractTab(tab)
      this.#detachIfUnheld(tab.tabId)
      return
    }
    if (eligible && tab.announced) {
      for (const conn of this.#conns.values()) {
        if (!conn.discover) continue
        this.#emit(conn, 'Target.targetInfoChanged', { targetInfo: this.#tabInfo(tab, tab.attached) })
        this.#emit(conn, 'Target.targetInfoChanged', { targetInfo: this.#pageInfo(tab, tab.attached) })
      }
    }
  }

  // ---- tab grouping -----------------------------------------------------------

  /** A tab belongs in the omp group when claimed, controllable, unpinned, not opted out, and not already grouped. */
  #groupWorthy(tab: TabState): boolean {
    if (!this.#claimed(tab.tabId) || !this.#eligible(tab) || tab.pinned || tab.groupOptOut) return false
    return tab.grouped || tab.groupId === -1
  }

  /** Re-group every claimed tab (extension hello / reconnect). */
  #syncGrouping(): void {
    if (!this.#group) return
    const worthy = [...this.#tabs.values()].filter(tab => this.#groupWorthy(tab) && !tab.grouped && !tab.grouping)
    if (worthy.length > 0) this.#requestGroup(worthy)
  }

  /** Reconcile one tab's group membership after a lifecycle event. */
  #syncTabGrouping(tab: TabState): void {
    if (!this.#group) return
    if (this.#groupWorthy(tab)) {
      if (!tab.grouped && !tab.grouping) this.#requestGroup([tab])
      return
    }
    if (tab.grouped) {
      tab.grouped = false
      tab.ompGroupId = undefined
      void this.#rpc({ op: 'ungroup', tabIds: [tab.tabId] }).catch(() => {})
    }
  }

  /**
   * Queue tabs for grouping and drain serially. Overlapping group RPCs race
   * the extension's non-atomic query→create→set-title sequence and mint
   * duplicate omp groups, so at most one group RPC is ever in flight.
   */
  #requestGroup(tabs: TabState[]): void {
    if (!this.#group) return
    for (const tab of tabs) {
      tab.grouping = true
      this.#groupQueue.push(tab)
    }
    if (!this.#groupDraining) void this.#drainGroupQueue()
  }

  async #drainGroupQueue(): Promise<void> {
    const group = this.#group
    if (!group) return
    this.#groupDraining = true
    try {
      while (this.#groupQueue.length > 0) {
        const batch = this.#groupQueue.splice(0)
        const tabIds = batch.map(tab => tab.tabId)
        try {
          const result = await this.#rpc({ op: 'group', tabIds, title: group.title, color: group.color })
          // Extension replies { grouped: { [tabId]: groupId } }; validate per entry.
          const grouped: Record<string, unknown> =
            result &&
            typeof result === 'object' &&
            'grouped' in result &&
            result.grouped &&
            typeof result.grouped === 'object'
              ? (result.grouped as Record<string, unknown>)
              : {}
          for (const tab of batch) {
            const groupId = grouped[String(tab.tabId)]
            if (typeof groupId !== 'number') continue
            tab.grouped = true
            tab.ompGroupId = groupId
          }
          this.#log('grouped tabs', { tabIds, grouped })
        } catch (err) {
          this.#log('tab grouping failed', { error: err instanceof Error ? err.message : String(err) })
        } finally {
          for (const tab of batch) {
            tab.grouping = false
            // The claim may have gone while the RPC was in flight (its client closed): undo the grouping.
            if (tab.grouped && !this.#groupWorthy(tab)) this.#syncTabGrouping(tab)
          }
        }
      }
    } finally {
      this.#groupDraining = false
    }
  }

  /** Tear a tab out of every downstream connection (closed, detached, or now ineligible). */
  #retractTab(tab: TabState): void {
    this.#forgetChildren(tab)
    for (const conn of this.#conns.values()) {
      const tabSessions = conn.sessionsForTab(tab.tabId, 'tab')
      for (const pageSession of conn.sessionsForTab(tab.tabId, 'page')) {
        conn.sessions.delete(pageSession)
        this.#emit(
          conn,
          'Target.detachedFromTarget',
          { sessionId: pageSession, targetId: pageTargetId(tab.tabId) },
          tabSessions[0],
        )
      }
      for (const tabSession of tabSessions) {
        conn.sessions.delete(tabSession)
        this.#emit(conn, 'Target.detachedFromTarget', { sessionId: tabSession, targetId: tabTargetId(tab.tabId) })
      }
      if (conn.discover && tab.announced) {
        this.#emit(conn, 'Target.targetDestroyed', { targetId: pageTargetId(tab.tabId) })
        this.#emit(conn, 'Target.targetDestroyed', { targetId: tabTargetId(tab.tabId) })
      }
    }
    tab.announced = false
  }

  // ---- session + attach bookkeeping --------------------------------------------

  #mintSession(conn: CdpConnection, kind: 'tab' | 'page', tabId: number): string {
    const sessionId = `S${kind === 'tab' ? 'T' : 'P'}${tabId}.${conn.id}.${++this.#sessionSeq}`
    conn.sessions.set(sessionId, { kind, tabId, autoAttach: false })
    return sessionId
  }

  #releaseSession(conn: CdpConnection, sessionId: string, parentSessionId: string | undefined): void {
    const ref = conn.sessions.get(sessionId)
    if (!ref) return
    conn.sessions.delete(sessionId)
    if (ref.autoAttach) this.#releaseAutoAttach(ref.tabId)
    const tab = this.#tabs.get(ref.tabId)
    if (ref.kind === 'page' && tab && !conn.childTargetSessionForTab(ref.tabId)) {
      this.#forgetConnectionChildren(conn, tab, true)
    }
    const targetId = ref.kind === 'tab' ? tabTargetId(ref.tabId) : pageTargetId(ref.tabId)
    this.#emit(conn, 'Target.detachedFromTarget', { sessionId, targetId }, parentSessionId)
    // An explicit release of the last session must drop the attachment too,
    // or it outlives every downstream session: the infobar stays up, and
    // dismissing it bans the tab for the rest of the epoch.
    this.#detachIfUnheld(ref.tabId)
  }

  /**
   * Tell every connection that was announced a real child of this tab that it
   * is gone — nested children first, since Map insertion order puts a parent
   * before the children reported under it.
   */
  #forgetChildren(tab: TabState): void {
    for (const conn of this.#conns.values()) this.#forgetConnectionChildren(conn, tab)
    for (const child of tab.realSessions.keys()) this.#realSessionTabs.delete(child)
    tab.realSessions.clear()
  }

  /**
   * Tell one connection that its known real children of the tab are gone —
   * nested children first, while their parent is still known. `automaticOnly`
   * spares subtrees the connection attached itself: its explicit children
   * outlive an auto-attach opt-out or a page release.
   */
  #forgetConnectionChildren(conn: CdpConnection, tab: TabState, automaticOnly = false): void {
    for (const child of [...tab.realSessions.keys()].reverse()) {
      const parent = conn.childParents.get(child)
      if (parent === undefined) continue
      if (automaticOnly) {
        // Skip anything whose topmost owner is explicit: a connection that
        // attached a child itself keeps it, and keeps its descendants.
        let ancestor = child
        while (!conn.explicitChildren.has(ancestor)) {
          const next = conn.childParents.get(ancestor)
          if (next === undefined) break
          ancestor = next
        }
        if (conn.explicitChildren.has(ancestor)) continue
      }
      conn.childParents.delete(child)
      conn.explicitChildren.delete(child)
      this.#emit(conn, 'Target.detachedFromTarget', { sessionId: child }, parent)
    }
  }

  /** Whether any connection, on the tab's one debugger attachment, still arms auto-attach. */
  #autoAttaches(tabId: number): boolean {
    for (const conn of this.#conns.values()) {
      if (conn.childTargetSessionForTab(tabId)) return true
    }
    return false
  }

  /** Disarm auto-attach once no connection still arms it; a departed holder must not leave it on. */
  #releaseAutoAttach(tabId: number): void {
    void this.#serializeAutoAttach(tabId, async () => {
      if (this.#autoAttaches(tabId)) return
      const tab = this.#tabs.get(tabId)
      if (!tab?.attached) return
      await this.#send(tabId, 'Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() => {})
    })
  }

  /**
   * Run one tab's auto-attach transitions one at a time: the extension starts
   * RPCs independently, so overlapping transitions must settle in order, or a
   * failed one's rollback would restore a state another transition had
   * already changed on the tab.
   */
  #serializeAutoAttach(tabId: number, run: () => Promise<void>): Promise<void> {
    const pending = this.#autoAttachTransitions.get(tabId)
    const result = pending ? pending.then(run) : run()
    const tail = result.catch(() => {})
    this.#autoAttachTransitions.set(tabId, tail)
    void tail.then(() => {
      if (this.#autoAttachTransitions.get(tabId) === tail) this.#autoAttachTransitions.delete(tabId)
    })
    return result
  }

  /**
   * Drop the debugger (and its infobar) from a tab nobody drives anymore.
   * Tracked like every detach so a fast re-attach waits out the landing one
   * instead of being silently undone when the late detach lands.
   */
  #detachIfUnheld(tabId: number): void {
    if (this.#sessionHolders(tabId).length > 0) return
    const tab = this.#tabs.get(tabId)
    if (!tab?.attached) return
    tab.attached = false
    // This detach is the relay's own; any reported detach reason is from an earlier cycle.
    tab.detachReason = undefined
    this.#forgetChildren(tab)
    const done = this.#rpc({ op: 'detach', tabId })
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        if (tab.detaching === done) tab.detaching = null
      })
    tab.detaching = done
  }

  /** Connections currently holding any session on a tab. */
  #sessionHolders(tabId: number): CdpConnection[] {
    const out: CdpConnection[] = []
    for (const conn of this.#conns.values()) {
      if (conn.sessionsForTab(tabId).length > 0) out.push(conn)
    }
    return out
  }

  #emitTabAttached(conn: CdpConnection, tab: TabState): void {
    if (conn.sessionsForTab(tab.tabId, 'tab').length > 0) return
    const sessionId = this.#mintSession(conn, 'tab', tab.tabId)
    this.#emit(conn, 'Target.attachedToTarget', {
      sessionId,
      targetInfo: this.#tabInfo(tab, true),
      waitingForDebugger: false,
    })
  }

  async #ensureAttached(tab: TabState): Promise<boolean> {
    if (tab.attached) return true
    // Wait out an in-flight detach first: a new attach racing it would be
    // undone when the late detach lands after the attach.
    if (tab.detaching) await tab.detaching
    if (tab.discarded) return false
    if (tab.banned || !this.#ext) return false
    if (tab.attaching) return await tab.attaching
    const attempt = this.#rpc({ op: 'attach', tabId: tab.tabId })
      .then(() => {
        tab.attached = true
        // A fresh attach leaves any earlier detach cycle's reason behind.
        tab.detachReason = undefined
        return true
      })
      .catch((err: unknown) => {
        this.#log('attach failed', {
          tabId: tab.tabId,
          url: tab.url,
          error: err instanceof Error ? err.message : String(err),
        })
        tab.banned = true
        return false
      })
      .finally(() => {
        tab.attaching = null
      })
    tab.attaching = attempt
    return await attempt
  }

  #eligible(tab: TabState): boolean {
    if (tab.banned) return false
    if (!tab.url) return true
    return !INELIGIBLE_URL.test(tab.url)
  }

  #tabInfo(tab: TabState, attached: boolean): TargetInfo {
    return {
      targetId: tabTargetId(tab.tabId),
      type: 'tab',
      title: tab.title,
      url: tab.url || 'about:blank',
      attached,
      canAccessOpener: false,
    }
  }

  #pageInfo(tab: TabState, attached: boolean): TargetInfo {
    return {
      targetId: pageTargetId(tab.tabId),
      type: 'page',
      title: tab.title,
      url: tab.url || 'about:blank',
      attached,
      canAccessOpener: false,
    }
  }

  // ---- plumbing ---------------------------------------------------------------

  #reply(conn: CdpConnection, msg: CdpCommand, result: Record<string, unknown>): void {
    conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }))
  }

  #replyError(conn: CdpConnection, msg: CdpCommand, message: string, code = CDP_ERROR_SERVER): void {
    conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code, message } }))
  }

  #emit(conn: CdpConnection, method: string, params: Record<string, unknown>, sessionId?: string): void {
    conn.socket.send(JSON.stringify({ sessionId, method, params }))
  }
  /**
   * Forward one CDP command to a tab under a deadline that fits the command:
   * page-bound work (`awaitPromise` evaluates, `Runtime.awaitPromise`,
   * `Page.navigate`) gets {@link PAGE_BOUND_RPC_TIMEOUT_MS}, everything else
   * {@link RPC_TIMEOUT_MS}. A deadline miss rejects with an error naming the
   * method and tab; other failures pass through unchanged.
   */
  async #send(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    const pageBound = params?.awaitPromise === true || method === 'Runtime.awaitPromise' || method === 'Page.navigate'
    const timeoutMs = pageBound ? PAGE_BOUND_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS
    try {
      return await this.#rpc({
        op: 'send',
        tabId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        method,
        ...(params !== undefined ? { params } : {}),
      }, timeoutMs)
    } catch (err) {
      if (!(err instanceof RpcTimeoutError)) throw err
      throw new Error(`${method} on tab ${tabId}: Chrome sent no answer within ${timeoutMs}ms`, { cause: err })
    }
  }

  #rpc(req: RelayRpcRequest, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    const ext = this.#ext
    if (!ext) return Promise.reject(new Error('relay extension is not connected'))
    const id = ++this.#rpcSeq
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      this.#pendingRpc.delete(id)
      reject(new RpcTimeoutError(`extension rpc '${req.op}' timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    this.#pendingRpc.set(id, { resolve, reject, timer })
    // Only in a tab a downstream connection claims may the extension empty another extension's
    // frames to get past Chrome's refusal; the user's other tabs keep their menus.
    const sent =
      req.op === 'attach' || req.op === 'send'
        ? { ...req, clearForeignFrames: this.#claimed(req.tabId) }
        : req
    ext.send(JSON.stringify({ t: 'rpc', id, ...sent } satisfies RelayToExtMessage))
    return promise
  }
}
