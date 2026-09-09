/**
 * Conventional-commit domain types for the `conventional/` module.
 * Ported from omp's `packages/coding-agent/src/commit/types.ts` (the shapes
 * the unified `conventional/` service operates on).
 * @module @hy-sde-org/dsh-git/conventional/types
 */

/** Conventional-commit type vocabulary (llm-git canonical, 22 entries). */
export type CommitType =
  | 'feat'
  | 'fix'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'chore'
  | 'style'
  | 'perf'
  | 'build'
  | 'ci'
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

/** Changelog categories. */
export type ChangelogCategory =
  | 'Breaking Changes'
  | 'Added'
  | 'Changed'
  | 'Deprecated'
  | 'Removed'
  | 'Fixed'
  | 'Security'

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
  summary?: string
  details: ConventionalDetail[]
  issueRefs: string[]
}

/** A ready-to-commit conventional message. */
export interface ConventionalCommit {
  type: CommitType
  scope: string | null
  summary: string
  body: string[]
  footers: string[]
}
