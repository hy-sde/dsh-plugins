/**
 * Agentic git plumbing for the DeepSeek Harness: `ctx.git`, a host-plane git
 * CLI service (diff capture/parsing, status, hunk staging, commit/push/log)
 * that the commit and review tools in `@hy-sde-org/dsh-tool-git` resolve.
 *
 * Port of omp (oh-my-pi)'s git layer — see LICENSE. The
 * service is stateless per call, so it lives in the base bundle like
 * `ctx.memory` / `ctx.internalUrls`; session-scoped concerns (which repo the
 * tools act on) come from the calling agent's session cwd at call time.
 * @module @hy-sde-org/dsh-git
 */

import { Context } from '@deepseek-ai/cordis'
import { GitService } from './service.ts'
import type { Config } from './service.ts'

export * from './types.ts'
export * from './service.ts'
export * from './diff.ts'
export * from './topo-sort.ts'
export * from './lock-files.ts'
export * from './trivial.ts'
export * from './commit-message.ts'
export * as vcs from './vcs.ts'
export * from './repo-lock.ts'
export * from './worktree.ts'
export * as conventional from './conventional/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The git service: read/write git primitives over the subprocess seam. */
    git: GitService
  }
}

export { GitCommandError } from './service.ts'

/**
 * Register `ctx.git`. Host-plane row: the service owns no durable state and
 * shells out per call, so one instance across sessions is correct.
 * @param ctx - the host or agent-plane context (needs the `subprocess` seam).
 * @param config - service configuration (git path, timeouts, caps).
 */
export function apply(ctx: Context, config: Config = {}): void {
  new GitService(ctx, config)
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'git'

export default { name, apply }
