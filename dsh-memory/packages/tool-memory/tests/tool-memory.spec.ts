/**
 * The five memory tools over a live Cordis context: retain/recall/reflect/
 * memory_edit/learn execute against the local backend mounted with `ctx.memory`,
 * and the `memory:project` system-prompt section reloads stored memory.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Memory from '@hy-sde-org/dsh-memory'
import * as ToolMemory from '@hy-sde-org/dsh-tool-memory'
import { SUMMARY_FILE } from '@hy-sde-org/dsh-memory'

const CWD = '/ws/memory'

async function mount(config?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Memory, { root })
  // The prompt section reads the same root as the service (both default to the
  // same path in production; tests pin it explicitly so they agree).
  await ctx.plugin(ToolMemory, { root, ...config ?? {} })
  return { ctx, root }
}

const agent = { session: { header: { id: 's1', cwd: CWD } } }

let callCounter = 0
async function call(ctx: Context, name: string, args: unknown) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: agent as never,
  })
  return result
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

async function sectionText(ctx: Context): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent: agent as never })
  return assembly.sections.find(s => s.name === 'memory:project')?.text ?? ''
}

describe('memory tools', () => {
  it('retain stores memories and recall finds them with ids for memory_edit', async () => {
    const { ctx } = await mount()
    await call(ctx, 'retain', {
      items: [{ content: 'user prefers vitest for unit tests', context: 'project setup' }],
    })
    const recalled = await call(ctx, 'recall', { query: 'preferred test runner' })
    const recalledText = text(recalled)
    expect(recalledText).toContain('Found 1 relevant memory')
    expect(recalledText).toContain('vitest')
    expect(recalledText).toMatch(/\[1\] m_/)

    const id = (recalled.value as { items: { id?: string }[] }).items[0]?.id ?? ''
    const edited = await call(ctx, 'memory_edit', { op: 'update', id, content: 'user prefers vitest and pytest' })
    expect(text(edited)).toContain(`${id} updated`)
    const re = await call(ctx, 'recall', { query: 'preferred test runner' })
    expect(text(re)).toContain('pytest')
  })

  it('reflect synthesizes an answer across stored memories', async () => {
    const { ctx } = await mount()
    await call(ctx, 'retain', { items: [{ content: 'the deploy pipeline runs on GitHub Actions' }] })
    await call(ctx, 'retain', { items: [{ content: 'staging deploys after every merge to main' }] })
    const reflected = await call(ctx, 'reflect', { query: 'How does deployment work?' })
    const reflectedText = text(reflected)
    expect(reflectedText).toContain('Based on')
    expect(reflectedText).toContain('GitHub Actions')
    expect(reflectedText).toContain('staging')
  })

  it('memory_edit forget removes an entry; missing id reports not found', async () => {
    const { ctx } = await mount()
    await call(ctx, 'retain', { items: [{ content: 'ephemeral note' }] })
    const recalled = await call(ctx, 'recall', { query: 'ephemeral note' })
    const id = (recalled.value as { items: { id?: string }[] }).items[0]?.id ?? ''
    expect(text(await call(ctx, 'memory_edit', { op: 'forget', id }))).toContain('forgotten')
    expect(text(await call(ctx, 'recall', { query: 'ephemeral note' }))).toContain('No relevant memories found')
    expect(text(await call(ctx, 'memory_edit', { op: 'forget', id }))).toContain('was not found')
  })

  it('memory_edit rejects read-only lesson ids', async () => {
    const { ctx } = await mount()
    await call(ctx, 'learn', { memory: 'run db migrations before the server starts' })
    const recalled = await call(ctx, 'recall', { query: 'db migrations' })
    const items = (recalled.value as { items: { id?: string; readonly?: boolean }[] }).items
    const lesson = items.find(item => item.readonly)
    expect(lesson).toBeDefined()
    const edited = await call(ctx, 'memory_edit', { op: 'update', id: lesson?.id ?? '', content: 'changed' })
    expect(text(edited)).toContain('read-only fact')
  })

  it('learn appends a lesson that recall surfaces', async () => {
    const { ctx } = await mount()
    await call(ctx, 'learn', { memory: 'always shell into `main` before cutting a release', context: 'release checklist' })
    const status = await ctx.memory.status({ cwd: CWD })
    expect(status.lessonCount).toBe(1)
    const found = await call(ctx, 'recall', { query: 'release cutting' })
    expect(text(found)).toContain('shell into')
  })

  it('the memory:project prompt section injects the stored block per session', async () => {
    const { ctx } = await mount()
    // Seed memory at the service level (like a prior session would have).
    await ctx.memory.save({ cwd: CWD }, { content: 'team uses trunk-based development' })
    await ctx.memory.learn({ cwd: CWD }, { content: 'never edit the lockfile by hand' })

    const sectionTextValue = await sectionText(ctx)
    expect(sectionTextValue).toContain('# Project memory')
    expect(sectionTextValue).toContain('trunk-based development')
    expect(sectionTextValue).toContain('lockfile')
  })

  it('mine_sessions degrades to an unavailable notice without the host service', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, 'mine_sessions', {})
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('unavailable')
    expect(text(result)).toContain('sessionQuery')
  })

  it('recall still works with session-history enabled but no host service', async () => {
    const { ctx } = await mount({ sessionRecall: true })
    await call(ctx, 'retain', { items: [{ content: 'session-scoped note survives without sessionQuery' }] })
    const recalled = await call(ctx, 'recall', { query: 'session-scoped note' })
    expect(text(recalled)).toContain('Found 1 relevant memory')
    expect(text(recalled)).not.toContain('session ')
  })

  it('the prompt section stays empty for a fresh project and when disabled', async () => {
    const { ctx } = await mount({ enabled: false })
    await ctx.memory.save({ cwd: CWD }, { content: 'hidden fact' })
    expect(await sectionText(ctx)).toBe('')
  })

  it('out-of-band memory_summary.md is injected on the next assembly', async () => {
    const { ctx } = await mount()
    // Locate the project root via the service status and write a summary into it.
    const status = await ctx.memory.status({ cwd: CWD })
    const scope = status.scope ?? ''
    await mkdir(scope, { recursive: true })
    await writeFile(join(scope, SUMMARY_FILE), '# Summary\n\n- deploy every Friday')
    const sectionTextValue = await sectionText(ctx)
    expect(sectionTextValue).toContain('deploy every Friday')
  })
})
