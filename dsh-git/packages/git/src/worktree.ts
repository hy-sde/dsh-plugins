/**
 * Worktree pool with durable leases for parallel agent work on one repository.
 *
 * Modeled on treehouse (MIT, https://github.com/kunchenguid/treehouse) `get
 * --lease` semantics, reduced to what a pure-TS fork can express over the
 * `ctx.git` subprocess seam:
 *
 * - A per-repository pool of git worktrees under a configurable root
 *   (default `~/.treehouse`), each slot cut at detached HEAD (treehouse
 *   default) or at a NAMED branch (DSH deviation D1: `tool-git commit_apply
 *   --push` runs `git push` on the current branch, which fails on a detached
 *   HEAD, so the PR path needs a branch).
 * - DURABLE LEASES: `acquireWorktree` reserves a slot in persistent pool state
 *   with an immutable random lease id; a leased slot is never handed out again
 *   and never pruned until `releaseWorktree` clears it with the matching id —
 *   exactly treehouse's lease contract, and the property that makes a task's
 *   environment survive a host restart (D3: DSH children die with the host, so
 *   the lease — not a process — is the ownership record).
 * - Safety is never inferred: a slot is only reused when it is provably idle
 *   (not leased), clean (`--untracked-files=all` so untracked files count) and
 *   its HEAD is already merged into the exact reset target; pruning and
 *   destroying default to dry-runs and refuse dirty/leased/unmerged work
 *   unless the caller passes the explicit flag.
 * - DEVIATIONS vs treehouse (see the scope doc): named-branch support (D1), no
 *   process scan/termination in release (D2 — reports instead of killing),
 *   lease holder identifies the session/agent rather than a PID (D3), and the
 *   pool state file is this package's own `treehouse-state.json` with
 *   treehouse-compatible field names — no byte-level interop claim (D4).
 *
 * Concurrency: pool-state mutations are serialized cross-process with
 * `@deepseek-ai/dsh-atomic-write`'s `writeFileAtomic` + `withFileLock` (the
 * same temp-rename + lock treehouse implements with a flock), and git
 * mutations additionally run under the in-process `withRepoLock` keyed on the
 * PRIMARY repo root so worktrees of one repository share one queue.
 * @module @hy-sde-org/dsh-git/worktree
 */

import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { GitService } from './service.ts'
import { withRepoLock } from './repo-lock.ts'

/** Machine-readable failure codes carried by {@link WorktreeError}. */
export type WorktreeErrorCode =
  | 'NotARepository'
  | 'UnsupportedRepository'
  | 'DefaultBranchUnknown'
  | 'LeaseMismatch'
  | 'UnknownWorktree'
  | 'DirtyWorktree'
  | 'UnlandedWorktree'
  | 'LeasedWorktree'
  | 'GitFailed'
  | 'MaxSlots'

/** A typed worktree-pool failure: semantic codes for the tool layer to branch on. */
export class WorktreeError extends Error {
  override readonly name = 'WorktreeError' as const
  readonly code: WorktreeErrorCode
  /** The worktree or pool path involved, when one exists. */
  readonly path: string | undefined

  constructor(code: WorktreeErrorCode, message: string, path?: string) {
    super(message)
    this.code = code
    this.path = path
  }
}

/** Pool-level settings (shareable as a tool config row). */
export interface WorktreeSettings {
  /**
   * Pool root directory holding one sub-directory per repository
   * (default `~/.treehouse`). Treated as a literal path — unlike treehouse it
   * is not treated as the parent of a `.treehouse` directory (documented
   * deviation D4; keep it explicit so an operator can point both tools at the
   * same root if interop ever matters).
   */
  root?: string
  /**
   * Default branch worktrees are cut from (default: inferred from
   * `refs/remotes/origin/HEAD`, then the current branch).
   */
  baseBranch?: string
  /** Fetch origin before acquiring (default true; skipped when no origin exists). */
  fetchBeforeAcquire?: boolean
  /** Max ms to wait for the cross-process pool-state lock (default 30000). */
  lockWaitMs?: number
  /**
   * Cap on total pooled slots for one repository (default 0 = unlimited).
   * `acquireWorktree` still reuses a provably-idle slot when the cap is
   * reached; it refuses to CUT a new slot and fails with code `MaxSlots`,
   * leaving release/prune/destroy (or raising the cap) as the fix.
   */
  maxSlots?: number
}

/** Per-acquire options. */
export interface AcquireOptions {
  /**
   * Cut HEAD at a NEW named branch instead of detached (DSH deviation D1, for
   * `commit_apply --push` / PR flows). The branch is created from the reset
   * target; a slot previously cut at the same branch name is the only slot
   * this option may reuse (D5).
   */
  branch?: string
  /** Cut from this branch, overriding `settings.baseBranch` and inference. */
  base?: string
  /** Lease holder label recorded in pool state (default `dsh`). */
  holder?: string
  /** Skip the origin fetch even when `settings.fetchBeforeAcquire` is true. */
  noFetch?: boolean
  signal?: AbortSignal
}

/** A completed lease acquisition (the caller's durable ownership record). */
export interface WorktreeLease {
  /** Absolute path of the worktree. */
  path: string
  /** Immutable per-acquisition identity; required to release this slot. */
  leaseId: string
  leaseHolder: string
  /** ISO timestamp of the acquisition. */
  leasedAt: string
  /** The branch this slot was cut from (explicit or inferred). */
  baseBranch: string
  /** Present when the slot was cut at a named branch (D1). */
  branch?: string
}

/** One pool slot as reported by {@link listWorktrees}. */
export interface WorktreeStatus {
  /** Pool-relative slot name (the numeric directory). */
  name: string
  path: string
  /** `leased` — durably reserved; `idle` — pooled and reusable; `damaged` — needs verification. */
  status: 'leased' | 'idle' | 'damaged'
  leased: boolean
  leaseId?: string
  leaseHolder?: string
  leasedAt?: string
  baseBranch: string
  /** The named branch this slot was cut at (D1), when any. */
  branch?: string
  /** True when `git status --porcelain --untracked-files=all` is non-empty. */
  dirty: boolean
  /** True when the worktree HEAD is an ancestor of the current reset target. */
  merged: boolean
  /** True when the worktree directory still exists. */
  exists: boolean
}

/** One prune candidate or skip item. */
export interface WorktreePruneItem {
  name: string
  path: string
  /** Human-readable reason: `removable`, or the skip reason. */
  reason: string
}

/** Result of {@link pruneWorktrees}. */
export interface WorktreePruneResult {
  candidates: WorktreePruneItem[]
  skipped: WorktreePruneItem[]
  /** Paths actually removed when `yes` was passed. */
  removed: string[]
}

/** Result of {@link destroyWorktree}. */
export interface WorktreeDestroyResult {
  path: string
  /** True when the slot was actually removed; false for a dry-run preview. */
  removed: boolean
}

/** Result of {@link releaseWorktree}. */
export interface WorktreeReleaseResult {
  path: string
  released: boolean
}

/** One entry of the on-disk pool state (treehouse-compatible field names, own file — D4). */
export interface WorktreeStateEntry {
  name: string
  path: string
  createdAt: string
  leased: boolean
  leaseId?: string
  leaseHolder?: string
  leasedAt?: string
  /** Explicit cut branch only (treehouse parity); empty for inferred. */
  baseBranch: string
  /** Named branch this slot was cut at (D1). */
  branch?: string
  /** True when this entry was rebuilt from disk after a corrupt/missing state file. */
  recovered?: boolean
}

/** The pool state file shape. */
export interface WorktreeState {
  schema: 1
  /** Canonical (realpath) primary repository root the pool belongs to. */
  repoRoot: string
  worktrees: WorktreeStateEntry[]
}

const STATE_FILE_NAME = 'treehouse-state.json'
const STATE_SCHEMA = 1 as const
const DEFAULT_ROOT = join(homedir(), '.treehouse')
const DEFAULT_LOCK_WAIT_MS = 30_000

function fail(code: WorktreeErrorCode, message: string, path?: string): never {
  throw new WorktreeError(code, message, path)
}

/** Never throw for a missing file; returns undefined. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Run a git command via the service, requiring exit 0 (WorktreeError on a non-zero exit). */
async function gitChecked(git: GitService, argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const run = await git.run(argv, { cwd, signal })
  if (run.exitCode !== 0) {
    throw new WorktreeError(
      'GitFailed',
      `git ${argv[0] ?? ''} failed (exit ${run.exitCode}): ${run.stderr.trim()}`,
      cwd,
    )
  }
  return run.stdout
}

/** Run a git command without throwing on a non-zero exit. */
async function gitMaybe(
  git: GitService,
  argv: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const run = await git.run(argv, { cwd, signal })
  return { ok: run.exitCode === 0, stdout: run.stdout, stderr: run.stderr }
}

function abortGuard(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WorktreeError('GitFailed', 'operation was aborted before it could start')
  }
}

/* ── repository discovery ──────────────────────────────────────────────── */

/**
 * The PRIMARY repository root (the main checkout) owning `cwd`, canonicalized
 * through realpath so one repository — main checkout or any linked worktree —
 * always resolves to one pool key, even across `/tmp` vs `/private/tmp`.
 * @param git - the git service.
 * @param cwd - a directory inside any checkout of the repository.
 * @param signal - optional abort.
 * @returns the canonical absolute primary root.
 */
export async function primaryRepoRoot(git: GitService, cwd: string, signal?: AbortSignal): Promise<string> {
  const inside = await gitMaybe(git, ['rev-parse', '--is-inside-work-tree'], cwd, signal)
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    fail('NotARepository', `not inside a git working tree: ${cwd}`, cwd)
  }
  const common = await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, signal })
  if (common.exitCode !== 0) {
    const fallback = await git.run(['rev-parse', '--git-common-dir'], { cwd, signal })
    if (fallback.exitCode !== 0) {
      fail('NotARepository', `cannot resolve the repository for ${cwd}: ${fallback.stderr.trim()}`, cwd)
    }
    let value = fallback.stdout.trim()
    if (!isAbsolute(value)) value = resolve(cwd, value)
    return realpath(dirname(value))
  }
  let value = common.stdout.trim()
  if (!isAbsolute(value)) value = resolve(cwd, value)
  if (basename(value) !== '.git') {
    fail('UnsupportedRepository', `bare or non-standard repository (git dir ${value})`, cwd)
  }
  return realpath(dirname(value))
}

/**
 * The pool directory for one primary repository root: `<root>/<repo>-<hash6>`
 * where the hash is the first 6 hex chars of sha256 over the canonical root
 * (stable offline; a remote URL is not consulted, unlike treehouse — D4).
 * @param settings - pool settings (root default `~/.treehouse`).
 * @param primaryRoot - canonical primary repository root.
 * @returns the absolute pool directory.
 */
export function resolveWorktreePoolRoot(settings: WorktreeSettings, primaryRoot: string): string {
  const root = settings.root ?? DEFAULT_ROOT
  const repoName = basename(primaryRoot)
  const hash = createHash('sha256').update(primaryRoot).digest('hex').slice(0, 6)
  return join(root, `${repoName}-${hash}`)
}

function stateFilePath(poolRoot: string): string {
  return join(poolRoot, STATE_FILE_NAME)
}

/* ── state file ────────────────────────────────────────────────────────── */

function parseState(text: string): WorktreeState | null {
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value !== 'object' || value === null) return null
    const record = value as Partial<WorktreeState>
    if (record.schema !== STATE_SCHEMA || !Array.isArray(record.worktrees)) return null
    return record as WorktreeState
  } catch {
    return null
  }
}

function serializeState(state: WorktreeState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

/**
 * Rebuild pool entries from the git worktree registry after a corrupt or
 * truncated state file (treehouse parity: entries are marked leased until a
 * human verifies them with `status`). Only worktrees under `poolRoot` are
 * adopted; everything else is left to git bookkeeping.
 * @returns the rebuilt entries, or null when the registry itself is unreadable.
 */
async function recoverEntriesFromDisk(
  git: GitService,
  repoRoot: string,
  poolRoot: string,
  signal?: AbortSignal,
): Promise<WorktreeStateEntry[] | null> {
  const list = await git.run(['worktree', 'list', '--porcelain'], { cwd: repoRoot, signal })
  if (list.exitCode !== 0) return null
  const prefix = poolRoot.endsWith(sep) ? poolRoot : `${poolRoot}${sep}`
  const entries: WorktreeStateEntry[] = []
  let current: { path?: string; branch?: string } | undefined
  const flush = (): void => {
    if (current?.path !== undefined && current.path.startsWith(prefix)) {
      const slot = dirname(current.path)
      entries.push({
        name: basename(slot),
        path: current.path,
        createdAt: new Date().toISOString(),
        leased: true,
        baseBranch: '',
        ...current.branch !== undefined ? { branch: current.branch } : {},
        recovered: true,
      })
    }
    current = undefined
  }
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('branch ')) {
      if (current !== undefined) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
    // A bare `detached` line is implied for detached slots; no extra state.
  }
  flush()
  return entries
}

/**
 * Load pool state, recovering from a corrupt/truncated/foreign file by
 * rebuilding from `git worktree list` (entries adopted as leased-unverified).
 */
async function loadState(
  git: GitService,
  repoRoot: string,
  poolRoot: string,
  signal?: AbortSignal,
): Promise<{ state: WorktreeState; recovered: boolean }> {
  const text = await readOptional(stateFilePath(poolRoot))
  if (text !== undefined && text.trim().length > 0) {
    const parsed = parseState(text)
    if (parsed !== null && parsed.repoRoot === repoRoot) {
      return { state: parsed, recovered: false }
    }
  }
  const rebuilt = (await recoverEntriesFromDisk(git, repoRoot, poolRoot, signal)) ?? []
  return { state: { schema: STATE_SCHEMA, repoRoot, worktrees: rebuilt }, recovered: true }
}

/* ── git predicates ────────────────────────────────────────────────────── */

/** True when the worktree has no tracked or untracked changes. */
async function isClean(git: GitService, worktreePath: string, signal?: AbortSignal): Promise<boolean> {
  const probe = await git.run(['status', '--porcelain', '--untracked-files=all'], { cwd: worktreePath, signal })
  return probe.exitCode === 0 && probe.stdout.trim().length === 0
}

/** True when the worktree HEAD is an ancestor of `target`. */
async function isMergedInto(
  git: GitService,
  worktreePath: string,
  target: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const probe = await gitMaybe(git, ['merge-base', '--is-ancestor', 'HEAD', target], worktreePath, signal)
  return probe.ok
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The repository's default branch: origin HEAD symbolic ref, then the current branch. */
async function inferDefaultBranch(git: GitService, repoRoot: string, signal?: AbortSignal): Promise<string> {
  const originHead = await gitMaybe(git, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoRoot, signal)
  if (originHead.ok) {
    const ref = originHead.stdout.trim()
    const prefix = 'refs/remotes/origin/'
    if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length)
  }
  const head = await gitMaybe(git, ['symbolic-ref', '--quiet', 'HEAD'], repoRoot, signal)
  if (head.ok) {
    const ref = head.stdout.trim()
    const prefix = 'refs/heads/'
    if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length)
  }
  fail('DefaultBranchUnknown', `cannot infer the default branch of ${repoRoot}; set settings.baseBranch or pass base`)
}

async function resolveTarget(
  git: GitService,
  repoRoot: string,
  explicit: string | undefined,
  settings: WorktreeSettings,
  signal?: AbortSignal,
): Promise<string> {
  const base = explicit ?? settings.baseBranch
  if (base !== undefined && base.length > 0) return base
  return inferDefaultBranch(git, repoRoot, signal)
}

/** The pool owning a worktree path: `<poolRoot>/<slot>/<repoName>` → `<poolRoot>`. */
function poolRootFromLeasePath(worktreePath: string): string {
  return dirname(dirname(worktreePath))
}

/* ── acquire ───────────────────────────────────────────────────────────── */

/**
 * Acquire a durable lease on one clean worktree slot. Never hands out a slot
 * that cannot be proven idle (unleased) and clean with its HEAD already merged
 * into the reset target; otherwise a new slot is cut. Holding the pool-state
 * file lock for the whole choose-cut-reset cycle makes concurrent acquires (in
 * any process) serialize, and `withRepoLock` on the primary root serializes
 * with other in-process git mutations of the same repository.
 *
 * The returned lease is the caller's durable ownership record:
 * `releaseWorktree` requires the exact `leaseId`, so a stale caller can never
 * release someone else's slot.
 * @param git - the git service.
 * @param cwd - any checkout (main or worktree) of the target repository.
 * @param settings - pool settings (root, default branch, fetch behavior).
 * @param options - per-acquire options (named branch, base, holder, noFetch, signal).
 * @returns the lease.
 */
export async function acquireWorktree(
  git: GitService,
  cwd: string,
  settings: WorktreeSettings = {},
  options: AcquireOptions = {},
): Promise<WorktreeLease> {
  abortGuard(options.signal)
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  const poolRoot = resolveWorktreePoolRoot(settings, repoRoot)
  await mkdir(poolRoot, { recursive: true })

  const target = await resolveTarget(git, repoRoot, options.base, settings, options.signal)

  return withFileLock(
    stateFilePath(poolRoot),
    async () => {
      // Serialize git mutations against other in-process callers of this repo.
      return withRepoLock(repoRoot, async () => {
        if (settings.fetchBeforeAcquire !== false && options.noFetch !== true) {
          const remote = await gitMaybe(git, ['remote', 'get-url', 'origin'], repoRoot, options.signal)
          if (remote.ok) {
            await gitChecked(git, ['fetch', 'origin'], repoRoot, options.signal)
          }
        }

        const { state } = await loadState(git, repoRoot, poolRoot, options.signal)
        const entries = state.worktrees
        const branch = options.branch

        // A reusable slot: unleased, unbroken, clean, and — critically — HEAD
        // already merged into the exact reset target; named-branch slots only
        // when the name matches (D5). Never reuse when safety is unprovable.
        const reusable = entries.find((entry) => {
          if (entry.leased || entry.recovered === true) return false
          if (branch !== undefined && entry.branch !== branch) return false
          return true
        })

        const atCap = settings.maxSlots !== undefined && settings.maxSlots > 0
          && entries.length >= settings.maxSlots
        // A cap limits NEW slots only: provable reuse is always allowed.
        const cutNew = (): Promise<WorktreeStateEntry> => {
          if (atCap) {
            throw new WorktreeError(
              'MaxSlots',
              `pool "${poolRoot}" is at its maxSlots cap (${settings.maxSlots}): no new slot can be cut — release a lease, prune/destroy an idle slot, or raise maxSlots`,
              poolRoot,
            )
          }
          return cutNewSlot(git, repoRoot, poolRoot, entries, target, branch, options.signal)
        }

        let entry: WorktreeStateEntry
        if (reusable !== undefined) {
          const clean = await isClean(git, reusable.path, options.signal)
          const merged = await isMergedInto(git, reusable.path, target, options.signal)
          const present = await exists(reusable.path)
          if (clean && merged && present) {
            // Proven reusable: park it at the target, then lease it below.
            entry = await reuseSlot(git, reusable, target, branch, options.signal)
          } else {
            // Safety unprovable: keep the slot untouched and cut a new one.
            entry = await cutNew()
          }
        } else {
          entry = await cutNew()
        }

        const leasedAt = new Date().toISOString()
        const leaseId = randomBytes(16).toString('hex')
        const updated: WorktreeStateEntry = {
          ...entry,
          leased: true,
          leaseId,
          leaseHolder: options.holder ?? 'dsh',
          leasedAt,
          baseBranch: options.base ?? settings.baseBranch ?? target,
          ...branch !== undefined ? { branch } : {},
          recovered: false,
        }
        state.worktrees = [
          ...state.worktrees.filter(item => !(item.name === updated.name && item.path === updated.path)),
          updated,
        ]
        await writeFileAtomic(stateFilePath(poolRoot), serializeState(state), { mode: 0o600 })

        return {
          path: updated.path,
          leaseId,
          leaseHolder: updated.leaseHolder ?? 'dsh',
          leasedAt,
          baseBranch: updated.baseBranch,
          ...branch !== undefined ? { branch } : {},
        }
      })
    },
    { waitMs: settings.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS },
  )
}

/** Park a proven-reusable slot at the reset target (named branch recreated — D5). */
async function reuseSlot(
  git: GitService,
  entry: WorktreeStateEntry,
  target: string,
  branch: string | undefined,
  signal?: AbortSignal,
): Promise<WorktreeStateEntry> {
  if (branch !== undefined) {
    await gitChecked(git, ['checkout', '-B', branch, target], entry.path, signal)
  } else {
    await gitChecked(git, ['checkout', '--detach', target], entry.path, signal)
  }
  return { ...entry, ...branch !== undefined ? { branch } : {} }
}

/** Cut a fresh slot: self-heal stale bookkeeping, then `worktree add`. */
async function cutNewSlot(
  git: GitService,
  repoRoot: string,
  poolRoot: string,
  entries: WorktreeStateEntry[],
  target: string,
  branch: string | undefined,
  signal?: AbortSignal,
): Promise<WorktreeStateEntry> {
  await gitChecked(git, ['worktree', 'prune'], repoRoot, signal)
  const used = new Set(entries.map(entry => entry.name))
  let slot = 1
  while (used.has(String(slot))) slot += 1
  const slotDir = join(poolRoot, String(slot))
  const path = join(slotDir, basename(repoRoot))
  if (branch !== undefined) {
    await gitChecked(git, ['worktree', 'add', '-b', branch, path, target], repoRoot, signal)
  } else {
    await gitChecked(git, ['worktree', 'add', '--detach', path, target], repoRoot, signal)
  }
  return {
    name: String(slot),
    path,
    createdAt: new Date().toISOString(),
    leased: false,
    baseBranch: '',
    ...branch !== undefined ? { branch } : {},
  }
}

/* ── release ───────────────────────────────────────────────────────────── */

/**
 * Release a leased worktree, clearing only the lease whose id matches. The
 * slot is parked: a non-forced release requires a clean tree (tracked AND
 * untracked) and then resets HEAD to the recorded base (or the inferred
 * default) at detached HEAD; `force` additionally runs `git clean -fdqx`.
 * D2: this engine never kills processes — a busy slot surfaces as a
 * {@link WorktreeError} with code `DirtyWorktree` instead.
 * @param git - the git service.
 * @param cwd - any checkout of the pool's repository (fallback pool resolution).
 * @param lease - the exact lease to release (`path` + `leaseId` from {@link acquireWorktree}).
 * @param options - `force`, `settings` (root), `signal`.
 */
export async function releaseWorktree(
  git: GitService,
  cwd: string,
  lease: { path: string; leaseId: string },
  options: { force?: boolean; settings?: WorktreeSettings; signal?: AbortSignal } = {},
): Promise<WorktreeReleaseResult> {
  abortGuard(options.signal)
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  // Prefer the pool the lease actually came from (settings-independent), then
  // fall back to the configured root so release still works after a restart
  // with a different tool config.
  let poolRoot = poolRootFromLeasePath(lease.path)
  if (await readOptional(stateFilePath(poolRoot)) === undefined) {
    poolRoot = resolveWorktreePoolRoot(options.settings ?? {}, repoRoot)
  }
  await mkdir(poolRoot, { recursive: true })
  return withFileLock(
    stateFilePath(poolRoot),
    async () => {
      const { state } = await loadState(git, repoRoot, poolRoot, options.signal)
      const entry = state.worktrees.find(item => item.path === lease.path)
      if (entry === undefined) fail('UnknownWorktree', `no pooled worktree at ${lease.path}`, lease.path)
      if (entry.leaseId !== lease.leaseId) {
        fail('LeaseMismatch', `lease ${lease.leaseId} does not own ${lease.path} (held by ${entry.leaseId ?? 'nobody'})`, lease.path)
      }
      return withRepoLock(repoRoot, async () => {
        if (!(await exists(lease.path))) {
          // The worktree is gone (external removal): drop the entry and prune bookkeeping.
          state.worktrees = state.worktrees.filter(item => item.path !== lease.path)
          await gitChecked(git, ['worktree', 'prune'], repoRoot, options.signal)
          await writeFileAtomic(stateFilePath(poolRoot), serializeState(state), { mode: 0o600 })
          return { path: lease.path, released: true }
        }
        const clean = await isClean(git, lease.path, options.signal)
        if (!clean && options.force !== true) {
          fail('DirtyWorktree', `worktree ${lease.path} has uncommitted changes; commit them or pass force`, lease.path)
        }
        const target = entry.baseBranch.length > 0
          ? entry.baseBranch
          : await resolveTarget(git, repoRoot, undefined, {}, options.signal)
        await gitChecked(git, ['checkout', '--detach', target], lease.path, options.signal)
        await gitChecked(git, ['reset', '--hard', target], lease.path, options.signal)
        if (!clean && options.force === true) {
          await gitChecked(git, ['clean', '-fdqx'], lease.path, options.signal)
        }
        state.worktrees = state.worktrees.map((item) => {
          if (item.path !== lease.path) return item
          const parked: WorktreeStateEntry = { ...item, leased: false, recovered: false }
          delete parked.leaseId
          delete parked.leaseHolder
          delete parked.leasedAt
          return parked
        })
        await writeFileAtomic(stateFilePath(poolRoot), serializeState(state), { mode: 0o600 })
        return { path: lease.path, released: true }
      })
    },
    { waitMs: 30_000 },
  )
}

/* ── list / prune / destroy ────────────────────────────────────────────── */

/**
 * Report every slot of the pool owning `cwd`. Read-only; never mutates pool
 * state. Status is computed live: `leased`, `idle` (clean + merged + present)
 * or `damaged` (recovered/unverified, missing, or dirty).
 */
export async function listWorktrees(
  git: GitService,
  cwd: string,
  options: { settings?: WorktreeSettings; signal?: AbortSignal } = {},
): Promise<WorktreeStatus[]> {
  abortGuard(options.signal)
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  const poolRoot = resolveWorktreePoolRoot(options.settings ?? {}, repoRoot)
  const text = await readOptional(stateFilePath(poolRoot))
  if (text === undefined) return []
  let entries = parseState(text)?.worktrees
  if (entries === undefined) {
    // Corrupt/truncated state: report a read-only rebuild so damage is visible.
    entries = (await recoverEntriesFromDisk(git, repoRoot, poolRoot, options.signal)) ?? []
  }
  const target = await resolveTarget(git, repoRoot, undefined, {}, options.signal).catch(() => '')
  const result: WorktreeStatus[] = []
  for (const entry of entries) {
    const present = await exists(entry.path)
    const dirty = present ? !(await isClean(git, entry.path, options.signal)) : true
    const merged = present && target.length > 0
      ? await isMergedInto(git, entry.path, target, options.signal)
      : false
    let status: WorktreeStatus['status']
    if (entry.recovered === true || (entry.leased && entry.leaseId === undefined)) status = 'damaged'
    else if (entry.leased) status = 'leased'
    else if (!present || dirty) status = 'damaged'
    else status = 'idle'
    result.push({
      name: entry.name,
      path: entry.path,
      status,
      leased: entry.leased,
      ...entry.leaseId !== undefined ? { leaseId: entry.leaseId } : {},
      ...entry.leaseHolder !== undefined ? { leaseHolder: entry.leaseHolder } : {},
      ...entry.leasedAt !== undefined ? { leasedAt: entry.leasedAt } : {},
      baseBranch: entry.baseBranch,
      ...entry.branch !== undefined ? { branch: entry.branch } : {},
      dirty,
      merged,
      exists: present,
    })
  }
  return result
}

/**
 * Produce (and with `yes`, execute) a prune plan for the pool owning `cwd`:
 * only unleased, clean slots whose HEAD is merged into the current reset target
 * are candidates; everything else is reported as skipped *without* removal.
 * `all` sweeps every pool under the configured root. Dry-run unless `yes`.
 */
export async function pruneWorktrees(
  git: GitService,
  cwd: string,
  options: { yes?: boolean; all?: boolean; settings?: WorktreeSettings; signal?: AbortSignal } = {},
): Promise<WorktreePruneResult> {
  abortGuard(options.signal)
  const settings = options.settings ?? {}
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  const defaultPool = resolveWorktreePoolRoot(settings, repoRoot)
  const scopes: Array<{ repoRoot: string; poolRoot: string }> = [{ repoRoot, poolRoot: defaultPool }]

  if (options.all === true) {
    const base = dirname(defaultPool)
    let names: string[] = []
    try {
      names = (await readdir(base, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      names = []
    }
    for (const name of names) {
      const pool = join(base, name)
      if (pool === defaultPool) continue
      scopes.push({ repoRoot: '', poolRoot: pool })
    }
  }

  const candidates: WorktreePruneItem[] = []
  const skipped: WorktreePruneItem[] = []
  const removed: string[] = []
  for (const scope of scopes) {
    const text = await readOptional(stateFilePath(scope.poolRoot))
    if (text === undefined) continue
    const parsed = parseState(text)
    if (parsed === null) continue
    const target = await resolveTarget(git, parsed.repoRoot, undefined, {}, options.signal).catch(() => '')
    let mutated = false
    for (const entry of [...parsed.worktrees]) {
      if (entry.leased) {
        skipped.push({ name: entry.name, path: entry.path, reason: 'leased' })
        continue
      }
      if (!(await exists(entry.path))) {
        skipped.push({ name: entry.name, path: entry.path, reason: 'missing' })
        continue
      }
      const clean = await isClean(git, entry.path, options.signal)
      const merged = target.length > 0
        ? await isMergedInto(git, entry.path, target, options.signal)
        : false
      if (!clean) {
        skipped.push({ name: entry.name, path: entry.path, reason: 'dirty' })
        continue
      }
      if (!merged) {
        skipped.push({ name: entry.name, path: entry.path, reason: 'not merged' })
        continue
      }
      candidates.push({ name: entry.name, path: entry.path, reason: 'removable' })
      if (options.yes === true) {
        await withRepoLock(parsed.repoRoot, async () => {
          await gitChecked(git, ['worktree', 'remove', '--force', entry.path], parsed.repoRoot, options.signal)
          await rm(dirname(entry.path), { recursive: true, force: true })
        })
        removed.push(entry.path)
        parsed.worktrees = parsed.worktrees.filter(item => item.path !== entry.path)
        mutated = true
      }
    }
    if (options.yes === true && mutated) {
      await writeFileAtomic(stateFilePath(scope.poolRoot), serializeState(parsed), { mode: 0o600 })
    }
  }
  return { candidates, skipped, removed }
}

/**
 * Destroy one pooled slot. Dry-run unless `yes`. Defaults refuse leased slots
 * (`includeLeased`) and dirty or unmerged work (`includeUnlanded`) — the same
 * guards as treehouse, with the same irreversible-data-loss semantics for the
 * unlanded case.
 */
export async function destroyWorktree(
  git: GitService,
  cwd: string,
  options: {
    /** Slot name (pool-relative) or absolute path under the pool. */
    name?: string
    path?: string
    yes?: boolean
    includeLeased?: boolean
    includeUnlanded?: boolean
    settings?: WorktreeSettings
    signal?: AbortSignal
  },
): Promise<WorktreeDestroyResult> {
  abortGuard(options.signal)
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  const poolRoot = resolveWorktreePoolRoot(options.settings ?? {}, repoRoot)
  const { state } = await loadState(git, repoRoot, poolRoot, options.signal)
  const entry = options.path !== undefined
    ? state.worktrees.find(item => item.path === options.path)
    : options.name !== undefined
      ? state.worktrees.find(item => item.name === options.name)
      : undefined
  if (entry === undefined) fail('UnknownWorktree', `no pooled worktree named ${String(options.name ?? options.path)}`, options.path)
  if (entry.leased && options.includeLeased !== true) {
    fail('LeasedWorktree', `worktree ${entry.path} is leased (${entry.leaseId ?? 'unverified'}); pass includeLeased to destroy`, entry.path)
  }
  if (options.yes !== true) {
    return { path: entry.path, removed: false }
  }
  return withFileLock(
    stateFilePath(poolRoot),
    async () => withRepoLock(repoRoot, async () => {
      const clean = await isClean(git, entry.path, options.signal)
      const target = await resolveTarget(git, repoRoot, undefined, {}, options.signal).catch(() => '')
      const merged = target.length > 0
        ? await isMergedInto(git, entry.path, target, options.signal)
        : clean
      if (!clean && options.includeUnlanded !== true) {
        fail('UnlandedWorktree', `worktree ${entry.path} is dirty; pass includeUnlanded to discard (irreversible)`, entry.path)
      }
      if (!merged && !clean && options.includeUnlanded !== true) {
        fail('UnlandedWorktree', `worktree ${entry.path} has unmerged work; pass includeUnlanded to discard (irreversible)`, entry.path)
      }
      await gitChecked(git, ['worktree', 'remove', '--force', entry.path], repoRoot, options.signal)
      await rm(dirname(entry.path), { recursive: true, force: true })
      const fresh = await loadState(git, repoRoot, poolRoot, options.signal)
      fresh.state.worktrees = fresh.state.worktrees.filter(item => item.path !== entry.path)
      await writeFileAtomic(stateFilePath(poolRoot), serializeState(fresh.state), { mode: 0o600 })
      return { path: entry.path, removed: true }
    }),
    { waitMs: 30_000 },
  )
}
