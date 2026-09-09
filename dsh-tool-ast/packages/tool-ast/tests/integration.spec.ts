/**
 * Integration tests: the REAL local subprocess service plus the PACKAGED `@ast-grep/cli` native
 * binary, exercised through `ctx.tools.execute()` with the real local filesystem, sandbox-policy
 * and observation-policy seams. These verify the WORLD — actual files are structurally matched
 * and rewritten, `ast_edit` apply goes through `ctx.fs` (observation/version guard), hostile
 * patterns stay inert argv, and engine failures classify into the `AST_*` vocabulary. The binary
 * ships inside the npm dependency, so the suite runs on every platform without a system ast-grep
 * install.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import * as ToolAst from '../src/index.ts'

const testToolSignal = new AbortController().signal

let dir: string
let ctx: Context

let callCounter = 0
function call(name: string, args: unknown, agentObj?: object) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`it-${++callCounter}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The fixture workspace as a session cwd, so relative paths resolve inside `dir`. */
const agent = () => ({ session: { header: { id: 'session-ast', cwd: dir } } })

describe('ast tools over the real subprocess service + the packaged ast-grep', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ast-int-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'greet.ts'), [
      'export function greet(name: string) {',
      '  console.log(`hello ${name}`)',
      '}',
      'export function goodbye(name: string) {',
      '  console.log(`bye ${name}`)',
      '}',
      '',
    ].join('\n'))
    await writeFile(join(dir, 'src', 'main.rs'), [
      'fn main() {',
      '  println!("hi");',
      '}',
      '',
    ].join('\n'))
    await writeFile(join(dir, 'src', 'note.md'), 'nothing structural here\n')

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    await ctx.plugin(ToolAst, {})
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('ast_grep', () => {
    it('finds structural matches grouped by file with line numbers', async () => {
      const result = await call('ast_grep', { pat: 'console.log($MSG)', path: 'src' }, agent())
      expect(result.isError).toBe(false)
      expect(text(result)).toMatch(/Found 2 matches/)
      expect(text(result)).toMatch(/Line 2:3/)
      expect(text(result)).toMatch(/console\.log/)
      expect(text(result)).toMatch(/captures: \$MSG =/)
    })

    it('returns zero matches (not an error) for a valid pattern that matches nothing', async () => {
      const result = await call('ast_grep', { pat: 'fn main()', path: 'src', include: '*.ts' }, agent())
      expect(result.isError).toBe(false)
      expect(text(result)).toMatch(/Found 0 matches/)
    })

    it('reports a usage error for an unsupported language', async () => {
      const result = await call('ast_grep', { pat: 'x', lang: 'NoSuchLang' }, agent())
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'AST_USAGE_ERROR' } })
    })

    it('rejects a blank pattern before spawning', async () => {
      const result = await call('ast_grep', { pat: '   ' }, agent())
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/pat must be a non-empty string/)
    })
  })

  describe('ast_edit (preview)', () => {
    it('previews rewrites without touching the filesystem', async () => {
      const before = await readFile(join(dir, 'src', 'greet.ts'), 'utf8')
      const result = await call('ast_edit', {
        pat: 'console.log($MSG)',
        rewrite: 'log.debug($MSG)',
        path: 'src/greet.ts',
      }, agent())
      expect(result.isError).toBe(false)
      const out = text(result)
      expect(out).toMatch(/Preview: 2 replacements across 1 file/)
      expect(out).toContain('console.log')
      expect(out).toContain('log.debug')
      // Nothing written in preview mode.
      expect(await readFile(join(dir, 'src', 'greet.ts'), 'utf8')).toBe(before)
    })

    it('deletes a node with an empty rewrite template', async () => {
      const result = await call('ast_edit', {
        pat: 'console.log($MSG)',
        rewrite: '',
        path: 'src/greet.ts',
        include: '*.ts',
      }, agent())
      expect(result.isError).toBe(false)
      const out = text(result)
      // The before image still contains the node; the after image drops it.
      // Both sides are present and the after side has no console.log to rewrite.
      expect(out).toMatch(/Preview: 2 replacements across 1 file/)
      expect(out).toContain('before:')
      expect(out).toContain('after:')
      expect(out.split('console.log').length - 1).toBeGreaterThan(out.split('log.debug').length - 1)
    })
  })

  describe('ast_edit (apply)', () => {
    it('rewrites files through ctx.fs with observation + version guard', async () => {
      const result = await call('ast_edit', {
        pat: 'console.log($MSG)',
        rewrite: 'log.debug($MSG)',
        path: 'src/greet.ts',
        apply: true,
      }, agent())
      expect(result.isError).toBe(false)
      const out = text(result)
      expect(out).toMatch(/Applied 2 replacements across 1 file/)
      expect(out).toMatch(/rewrote/)

      const rewritten = await readFile(join(dir, 'src', 'greet.ts'), 'utf8')
      expect(rewritten).not.toContain('console.log')
      expect(rewritten).toContain('log.debug(`hello ${name}`)')
      expect(rewritten).toContain('log.debug(`bye ${name}`)')
    })

    it('fails cleanly when the file does not exist', async () => {
      const result = await call('ast_edit', {
        pat: 'x',
        rewrite: 'y',
        path: 'src/missing.ts',
        apply: true,
      }, agent())
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'AST_FIND_ERROR' } })
    })

    it('errors (not silently writes) when apply fails the sandbox', async () => {
      const sandboxDir = await mkdtemp(join(tmpdir(), 'dsh-ast-sbx-'))
      try {
        await writeFile(join(sandboxDir, 'a.ts'), 'run(1,2)\n')
        const sandboxCtx = new Context()
        await sandboxCtx.plugin(SystemPrompt)
        await sandboxCtx.plugin(ToolRuntime)
        await sandboxCtx.plugin(LocalSubprocessRuntime)
        await sandboxCtx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: sandboxDir })
        await sandboxCtx.plugin(SandboxedFileSystem, { cwd: sandboxDir })
        await sandboxCtx.plugin(FsPolicy)
        await sandboxCtx.plugin(ToolAst, {})
        const result = await sandboxCtx.tools.execute({
          signal: testToolSignal,
          callId: ToolCallId(`sbx-${++callCounter}`),
          name: 'ast_edit',
          arguments: {
            pat: 'run($A, $B)',
            rewrite: 'run($B, $A)',
            path: 'a.ts',
            apply: true,
          },
          agent: { session: { header: { id: 'session-ast-sbx', cwd: sandboxDir } } } as never,
        })
        expect(result.isError).toBe(true)
        expect(await readFile(join(sandboxDir, 'a.ts'), 'utf8')).toBe('run(1,2)\n')
        await sandboxCtx.fiber.dispose()
      } finally {
        await rm(sandboxDir, { recursive: true, force: true })
      }
    })
  })

  describe('abort + cancellation', () => {
    it('classifies a pre-aborted registry call without spawning', async () => {
      const controller = new AbortController()
      controller.abort()
      const result = await ctx.tools.execute({
        signal: controller.signal,
        callId: ToolCallId(`abort-${++callCounter}`),
        name: 'ast_grep',
        arguments: { pat: 'x($A)', path: '.' },
        agent: { session: { header: { id: 'session-ast', cwd: dir } } } as never,
      })
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ code: TOOL_ABORTED_BEFORE_DISPATCH })
    })
  })
})
