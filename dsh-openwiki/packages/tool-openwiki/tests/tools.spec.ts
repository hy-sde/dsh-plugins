/**
 * `@hy-sde-org/dsh-tool-openwiki` tests: the five lifecycle tool schemas
 * register under exactly their OpenWiki 0.4 names, the shared single-run
 * adapter is created on mount, and the prompt section builds the protocol
 * contract card. No filesystem is touched.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { applyOpenWikiTools } from '../src/tools.ts'
import { buildOpenWikiPromptSection } from '../src/prompt.ts'

const FIVE_NAMES = [
  'openwiki_begin',
  'openwiki_submit_plan',
  'openwiki_next_page',
  'openwiki_submit_page',
  'openwiki_finish',
] as const

describe('openwiki tool surface', () => {
  it('registers exactly the five OpenWiki lifecycle tools on mount', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    applyOpenWikiTools(ctx, { host: 'test', producerActor: 'test' })

    const visible = ctx.tools.schemas()
    const names = visible.map(t => t.name)
    for (const expected of FIVE_NAMES) {
      expect(names).toContain(expected)
    }
    expect(names).toHaveLength(5)
    await ctx.fiber.dispose()
  })

  it('gives each lifecycle tool a grounded description + parameter schema', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    applyOpenWikiTools(ctx, {})

    const visible = ctx.tools.schemas()
    const byName = Object.fromEntries(visible.map(t => [t.name, t]))
    for (const name of FIVE_NAMES) {
      const tool = byName[name]
      expect(tool).toBeDefined()
      expect(tool!.description.length).toBeGreaterThan(40)
      expect(typeof tool!.parameters).toBe('object')
    }

    const begin = byName['openwiki_begin']!
    expect(begin.parameters.properties).toMatchObject({ root: { type: 'string' }, mode: { type: 'string' } })
    const plan = byName['openwiki_submit_plan']!
    expect(plan.parameters.properties).toMatchObject({ runId: {}, pages: {} })
    const page = byName['openwiki_submit_page']!
    expect(page.parameters.properties).toMatchObject({ runId: {}, jobId: {}, claims: {} })
    const next = byName['openwiki_next_page']!
    expect(next.parameters.properties).toMatchObject({ runId: {} })
    const finish = byName['openwiki_finish']!
    expect(finish.parameters.properties).toMatchObject({ runId: {} })

    await ctx.fiber.dispose()
  })
})

describe('openwiki prompt section', () => {
  it('builds a non-empty protocol card named openwiki:tools', () => {
    const section = buildOpenWikiPromptSection()
    expect(section.name).toBe('openwiki:tools')
    expect(typeof section.order).toBe('number')
    expect(section.text.length).toBeGreaterThan(100)
    expect(section.text).toContain('openwiki_begin')
    expect(section.text).toContain('openwiki_submit_plan')
    expect(section.text).toContain('codebase-memory')
  })

  it('can be disabled', () => {
    const section = buildOpenWikiPromptSection({ enabled: false })
    expect(section.text).toBe('')
  })
})

describe('openwiki tools over a real scratch repository (registry-integration)', () => {
  const gitAvailable = (() => {
    try { spawnSync('git', ['--version'], { timeout: 5000, stdio: 'ignore' }); return true } catch { return false }
  })()

  const runIt = gitAvailable ? it : it.skip

  /** Runs the whole cycle begin→plan→next→submit→finish through ctx.tools.execute. */
  runIt('completes a durable wiki run with schema-valid tool outputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-openwiki-'))
    const genv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), HOME: dir }
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { env: genv })
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@e.com'], { env: genv })
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T'], { env: genv })
    await writeFile(join(dir, 'README.md'), '# Fixture\n\nBody.\n')
    execFileSync('git', ['-C', dir, 'add', '.'], { env: genv })
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init'], { env: genv })

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    applyOpenWikiTools(ctx, { host: 'test', producerActor: 'test' })
    const signal = new AbortController().signal

    try {
      // begin → active planning run
      const begun = await runTool(ctx, signal, 'openwiki_begin', { root: dir, mode: 'init' })
      expect(begun).toMatchObject({ status: 'active', mode: 'init', phase: 'planning' })
      expect(typeof begun.runId).toBe('string')
      const runId = begun.runId

      // submit plan → accepted, 2 jobs (quickstart required by init)
      const planned = await runTool(ctx, signal, 'openwiki_submit_plan', {
        runId,
        pages: [
          { path: '/openwiki/quickstart.md', title: 'Quickstart', purpose: 'Entry point.' },
          { path: '/openwiki/architecture.md', title: 'Architecture', purpose: 'Document the fixture.', seedPaths: ['README.md'] },
        ],
      })
      expect(planned).toMatchObject({ status: 'accepted', totalPages: 2 })

      // next/sumbit both pages (quickstart is deliberately generated last)
      for (const expected of ['/openwiki/architecture.md', '/openwiki/quickstart.md']) {
        const next = await runTool(ctx, signal, 'openwiki_next_page', { runId })
        expect(next).toMatchObject({ status: 'pending' })
        expect(next.job).toMatchObject({ path: expected })
        const job = next.job as { id: string }
        await writeFile(join(dir, 'openwiki', expected.replace('/openwiki/', '')),
          `---\ntitle: ${expected.split('/').pop()}\ntype: Reference\ntags:\n  - topic\n---\n\n# ${expected.split('/').pop()}\n\nPage body.\n`)
        const submitted = await runTool(ctx, signal, 'openwiki_submit_page', {
          runId,
          jobId: job.id,
          claims: [{ statement: 'The fixture has a README.', evidence: [{ resource: 'repo://README.md#L1-L3' }] }],
        })
        expect(submitted).toMatchObject({ status: 'complete', page: expected })
      }

      // next_page for a completed run says complete
      const exhausted = await runTool(ctx, signal, 'openwiki_next_page', { runId })
      expect(exhausted.status).toBe('complete')

      // finish → run state removed, metadata + manifest persisted
      const finished = await runTool(ctx, signal, 'openwiki_finish', { runId })
      expect(finished).toMatchObject({ status: 'complete' })
      const exists = async (p: string) => { try { await access(join(dir, p)); return true } catch { return false } }
      expect(await exists('openwiki/.run.json')).toBe(false)
      expect(await exists('openwiki/.last-update.json')).toBe(true)
      expect(await exists('openwiki/.page-manifest.json')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/** This suite executes tools, so it needs child_process + fs accessors. */
import { execFileSync, spawnSync } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Context as CordisContext } from '@deepseek-ai/cordis'

type ToolOutcome = { status: string } & Record<string, unknown>

/** One registry dispatch returning the parsed tool output value. */
async function runTool(ctx: CordisContext, signal: AbortSignal, name: string, args: unknown): Promise<ToolOutcome> {
  const result = await ctx.tools.execute({ signal, callId: ToolCallId(`it-${Math.random()}`), name, arguments: args })
  if (result.error) throw new Error(`tool ${name} failed: ${result.error.message}`)
  const text = result.content.filter(b => b.type === 'text').map(b => 'text' in b ? b.text : '').join('')
  return JSON.parse(text) as { status: string; [k: string]: unknown }
}
