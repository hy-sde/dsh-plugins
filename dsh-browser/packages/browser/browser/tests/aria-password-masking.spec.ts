/**
 * Security regression for the bundled ARIA-snapshot sources: password values
 * must never leak into snapshots (they are replaced by `•` runs page-side) and
 * a page whose password `value` getter throws must not fail the snapshot.
 * Ported from oh-my-pi 59fcea29c1..77cca7b7a0. Runs a real headless Chrome via
 * the same playwright-core path the browser service uses; skipped when no
 * Chrome executable is available (like service.spec.ts).
 */

import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { captureAriaSnapshot } from '../src/aria.ts'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
const CHROME = CHROME_CANDIDATES.find(existsSync)

const SECRET = 'hunter2supersecret'
const LOGIN_PAGE = `data:text/html,${encodeURIComponent(
  '<form>'
  + '<label>User <input id="user" autocomplete="username"></label>'
  + '<label>Password <input id="pw" type="password" autocomplete="current-password"></label>'
  + '</form>',
)}`

describe.skipIf(CHROME === undefined)('ARIA snapshot password masking', { timeout: 20_000 }, () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ ...(CHROME !== undefined && { executablePath: CHROME }), headless: true })
    page = await browser.newPage()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('masks password values as bullet runs in document snapshots', async () => {
    await page.goto(LOGIN_PAGE)
    await page.fill('#user', 'dana@example.test')
    await page.fill('#pw', SECRET)

    const snapshot = await captureAriaSnapshot(page, null)

    expect(snapshot).toContain('dana@example.test') // non-password values stay
    expect(snapshot).not.toContain(SECRET)
    expect(snapshot).toContain('•'.repeat(SECRET.length))
    // The page keeps its real value once the snapshot is done.
    expect(await page.inputValue('#pw')).toBe(SECRET)
    expect(await page.inputValue('#user')).toBe('dana@example.test')
  })

  it('still produces a snapshot when a password value getter throws', async () => {
    await page.goto(`data:text/html,${encodeURIComponent('<form><input id="boom" type="password"></form>')}`)
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#boom')
      if (input === null) { throw new Error('missing #boom') }
      Object.defineProperty(input, 'value', {
        configurable: true,
        get() { throw new Error('no value') },
      })
    })

    const snapshot = await captureAriaSnapshot(page, null)

    expect(snapshot).toContain('textbox')
  })
})
