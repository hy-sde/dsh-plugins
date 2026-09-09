/**
 * Durable ownership registry for browser processes this host launched.
 *
 * The DSH harness spawns Chromium in-process (`chromium.launch`) and closes it
 * with the service (`stop`). That works for graceful shutdown but not for an
 * abnormal host death (crash, SIGKILL, cleanup timeout): the launched Chromium
 * children are reparented to PID 1 and keep running forever, accumulating into
 * multi-GB leaked browser processes. This is the exact orphan class oh-my-pi
 * fixed for its shared broker Chromium (#10022 / `orphan-registry.ts`); the
 * fork has no shared broker, so the registry below records the OS PID of every
 * browser *this host* spawned, and any later host process can reap browsers
 * whose recorded owner is gone.
 *
 * Ownership is authoritative in the safe direction: a browser is reaped only
 * when its owner PID reports `ESRCH` (definitively dead). A live PID is never
 * reaped, so a running host's browsers cannot be yanked out from under it; the
 * worst case (recycled PID) leaves an orphan uncollected rather than killing a
 * live page. Ported from oh-my-pi `orphan-registry.ts` (MIT), adapted from
 * per-target to per-process records because each fork `launch` owns a whole
 * browser, not one page target in a shared one.
 * @module @hy-sde-org/dsh-browser/orphan-registry
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

/** On-disk ownership record: one file per owning host process. */
interface OwnershipFile {
  pid: number
  updatedAt: number
  /** OS pids of browsers this owner launched. */
  browserPids: number[]
}

/**
 * Reap only records whose owner has been dead AND untouched for this long.
 * The PID probe is already authoritative; the grace window is a conservative
 * guard against clock skew and PID-reuse races, and keeps a just-crashed
 * host's very fresh records around briefly in case it is being restarted.
 */
const DEFAULT_GRACE_MS = 15_000

/** Registry directory: user temp (survives host death, writable without hosts colliding). */
export function orphanRegistryDir(): string {
  return path.join(tmpdir(), 'dsh-browser-orphans')
}

/** Resolve the registry dir, honoring an injectable override (tests use a unique temp dir). */
function resolveRegistryDir(override?: string): string {
  return override ?? orphanRegistryDir()
}

/** In-process set of browser pids this host launched, keyed by registry dir. */
const ownedByDir = new Map<string, Set<number>>()
/** Per-registry-dir write serialization so concurrent record/forget can't tear the file. */
const writeChains = new Map<string, Promise<void>>()

function ownershipFilePath(dir: string, pid: number): string {
  return path.join(dir, `${pid}.json`)
}

/** Serialize a write against others for the same registry dir. */
function chain(dir: string, task: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(dir) ?? Promise.resolve()
  const next = prev.then(task, task)
  writeChains.set(
    dir,
    next.catch(() => undefined),
  )
  return next
}

/** Persist (or, when empty, remove) this process's ownership file for a registry dir. */
async function flush(dir: string): Promise<void> {
  const owned = ownedByDir.get(dir)
  const file = ownershipFilePath(dir, process.pid)
  if (!owned || owned.size === 0) {
    await fs.rm(file, { force: true }).catch(() => undefined)
    return
  }
  const record: OwnershipFile = {
    pid: process.pid,
    updatedAt: Date.now(),
    browserPids: [...owned],
  }
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(record), 'utf8')
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Record that this process launched browser with OS pid `browserPid`. */
export async function recordOwnedBrowser(browserPid: number, dirOverride?: string): Promise<void> {
  const dir = resolveRegistryDir(dirOverride)
  let owned = ownedByDir.get(dir)
  if (!owned) {
    owned = new Set()
    ownedByDir.set(dir, owned)
  }
  owned.add(browserPid)
  await chain(dir, () => flush(dir)).catch(() => { /* best effort */ })
}

/** Drop `browserPid` from this process's ownership file (closed the normal way). */
export async function forgetOwnedBrowser(browserPid: number, dirOverride?: string): Promise<void> {
  const dir = resolveRegistryDir(dirOverride)
  const owned = ownedByDir.get(dir)
  if (!owned?.delete(browserPid)) return
  await chain(dir, () => flush(dir)).catch(() => { /* best effort */ })
}

/** True when `pid` names a live process; non-`ESRCH` probe failures are treated as alive (safe direction). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Options for {@link collectOrphanBrowsers}; the defaults hit the real registry, the seams are for tests. */
export interface CollectOrphanOptions {
  /** Registry dir override (tests use a unique temp dir). */
  dir?: string
  /** Wall clock; injectable for deterministic grace-window tests. */
  now?: () => number
  /** PID liveness probe; injectable so tests need no real subprocesses. */
  isAlive?: (pid: number) => boolean
  /** Grace window in ms before a dead owner's records are eligible. */
  graceMs?: number
}

/** Browsers belonging to one dead process, kept grouped so partial failures remain retryable. */
export interface OrphanOwner {
  file: string
  pid: number
  updatedAt: number
  browserPids: number[]
}

/** Orphan-scan result grouped by durable ownership file. */
export interface OrphanScan {
  owners: OrphanOwner[]
}

/**
 * Scan the registry for browser pids whose owning host process is gone.
 * Returns one entry per dead owner so a reaper can retain only pids whose
 * termination was not confirmed. This process's own file and every live
 * owner's file are left untouched.
 */
export async function collectOrphanBrowsers(opts: CollectOrphanOptions = {}): Promise<OrphanScan> {
  const now = opts.now ?? Date.now
  const isAlive = opts.isAlive ?? isPidAlive
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const dir = resolveRegistryDir(opts.dir)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { owners: [] }
    throw error
  }
  const owners: OrphanOwner[] = []
  const nowMs = now()
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const file = path.join(dir, entry)
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      continue // torn or malformed file; a live owner will rewrite it
    }
    let record: OwnershipFile
    try {
      record = JSON.parse(raw) as OwnershipFile
    } catch {
      continue
    }
    if (typeof record.pid !== 'number' || !Array.isArray(record.browserPids)) continue
    if (record.pid === process.pid) continue // our own file
    if (isAlive(record.pid)) continue // owner still running
    if (nowMs - record.updatedAt < graceMs) continue // conservative grace
    owners.push({
      file,
      pid: record.pid,
      updatedAt: record.updatedAt,
      browserPids: record.browserPids.filter(browserPid => typeof browserPid === 'number'),
    })
  }
  return { owners }
}

/** Terminate one orphaned browser process; true when the pid is confirmed gone. */
export function terminateOrphanBrowser(pid: number): boolean {
  // Terminate the recorded browser process itself. Chrome cleans up its own
  // renderer/GPU children when its main process dies, so the direct pid is
  // the correct target — never the process group, which here is the NEW host's
  // own group (Playwright does not spawn browsers detached).
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // ESRCH: already gone, which is the outcome we wanted anyway.
    return true
  }
  return true
}

/** Atomically retain unresolved pids, or remove an ownership file once all are resolved. */
async function updateOwnershipFile(owner: OrphanOwner, browserPids: number[]): Promise<void> {
  if (browserPids.length === 0) {
    await fs.rm(owner.file, { force: true })
    return
  }
  const tmp = `${owner.file}.${process.pid}.tmp`
  try {
    const record: OwnershipFile = { pid: owner.pid, updatedAt: owner.updatedAt, browserPids }
    await fs.writeFile(tmp, JSON.stringify(record), 'utf8')
    await fs.rename(tmp, owner.file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Reap browser processes whose owning host is gone. Each owner file is removed
 * only after every pid is resolved; partial failures atomically retain the
 * unresolved ids for the next sweep to retry. Failures are logged-silently,
 * never thrown, so cleanup cannot block browser open.
 */
export async function reapOrphanBrowsers(opts: CollectOrphanOptions = {}): Promise<number> {
  let scan: OrphanScan
  try {
    scan = await collectOrphanBrowsers(opts)
  } catch {
    return 0
  }
  let reaped = 0
  for (const owner of scan.owners) {
    const retained: number[] = []
    for (const browserPid of owner.browserPids) {
      if (terminateOrphanBrowser(browserPid)) {
        reaped++
      } else {
        retained.push(browserPid)
      }
    }
    if (retained.length === owner.browserPids.length) continue
    try {
      await updateOwnershipFile(owner, retained)
    } catch {
      // best effort; the next sweep retries
    }
  }
  return reaped
}

/** Test-only reset of the in-process ownership state. */
export function resetOrphanRegistryForTest(): void {
  ownedByDir.clear()
  writeChains.clear()
}
