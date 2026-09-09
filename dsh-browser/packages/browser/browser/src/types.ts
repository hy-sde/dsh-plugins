/**
 * Types shared across the browser service, its tool consumer, and tests.
 * @module @hy-sde-org/dsh-browser/types
 */

/** Which browser backend a tab belongs to. */
export type BrowserKind =
  | { kind: 'launch'; path?: string }
  | { kind: 'attach'; cdpUrl: string }
  | { kind: 'relay'; cdpUrl: string }

export type BrowserKindTag = BrowserKind['kind']

/** One live element snapshot row inside an observation's aria tree. */
export interface ObservationEntry {
  ref: string
  role: string
  name: string
  description?: string
  /** "checked", "pressed", … */
  state?: string
}

/** Page observation returned by the service to the tool. */
export interface PageObservation {
  title: string
  url: string
  aria: string
  width: number
  height: number
}

export interface ScreenshotResult {
  path: string
  width?: number
  height?: number
}

/** Service configuration for `ctx.browser` (config row values). */
export interface BrowserConfig {
  /** Resolvable browser executable path; empty lets Playwright find one. */
  browserPath?: string
  /** Headless mode for launched browsers (default true). */
  headless?: boolean
  /** Default viewport for launched browsers. */
  viewport?: {
    /** Viewport width in CSS pixels (default 1280). */
    width: number
    /** Viewport height in CSS pixels (default 720). */
    height: number
    /** Device scale factor — values above 1 simulate high-DPI displays (default 1). */
    deviceScaleFactor?: number
  }
  /** Relay endpoint (default `http://127.0.0.1:9224`). */
  relayUrl?: string
  /** Token the extension must present at `ws://…/ext?token=` (unset = open). */
  relayToken?: string
  /** Timeout in ms applied to navigation calls (default 30_000). */
  timeoutMs?: number
}
