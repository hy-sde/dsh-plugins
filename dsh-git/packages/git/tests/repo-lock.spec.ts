/**
 * Tests for `withRepoLock`: per-primary-root serialization of in-process
 * mutating blocks (worktree-unified keying), failure isolation, abort checks.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withRepoLock } from '../src/repo-lock.ts'

let root: string
let sub: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-git-lock-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  sub = join(root, 'sub')
  mkdirSync(sub, { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('withRepoLock', () => {
  it('keys worktrees/subdirs of the same repo on one queue (shared serialization)', async () => {
    const order: string[] = []
    const release: Array<() => void> = []
    const slow = async () => {
      await new Promise<void>(resolve => release.push(resolve))
      order.push('slow')
    }
    const fast = async () => {
      order.push('fast')
    }
    const first = withRepoLock(sub, slow)
    // Second acquisition on the SAME repo must queue behind the first.
    const second = withRepoLock(root, fast)
    await new Promise(setImmediate)
    expect(order).toEqual([]) // nothing ran yet — second queued behind first
    release[0]?.()
    await first
    await second
    expect(order).toEqual(['slow', 'fast'])
  })

  it('a failing block does not poison the queue for the next caller', async () => {
    const attempts: string[] = []
    await expect(
      withRepoLock(root, async () => {
        attempts.push('fail')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await withRepoLock(root, async () => {
      attempts.push('ok')
    })
    expect(attempts).toEqual(['fail', 'ok'])
  })

  it('honors an already-aborted signal by refusing to run', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      withRepoLock(root, async () => 'ran', controller.signal),
    ).rejects.toThrow(/aborted/)
  })

  it('returns the block result', async () => {
    const result = await withRepoLock(root, async () => 42)
    expect(result).toBe(42)
  })
})
