/**
 * The `browser` tool: pure-helper coverage (cwd resolution, ARIA trimming,
 * result stringification) plus an end-to-end execute against the real browser
 * service mounted with the machine's Chrome (skips cleanly when no Chrome is
 * available). Exercises tool schema registration and the full
 * open/state/close driver without a live model.
 */

import { existsSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import Browser from '@hy-sde-org/dsh-browser'
import toolBrowserPackage from '@hy-sde-org/dsh-tool-browser'
import { resolveCwd, trimAria, stringifyResult } from '../src/browser.ts'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
const CHROME = CHROME_CANDIDATES.find(existsSync)
const LIVE = CHROME !== undefined

let dir: string
let ctx: Context
let counter = 0

const agent = { session: { header: { id: 'b1', cwd: '' } } } as never

async function call(args: unknown): Promise<{ value: unknown }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`br-${++counter}`),
    name: 'browser',
    arguments: args,
    agent,
  })
  if (result.isError) {
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    throw new Error(text || 'tool failed')
  }
  return result
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-browser-'))
  ;(agent as { session: { header: { cwd: string } } }).session.header.cwd = dir
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Browser, CHROME !== undefined ? { browserPath: CHROME, headless: true } : { headless: true })
  await ctx.plugin(toolBrowserPackage)
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await ctx.fiber.dispose()
})

describe('pure helpers', () => {
  it('resolves the cwd from the session header', () => {
    expect(resolveCwd({ agent } as never, undefined, undefined)).toBe(dir)
  })

  it('trims the aria snapshot to the budget', () => {
    expect(trimAria('abc', 10)).toBe('abc')
    expect(trimAria('abc', 2)).toContain('…')
  })

  it('stringifies tool results', () => {
    expect(stringifyResult(42)).toBe('42')
    expect(stringifyResult('x')).toBe('x')
    expect(stringifyResult({ a: 1 })).toContain('"a"')
    expect(stringifyResult(undefined)).toBe('undefined')
  })
})

describe('browser tool registration', () => {
  it('registers the browser tool with the expected name', () => {
    expect(ctx.tools.get('browser')).toBeDefined()
  })
})

const skip = LIVE ? describe : describe.skip
skip('browser tool end-to-end over real Chrome', () => {
  it('opens a page and returns an observation with a ref tree', async () => {
    const { value } = await call({
      action: 'open',
      url: `data:text/html,${encodeURIComponent('<a role="link" href="#x">hello tool</a>')}`,
      app: { path: CHROME },
    })
    const v = value as { observation?: { url: string; aria: string; title: string }; screenshots?: string[]; result?: string }
    expect(v.observation?.url).toContain('data:text/html')
    expect(v.observation?.aria).toContain('[ref=')
    expect(v.screenshots).toBeUndefined()
  })

  it('runs code and observes afterwards', async () => {
    const { value } = await call({ action: 'run', code: 'document.title = "ran"; 2 + 2' })
    const v = value as { result?: string; observation?: { title: string } }
    expect(v.result).toBe('4')
    expect(v.observation?.title).toBe('ran')
  })

  it('writes a screenshot and returns its path', async () => {
    const { value } = await call({
      action: 'open',
      url: `data:text/html,${encodeURIComponent('<h1>shot</h1>')}`,
      app: { path: CHROME },
      screenshot: true,
    })
    const v = value as { screenshots?: string[] }
    expect(v.screenshots?.length).toBe(1)
    expect(v.screenshots?.[0]).toMatch(/\.png$/)
  })

  it('closes tabs with close action', async () => {
    const { value } = await call({ action: 'close', name: 'main', app: { path: CHROME }, all: true })
    expect((value as { result?: string }).result).toBe('closed')
  })

  it('returns a friendly error for a missing url on open', async () => {
    const { value } = await call({ action: 'open' })
    expect((value as { result?: string }).result).toContain('error')
  })
})
