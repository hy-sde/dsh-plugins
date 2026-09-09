/**
 * Tests for the pi-vcs TS contract surface: VcsError taxonomy, discovery
 * (repo/gitInfo/require/requireGit), newline-safe joinPatches (incl. the GIT
 * binary terminator round-trip), and HEAD stat-poll watching.
 */

import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  VcsError,
  isVcsError,
  isEmptyCherryPick,
  vcsError,
  gitInfo,
  repo,
  require,
  requireGit,
  isPureJj,
  joinPatches,
  watch,
  HEAD_WATCH_INTERVAL_MS,
  prefixOf,
} from '../src/vcs.ts'
import { parseFileDiffs } from '../src/diff.ts'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-git-vcs-'))
  await mkdir(join(dir, '.git'), { recursive: true })
  await mkdir(join(dir, 'sub'), { recursive: true })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('VcsError taxonomy', () => {
  it('constructs with code/exitCode/stdout/stderr and name VcsError', () => {
    const error = vcsError('CliTimeout', 'git hung', { stderr: 'timed out' })
    expect(error.name).toBe('VcsError')
    expect(error.code).toBe('CliTimeout')
    expect(error.exitCode).toBe(1) // default
    expect(error.stderr).toBe('timed out')
    expect(error).toBeInstanceOf(Error)
  })

  it('isVcsError matches only VcsError identity (name-based, like upstream)', () => {
    expect(isVcsError(vcsError('NotARepository', 'nope'))).toBe(true)
    expect(isVcsError(new Error('plain'))).toBe(false)
    expect(isVcsError('string')).toBe(false)
  })

  it('isEmptyCherryPick narrows to the EmptyCherryPick code', () => {
    expect(isEmptyCherryPick(vcsError('EmptyCherryPick', 'already applied'))).toBe(true)
    expect(isEmptyCherryPick(vcsError('Conflict', 'conflict'))).toBe(false)
  })

  it('VcsError is a subclass of Error usable with instanceof', () => {
    const error = new VcsError('Io', 'disk')
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error).toBe(true)
  })
})

describe('discovery', () => {
  it('gitInfo walks up to the nearest .git ancestor', () => {
    const info = gitInfo(join(dir, 'sub'))
    expect(info).not.toBeNull()
    expect(info?.root).toBe(dir)
    expect(info?.gitDir).toBe(join(dir, '.git'))
  })

  it('gitInfo returns null outside a repository', () => {
    const outside = join(dir, '..', `no-repo-${Date.now()}`)
    expect(gitInfo(outside)).toBeNull()
  })

  it('repo returns a VcsRepo handle with watchTarget and supports gates', () => {
    const discovered = repo(dir)
    expect(discovered).not.toBeNull()
    expect(discovered?.kind).toBe('git')
    expect(discovered?.root).toBe(dir)
    expect(discovered?.watchTarget).toBe(join(dir, '.git', 'HEAD'))
    expect(discovered?.supports('stagedDiff')).toBe(true)
    expect(discovered?.supports('revDiff')).toBe(true)
  })

  it('require asserts capabilities and throws NotARepository outside a repo', () => {
    const outside = join(dir, '..', `no-repo-${Date.now()}`)
    const discovered = require(dir, 'stagedDiff')
    expect(discovered.kind).toBe('git')
    expect(() => require(outside)).toThrow(/not a repository/)
    try {
      require(outside)
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as VcsError).code).toBe('NotARepository')
    }
  })

  it('requireGit throws NotARepository outside a repo, returns inside', () => {
    const discovered = requireGit(dir)
    expect(discovered.root).toBe(dir)
    const outside = join(dir, '..', `no-repo-${Date.now()}`)
    expect(() => requireGit(outside)).toThrow(/not a repository/)
  })

  it('isPureJj is always false (no jj backend on the fork)', () => {
    expect(isPureJj(dir)).toBe(false)
  })

  it('prefixOf resolves worktree-relative prefixes and null outside', () => {
    const discovered = repo(dir)
    expect(discovered).not.toBeNull()
    expect(prefixOf(discovered!, 'sub')).toBe('sub')
    expect(prefixOf(discovered!, dir)).toBeNull()
    expect(prefixOf(discovered!, join(dir, '..'))).toBeNull()
  })
})

describe('joinPatches (pi-vcs newline-safe)', () => {
  it('joins parts verbatim, adding a newline only when a part lacks one', () => {
    expect(joinPatches(['one', 'two'])).toBe('one\ntwo\n')
    expect(joinPatches(['one\n', 'two'])).toBe('one\ntwo\n')
    expect(joinPatches(['one\n\n', 'two', ''])).toBe('one\n\ntwo\n\n')
  })

  it('preserves a space-only empty context line at the end of a patch', () => {
    const parts = [
      '@@ -1,2 +1,2 @@\n',
      'foo\n',
      '@@ -10,4 +10,4 @@\n',
      'line1\n',
      '-old\n',
      '+new\n',
      ' \n',
    ]
    const result = joinPatches(parts)
    expect(result.endsWith(' \n')).toBe(true)
    expect(result.replace(/[ \t]+$/, '')).toEqual(result)
  })

  it('round-trips parseFileDiffs → joinPatches byte-exact incl. GIT binary terminator (last)', () => {
    const textBlock =
      'diff --git a/a.txt b/a.txt\n' + '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+b changed\n'
    const binaryBlock =
      'diff --git a/bin.dat b/bin.dat\n' +
      'index 1111111..2222222 100644\n' +
      'GIT binary patch\n' +
      'literal 6\n' +
      'zc$@zAB0000\n' +
      '\n'
    const diff = textBlock + binaryBlock
    const rebuilt = joinPatches(parseFileDiffs(diff).map(file => file.content))
    expect(rebuilt).toBe(diff)
    expect(rebuilt.endsWith('zc$@zAB0000\n\n')).toBe(true)
  })

  it('round-trips parseFileDiffs → joinPatches byte-exact incl. binary terminator (not last)', () => {
    const textBlock =
      'diff --git a/a.txt b/a.txt\n' + '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+b changed\n'
    const binaryBlock =
      'diff --git a/bin.dat b/bin.dat\n' +
      'index 1111111..2222222 100644\n' +
      'GIT binary patch\n' +
      'literal 6\n' +
      'zc$@zAB0000\n' +
      '\n'
    const diff = binaryBlock + textBlock
    const rebuilt = joinPatches(parseFileDiffs(diff).map(file => file.content))
    expect(rebuilt).toBe(diff)
    expect(rebuilt.includes('zc$@zAB0000\n\ndiff --git a/a.txt')).toBe(true)
  })
})

describe('watch', () => {
  it('HEAD_WATCH_INTERVAL_MS is the upstream 1000ms stat-poll interval', () => {
    expect(HEAD_WATCH_INTERVAL_MS).toBe(1000)
  })

  it('watch returns a disposer and fires on HEAD change (real file)', async () => {
    const discovered = repo(dir)
    expect(discovered).not.toBeNull()
    const headPath = discovered!.watchTarget
    await writeFile(headPath, 'ref: refs/heads/main\n', 'utf8')

    let calls = 0
    const onChange = () => { calls += 1 }
    const dispose = watch(discovered!, onChange, 20)
    try {
      await writeFile(headPath, 'ref: refs/heads/other\n', 'utf8')
      // Stat-poll: give the watcher a beat to observe the change.
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(calls).toBeGreaterThan(0)
    } finally {
      dispose()
      rmSync(headPath, { force: true })
    }
  })

  it('dispose stops further updates', async () => {
    const discovered = repo(dir)
    expect(discovered).not.toBeNull()
    const headPath = discovered!.watchTarget
    await writeFile(headPath, 'ref: refs/heads/main\n', 'utf8')
    let calls = 0
    const dispose = watch(discovered!, () => { calls += 1 }, 20)
    dispose()
    await writeFile(headPath, 'ref: refs/heads/other\n', 'utf8')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(calls).toBe(0)
    rmSync(headPath, { force: true })
  })
})
