/**
 * CloakBrowser backend (`app.patch`): launch the CloakBrowser Chromium — a
 * fork carrying 71 source-level C++ fingerprint patches (canvas, WebGL,
 * audio, fonts, GPU, screen, WebRTC, network timing, automation signals) —
 * through the `cloakbrowser` npm package, a drop-in Playwright replacement:
 * its `launch()` returns a plain Playwright-compatible `Browser` over its
 * patched Chromium binary.
 *
 * `cloakbrowser` is an OPTIONAL peer: it is dynamically imported here with a
 * computed specifier (same technique as @hy-sde-org/dsh-tool-library-search's
 * optional transformers embedder) so the package keeps zero hard dependency on
 * it. The first launch auto-downloads the patched Chromium (~200 MB, cached
 * under `~/.cloakbrowser/`); every launch randomizes per-session fingerprints
 * at the C++ layer, so the dsh-browser UA override and JS init scripts are
 * deliberately NOT applied on this backend (they would fight the
 * randomization).
 * @module @hy-sde-org/dsh-browser/cloak
 */

/** Raised when the CloakBrowser backend is requested but not usable. */
export class CloakUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloakUnavailableError'
  }
}

/** Launch options passed through to `cloakbrowser.launch()` (README surface). */
export interface CloakLaunchOptions {
  /** Headless mode (default: the service's `headless` config, usually true). */
  headless?: boolean
  /** Proxy URL passed to the browser (e.g. a residential proxy). */
  proxy?: string
  /** Match timezone + locale to the proxy IP (needs `proxy`). */
  geoip?: boolean
  /** Human-like mouse, keyboard, scroll behaviour. */
  humanize?: boolean
}

/**
 * Launch a CloakBrowser Chromium.
 * @param options - launch options (headless/proxy/geoip/humanize passthrough).
 * @returns the Playwright-compatible `Browser` (cast by the caller).
 * @throws {CloakUnavailableError} when `cloakbrowser` is not installed or has
 * no `launch` export (too old / wrong package).
 */
export async function launchCloakBrowser(options: CloakLaunchOptions): Promise<unknown> {
  // Computed specifier: keeps the OPTIONAL peer out of static type resolution
  // (it is not installed in base deployments) while still allowing a runtime
  // `npm i cloakbrowser` to be picked up lazily. Typed as `string` so tsc
  // never tries to resolve it.
  const moduleName: string = 'cloakbrowser'
  let mod: { launch?: (options?: Record<string, unknown>) => Promise<unknown> }
  try {
    mod = await import(moduleName) as { launch?: (options?: Record<string, unknown>) => Promise<unknown> }
  } catch {
    throw new CloakUnavailableError(
      'browser app.patch: install the optional peer `cloakbrowser` (npm i cloakbrowser) to use this backend '
      + '— its first launch auto-downloads the patched Chromium (~200MB, cached under ~/.cloakbrowser/).',
    )
  }
  if (typeof mod.launch !== 'function') {
    throw new CloakUnavailableError(
      'browser app.patch: the installed `cloakbrowser` has no `launch` export — install a current version (>=0.5).',
    )
  }
  const launchOptions: Record<string, unknown> = { headless: options.headless ?? true }
  if (options.proxy !== undefined) launchOptions.proxy = options.proxy
  if (options.geoip === true) launchOptions.geoip = true
  if (options.humanize === true) launchOptions.humanize = true
  return mod.launch(launchOptions)
}
