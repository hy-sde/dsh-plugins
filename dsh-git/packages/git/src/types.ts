/**
 * Shared types for the git service and its commit/review tools.
 * Port of the omp (oh-my-pi) commit data shapes — see LICENSE.
 * @module @hy-sde-org/dsh-git/types
 */

/** Conventional-commit type vocabulary. */
export type CommitType =
  | 'feat'
  | 'fix'
  | 'refactor'
  | 'perf'
  | 'docs'
  | 'test'
  | 'build'
  | 'ci'
  | 'chore'
  | 'style'
  | 'revert'
  | 'deps'
  | 'security'
  | 'config'
  | 'ux'
  | 'release'
  | 'hotfix'
  | 'infra'
  | 'init'
  | 'merge'
  | 'hack'
  | 'wip'

/** One conventional-commit type list entry. */
export interface ConventionalDetail {
  text: string
  /** Optional changelog category (kept for shape parity with omp). */
  changelogCategory?: string
  /** Whether this line is user-visible. */
  userVisible: boolean
}

/** Parsed conventional analysis for one commit. */
export interface ConventionalAnalysis {
  type: CommitType
  scope: string | null
  details: ConventionalDetail[]
  issueRefs: string[]
}

/** Per-file add/delete counts from `git diff --numstat`. */
export interface NumstatEntry {
  path: string
  additions: number
  deletions: number
}

/** One file section of a `diff --git` stream. */
export interface FileDiff {
  filename: string
  content: string
  additions: number
  deletions: number
  isBinary: boolean
}

/** One `@@` hunk of a file diff. */
export interface DiffHunk {
  /** Zero-based position among the file's hunks. */
  index: number
  /** The raw `@@ … @@` header line. */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The hunk header plus body, without the file header. */
  content: string
}

/** A file diff with its hunks parsed out (empty hunks for binary files). */
export interface FileHunks {
  filename: string
  isBinary: boolean
  hunks: DiffHunk[]
}

/** How much of one file a split-commit group selects. */
export type HunkSelector =
  | { type: 'all' }
  | { type: 'indices'; indices: number[] }
  | { type: 'lines'; start: number; end: number }

/** One file selection inside a split-commit group. */
export interface FileChange {
  path: string
  hunks: HunkSelector
}

/** One commit group in a split plan. */
export interface SplitCommitGroup {
  changes: FileChange[]
  type: CommitType
  scope: string | null
  summary: string
  details: ConventionalDetail[]
  issueRefs: string[]
  /** Human rationale the model writes (advisory, not validated). */
  rationale?: string
  /** Indices of groups this group depends on (must be acyclic). */
  dependencies: number[]
}

/** A complete split-commit plan. */
export interface SplitCommitPlan {
  commits: SplitCommitGroup[]
  warnings: string[]
}

/** Plain `git status --porcelain` summary counts. */
export interface GitStatusSummary {
  staged: number
  unstaged: number
  untracked: number
}

/** One recent-commit entry from `git log`. */
export interface GitLogEntry {
  hash: string
  shortHash: string
  subject: string
  authorName: string
  authorEmail: string
  date: string
}
