/**
 * End-to-end tool tests for `worktree` over a real temp git repository: the
 * five actions (acquire/release/list/prune/destroy) through ctx.tools, lease
 * exclusivity and conditional release, dirty/leased/unmerged guards surfacing
 * as typed `[CODE]` tool errors, dry-run semantics, and the configurable pool
 * root (tests ALWAYS point the pool at a mkdtemp dir — never ~/.treehouse).
 */

import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Git from '@hy-sde-org/dsh-git'
import toolGitPackage from '@hy-sde-org/dsh-tool-git'

let dir: string
let pool: string
let ctx: Context
let counter = 0

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

async function writeRelative(base: string, path: string, content: string): Promise<void> {
  const target = join(base, path)
  await writeFile(target, content)
}

const agent = { session: { header: { id: 's1', cwd: '' } } } as never

async function call(args: unknown): Promise<{ value: unknown }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++counter}`),
    name: 'worktree',
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
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-wt-'))
  pool = await mkdtemp(join(tmpdir(), 'dsh-tool-wt-pool-'))
  runGit(['init', '-q', '-b', 'master'])
  runGit(['config', 'user.email', 'test@example.com'])
  runGit(['config', 'user.name', 'Test User'])
  runGit(['config', 'commit.gpgsign', 'false'])
  await writeFile(join(dir, 'seed.txt'), 'seed\n')
  runGit(['add', '.'])
  runGit(['commit', '-qm', 'init'])
  ;(agent as { session: { header: { cwd: string } } }).session.header.cwd = dir
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Git)
  await ctx.plugin(toolGitPackage, { worktreeRoot: pool })
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(pool, { recursive: true, force: true })
  await ctx.fiber.dispose()
})

async function dirty(repo: string, file: string): Promise<void> {
  await writeRelative(repo, file, 'wip\n')
}

describe('worktree acquire + release + list', () => {
  it('acquires a lease under the configured pool root and lists it as leased', async () => {
    const result = await call({ action: 'acquire' })
    const value = result.value as { lease: { path: string; leaseId: string; baseBranch: string } }
    try {
      expect(value.lease.path.startsWith(pool)).toBe(true)
      expect(value.lease.leaseId).toMatch(/^[0-9a-f]{32}$/)
      expect(value.lease.baseBranch).toBe('master')
      const listed = await call({ action: 'list' })
      const value2 = listed.value as { worktrees: Array<{ status: string; leased: boolean; path: string }> }
      expect(value2.worktrees).toHaveLength(1)
      expect(value2.worktrees[0]).toMatchObject({ status: 'leased', leased: true, path: value.lease.path })
    } finally {
      await call({ action: 'release', path: value.lease.path, leaseId: value.lease.leaseId })
    }
  })

  it('cuts a named-branch HEAD with branch (D1)', async () => {
    const result = await call({ action: 'acquire', branch: 'feat/tool' })
    const value = result.value as { lease: { path: string; leaseId: string; branch?: string } }
    try {
      expect(value.lease.branch).toBe('feat/tool')
      expect(runGitIn(value.lease.path, ['branch', '--show-current']).trim()).toBe('feat/tool')
    } finally {
      await call({ action: 'release', path: value.lease.path, leaseId: value.lease.leaseId })
    }
  })

  it('requires the matching lease id on release', async () => {
    const result = await call({ action: 'acquire' })
    const value = result.value as { lease: { path: string; leaseId: string } }
    try {
      await expect(call({ action: 'release', path: value.lease.path, leaseId: 'f'.repeat(32) }))
        .rejects.toThrow(/LeaseMismatch/)
      const listed = await call({ action: 'list' })
      const worktrees = (listed.value as { worktrees: Array<{ leased: boolean }> }).worktrees
      expect(worktrees.find(item => item.leased)).toBeDefined()
    } finally {
      await call({ action: 'release', path: value.lease.path, leaseId: value.lease.leaseId })
    }
  })

  it('refuses a dirty slot unless force, and force cleans it', async () => {
    const result = await call({ action: 'acquire' })
    const value = result.value as { lease: { path: string; leaseId: string } }
    await dirty(value.lease.path, 'wip.txt')
    let cleanedUp = false
    try {
      await expect(call({ action: 'release', path: value.lease.path, leaseId: value.lease.leaseId }))
        .rejects.toThrow(/DirtyWorktree/)
      const released = await call({ action: 'release', path: value.lease.path, leaseId: value.lease.leaseId, force: true })
      cleanedUp = true
      expect((released.value as { released: { released: boolean } }).released.released).toBe(true)
      await expect(readFile(join(value.lease.path, 'wip.txt'), 'utf8')).rejects.toThrow()
    } finally {
      if (!cleanedUp) await call({ action: 'release', path: value.lease.path, leaseId: value.lease.leaseId, force: true })
    }
  })

  it('validates required fields at runtime', async () => {
    await expect(call({ action: 'release' })).rejects.toThrow(/requires path and leaseId/)
    await expect(call({ action: 'destroy' })).rejects.toThrow(/requires path or name/)
  })
})

describe('worktree prune + destroy', () => {
  it('prunes only idle slots: dry-run first, then yes', async () => {
    const acquired = await call({ action: 'acquire' })
    const lease = (acquired.value as { lease: { path: string; leaseId: string } }).lease
    await call({ action: 'release', path: lease.path, leaseId: lease.leaseId })

    const dry = await call({ action: 'prune' })
    const dryValue = dry.value as { prune: { candidates: Array<{ path: string }>; removed: string[] } }
    expect(dryValue.prune.candidates.map(item => item.path)).toContain(lease.path)
    expect(dryValue.prune.removed).toHaveLength(0)
    expect(runGitIn(lease.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')

    const executed = await call({ action: 'prune', yes: true })
    const executedValue = executed.value as { prune: { removed: string[] } }
    expect(executedValue.prune.removed).toContain(lease.path)
    const listed = await call({ action: 'list' })
    expect((listed.value as { worktrees: unknown[] }).worktrees).toHaveLength(0)
  })

  it('destroy previews without yes, refuses leased/unlanded, then removes', async () => {
    const acquired = await call({ action: 'acquire' })
    const lease = (acquired.value as { lease: { path: string; leaseId: string } }).lease

    // Leased slot is never destroyed without the explicit flag.
    await expect(call({ action: 'destroy', path: lease.path, yes: true })).rejects.toThrow(/LeasedWorktree/)

    // Dry-run previews without removing.
    await call({ action: 'release', path: lease.path, leaseId: lease.leaseId })
    const preview = await call({ action: 'destroy', path: lease.path })
    expect((preview.value as { destroyed: { removed: boolean } }).destroyed.removed).toBe(false)
    expect(runGitIn(lease.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')

    // Dirty work requires includeUnlanded (irreversible), then succeeds.
    await dirty(lease.path, 'wip.txt')
    await expect(call({ action: 'destroy', path: lease.path, yes: true })).rejects.toThrow(/UnlandedWorktree/)
    const destroyed = await call({ action: 'destroy', path: lease.path, yes: true, includeUnlanded: true })
    expect((destroyed.value as { destroyed: { removed: boolean } }).destroyed.removed).toBe(true)
    expect(await exists(lease.path)).toBe(false)
  })
})

function runGitIn(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
