/**
 * End-to-end tool routing: with `ctx.internalUrls` mounted, the read tool
 * surfaces conflict:// blocks (notice + ids), the conflict:// URL reads and
 * `:conflicts` summaries resolve virtually, and write dispatches resolution
 * through the handler — all against a fake FileSystem provider.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as InternalUrls from '@hy-sde-org/dsh-internal-urls'
import * as ToolFs from '@hy-sde-org/dsh-tool-fs-internal-urls'
import { isAbsolute, join } from 'node:path'

const testToolSignal = new AbortController().signal

const CWD = '/ws'

/** An in-memory fake provider; target identity is the canonical absolute path
 * (coherent across the tool's `processPath` and the conflict bridge's `resolve`). */
class FakeFs extends FileSystem {
  files = new Map<string, string>()

  canonical(path: string): string {
    return isAbsolute(path) ? path : join(CWD, path)
  }

  override async resolve(path: string): Promise<FsTarget> {
    const abs = this.canonical(path)
    return { targetKey: FsTargetKey(`abs:${abs}`), displayPath: abs }
  }
  override processPath(target: FsTarget): string {
    return String(target.targetKey).startsWith('abs:') ? String(target.targetKey).slice(4) : String(target.targetKey)
  }
  override fileUrl(target: FsTarget): string { return `file://${target.targetKey}` }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    return String(child.targetKey).startsWith(String(parent.targetKey))
  }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const content = this.files.get(String(target.targetKey))
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async lstat(path: string): Promise<FsPathInfo | undefined> {
    const content = this.files.get(`abs:${this.canonical(path)}`)
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async readText(target: FsTarget): Promise<string> {
    return this.files.get(String(target.targetKey)) ?? ''
  }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const content = this.files.get(String(target.targetKey)) ?? ''
    return (async function* () { yield content })()
  }
  override async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(this.files.get(String(target.targetKey)) ?? '')
    if (bytes.length > maxBytes) throw new FsError(`too large: ${target.displayPath}`, 'FS_TOO_LARGE')
    return bytes
  }
  override async listDir(_target: FsTarget): Promise<FsDirEntry[]> {
    return []
  }
  override async writeText(target: FsTarget, content: string, _expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    const before = this.files.get(String(target.targetKey)) ?? null
    this.files.set(String(target.targetKey), content)
    return { operation: before !== null ? 'update' : 'create', version: FsVersion('v2'), before, after: content }
  }
  override async editText(target: FsTarget, edit: FsEditRequest, _expected?: { version: FsVersion }): Promise<FsEditOutcome> {
    const content = this.files.get(String(target.targetKey)) ?? ''
    const after = content.split(edit.oldString).join(edit.newString)
    this.files.set(String(target.targetKey), after)
    return { version: FsVersion('v3'), before: content, after }
  }
}

// Markers are built at runtime so no source line begins `<<<<<<<`/`=======`
// (git's `diff --check` treats column-0 markers as leftover merge conflicts);
// the fixture text itself is byte-identical to a real conflict block.
const OURS_OPEN = '<'.repeat(7) + ' HEAD'
const THEIRS_CLOSE = '>'.repeat(7) + ' feature/x'
const SEP = '='.repeat(7)

const CONFLICTS = `function f():
${OURS_OPEN}
    return 1
${SEP}
    return 2
${THEIRS_CLOSE}
    pass`

async function setup(files: Record<string, string>) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeFs) // Service class: self-registers as ctx.fs
  const fs = ctx.fs as FakeFs
  for (const [name, content] of Object.entries(files)) {
    fs.files.set(`abs:${fs.canonical(name)}`, content)
  }
  await ctx.plugin(InternalUrls)
  await ctx.plugin(ToolFs)
  return { ctx, fs }
}

let callCounter = 0
const agent = { session: { header: { id: 's1', cwd: CWD } } }

async function call(ctx: Context, name: string, args: unknown) {
  const result = await ctx.tools.execute({
    signal: testToolSignal,
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

describe('read/grep/write scheme routing', () => {
  it('does not route or scan when the registry is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeFs)
    await ctx.plugin(ToolFs)
    const fs = ctx.fs as FakeFs
    fs.files.set('abs:/ws/a.ts', CONFLICTS)
    const result = await call(ctx, 'read', { file_path: 'a.ts' })
    expect((result.value as { notice?: string }).notice).toBeUndefined()
  })

  it('a normal read registers conflict blocks and appends the resolution notice', async () => {
    const { ctx, fs } = await setup({ 'a.ts': CONFLICTS })
    const result = await call(ctx, 'read', { file_path: 'a.ts' })
    const value = result.value as { path: string; lines: { text: string }[]; notice?: string; totalLines: number }
    expect(value.path).toBe('/ws/a.ts')
    expect(value.totalLines).toBe(7)
    expect(value.notice).toBeTruthy()
    expect(value.notice).toContain('⚠ 1 unresolved conflict detected')
    expect(value.notice).toContain('`conflict://<N>`')
    expect(value.notice).toContain('@theirs')
    expect(text(result)).toContain('⚠ 1 unresolved conflict')
    // The file on disk is untouched by the read.
    expect(fs.files.get('abs:/ws/a.ts')).toBe(CONFLICTS)
  })

  it('reads a registered conflict region through conflict://N', async () => {
    const { ctx } = await setup({ 'a.ts': CONFLICTS })
    await call(ctx, 'read', { file_path: 'a.ts' }) // registers #1
    const result = await call(ctx, 'read', { file_path: 'conflict://1' })
    const value = result.value as { path: string; lines: { text: string }[]; totalLines: number }
    const joined = value.lines.map(l => l.text).join('\n')
    expect(value.path).toBe('conflict://1')
    expect(joined).toContain('<<<<<<< HEAD')
    expect(joined).toContain('return 1')
    expect(joined).toContain('return 2')
    expect(joined).toContain('>>>>>>> feature/x')
  })

  it('reads single sides through conflict://N/ours and :theirs', async () => {
    const { ctx } = await setup({ 'a.ts': CONFLICTS })
    await call(ctx, 'read', { file_path: 'a.ts' })
    const ours = await call(ctx, 'read', { file_path: 'conflict://1/ours' })
    expect((ours.value as { lines: { text: string }[] }).lines.map(l => l.text)).toEqual(['    return 1'])
    const theirs = await call(ctx, 'read', { file_path: 'conflict://1/theirs' })
    expect((theirs.value as { lines: { text: string }[] }).lines.map(l => l.text)).toEqual(['    return 2'])
  })

  it('reads the :conflicts whole-file summary selector', async () => {
    const { ctx } = await setup({ 'a.ts': CONFLICTS })
    const result = await call(ctx, 'read', { file_path: 'a.ts:conflicts' })
    const value = result.value as { path: string; lines: { text: string }[] }
    expect(value.path).toBe('a.ts:conflicts')
    const joined = value.lines.map(l => l.text).join('\n')
    expect(joined).toContain('1 unresolved conflict')
    expect(joined).toContain('#1')
    // The summary read itself registers the block (ids usable afterward).
    const region = await call(ctx, 'read', { file_path: 'conflict://1' })
    expect((region.value as { lines: { text: string }[] }).lines.length).toBeGreaterThan(0)
  })

  it('writes a conflict://N resolution, splicing and invalidating', async () => {
    const { ctx, fs } = await setup({ 'a.ts': CONFLICTS })
    await call(ctx, 'read', { file_path: 'a.ts' })
    const result = await call(ctx, 'write', { file_path: 'conflict://1', content: '@theirs' })
    expect((result.value as { operation: string }).operation).toBe('update')
    const now = fs.files.get('abs:/ws/a.ts') ?? ''
    expect(now).toContain('    return 2')
    expect(now).not.toContain('<<<<<<<')
    // Id is invalidated: reading it now explains it is gone.
    const reread = await call(ctx, 'read', { file_path: 'conflict://1' })
    expect(reread.isError).toBe(true)
    expect(text(reread)).toMatch(/not registered/)
  })

  it('writes @ours and verifies the other side survived', async () => {
    const { ctx, fs } = await setup({ 'a.ts': CONFLICTS })
    await call(ctx, 'read', { file_path: 'a.ts:conflicts' })
    await call(ctx, 'write', { file_path: 'conflict://1', content: '@ours' })
    const now = fs.files.get('abs:/ws/a.ts') ?? ''
    expect(now).toContain('    return 1')
    expect(now).not.toContain('return 2')
    expect(now).not.toContain('<<<<<<<')
  })

  it('bulk-resolves every registered conflict via conflict://*', async () => {
    const two = `${OURS_OPEN}
a
${SEP}
b
${'>>>>>>>' + ' x'}
`
    const { ctx, fs } = await setup({ 'm.ts': two + two })
    await call(ctx, 'read', { file_path: 'm.ts:conflicts' })
    await call(ctx, 'write', { file_path: 'conflict://*', content: '@ours' })
    const now = fs.files.get('abs:/ws/m.ts') ?? ''
    expect(now).not.toContain('<<<<<<<')
    expect(now).not.toContain('=======')
  })

  it('never routes an unregistered scheme — read falls through to fs', async () => {
    const { ctx } = await setup({ 'a.ts': 'plain' })
    const result = await call(ctx, 'read', { file_path: 'folio://9' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/not found|no such/i)
  })

  it('registers and exposes the service with the shipped schemes', async () => {
    const { ctx } = await setup({})
    const schemes = ctx.internalUrls.schemes()
    expect(schemes).toContain('conflict')
    expect(schemes).toContain('issue')
    expect(schemes).toContain('pr')
    expect(ctx.internalUrls.canHandle('conflict://1')).toBe(true)
    expect(ctx.internalUrls.canHandle('a.ts')).toBe(false)
  })
})
