/**
 * Tests for the fork's browser orphan registry (port of oh-my-pi #10022 fix,
 * `orphan-registry.ts`): the harness's spawned Chromium children are recorded
 * on disk keyed by the owning host pid, so a LATER host process can reap
 * browsers whose recorded owner is gone (crashed/SIGKILLed hosts otherwise
 * leave Chromium reparented to PID 1 forever).
 *
 * The contract under test:
 *  - a dead owner's browsers are collected for reaping, a live owner's are not;
 *  - this process's own records are never reaped;
 *  - a conservative grace window keeps a just-crashed owner's fresh records;
 *  - confirmed terminations remove the owner file; failures retain pids for a
 *    later retry.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import {
  collectOrphanBrowsers,
  forgetOwnedBrowser,
  orphanRegistryDir,
  reapOrphanBrowsers,
  recordOwnedBrowser,
  resetOrphanRegistryForTest,
} from '../src/orphan-registry.ts'

/** A real, non-colliding temp registry dir for one test. */
const registryDirs: string[] = []
async function isolateRegistry(): Promise<string> {
  const dir = path.join(os.tmpdir(), `dsh-browser-orphans-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  registryDirs.push(dir)
  return dir
}

/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('true', [], { stdio: 'ignore' })
    proc.once('exit', () => { resolve(proc.pid as number) })
    proc.once('error', reject)
  })
}

async function writeOwnershipFile(dir: string, record: { pid: number; updatedAt: number; browserPids: number[] }): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${record.pid}.json`), JSON.stringify(record), 'utf8')
}

afterEach(async () => {
  resetOrphanRegistryForTest()
  for (const dir of registryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('browser orphan registry — ownership scan', () => {
  it('collects a dead owner and leaves a live owner untouched', async () => {
    const dir = await isolateRegistry()
    const dead = await deadPid()
    const live = 424_242 // treated as alive by the injected probe
    await writeOwnershipFile(dir, { pid: dead, updatedAt: 0, browserPids: [11, 22] })
    await writeOwnershipFile(dir, { pid: live, updatedAt: 0, browserPids: [33] })

    const scan = await collectOrphanBrowsers({ dir, now: () => 10_000_000, isAlive: pid => pid === live })

    expect(scan.owners).toEqual([
      { file: path.join(dir, `${dead}.json`), pid: dead, updatedAt: 0, browserPids: [11, 22] },
    ])
  })

  it("never reaps this process's own recorded browsers", async () => {
    const dir = await isolateRegistry()
    await recordOwnedBrowser(41, dir)
    await recordOwnedBrowser(42, dir)

    const scan = await collectOrphanBrowsers({ dir, now: () => 10_000_000, isAlive: () => false })

    expect(scan.owners).toEqual([])
  })

  it('respects the conservative grace window for a just-crashed owner', async () => {
    const dir = await isolateRegistry()
    const dead = await deadPid()
    await writeOwnershipFile(dir, { pid: dead, updatedAt: 999_999, browserPids: [7] })

    // Fresh record (updatedAt near `now`): not eligible yet.
    const fresh = await collectOrphanBrowsers({ dir, now: () => 1_000_000, isAlive: () => false, graceMs: 15_000 })
    expect(fresh.owners).toEqual([])

    // Old record (updatedAt well before `now`): eligible.
    const aged = await collectOrphanBrowsers({ dir, now: () => 2_000_000, isAlive: () => false, graceMs: 15_000 })
    expect(aged.owners).toHaveLength(1)
  })

  it('ignores torn or malformed ownership files', async () => {
    const dir = await isolateRegistry()
    await fs.writeFile(path.join(dir, '999.json'), 'not json', 'utf8')
    await fs.writeFile(path.join(dir, '1000.json'), JSON.stringify({ pid: 'nope' }), 'utf8')

    const scan = await collectOrphanBrowsers({ dir, now: () => 10_000_000, isAlive: () => false })

    expect(scan.owners).toEqual([])
  })
})

describe('browser orphan registry — reap', () => {
  it('removes a dead owner file once all browsers are reaped', async () => {
    const dir = await isolateRegistry()
    const dead = await deadPid()
    await writeOwnershipFile(dir, { pid: dead, updatedAt: 0, browserPids: [999_999] })

    const reaped = await reapOrphanBrowsers({ dir, now: () => 10_000_000, isAlive: () => false })

    expect(reaped).toBe(1)
    await expect(fs.readdir(dir)).resolves.toEqual([])
  })

  it('record + forget round-trips the durable file', async () => {
    const dir = await isolateRegistry()
    await recordOwnedBrowser(123, dir)
    const file = path.join(dir, `${process.pid}.json`)
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { pid: number; browserPids: number[] }
    expect(raw.pid).toBe(process.pid)
    expect(raw.browserPids).toContain(123)

    await forgetOwnedBrowser(123, dir)
    await expect(fs.readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the default registry dir stable', () => {
    expect(orphanRegistryDir()).toContain('dsh-browser-orphans')
  })
})
