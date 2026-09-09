/**
 * Real-repository integration for `ctx.git`: a temp worktree is initialized,
 * files are authored/staged, and the service's diff/stage/commit/log verbs are
 * exercised against actual `git` through the subprocess seam.
 */

import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitService } from '../src/service.ts'

let dir: string
let ctx: Context
let git: GitService

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-git-'))
  runGit(['init', '-q', '-b', 'master'])
  runGit(['config', 'user.email', 'test@example.com'])
  runGit(['config', 'user.name', 'Test User'])
  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  git = new GitService(ctx)
})

afterAll(async () => {
  const { rmSync } = await import('node:fs')
  rmSync(dir, { recursive: true, force: true })
  await ctx.fiber.dispose()
})

describe('ctx.git over a real repository', () => {
  it('exposes repository state', async () => {
    expect(await git.isRepo(dir)).toBe(true)
    expect(await git.root(dir)).toBe(realpathSync(dir))
    expect(await git.branch(dir)).toBe('master')
  })

  it('captures staged diffs and numstat', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    await git.addAll(dir, ['a.txt'])
    expect(await git.hasStaged(dir)).toBe(true)
    const numstat = await git.diff.numstat(dir, { cached: true })
    expect(numstat).toContainEqual({ path: 'a.txt', additions: 3, deletions: 0 })
    const changed = await git.diff.changedFiles(dir, { cached: true })
    expect(changed).toEqual(['a.txt'])
  })

  it('commits with a stdin message and reads it back from log', async () => {
    await git.commit(dir, 'feat(scaffold): add a.txt\n\n- three lines', {})
    const entries = await git.log(dir, { max: 5 })
    expect(entries[0]!.subject).toBe('feat(scaffold): add a.txt')
    expect(entries[0]!.authorName).toBe('Test User')
    expect(entries[0]!.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(await git.hasStaged(dir)).toBe(false)
  })

  it('resets the index without losing worktree changes', async () => {
    await writeFile(join(dir, 'reset.txt'), 'content\n')
    await git.addAll(dir, ['reset.txt'])
    expect(await git.hasStaged(dir)).toBe(true)
    await git.resetIndex(dir)
    expect(await git.hasStaged(dir)).toBe(false)
    expect(await readFile(join(dir, 'reset.txt'), 'utf8')).toBe('content\n')
  })

  it('rejects commit_apply-style unused staged files via diff.has', async () => {
    await git.addAll(dir, ['reset.txt'])
    expect(await git.diff.has(dir, { cached: true })).toBe(true)
    await git.resetIndex(dir)
  })

  it('selectively stages hunks from a cached diff', async () => {
    const baseline = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    const edited = baseline
      .replace('line2', 'ALPHA-EDIT')
      .replace('line27', 'OMEGA-EDIT')
    await writeFile(join(dir, 'hunks.txt'), baseline)
    await git.addAll(dir, ['hunks.txt'])
    const cached = await git.diffText(dir, { cached: true, binary: true })
    await git.commit(dir, 'chore: baseline hunks file', {})
    await writeFile(join(dir, 'hunks.txt'), edited)
    await git.addAll(dir, ['hunks.txt'])
    const updated = await git.diffText(dir, { cached: true, binary: true })
    expect(cached).toContain('hunks.txt')
    expect(updated).not.toEqual(cached)

    // Reset then re-stage only the second hunk (around line 27) via the cached diff.
    await git.resetIndex(dir)
    await git.stageHunks(dir, [{ path: 'hunks.txt', hunks: { type: 'indices', indices: [2] } }], { rawDiff: updated })
    const stagedDiff = await git.diffText(dir, { cached: true })
    expect(stagedDiff).not.toContain('ALPHA-EDIT')
    expect(stagedDiff).toContain('OMEGA-EDIT')

    await git.commit(dir, 'feat(hunks): stage only second edit', {})
    expect((await git.log(dir, { max: 1 }))[0]!.subject).toBe('feat(hunks): stage only second edit')
  })

  it('round-trips unchanged content after a full-file restage', async () => {
    await git.addAll(dir, ['hunks.txt'])
    const full = await git.diffText(dir, { cached: true, binary: true })
    expect(full).toContain('ALPHA-EDIT')
    await git.resetIndex(dir)
    await git.stageHunks(dir, [{ path: 'hunks.txt', hunks: { type: 'all' } }], { rawDiff: full })
    expect(await git.diff.has(dir, { cached: true })).toBe(true)
    await git.resetIndex(dir)
  })

  it('reports a failed command with stderr detail', async () => {
    await expect(git.diffText(join(dir, 'nope'), { cached: true, binary: true })).rejects.toThrow(/git diff/)
  })
})
