/**
 * Model-facing agentic git tools over the host `ctx.git` service: `commit`
 * (analyze + suggest a split-plan skeleton), `commit_apply` (validate and
 * execute a model-authored split plan with dependency order, cycle rejection,
 * lock-file placement, and atomic hunk-staged commits), `review` (parallel
 * reviewer subagents with P0–P3 findings and a ship/reject verdict), and
 * `worktree` (a persistent pool of isolated git worktrees with durable
 * leases — the firstmate/treehouse model), plus a `git:tools` system-prompt
 * section.
 *
 * Port of omp (oh-my-pi)'s commit + review surface for the DeepSeek Harness —
 * see LICENSE. Agent-plane: this package mounts as a
 * preset row and resolves the host `git` service; it registers no service of
 * its own. Deterministic validation and execution mechanics are direct ports
 * of omp's `commit/agentic/*` and `commit/git/*` — the model does the planning
 * between `commit` and `commit_apply`, not a hidden LLM session.
 * @module @hy-sde-org/dsh-tool-git
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@hy-sde-org/dsh-git'
import { applyCommitTool, applyCommitApplyTool } from './commit.ts'
import { applyReviewTool } from './review.ts'
import { applyWorktreeTool } from './worktree.ts'
import type { WorktreeToolConfig } from './worktree.ts'
import { buildGitPromptSection } from './prompt.ts'
import type { GitPromptConfig } from './prompt.ts'

/** Plugin configuration. */
export interface Config extends GitPromptConfig, WorktreeToolConfig {
  /** `ctx.subagents` provider name for review reviewers (default `spawn`). */
  reviewProvider?: string
  /** Cap on parallel review reviewers (default 4). */
  maxReviewers?: number
  /** Char cap on one reviewer's inline diff (default 40000). */
  maxReviewerDiffChars?: number
  /** Char cap on the diff in a `commit` analysis (default 60000). */
  maxDiffChars?: number
}

export {
  buildGitPromptSection,
} from './prompt.ts'
export type { GitPromptConfig } from './prompt.ts'
export { applyCommitTool, applyCommitApplyTool, resolveCwd } from './commit.ts'
export { openReads } from './reads.ts'
export type { ReadSurface, ReadRange } from './reads.ts'
export type { CommitToolConfig, CommitAnalysisValue, CommitApplyValue } from './commit.ts'
export { applyReviewTool } from './review.ts'
export type { ReviewToolConfig, SliceResult } from './review.ts'
export { applyWorktreeTool } from './worktree.ts'
export type { WorktreeToolConfig } from './worktree.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-git'

/** Services consumed by this plugin (git resolved from the host bundle). */
export const inject = ['tools', 'systemPrompt', 'git']

/**
 * Register the four git tools and the `git:tools` prompt section.
 * @param ctx - the agent-plane plugin context (injects `tools`, `systemPrompt`, `git`; `vcs` is resolved opportunistically).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  applyCommitTool(ctx, { ...config.maxDiffChars !== undefined ? { maxDiffChars: config.maxDiffChars } : {} })
  applyCommitApplyTool(ctx)
  applyReviewTool(ctx, {
    ...config.reviewProvider !== undefined ? { provider: config.reviewProvider } : {},
    ...config.maxReviewers !== undefined ? { maxReviewers: config.maxReviewers } : {},
    ...config.maxReviewerDiffChars !== undefined ? { maxReviewerDiffChars: config.maxReviewerDiffChars } : {},
  })
  applyWorktreeTool(ctx, {
    ...config.worktreeRoot !== undefined ? { worktreeRoot: config.worktreeRoot } : {},
    ...config.worktreeBaseBranch !== undefined ? { worktreeBaseBranch: config.worktreeBaseBranch } : {},
    ...config.worktreeFetchBeforeAcquire !== undefined ? { worktreeFetchBeforeAcquire: config.worktreeFetchBeforeAcquire } : {},
    ...config.worktreeLockWaitMs !== undefined ? { worktreeLockWaitMs: config.worktreeLockWaitMs } : {},
  })
  ctx.systemPrompt.section(buildGitPromptSection(config))
}

export default { name, inject, apply }
