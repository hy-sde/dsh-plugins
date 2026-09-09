/**
 * Type shapes for the `ctx.vcs` service, mirroring the JSON payloads of the
 * `pi-vcs` CLI (repo-info) and its JSON-lines watch protocol. Field names are
 * kept 1:1 with the CLI contract so a newer `pi-vcs` release shows up as
 * parsed data rather than a schema drift.
 * @module @hy-sde-org/dsh-vcs/types
 */

/** `pi-vcs repo-info <dir>` JSON payload. */
export interface VcsRepoInfo {
  /** Checkout root (the directory containing the `.git` entry). */
  root: string
  /** Resolved git directory (worktree-private for linked worktrees). */
  gitDir: string
  /** Current branch name, or `null` on a detached HEAD. */
  branch?: string | null
}

/** Plain status summary, mirroring the harness `ctx.git.status` shape. */
export interface VcsStatusSummary {
  /** Line counts from `git status --porcelain` column 1 (renames count too). */
  staged: number
  /** Line counts from `git status --porcelain` column 2. */
  unstaged: number
  /** `??` entries; untracked directories collapse to one entry like git. */
  untracked: number
}

/** CLI diff output mode (`--name-only`/`--numstat` flags on the diff verbs). */
export type VcsDiffMode = 'text' | 'name-only' | 'numstat'

/** Diff target selectors shared by the read surfaces. */
export interface VcsDiffOptions {
  /** True for index→HEAD when `base`/`head` are unset. */
  cached?: boolean
  /** Base revision; head omitted → base→worktree. */
  base?: string
  /** Head revision (only with `base`). */
  head?: string
}

/** One `pi-vcs watch` event (JSON-lines on stdout). */
export interface VcsWatchEvent {
  /** `head` — the repository HEAD moved. */
  event: 'head'
  /** 1-based event sequence within this watch session. */
  seq: number
}

/** Capabilities present when the service was reached. */
export interface VcsProbe {
  /** Whether the `pi-vcs` CLI is reachable and answers `pi-vcs --version`. */
  available: boolean
  /** CLI-reported version (e.g. `0.1.0`) when available. */
  version?: string
  /** Human-readable failure reason when unavailable. */
  reason?: string
}
