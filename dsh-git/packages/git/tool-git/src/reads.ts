/**
 * Read-preference routing for the git tools (see LICENSE): every commit /
 * review READ surface resolves through the native `pi-vcs` CLI (`ctx.vcs`)
 * when its probe is clean, with the TS/git-CLI `ctx.git` service as the
 * fallback. Mutation inputs — `stageHunks` raw diffs, `commit` trees —
 * always stay on `ctx.git`; this facade deliberately has no add/commit/apply.
 *
 * The facade is created once per tool execution (a single probe), so the
 * read surfaces share one backend decision for that call.
 * @module @hy-sde-org/dsh-tool-git/reads
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GitService, GitStatusSummary, NumstatEntry } from '@hy-sde-org/dsh-git'
import { parseNumstat } from '@hy-sde-org/dsh-git'

/**
 * Minimal structural shape of a host `ctx.vcs` service as this facade
 * consumes it. `@deepseek-ai/dsh-vcs` is NOT published to npm (it exists only
 * inside the DeepSeek Harness fork), so the standalone declares the narrow
 * surface it needs instead of importing the package; any host that registers
 * a compatible `vcs` service (probe + repo-info + diff verbs) satisfies this
 * type, and the facade degrades to `ctx.git` when the service is absent.
 */
export interface VcsService {
  /** Whether the native CLI is reachable and answers a version probe. */
  probe(): Promise<{ available: boolean; version?: string; reason?: string }>
  /** Repository discovery; `null` when `dir` is outside any checkout. */
  repoInfo(dir: string): Promise<{ root: string; gitDir: string; branch?: string | null } | null>
  changedFiles(dir: string, options?: ReadRange, signal?: AbortSignal): Promise<string[]>
  status(dir: string, signal?: AbortSignal): Promise<GitStatusSummary>
  numstat(dir: string, options?: ReadRange, signal?: AbortSignal): Promise<string>
  branch(dir: string): Promise<string | undefined>
  diff(dir: string, options?: ReadRange, signal?: AbortSignal): Promise<string>
}

/** Range selectors shared by the read surfaces (mirrors `git` diff options). */
export interface ReadRange {
  /** True for index→HEAD when `base`/`head` are unset. */
  cached?: boolean
  /** Base revision; head omitted → base→worktree. */
  base?: string
  /** Head revision (only with `base`). */
  head?: string
}

/** The read-only git surface the commit/review tools consume. */
export interface ReadSurface {
  /** Which backend served this facade (for diagnostics/tests). */
  readonly backend: 'vcs' | 'git'
  /** Whether `cwd` is inside a git working tree. */
  isRepo(): Promise<boolean>
  /** Changed file names (destination path for renames). */
  changedFiles(options?: ReadRange): Promise<string[]>
  /** Staged/unstaged/untracked status counts. */
  status(): Promise<GitStatusSummary>
  /** Parsed numstat entries (binary rows carry `-` counts). */
  numstat(options?: ReadRange): Promise<NumstatEntry[]>
  /** Current branch name, or undefined when detached. */
  branch(): Promise<string | undefined>
  /** Raw git-compatible unified diff text for one range. */
  diffText(options?: ReadRange): Promise<string>
}

/** Backend over `ctx.vcs` (native `pi-vcs` CLI; probe already clean). */
class VcsReads implements ReadSurface {
  readonly backend = 'vcs' as const
  constructor(
    private readonly vcs: VcsService,
    private readonly cwd: string,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async isRepo(): Promise<boolean> {
    return (await this.vcs.repoInfo(this.cwd)) !== null
  }

  async changedFiles(options: ReadRange = {}): Promise<string[]> {
    return this.vcs.changedFiles(this.cwd, options, this.signal)
  }

  async status(): Promise<GitStatusSummary> {
    return this.vcs.status(this.cwd, this.signal)
  }

  async numstat(options: ReadRange = {}): Promise<NumstatEntry[]> {
    return parseNumstat(await this.vcs.numstat(this.cwd, options, this.signal))
  }

  async branch(): Promise<string | undefined> {
    return this.vcs.branch(this.cwd)
  }

  async diffText(options: ReadRange = {}): Promise<string> {
    return this.vcs.diff(this.cwd, options, this.signal)
  }
}

/** Backend over `ctx.git` (TS/git-CLI). */
class GitBackendReads implements ReadSurface {
  readonly backend = 'git' as const
  constructor(
    private readonly git: GitService,
    private readonly cwd: string,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async isRepo(): Promise<boolean> {
    return this.git.isRepo(this.cwd, this.signal)
  }

  async changedFiles(options: ReadRange = {}): Promise<string[]> {
    const all: Record<string, unknown> = { ...options }
    if (this.signal !== undefined) all.signal = this.signal
    return this.git.diff.changedFiles(
      this.cwd,
      all,
    )
  }

  async status(): Promise<GitStatusSummary> {
    return this.git.status(this.cwd, this.signal)
  }

  async numstat(options: ReadRange = {}): Promise<NumstatEntry[]> {
    const all: { cached?: boolean; signal?: AbortSignal } = { ...options }
    if (this.signal !== undefined) all.signal = this.signal
    return this.git.diff.numstat(this.cwd, all)
  }

  async branch(): Promise<string | undefined> {
    return this.git.branch(this.cwd, this.signal)
  }

  async diffText(options: ReadRange = {}): Promise<string> {
    return this.git.diffText(this.cwd, { ...options, binary: true }, this.signal)
  }
}

/**
 * Open a read facade for one tool execution: prefer `ctx.vcs` when the host
 * bundle registered it and its probe reports a clean `pi-vcs` binary, else
 * fall back to `ctx.git`. Never throws on the probe.
 * @param ctx - the agent-plane plugin context (injects `git`; `vcs` optional).
 * @param cwd - working directory inside the repository under review.
 * @param signal - optional abort, forwarded to the active backend.
 * @returns a read facade bound to the chosen backend (`vcs` when its probe
 * is clean, else `git`).
 */
export async function openReads(
  ctx: Context,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ReadSurface> {
  const vcs = ctx.get('vcs')
  if (vcs !== undefined) {
    const probe = await vcs.probe()
    if (probe.available) return new VcsReads(vcs, cwd, signal)
  }
  return new GitBackendReads(ctx.git, cwd, signal)
}
