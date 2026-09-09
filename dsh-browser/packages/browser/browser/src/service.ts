/**
 * The `ctx.browser` service: an agent-facing browser over Playwright Core CDP.
 *
 * Three backends, mirroring omp's browser tool:
 * - **launch** — spawn a (stealth-patched) browser executable,
 * - **attach** — connect to an existing CDP endpoint (`cdp_url`), and
 * - **relay** — connect to the local relay server whose companion Chrome
 *   extension drives the user's own tabs.
 *
 * Tabs are addressed by name (default `main`) per service instance; one
 * browser connection is shared across tabs. The service owns no durable state
 * and is conversation/session-scoped by the plugin row that mounts it.
 *
 * Port of oh-my-pi's browser — stealth plus relay/CDP-attach (see LICENSE).
 * Model-facing surface lives in
 * @hy-sde-org/dsh-tool-browser.
 * @module @hy-sde-org/dsh-browser/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { chromium, type Browser as PlaywrightBrowser, type BrowserServer as PlaywrightServer, type Page as PlaywrightPage } from 'playwright-core'
import { forgetOwnedBrowser, reapOrphanBrowsers, recordOwnedBrowser } from './orphan-registry.ts'
import { captureAriaSnapshot, resolveAriaRefElement } from './aria.ts'
import {
  DEFAULT_VIEWPORT,
  STEALTH_LAUNCH_ARGS,
  applyUserAgentOverride,
  preparePage,
  resolveUserAgentOverride,
  stealthIgnoreDefaultArgs,
} from './stealth.ts'
import { startRelayServer, type RelayServer } from './relay/server.ts'
import { resolveRelayKind } from './relay/kind.ts'
import type { BrowserConfig, BrowserKind, PageObservation, ScreenshotResult } from './types.ts'

export type { BrowserConfig, BrowserKind, BrowserKindTag, PageObservation, ObservationEntry, ScreenshotResult } from './types.ts'

/** Navigation wait condition accepted by the tool (Playwright dialect). */
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit'

/** Map omp/puppeteer-style wait conditions onto Playwright's dialect. */
export function normalizeWaitUntil(value: string | undefined): WaitUntil | undefined {
  if (value === 'networkidle0' || value === 'networkidle2') return 'networkidle'
  if (value === 'load' || value === 'domcontentloaded' || value === 'networkidle' || value === 'commit') {
    return value
  }
  return undefined
}

/** How a tab is addressed in `close`. */
export type CloseMode = 'single' | 'all' | 'kill'

interface BrowserEntry {
  kind: BrowserKind
  browser: PlaywrightBrowser
  /** The launch handle, present for launch-kind entries: owns the OS process (`.process().pid`) and a definitive kill. */
  server?: PlaywrightServer
  headless: boolean
  cwd: string
}

interface TabEntry {
  page: PlaywrightPage
  browserKey: string
  name: string
}

const DEFAULT_TIMEOUT_MS = 30_000

/** One browser connection per (cwd + kind), one tab per name. */
export class BrowserService extends Service {
  private readonly browserPath: string | undefined
  private readonly headless: boolean
  private readonly viewport: { width: number; height: number; deviceScaleFactor?: number }
  private readonly relayUrl: string
  private readonly relayToken: string | undefined
  private readonly timeoutMs: number
  private readonly browsers = new Map<string, BrowserEntry>()
  private readonly tabs = new Map<string, TabEntry>()
  private relay: RelayServer | undefined

  constructor(
    ctx: Context,
    config: BrowserConfig = {},
  ) {
    super(ctx, 'browser')
    this.browserPath = config.browserPath
    this.headless = config.headless ?? true
    this.viewport = config.viewport ?? DEFAULT_VIEWPORT
    this.relayUrl = config.relayUrl?.replace(/\/+$/, '') ?? 'http://127.0.0.1:9224'
    this.relayToken = config.relayToken
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Boot-time reap: a previously crashed/killed host leaves its spawned
    // Chromium behind (reparented to PID 1). Sweep the ownership registry for
    // browsers whose recorded owner is gone before opening anything new.
    // Fire-and-forget: cleanup must never block browser open.
    void reapOrphanBrowsers().catch(() => {})
  }

  /**
   * The relay endpoint this instance serves (created lazily in relay kind).
   * @returns the relay base URL this instance binds or resolves.
   */
  relayEndpoint(): string {
    return this.relay ? `http://127.0.0.1:${this.relay.port}` : this.relayUrl
  }

  private browserKeyFor(kind: BrowserKind, cwd: string): string {
    if (kind.kind === 'launch') return `launch:${cwd}`
    return `${kind.kind}:${'cdpUrl' in kind ? kind.cdpUrl : ''}`
  }

  private async connect(kind: BrowserKind, cwd: string): Promise<BrowserEntry> {
    const key = this.browserKeyFor(kind, cwd)
    const existing = this.browsers.get(key)
    if (existing) return existing

    const entry = await this.openConnection(kind, cwd)
    this.browsers.set(key, entry)
    return entry
  }

  private async openConnection(kind: BrowserKind, cwd: string): Promise<BrowserEntry> {
    if (kind.kind === 'launch') {
      const executablePath = kind.path ?? this.browserPath
      const launchOptions = {
        executablePath,
        headless: this.headless,
        args: [...STEALTH_LAUNCH_ARGS],
        ignoreDefaultArgs: stealthIgnoreDefaultArgs(executablePath),
      } as never
      // launchServer (not bare launch): the returned server owns the real OS
      // process, exposing its pid for the orphan registry and giving us a
      // definitive kill handle. The connected Browser still serves pages, and
      // newBrowserCDPSession (UA override) works over the connection.
      const server = await chromium.launchServer(launchOptions)
      const browser = await chromium.connect(server.wsEndpoint())
      void applyUserAgentOverride(browser, await resolveUserAgentOverride(browser))
      // Record our own spawned browser in the orphan registry so a later host
      // can reap it if THIS process dies before closing it. `launch` pids only
      // (attach/relay browsers belong to other owners and must never be
      // touched by our reap sweep).
      const launchedPid = server.process().pid
      if (typeof launchedPid === 'number' && Number.isInteger(launchedPid)) {
        void recordOwnedBrowser(launchedPid).catch(() => {})
      }
      return { kind, server, browser, headless: this.headless, cwd }
    }

    // attach + relay both speak Chrome CDP discovery; the relay impersonates it.
    const browser = await chromium.connectOverCDP(kind.cdpUrl)
    return { kind, browser, headless: false, cwd }
  }

  /**
   * Resolve the browser kind for a session (attach/launch/relay), like omp.
   * @param input - optional app-path, cdp URL, or explicit relay opt-in.
   * @returns the resolved {@link BrowserKind} to drive.
   */
  resolveKind(input: { path?: string; cdpUrl?: string; relay?: boolean }): BrowserKind {
    if (input.cdpUrl) return { kind: 'attach', cdpUrl: input.cdpUrl.replace(/\/+$/, '') }
    if (input.path) return { kind: 'launch', path: input.path }
    const relay = resolveRelayKind({ settingEnabled: input.relay ?? false, url: this.relayUrl })
    if (relay) return { kind: 'relay', cdpUrl: relay.cdpUrl }
    return this.browserPath !== undefined ? { kind: 'launch', path: this.browserPath } : { kind: 'launch' }
  }

  /**
   * Ensure the relay server is running for this instance (idempotent).
   * @returns the relay base URL the in-process server is bound to.
   */
  async ensureRelay(): Promise<string> {
    if (this.relay) return this.relayEndpoint()
    const port = Number(new URL(this.relayUrl).port || 80)
    const server = await startRelayServer({
      port,
      ...(this.relayToken !== undefined ? { token: this.relayToken } : {}),
      // fall back to an ephemeral port if the default is taken
      log: () => {},
    })
    this.relay = server
    return this.relayEndpoint()
  }

  private async tab(name: string, kind: BrowserKind, cwd: string): Promise<TabEntry> {
    const existing = this.tabs.get(name)
    if (existing) return existing
    const entry = await this.connect(kind, cwd)
    const page = await entry.browser.newPage({ viewport: this.viewport })
    if (entry.kind.kind === 'launch') await preparePage(page)
    const tab: TabEntry = { page, browserKey: this.browserKeyFor(kind, cwd), name }
    this.tabs.set(name, tab)
    return tab
  }

  /**
   * Open (or navigate) a named tab to `url`; returns the page observation.
   * @param name - tab id; one tab per name, one browser per cwd+kind.
   * @param url - the URL to navigate to.
   * @param opts - backend kind, working directory, wait condition, timeout.
   * @returns the page observation (title, url, ARIA snapshot, size).
   */
  async open(
    name: string,
    url: string,
    opts: {
      kind: BrowserKind
      cwd: string
      waitUntil?: WaitUntil
      timeoutMs?: number
    },
  ): Promise<PageObservation> {
    const tab = await this.tab(name, opts.kind, opts.cwd)
    await tab.page.goto(url, {
      waitUntil: normalizeWaitUntil(opts.waitUntil) ?? 'load',
      timeout: opts.timeoutMs ?? this.timeoutMs,
    })
    return this.observePage(tab.page)
  }

  /**
   * Evaluate `code` in the named tab and return the JSON-serializable value.
   * @param name - tab id.
   * @param code - JavaScript body/expression evaluated in the tab's page.
   * @param opts - backend kind, working directory, timeout.
   * @returns the evaluated value (JSON-serializable).
   */
  async run(
    name: string,
    code: string,
    opts: { kind: BrowserKind; cwd: string; timeoutMs?: number },
  ): Promise<unknown> {
    const tab = await this.tab(name, opts.kind, opts.cwd)
    return tab.page.evaluate(code)
  }

  /**
   * Click an ARIA-ref (`aria-ref=e5`) or CSS selector in the named tab.
   * @param name - tab id.
   * @param selector - ARIA ref selector or CSS selector.
   * @param opts - backend kind, working directory.
   * @returns the re-observed page after the click.
   */
  async click(
    name: string,
    selector: string,
    opts: { kind: BrowserKind; cwd: string },
  ): Promise<PageObservation> {
    const tab = await this.tab(name, opts.kind, opts.cwd)
    const ref = selector.trim()
    const bareRef = ref.startsWith('aria-ref=') ? ref.split('=')[1] ?? '' : ref.startsWith('aria-ref/') || ref.startsWith('ariaref/') ? ref.split('/').pop() ?? '' : undefined
    if (bareRef !== undefined) {
      const target = await resolveAriaRefElement(tab.page, bareRef)
      if (target === null) throw new Error(`browser: aria ref ${bareRef} no longer matches any element (re-snapshot)`)
      await target.click()
    } else {
      await tab.page.locator(ref).first().click()
    }
    return this.observePage(tab.page)
  }

  /**
   * Type text into an ARIA-ref or CSS selector in the named tab.
   * @param name - tab id.
   * @param selector - ARIA ref selector or CSS selector.
   * @param text - the text to fill.
   * @param opts - backend kind, working directory.
   * @returns the re-observed page after the fill.
   */
  async type(
    name: string,
    selector: string,
    text: string,
    opts: { kind: BrowserKind; cwd: string },
  ): Promise<PageObservation> {
    const tab = await this.tab(name, opts.kind, opts.cwd)
    const ref = selector.trim()
    const bareRef = ref.startsWith('aria-ref=') ? ref.split('=')[1] ?? '' : ref.startsWith('aria-ref/') || ref.startsWith('ariaref/') ? ref.split('/').pop() ?? '' : undefined
    if (bareRef !== undefined) {
      const target = await resolveAriaRefElement(tab.page, bareRef)
      if (target === null) throw new Error(`browser: aria ref ${bareRef} no longer matches any element (re-snapshot)`)
      await target.fill(text)
    } else {
      await tab.page.locator(ref).first().fill(text)
    }
    return this.observePage(tab.page)
  }

  /**
   * Close named tabs; `all` closes every tab, `kill` also closes browsers.
   * @param name - tab id.
   * @param opts - backend kind, working directory, close-all and kill flags.
   * @returns a promise resolving once the close is initiated.
   */
  async close(name: string, opts: { kind: BrowserKind; cwd: string; all?: boolean; kill?: boolean }): Promise<void> {
    const entry = this.browsers.get(this.browserKeyFor(opts.kind, opts.cwd))
    if (opts.all) {
      for (const [tabName, tab] of this.tabs) {
        void tab.page.close().catch(() => {})
        this.tabs.delete(tabName)
      }
      if (opts.kill && entry) {
        await this.#closeBrowser(entry)
        this.#releaseBrowser(entry)
        this.browsers.delete(this.browserKeyFor(opts.kind, opts.cwd))
      }
      return
    }
    const tab = this.tabs.get(name)
    if (!tab) return
    void tab.page.close().catch(() => {})
    this.tabs.delete(name)
    if (opts.kill && entry) {
      void this.#closeBrowser(entry)
      this.#releaseBrowser(entry)
      this.browsers.delete(this.browserKeyFor(opts.kind, opts.cwd))
    }
  }

  /** Close a browser: for launch-kind, kill the real OS process; otherwise close the connection. */
  async #closeBrowser(entry: BrowserEntry): Promise<void> {
    if (entry.server) {
      // Server.close terminates the launched Chromium process — a definitive
      // kill even if the page layer wedged. The connected Browser's own close
      // would only drop the connection.
      await entry.server.close().catch(() => {})
      return
    }
    await entry.browser.close().catch(() => {})
  }

  /** Drop a closed browser from the orphan registry (we closed it ourselves, so it is not an orphan). */
  #releaseBrowser(entry: BrowserEntry): void {
    const launchedPid = entry.server?.process().pid
    if (typeof launchedPid === 'number' && Number.isInteger(launchedPid)) {
      void forgetOwnedBrowser(launchedPid).catch(() => {})
    }
  }

  /**
   * Screenshot the named tab to a PNG file; returns the written path.
   * @param name - tab id.
   * @param destination - the PNG file path to write.
   * @param opts - backend kind, working directory, full-page flag.
   * @returns the written screenshot path.
   */
  async screenshot(
    name: string,
    destination: string,
    opts: { kind: BrowserKind; cwd: string; fullPage?: boolean },
  ): Promise<ScreenshotResult> {
    const tab = await this.tab(name, opts.kind, opts.cwd)
    await tab.page.screenshot({ path: destination, ...(opts.fullPage !== undefined ? { fullPage: opts.fullPage } : {}) })
    return { path: destination }
  }

  /**
   * Observe the named tab (title, url, size, ARIA snapshot) without navigating.
   * @param name - tab id.
   * @param opts - backend kind, working directory.
   * @returns the page observation.
   */
  async observe(name: string, opts: { kind: BrowserKind; cwd: string }): Promise<PageObservation> {
    const tab = await this.tab(name, opts.kind, opts.cwd)
    return this.observePage(tab.page)
  }

  /** Observe a page: title, url, size, and the ARIA snapshot. */
  private async observePage(page: PlaywrightPage): Promise<PageObservation> {
    const [title, aria] = await Promise.all([page.title().catch(() => ''), captureAriaSnapshot(page, null, {})])
    const url = page.url()
    const viewport = page.viewportSize()
    return {
      title,
      url,
      aria,
      width: viewport?.width ?? 0,
      height: viewport?.height ?? 0,
    }
  }

  /** Close every browser connection and stop the relay (cleanup on ctx dispose). */
  stop(): void {
    for (const entry of this.browsers.values()) {
      // release from the orphan registry first: a graceful ctx dispose means
      // WE are closing these, so no later host should treat them as orphans.
      this.#releaseBrowser(entry)
      void this.#closeBrowser(entry)
    }
    this.browsers.clear()
    this.tabs.clear()
    this.relay?.stop()
    this.relay = undefined
  }

  /** Number of open browser connections (tests / diagnostics). */
  get browserCount(): number {
    return this.browsers.size
  }
}

export { captureAriaSnapshot, resolveAriaRefElement } from './aria.ts'
export { startRelayServer, type RelayServer } from './relay/server.ts'
export { resolveRelayKind, DEFAULT_RELAY_URL } from './relay/kind.ts'
export {
  DEFAULT_VIEWPORT,
  STEALTH_LAUNCH_ARGS,
  stealthIgnoreDefaultArgs,
  resolveUserAgentOverride,
  applyUserAgentOverride,
  type UserAgentOverride,
} from './stealth.ts'
