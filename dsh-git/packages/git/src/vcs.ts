/**
 * TS contract port of omp's native `pi-vcs` surface (see `@oh-my-pi/pi-natives/vcs`),
 * reduced to what a pure-TS/Node fork can express: the {@link VcsError} taxonomy,
 * repository discovery with feature-gated `require()`, newline-safe patch joining,
 * and HEAD stat-poll watching. The 60-method `VcsGitRepo` handle is NOT ported —
 * the fork already shells out through `GitService` (`ctx.git`) per call, so a
 * handle would duplicate that seam; what pi-vcs adds is typed error branching
 * and the small discovery/lock/watch vocabulary.
 *
 * The fork has no Rust/N-API pipeline and no Jujutsu support, so `jj`, `clone`,
 * `detachGitDir` and the `gix`-backed read/write verbs are out of scope; the
 * portable contract here is: `repo()/git()/gitInfo()` discovery, `require()` /
 * `requireGit()` feature gates, the `VcsError` taxonomy with `isVcsError` /
 * `isEmptyCherryPick`, `joinPatches` (newline-safe), and `watch()` /
 * `HEAD_WATCH_INTERVAL_MS`. `withRepoLock` lives in `./repo-lock.ts` and keys on
 * `repo(cwd).primaryRoot()`.
 * @module @hy-sde-org/dsh-git/vcs
 */

import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { statSync, watchFile, unwatchFile, type Stats } from 'node:fs'

/** Portable capabilities that differ between backends (git-only here). */
export type VcsFeature = 'stagedDiff' | 'revDiff'

/** Machine-readable codes carried by a {@link VcsError}. */
export type VcsErrorCode =
  | 'NotARepository'
  | 'RefNotFound'
  | 'ObjectNotFound'
  | 'EmptyCherryPick'
  | 'Conflict'
  | 'PatchFailed'
  | 'Cli'
  | 'CliTimeout'
  | 'Io'
  | 'Backend'
  | 'Canceled'
  | 'Unsupported'

/**
 * A typed VCS failure: a real `Error` with `name: "VcsError"`, a
 * machine-readable `code`, and CLI-result fields. Non-CLI failures synthesize
 * `exitCode: 1` and mirror `message` into `stderr`. Identify with
 * {@link isVcsError} — upstream constructs these on the JS thread so identity
 * rides on `name`, and this port keeps that contract.
 */
export class VcsError extends Error {
  override readonly name = 'VcsError' as const
  readonly code: VcsErrorCode
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string

  constructor(code: VcsErrorCode, message: string, fields: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    super(message)
    this.code = code
    this.exitCode = fields.exitCode ?? 1
    this.stdout = fields.stdout ?? ''
    this.stderr = fields.stderr ?? message
  }
}

/**
 * True when `error` is a VCS failure (identity rides on `name`, like upstream).
 * @param error - the value to test.
 * @returns true for a {@link VcsError} instance.
 */
export function isVcsError(error: unknown): error is VcsError {
  return error instanceof Error && error.name === 'VcsError'
}

/**
 * True when a cherry-pick failed because the commit is already applied.
 * @param error - the value to test.
 * @returns true for an `EmptyCherryPick` {@link VcsError}.
 */
export function isEmptyCherryPick(error: unknown): error is VcsError & { code: 'EmptyCherryPick' } {
  return isVcsError(error) && error.code === 'EmptyCherryPick'
}

/**
 * Construct a {@link VcsError} (upstream `vcsError` factory).
 * @param code - the machine-readable error code.
 * @param message - the human-readable message.
 * @param fields - optional `exitCode`/`stdout`/`stderr` fields.
 * @returns the constructed error.
 */
export function vcsError(
  code: VcsErrorCode,
  message: string,
  fields: { exitCode?: number; stdout?: string; stderr?: string } = {},
): VcsError {
  return new VcsError(code, message, fields)
}

/** Repository metadata only (sync, cheap). */
export interface VcsGitRepoInfo {
  /** Cheapest discovered working-tree root (the first `.git` ancestor). */
  root: string
  /** The `.git` directory path (or, for worktrees, the primary git dir). */
  gitDir: string
}

/** A discovered repo's sync metadata plus derived helpers. */
export interface VcsRepo {
  /** Backend kind (`"git"` in this port). */
  kind: 'git'
  /** Checkout or workspace root. */
  root: string
  /** The `.git` directory path. */
  gitDir: string
  /** Filesystem target to watch for repository-head changes. */
  watchTarget: string
  /** Whether this backend implements a portable feature. */
  supports(feature: VcsFeature): boolean
}

/* ── discovery ─────────────────────────────────────────────────────────── */

function looksLikeGitDir(dir: string): boolean {
  try {
    // node:fs sync stat — `.git` is either a directory (normal repo) or a
    // file (a worktree pointer `gitdir: <path>`); both are discoverable here.
    statSync(dir)
    return true
  } catch {
    return false
  }
}

/**
 * Walk up from `dir` to the nearest ancestor holding a `.git` entry, or null.
 * @param dir - the directory to start the walk from.
 * @returns the repo info, or `null` when no `.git` ancestor exists.
 */
export function gitInfo(dir: string): VcsGitRepoInfo | null {
  let current = normalize(dir)
  const root = dirname(current)
  for (;;) {
    const candidate = join(current, '.git')
    if (looksLikeGitDir(candidate)) {
      return { root: current, gitDir: candidate }
    }
    if (current === root) return null
    current = root
  }
}

/**
 * Discover the repository owning `dir`; `null` outside any repository.
 * Sync (cheap fs walk) for render paths; async callers that already shell out
 * should prefer `GitService`.
 * @param dir - the directory to discover in.
 * @returns the repo handle, or `null` outside a repository.
 */
export function repo(dir: string): VcsRepo | null {
  const info = gitInfo(dir)
  if (info === null) return null
  return {
    kind: 'git',
    root: info.root,
    gitDir: info.gitDir,
    watchTarget: join(info.gitDir, 'HEAD'),
    supports: (): boolean => true,
  }
}

/**
 * Like {@link repo}, asserting any requested backend capabilities.
 * @param dir - the directory to discover in.
 * @param features - zero or more capabilities to assert.
 * @returns the repo handle (throws `NotARepository` outside a repository).
 */
export function require(dir: string, ...features: VcsFeature[]): VcsRepo {
  const discovered = repo(dir)
  if (!discovered) {
    throw vcsError('NotARepository', `not a repository: ${dir}`)
  }
  for (const feature of features) {
    if (!discovered.supports(feature)) {
      throw vcsError('Unsupported', `\`${feature}\` is not supported on a ${discovered.kind} repository`)
    }
  }
  return discovered
}

/**
 * Like `repo`, but throws a `NotARepository` {@link VcsError}.
 * @param dir - the directory to discover in.
 * @returns the repo handle.
 */
export function requireGit(dir: string): VcsRepo {
  const repository = repo(dir)
  if (!repository) {
    throw vcsError('NotARepository', `not a repository: ${dir}`)
  }
  return repository
}

/**
 * Whether the nearest VCS ancestor is jj, making git automation unsafe.
 * @param _dir - the directory to inspect (unused; no jj backend in this fork).
 * @returns always `false` in this port.
 */
export function isPureJj(_dir: string): boolean {
  // The fork has no Jujutsu backend; always false.
  return false
}

/* ── patch joining ─────────────────────────────────────────────────────── */

/**
 * Join patch fragments verbatim, adding one final newline only when absent.
 * Mirrors pi-vcs `join_patches`: parts are NOT re-joined with separators and
 * trailing newlines are NOT collapsed, so a `GIT binary patch` terminator
 * (a blank line after the payload) survives byte-exact (#8899).
 * @param parts - the patch fragments to join, in order.
 * @returns the joined patch text.
 */
export function joinPatches(parts: readonly string[]): string {
  let joined = ''
  for (const part of parts) {
    joined += part
    if (!part.endsWith('\n')) {
      joined += '\n'
    }
  }
  return joined
}

/* ── HEAD watching ─────────────────────────────────────────────────────── */

/** Stat-poll interval for {@link watch}. */
export const HEAD_WATCH_INTERVAL_MS = 1000

/**
 * Watch a repository for head changes; returns a disposer.
 * Stat-polls via `fs.watchFile` instead of `fs.watch`: backends may atomically
 * replace the watched entry, permanently silencing inotify-backed watchers.
 * @param repo - the repository returned by {@link repo} / {@link require}.
 * @param onChange - called whenever the repository head changes.
 * @param intervalMs - stat-poll interval in ms.
 * @returns a disposer that stops watching.
 */
export function watch(repo: VcsRepo, onChange: () => void, intervalMs: number = HEAD_WATCH_INTERVAL_MS): () => void {
  const target = repo.watchTarget
  const listener = (curr: Stats, prev: Stats): void => {
    if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino || curr.size !== prev.size) onChange()
  }
  watchFile(target, { interval: intervalMs }, listener).unref()
  return () => { unwatchFile(target, listener) }
}

/**
 * Worktree-relative prefix of a directory (pi-vcs `prefixOf`); null outside.
 * @param repo - the repository handle.
 * @param dir - an absolute (or repo-relative) path inside the worktree.
 * @returns the worktree-relative prefix, or `null` for the root/outside paths.
 */
export function prefixOf(repo: VcsRepo, dir: string): string | null {
  const abs = isAbsolute(dir) ? normalize(dir) : join(repo.root, dir)
  const relative = abs.startsWith(`${repo.root}${sep}`) ? abs.slice(repo.root.length + sep.length) : null
  if (relative === null) return null
  return relative.length === 0 ? null : relative
}
