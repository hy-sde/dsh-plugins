/**
 * M3 end-to-end: the full worktree pool story in harness terms.
 *
 * - Two agents acquire leases CONCURRENTLY on one repository and get distinct
 *   slots (lease exclusivity under real interleaving).
 * - A "host restart" is simulated by tearing down the whole cordis context and
 *   mounting a fresh one over the same repo + pool; the restarted agent can
 *   release the original lease by id — ownership is the durable state file,
 *   not process memory — and a wrong id still cannot release it.
 * - A dirty worktree round-trip: edit → release refuses → force release cleans
 *   → prune (dry-run then yes) empties the pool.
 * - prune --all sweeps a second repository's pool under the same root.
 *
 * The pool root is always a mkdtemp dir (never ~/.treehouse) and every test
 * self-cleans through release/destroy, so a mid-test assertion failure cannot
 * leak leased slots into later cases.
 */

import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { rmSync, realpathSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Git from '@hy-sde-org/dsh-git'
import toolGitPackage from '@hy-sde-org/dsh-tool-git'

const contexts: Context[] = []
let repo1: string
let repo2: string
let pool: string
let counter = 0

function gitRun(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

async function initRepo(dir: string): Promise<void> {
  gitRun(dir, ['init', '-q', '-b', 'master'])
  gitRun(dir, ['config', 'user.email', 'test@example.com'])
  gitRun(dir, ['config', 'user.name', 'Test User'])
  gitRun(dir, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(dir, 'seed.txt'), 'seed\n')
  gitRun(dir, ['add', '.'])
  gitRun(dir, ['commit', '-qm', 'init'])
}

/** Mount the standard agent-plane stack for one "host process". */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Git)
  await ctx.plugin(toolGitPackage, { worktreeRoot: pool })
  contexts.push(ctx)
  return ctx
}

interface FakeAgent {
  session: { header: { id: string; cwd: string } }
}

function agent(id: string, repo = repo1): FakeAgent {
  return { session: { header: { id, cwd: repo } } }
}

async function call(ctx: Context, agentValue: FakeAgent, args: unknown): Promise<{ value: unknown }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++counter}`),
    name: 'worktree',
    arguments: args,
    agent: agentValue as never,
  })
  if (result.isError) {
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    throw new Error(text || 'tool failed')
  }
  return result
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Remove the on-disk slot directory (works regardless of pool state). */
function removeSlotDir(leasePath: string): void {
  rmSync(dirname(leasePath), { recursive: true, force: true })
}

beforeAll(async () => {
  repo1 = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-e2e-a-')))
  repo2 = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-e2e-b-')))
  pool = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-e2e-pool-')))
  await initRepo(repo1)
  await initRepo(repo2)
})

afterAll(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  rmSync(repo1, { recursive: true, force: true })
  rmSync(repo2, { recursive: true, force: true })
  rmSync(pool, { recursive: true, force: true })
})

describe('two concurrent agents (one repository)', () => {
  it('acquires distinct lease slots under real interleaving', async () => {
    const ctx = await boot()
    const [a, b] = await Promise.all([
      call(ctx, agent('agent-a'), { action: 'acquire', holder: 'agent-a' }),
      call(ctx, agent('agent-b'), { action: 'acquire', holder: 'agent-b' }),
    ])
    const leaseA = (a.value as { lease: { path: string; leaseId: string; leaseHolder: string } }).lease
    const leaseB = (b.value as { lease: { path: string; leaseId: string; leaseHolder: string } }).lease
    try {
      expect(leaseA.path).not.toBe(leaseB.path)
      expect(leaseA.leaseHolder).toBe('agent-a')
      expect(leaseB.leaseHolder).toBe('agent-b')
      // Both are real, clean worktrees of the same repository at detached HEAD.
      for (const lease of [leaseA, leaseB]) {
        expect(gitRun(lease.path, ['rev-parse', '--show-toplevel']).trim()).toBe(lease.path)
        expect(gitRun(lease.path, ['status', '--porcelain']).trim()).toBe('')
        expect(gitRun(lease.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD')
      }
      // Each is durably recorded as leased; a third acquire still gets a fresh slot.
      const listed = await call(ctx, agent('agent-a'), { action: 'list' })
      const worktrees = (listed.value as { worktrees: Array<{ leased: boolean }> }).worktrees
      expect(worktrees.filter(item => item.leased)).toHaveLength(2)
      const c = await call(ctx, agent('agent-c'), { action: 'acquire', holder: 'agent-c' })
      const leaseC = (c.value as { lease: { path: string; leaseId: string } }).lease
      expect(leaseC.path).not.toBe(leaseA.path)
      expect(leaseC.path).not.toBe(leaseB.path)
      await call(ctx, agent('agent-c'), { action: 'release', path: leaseC.path, leaseId: leaseC.leaseId })
    } finally {
      // Never leak slots into later cases: release everything still owned.
      const listed = await call(ctx, agent('agent-a'), { action: 'list' })
      const worktrees = (listed.value as { worktrees: Array<{ path: string; leaseId?: string }> }).worktrees
      for (const item of worktrees) {
        if (item.leaseId !== undefined) {
          await call(ctx, agent('agent-a'), { action: 'release', path: item.path, leaseId: item.leaseId, force: true })
        }
      }
    }
  })

  it('a lease survives a host restart and stays id-gated (restart is a non-event)', async () => {
    // Boot, acquire, then tear the whole context down WITHOUT releasing —
    // the durable state file (not process memory) owns the slot now.
    const ctx1 = await boot()
    const acquired = await call(ctx1, agent('restartee'), { action: 'acquire', holder: 'restartee' })
    const lease = (acquired.value as { lease: { path: string; leaseId: string } }).lease
    await ctx1.fiber.dispose()

    // New host process: fresh cordis context over the same repo + pool.
    const ctx2 = await boot()
    try {
      // State survived: list still shows the slot leased by restartee.
      const listed = await call(ctx2, agent('fresh-boot'), { action: 'list' })
      const worktrees = (listed.value as { worktrees: Array<{ status: string; leased: boolean; leaseHolder?: string }> }).worktrees
      const slot = worktrees.find(item => item.leased)
      expect(slot).toBeDefined()
      expect(slot).toMatchObject({ status: 'leased', leaseHolder: 'restartee' })

      // The wrong id still cannot release it (state was not lost or softened).
      await expect(call(ctx2, agent('fresh-boot'), { action: 'release', path: lease.path, leaseId: '0'.repeat(32) }))
        .rejects.toThrow(/LeaseMismatch/)

      // The original lease id DOES work from the restarted host: ownership is durable.
      const released = await call(ctx2, agent('fresh-boot'), { action: 'release', path: lease.path, leaseId: lease.leaseId })
      expect((released.value as { released: { released: boolean } }).released.released).toBe(true)
    } finally {
      await ctx2.fiber.dispose()
    }
  })

  it('edit → release refuses → force release cleans → prune empties the pool', async () => {
    const ctx = await boot()
    const acquired = await call(ctx, agent('worker'), { action: 'acquire', holder: 'worker' })
    const lease = (acquired.value as { lease: { path: string; leaseId: string } }).lease
    try {
      await writeFile(join(lease.path, 'feature.txt'), 'work in progress\n')
      await expect(call(ctx, agent('worker'), { action: 'release', path: lease.path, leaseId: lease.leaseId }))
        .rejects.toThrow(/DirtyWorktree/)

      const forced = await call(ctx, agent('worker'), { action: 'release', path: lease.path, leaseId: lease.leaseId, force: true })
      expect((forced.value as { released: { released: boolean } }).released.released).toBe(true)
      await expect(readFile(join(lease.path, 'feature.txt'), 'utf8')).rejects.toThrow()

      const dry = await call(ctx, agent('worker'), { action: 'prune' })
      const prune = (dry.value as { prune: { candidates: Array<{ path: string }>; removed: string[] } }).prune
      expect(prune.candidates.map(item => item.path)).toContain(lease.path)
      expect(prune.removed).toHaveLength(0)

      const executed = await call(ctx, agent('worker'), { action: 'prune', yes: true })
      expect((executed.value as { prune: { removed: string[] } }).prune.removed).toContain(lease.path)
      expect(await exists(lease.path)).toBe(false)
      const listed = await call(ctx, agent('worker'), { action: 'list' })
      expect((listed.value as { worktrees: unknown[] }).worktrees).toHaveLength(0)
    } finally {
      removeSlotDir(lease.path)
    }
  })

  it('prune --all sweeps another repository pool under the same root', async () => {
    const ctxA = await boot()
    const ctxB = await boot()
    const a = await call(ctxA, agent('a'), { action: 'acquire' })
    const b = await call(ctxB, agent('b', repo2), { action: 'acquire' })
    const leaseA = (a.value as { lease: { path: string; leaseId: string } }).lease
    const leaseB = (b.value as { lease: { path: string; leaseId: string } }).lease
    try {
      expect(leaseA.path).not.toBe(leaseB.path)
      await call(ctxA, agent('a'), { action: 'release', path: leaseA.path, leaseId: leaseA.leaseId })
      await call(ctxB, agent('b', repo2), { action: 'release', path: leaseB.path, leaseId: leaseB.leaseId })
      const result = await call(ctxA, agent('a'), { action: 'prune', all: true, yes: true })
      const removed = (result.value as { prune: { removed: string[] } }).prune.removed
      expect(removed).toEqual(expect.arrayContaining([leaseA.path, leaseB.path]))
    } finally {
      for (const lease of [leaseA, leaseB]) removeSlotDir(lease.path)
    }
  })
})
