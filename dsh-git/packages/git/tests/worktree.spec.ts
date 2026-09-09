/**
 * Real-repository integration for the worktree pool: temp repositories are
 * initialized, slots are acquired/released/pruned/destroyed through the
 * engine against actual `git` through the subprocess seam, and every safety
 * invariant (lease ids, dirty/leased/unmerged guards, corrupt-state recovery)
 * is exercised with the real filesystem.
 */

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitService } from '../src/service.ts'
import {
  acquireWorktree,
  releaseWorktree,
  listWorktrees,
  pruneWorktrees,
  destroyWorktree,
  primaryRepoRoot,
  resolveWorktreePoolRoot,
  WorktreeError,
} from '../src/worktree.ts'

interface Fixture {
  dir: string
  pool: string
  git: GitService
  ctx: Context
  run: (args: string[]) => string
  runIn: (cwd: string, args: string[]) => string
  cleanup: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean()
})

function gitRun(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

async function makeFixture(options: { poolRoot?: string } = {}): Promise<Fixture> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-wt-')))
  const pool = realpathSync(options.poolRoot ?? await mkdtemp(join(tmpdir(), 'dsh-wt-pool-')))
  gitRun(dir, ['init', '-q', '-b', 'master'])
  gitRun(dir, ['config', 'user.email', 'test@example.com'])
  gitRun(dir, ['config', 'user.name', 'Test User'])
  gitRun(dir, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(dir, 'seed.txt'), 'seed\n')
  gitRun(dir, ['add', '.'])
  gitRun(dir, ['commit', '-qm', 'init'])
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const git = new GitService(ctx)
  const fixture: Fixture = {
    dir,
    pool,
    git,
    ctx,
    run: args => gitRun(dir, args),
    runIn: (cwd, args) => gitRun(cwd, args),
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true })
      rmSync(pool, { recursive: true, force: true })
      await ctx.fiber.dispose()
    },
  }
  cleanups.push(fixture.cleanup)
  return fixture
}

async function expectCode<T>(promise: Promise<T>, code: WorktreeError['code']): Promise<void> {
  try {
    await promise
    expect.unreachable(`expected WorktreeError ${code}`)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorktreeError)
    expect((error as WorktreeError).code).toBe(code)
  }
}

describe('primaryRepoRoot', () => {
  it('resolves the main checkout for a main-checkout cwd', async () => {
    const f = await makeFixture()
    expect(await primaryRepoRoot(f.git, f.dir)).toBe(f.dir)
  })

  it('resolves the MAIN root from inside a linked worktree (pool unification)', async () => {
    const f = await makeFixture()
    const wt = join(f.pool, 'manual-wt')
    f.run(['worktree', 'add', '--detach', wt, 'master'])
    expect(await primaryRepoRoot(f.git, wt)).toBe(f.dir)
  })

  it('rejects a non-repository cwd', async () => {
    const f = await makeFixture()
    const outside = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-wt-outside-')))
    rmSync(outside, { recursive: true, force: true })
    await mkdir(outside)
    await expectCode(primaryRepoRoot(f.git, outside), 'NotARepository')
  })
})

describe('resolveWorktreePoolRoot', () => {
  it('is deterministic and names the repo plus a short hash', () => {
    const a = resolveWorktreePoolRoot({ root: '/tmp/pool' }, '/repo/x')
    const b = resolveWorktreePoolRoot({ root: '/tmp/pool' }, '/repo/x')
    expect(a).toBe(b)
    expect(a).toMatch(/pool[/\\]x-[0-9a-f]{6}$/)
  })

  it('defaults to ~/.treehouse and honors a custom root', () => {
    expect(resolveWorktreePoolRoot({}, '/repo/x')).toMatch(new RegExp(`^${join(homedir(), '.treehouse', 'x-')}`))
    expect(resolveWorktreePoolRoot({}, '/repo/x')).toMatch(/x-[0-9a-f]{6}$/)
    expect(resolveWorktreePoolRoot({ root: '/custom' }, '/repo/x')).toBe(join('/custom', 'x-37fb0d'))
  })
})

describe('acquireWorktree', () => {
  it('cuts a detached slot under the pool and records a durable lease', async () => {
    const f = await makeFixture()
    const lease = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(lease.path.startsWith(f.pool)).toBe(true)
    expect(lease.leaseId).toMatch(/^[0-9a-f]{32}$/)
    expect(lease.branch).toBeUndefined()
    expect(f.runIn(lease.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD')
    expect(f.runIn(lease.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ status: 'leased', leased: true, exists: true, dirty: false })
    expect(listed[0]!.leaseId).toBe(lease.leaseId)
  })

  it('cuts a NEW slot while the first lease is held (never hands out leased)', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(b.path).not.toBe(a.path)
    expect((await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })).length).toBe(2)
  })

  it('reuses an idle clean slot after release (same slot, new lease id)', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(b.path).toBe(a.path)
    expect(b.leaseId).not.toBe(a.leaseId)
  })

  it('cuts a named branch on demand and parks detached on release (D1/D5)', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/x' })
    expect(f.runIn(a.path, ['branch', '--show-current']).trim()).toBe('feat/x')
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    expect(f.runIn(a.path, ['branch', '--show-current']).trim()).toBe('')

    const again = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/x' })
    expect(again.path).toBe(a.path)
    expect(f.runIn(again.path, ['branch', '--show-current']).trim()).toBe('feat/x')

    const other = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/y' })
    expect(other.path).not.toBe(a.path)
    expect(f.runIn(other.path, ['branch', '--show-current']).trim()).toBe('feat/y')
  })

  it('never reuses a slot whose safety is unprovable (dirty slot is skipped)', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(b.path).not.toBe(a.path)
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    const dirtySlot = listed.find(item => item.path === a.path)
    expect(dirtySlot).toMatchObject({ status: 'damaged', dirty: true })
  })

  it('refuses an already-aborted signal before touching git', async () => {
    const f = await makeFixture()
    const controller = new AbortController()
    controller.abort()
    await expectCode(
      acquireWorktree(f.git, f.dir, { root: f.pool }, { signal: controller.signal }),
      'GitFailed',
    )
  })
})

describe('releaseWorktree', () => {
  it('requires the matching lease id (stale caller cannot release)', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await expectCode(
      releaseWorktree(f.git, f.dir, { path: a.path, leaseId: 'f'.repeat(32) }, { settings: { root: f.pool } }),
      'LeaseMismatch',
    )
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed[0]).toMatchObject({ status: 'leased' })
    expect(listed[0]!.leaseId).toBe(a.leaseId)
  })

  it('parks a clean slot as idle for reuse', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const result = await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    expect(result).toEqual({ path: a.path, released: true })
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed[0]).toMatchObject({ status: 'idle', leased: false, dirty: false })
  })

  it('refuses a dirty slot unless force, and force cleans it', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    await expectCode(
      releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } }),
      'DirtyWorktree',
    )
    const result = await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool }, force: true })
    expect(result.released).toBe(true)
    // force runs git clean -fdqx → the untracked file is gone.
    await expect(readFile(join(a.path, 'wip.txt'), 'utf8')).rejects.toThrow()
  })

  it('drops the entry when the worktree was removed externally', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await rm(a.path, { recursive: true, force: true })
    const result = await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    expect(result.released).toBe(true)
    expect(await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })).toHaveLength(0)
  })
})

describe('pruneWorktrees', () => {
  it('previews removable idle slots without removing anything', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const result = await pruneWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({ path: a.path, reason: 'removable' })
    expect(result.removed).toHaveLength(0)
    expect(f.runIn(a.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
  })

  it('removes only unleased clean merged slots with yes', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const result = await pruneWorktrees(f.git, f.dir, { settings: { root: f.pool }, yes: true })
    expect(result.removed).toEqual([a.path])
    expect(result.skipped).toContainEqual(expect.objectContaining({ path: b.path, reason: 'leased' }))
    expect(f.runIn(b.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed.map(item => item.path)).toEqual([b.path])
  })

  it('all sweeps every pool under the configured root', async () => {
    const f = await makeFixture()
    const g = await makeFixture({ poolRoot: f.pool })
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const b = await acquireWorktree(g.git, g.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    await releaseWorktree(g.git, g.dir, b, { settings: { root: f.pool } })
    const result = await pruneWorktrees(f.git, f.dir, { settings: { root: f.pool }, all: true, yes: true })
    expect(result.removed).toEqual(expect.arrayContaining([a.path, b.path]))
  })
})

describe('destroyWorktree', () => {
  it('previews without yes and never removes', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const result = await destroyWorktree(f.git, f.dir, { path: a.path, settings: { root: f.pool } })
    expect(result).toEqual({ path: a.path, removed: false })
    expect(f.runIn(a.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
  })

  it('refuses a leased slot unless includeLeased', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(a.leaseId).toMatch(/^[0-9a-f]{32}$/)
    await expectCode(
      destroyWorktree(f.git, f.dir, { name: '1', yes: true, settings: { root: f.pool } }),
      'LeasedWorktree',
    )
  })

  it('refuses dirty work unless includeUnlanded, then removes with both flags', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    await expectCode(
      destroyWorktree(f.git, f.dir, { path: a.path, yes: true, settings: { root: f.pool } }),
      'UnlandedWorktree',
    )
    const result = await destroyWorktree(f.git, f.dir, {
      path: a.path,
      yes: true,
      includeUnlanded: true,
      settings: { root: f.pool },
    })
    expect(result.removed).toBe(true)
    expect(await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })).toHaveLength(0)
  })
})

describe('maxSlots cap', () => {
  it('refuses to cut a new slot at the cap, allows provable reuse, and maxSlots 0 is unlimited', async () => {
    const f = await makeFixture()
    const capped = { root: f.pool, maxSlots: 1 }
    const a = await acquireWorktree(f.git, f.dir, capped)
    await expectCode(
      acquireWorktree(f.git, f.dir, capped),
      'MaxSlots',
    )
    // The cap limits NEW slots only: provable reuse is still allowed.
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const b = await acquireWorktree(f.git, f.dir, capped)
    expect(b.path).toBe(a.path)
    // Explicitly unlimited: cuts beyond the former cap.
    const c = await acquireWorktree(f.git, f.dir, { root: f.pool, maxSlots: 0 })
    expect(c.path).not.toBe(b.path)
  })

  it('refuses to cut past the cap even when a dirty/leased slot blocks reuse', async () => {
    const f = await makeFixture()
    const capped = { root: f.pool, maxSlots: 1 }
    const a = await acquireWorktree(f.git, f.dir, capped)
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    await expectCode(
      acquireWorktree(f.git, f.dir, capped),
      'MaxSlots',
    )
  })
})

describe('corrupt state recovery', () => {
  it('rebuilds entries as damaged/unverified and keeps the safety guards', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    await writeFile(statePath, 'not json {{{')
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ status: 'damaged', exists: true })
    // Unverified rebuilt entry has no lease id → the original lease cannot release it.
    await expectCode(
      releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } }),
      'LeaseMismatch',
    )
    // Cleanup path: destroy admits leased-recovered entries by exact slot with includeLeased.
    const destroyed = await destroyWorktree(f.git, f.dir, {
      name: '1',
      yes: true,
      includeLeased: true,
      settings: { root: f.pool },
    })
    expect(destroyed.removed).toBe(true)
    expect(await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })).toHaveLength(0)
  })
})
