/**
 * Stealth browser launch + user-agent spoofing, ported from oh-my-pi's
 * `coding-agent/src/tools/browser/launch.ts` (MIT, see LICENSE).
 *
 * Puppeteer's `--enable-automation` flag sets `navigator.webdriver=true` and
 * shows the "controlled by automated software" infobar. Playwright's default
 * launch adds a similar set; we suppress the machine-tell flags and apply an
 * `Emulation.setUserAgentOverride` (+ client hints) on every target so a
 * launched browser looks like a normal Chrome install.
 * @module @hy-sde-org/dsh-browser/stealth
 */

import type { Browser, CDPSession, Page } from 'playwright-core'
import { installStealth } from './stealth-scripts.ts'

/** Default viewport used for launched browsers. */
export const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 } as const

const ENABLE_AUTOMATION_FLAG = '--enable-automation'

/** Puppeteer/Playwright automation-tell launch flags to suppress (when present). */
const STEALTH_IGNORE_DEFAULT_ARGS = [
  ENABLE_AUTOMATION_FLAG,
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-component-extensions-with-background-pages',
  '--disable-popup-blocking',
  '--disable-client-side-phishing-detection',
  '--allow-pre-commit-input',
  '--disable-ipc-flooding-protection',
  '--metrics-recording-only',
]

function isEdgeExecutable(executablePath: string | undefined): boolean {
  if (!executablePath) return false
  const name = executablePath.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  return name === 'msedge.exe' || name === 'microsoft edge' || name.startsWith('microsoft-edge')
}

/** Default flags suppressed: Edge keeps `--enable-automation` (stability). */
export function stealthIgnoreDefaultArgs(executablePath?: string): string[] {
  if (!isEdgeExecutable(executablePath)) return [...STEALTH_IGNORE_DEFAULT_ARGS]
  return STEALTH_IGNORE_DEFAULT_ARGS.filter(arg => arg !== ENABLE_AUTOMATION_FLAG)
}

/** Additional launch args reducing automation fingerprints. */
export const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-features=Translate,PrivacySandboxSettings4',
  '--disable-domain-reliability',
  '--disable-breakpad',
] as const

/** User-agent + client-hints override, mirroring omp's `UserAgentOverride`. */
export interface UserAgentOverride {
  userAgent: string
  platform: string
  acceptLanguage: string
  userAgentMetadata: {
    brands: Array<{ brand: string; version: string }>
    fullVersion: string
    fullVersionList: Array<{ brand: string; version: string }>
    platform: string
    platformVersion: string
    architecture: string
    bitness: string
    model: string
    mobile: boolean
  }
}

function hostArchitecture(): string {
  if (process.arch === 'arm64') return 'arm'
  if (process.arch.includes('64')) return 'x86'
  return ''
}

function hostBitness(): string {
  return process.arch.includes('64') ? '64' : ''
}

/** Derive a realistic chrome UA (+ client hints) from a Playwright browser. */
export async function resolveUserAgentOverride(browser: Browser): Promise<UserAgentOverride> {
  let rawUserAgent = ''
  try {
    const session = await (browser as unknown as { newBrowserCDPSession: () => Promise<CDPSession> }).newBrowserCDPSession()
    const version = (await session.send('Browser.getVersion')) as { userAgent?: string }
    rawUserAgent = version.userAgent ?? ''
    await session.detach()
  } catch {
    rawUserAgent = ''
  }
  if (!rawUserAgent) {
    const version = browser.version()
    rawUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
  }
  let userAgent = rawUserAgent.replace('HeadlessChrome/', 'Chrome/')
  if (userAgent.includes('Linux') && !userAgent.includes('Android')) {
    userAgent = userAgent.replace(/\(([^)]+)\)/, '(Windows NT 10.0; Win64; x64)')
  }
  const uaVersionMatch = userAgent.match(/Chrome\/([\d.]+)/)
  const browserVersionMatch = (browser.version()).match(/\/([\d.]+)/)
  const legacyVersion = uaVersionMatch?.[1] ?? browserVersionMatch?.[1] ?? '0'
  const fullVersion = browserVersionMatch?.[1] ?? legacyVersion
  const majorVersion = Number.parseInt(legacyVersion.split('.')[0] ?? '0', 10) || 0
  const isAndroid = userAgent.includes('Android')
  const isMac = userAgent.includes('Mac OS X')
  const isWindows = userAgent.includes('Windows')
  const platform = isMac ? 'MacIntel' : isAndroid ? 'Android' : userAgent.includes('Linux') ? 'Linux' : 'Win32'
  const platformFull = isMac ? 'macOS' : isAndroid ? 'Android' : userAgent.includes('Linux') ? 'Linux' : 'Windows'
  const platformVersion = isMac
    ? ''
    : isAndroid
      ? (userAgent.match(/Android ([^;]+)/)?.[1] ?? '')
      : isWindows
        ? (userAgent.match(/Windows NT ([\d.]+)/)?.[1] ?? '')
        : ''
  const architecture = isAndroid ? '' : hostArchitecture()
  const bitness = isAndroid ? '' : hostBitness()
  const model = isAndroid ? (userAgent.match(/Android.*?;\s([^)]+)/)?.[1] ?? '') : ''

  const brandOrders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ] as const
  const order = brandOrders[majorVersion % brandOrders.length] ?? brandOrders[0]
  const escapedChars = [' ', ' ', ';'] as const
  const greaseyBrand = `Not${escapedChars[order[0]]}A${escapedChars[order[1]]}${escapedChars[order[2]]}Brand`
  const brands: Array<{ brand: string; version: string }> = []
  brands[order[0]] = { brand: greaseyBrand, version: '99' }
  brands[order[1]] = { brand: 'Chromium', version: String(majorVersion) }
  brands[order[2]] = { brand: 'Google Chrome', version: String(majorVersion) }
  const fullVersionList = brands.map(({ brand }) => ({
    brand,
    version: brand === greaseyBrand ? '99.0.0.0' : fullVersion,
  }))

  return {
    userAgent,
    platform,
    acceptLanguage: 'en-US,en',
    userAgentMetadata: {
      brands,
      fullVersion,
      fullVersionList,
      platform: platformFull,
      platformVersion,
      architecture,
      bitness,
      model,
      mobile: isAndroid,
    },
  }
}

async function sendUserAgentOverride(session: CDPSession, override: UserAgentOverride): Promise<void> {
  try {
    await session.send('Network.enable')
  } catch {
    // page/browser may already have Network enabled — ignore
  }
  try {
    await session.send('Network.setUserAgentOverride', { ...override })
  } catch {
    // ignore per-target failure; Emulation override below is the important one
  }
  try {
    await session.send('Emulation.setUserAgentOverride', { ...override })
  } catch {
    // ignore
  }
}

/**
 * Apply the UA override on the browser session. Playwright (unlike Puppeteer)
 * does not expose child sessions through `CDPSession.connection`, so the
 * per-target override is applied on each page through
 * {@link applyUserAgentToPage} after creation — the service calls both for
 * every launched page.
 */
export async function configureUserAgentTargets(
  browser: Browser,
  override: UserAgentOverride,
): Promise<CDPSession | null> {
  try {
    const session = await (browser as unknown as { newBrowserCDPSession: () => Promise<CDPSession> }).newBrowserCDPSession()
    await sendUserAgentOverride(session, override)
    return session
  } catch {
    return null
  }
}

/** Apply the UA override to one page (launched or attached). */
export async function applyUserAgentToPage(page: Page, override: UserAgentOverride): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page)
    await sendUserAgentOverride(session, override)
    await session.detach()
  } catch {
    // per-page override is best-effort; the browser-session override still applies
  }
}

/** Apply all stealth init scripts to a just-created page (before navigation). */
export async function preparePage(page: Page): Promise<void> {
  await installStealth(page)
}

/** Apply the spoofed UA override to a new browser connection (once per browser). */
export function applyUserAgentOverride(browser: Browser, override: UserAgentOverride): Promise<CDPSession | null> {
  return configureUserAgentTargets(browser, override)
}
