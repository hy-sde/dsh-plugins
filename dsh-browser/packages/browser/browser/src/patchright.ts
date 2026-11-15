/**
 * Patchright backend (`app.patch`): launch Chromium through
 * [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) — a
 * Playwright fork that closes Playwright's own automation leaks at the CDP
 * client layer (Runtime.enable, console/stack-trace/URL leaks, the
 * `--enable-automation`-style default args) while staying a drop-in
 * Playwright replacement: its `chromium.launch()` returns a standard
 * `Browser` object.
 *
 * `patchright` is an OPTIONAL peer: it is dynamically imported here with a
 * computed specifier (same technique as @hy-sde-org/dsh-tool-library-search's
 * optional transformers embedder) so the package keeps zero hard dependency on
 * it. The browser binary is fetched once with `npx patchright install
 * chromium` (cached under `~/Library/Caches/ms-playwright/`). Patchright only
 * fixes automation-leak channels — it does NOT randomize fingerprints — so the
 * dsh-browser JS stealth layer (launch args, UA/client-hints override, init
 * scripts) IS applied on this backend, same as the launch backend.
 * @module @hy-sde-org/dsh-browser/patchright
 */

/** Raised when the Patchright backend is requested but not usable. */
export class PatchrightUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchrightUnavailableError'
  }
}

/** Launch options passed through to `patchright.chromium.launch()`. */
export interface PatchrightLaunchOptions {
  /** Headless mode (default: the service's `headless` config, usually true). */
  headless?: boolean
  /** Proxy URL passed to the browser (e.g. a residential proxy). */
  proxy?: string
  /** Browser distribution channel, e.g. `chrome` to drive installed Google Chrome. */
  channel?: string
  /** Explicit browser executable path (overrides the channel). */
  executablePath?: string
  /** Extra Chromium launch args. */
  args?: string[]
  /** Chromium default args to strip. */
  ignoreDefaultArgs?: string[]
}

/**
 * Launch a patchright-driven Chromium.
 * @param options - launch options (headless/proxy/channel/executable passthrough).
 * @returns the Playwright-compatible `Browser` (cast by the caller).
 * @throws {PatchrightUnavailableError} when `patchright` is not installed or has
 * no `chromium.launch` export (too old / wrong package).
 */
export async function launchPatchrightBrowser(options: PatchrightLaunchOptions): Promise<unknown> {
  // Computed specifier: keeps the OPTIONAL peer out of static type resolution
  // (it is not installed in base deployments) while still allowing a runtime
  // `npm i patchright` to be picked up lazily. Typed as `string` so tsc
  // never tries to resolve it.
  const moduleName: string = 'patchright'
  let mod: { chromium?: { launch?: (options?: Record<string, unknown>) => Promise<unknown> } }
  try {
    mod = await import(moduleName) as { chromium?: { launch?: (options?: Record<string, unknown>) => Promise<unknown> } }
  } catch {
    throw new PatchrightUnavailableError(
      'browser app.patch: install the optional peer `patchright` (npm i patchright) and download its browser '
      + '(npx patchright install chromium) to use this backend.',
    )
  }
  const chromium = mod.chromium
  if (!chromium || typeof chromium.launch !== 'function') {
    throw new PatchrightUnavailableError(
      'browser app.patch: the installed `patchright` has no `chromium.launch` export — install a current version (>=1.49).',
    )
  }
  const launchOptions: Record<string, unknown> = { headless: options.headless ?? true }
  if (options.channel !== undefined) launchOptions.channel = options.channel
  if (options.executablePath !== undefined) launchOptions.executablePath = options.executablePath
  if (options.proxy !== undefined) launchOptions.proxy = { server: options.proxy }
  if (options.args !== undefined) launchOptions.args = options.args
  if (options.ignoreDefaultArgs !== undefined) launchOptions.ignoreDefaultArgs = options.ignoreDefaultArgs
  return chromium.launch(launchOptions)
}

/**
 * OS pid of a launched patchright Chromium, when the peer exposes its
 * process. patchright's `chromium.launch()` returns a standard `Browser`
 * with no launchServer handle, so a crashed host's patch browser is only
 * reapable if the peer surfaces the pid (duck-typed — a peer without the
 * accessor records nothing, same as before this existed).
 * @param browser - the value returned by {@link launchPatchrightBrowser}.
 * @returns the browser's OS pid, or undefined when not exposed.
 */
export function patchrightBrowserPid(browser: unknown): number | undefined {
  const processFn = (browser as { process?: () => { pid?: number } | undefined }).process
  if (typeof processFn !== 'function') return undefined
  const pid = processFn.call(browser)?.pid
  return typeof pid === 'number' && Number.isInteger(pid) ? pid : undefined
}
