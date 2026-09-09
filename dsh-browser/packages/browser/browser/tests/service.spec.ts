/**
 * Real-browser integration for `ctx.browser`: launches the system Chrome
 * headless through the stealth backend, then exercises open / run / observe /
 * click / screenshot / close. Skipped cleanly when no Chrome executable is
 * available (CI without browsers).
 */

import { existsSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BrowserService, type BrowserKind } from '../src/service.ts'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
const CHROME = CHROME_CANDIDATES.find(existsSync)
const LIVE = CHROME !== undefined

const DATA_URL = `data:text/html,${encodeURIComponent('<h1 role="heading">Hello Browser</h1><a href="#x" role="link">Go</a><input aria-label="Name">')}`

let ctx: Context
let service: BrowserService
let dir: string
const skip = LIVE ? describe : describe.skip

beforeAll(async () => {
  ctx = new Context()
  service = new BrowserService(ctx, CHROME !== undefined ? { browserPath: CHROME, headless: true } : { headless: true })
  dir = await mkdtemp(join(tmpdir(), 'dsh-browser-'))
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  service.stop()
  await ctx.fiber.dispose()
})

const launchKind = (CHROME !== undefined ? { kind: 'launch', path: CHROME } : { kind: 'launch' }) as BrowserKind

skip('ctx.browser over a real Chrome', { timeout: 20000 }, () => {
  it('opens a url and returns an observation with title/url/aria', async () => {
    const observation = await service.open('main', DATA_URL, { kind: launchKind, cwd: dir })
    expect(observation.url).toContain('data:text/html')
    expect(observation.aria).toContain('Hello Browser')
    expect(observation.aria).toContain('[ref=')
    expect(observation.width).toBeGreaterThan(0)
  })

  it('runs JS in the tab and returns the serialized value', async () => {
    const result = await service.run('main', '1 + 41', { kind: launchKind, cwd: dir })
    expect(result).toBe(42)
    const dom = await service.run('main', 'document.querySelector("a").textContent', { kind: launchKind, cwd: dir })
    expect(dom).toBe('Go')
  })

  it('clicks a CSS selector and re-observes', async () => {
    const before = await service.observe('main', { kind: launchKind, cwd: dir })
    expect(before.aria).toContain('Go')
    const after = await service.click('main', 'a[href="#x"]', { kind: launchKind, cwd: dir })
    // fragment navigation on data: URLs stays put; verify the click was applied
    expect(after.aria).toContain('Hello Browser')
  })

  it('screenshots to a PNG file', async () => {
    const target = join(dir, 'shot.png')
    const result = await service.screenshot('main', target, { kind: launchKind, cwd: dir })
    expect(result.path).toBe(target)
    const bytes = await readFile(target)
    // PNG magic
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('types into an input via locator and closes tabs', async () => {
    await service.open('second', DATA_URL, { kind: launchKind, cwd: dir })
    await service.type('second', 'input[aria-label="Name"]', 'Ada', { kind: launchKind, cwd: dir })
    const value = await service.run('second', 'document.querySelector("input").value', { kind: launchKind, cwd: dir })
    expect(value).toBe('Ada')
    await service.close('second', { kind: launchKind, cwd: dir })
    await expect(service.observe('second', { kind: launchKind, cwd: dir })).resolves.toBeDefined()
  })

  it('kills spawned browsers on close kill=true', async () => {
    await service.open('tmp', DATA_URL, { kind: launchKind, cwd: dir })
    const countBefore = service.browserCount
    await service.close('tmp', { kind: launchKind, cwd: dir, kill: true })
    expect(service.browserCount).toBeLessThan(countBefore)
  })
})

describe('kind + wait resolution (pure)', () => {
  it('resolves attach before launch from cdp_url', () => {
    const kind = service.resolveKind({ cdpUrl: 'http://127.0.0.1:9222/' })
    expect(kind).toEqual({ kind: 'attach', cdpUrl: 'http://127.0.0.1:9222' })
  })

  it('resolves launch from an explicit path', () => {
    const kind = service.resolveKind({ path: '/opt/chrome' })
    expect(kind).toEqual({ kind: 'launch', path: '/opt/chrome' })
  })

  it('resolves launch when nothing is given', () => {
    const kind = service.resolveKind({})
    expect(kind.kind).toBe('launch')
  })
})
