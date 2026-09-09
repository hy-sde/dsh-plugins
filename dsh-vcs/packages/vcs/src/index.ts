/**
 * Native vcs plumbing for the DeepSeek Harness: `ctx.vcs`, a host-plane
 * service over the `pi-vcs` CLI — the narrow native slice of the omp vcs
 * surface (git rev-diffs and staged diffs rendered in-process by gitoxide,
 * plus a HEAD-change watch companion) — modeled on `ctx.av`.
 *
 * The service is stateless per call, so it lives in the base bundle like
 * `ctx.git` / `ctx.av`. It is purely additive and feature-detected: the git
 * service (`ctx.git`, TS/git-CLI) stays the default path, and these surfaces
 * resolve only when a user-installed `pi-vcs` binary is reachable (config →
 * `DSH_VCS_PATH` → PATH) and probing clean. No jj backend, no mutation verbs.
 * @module @hy-sde-org/dsh-vcs
 */

import { Context } from '@deepseek-ai/cordis'
import { VcsService } from './service.ts'
import type { Config } from './service.ts'

export * from './types.ts'
export * from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The vcs service: narrow native git diff + watch queries over subprocess. */
    vcs: VcsService
  }
}

export { VcsCommandError } from './service.ts'

/**
 * Register `ctx.vcs`. Host-plane row: the service owns no durable state and
 * shells out per call, so one instance across sessions is correct.
 * @param ctx - the host or agent-plane context (needs the `subprocess` seam).
 * @param config - service configuration (pi-vcs path, timeouts, caps).
 */
export function apply(ctx: Context, config: Config = {}): void {
  new VcsService(ctx, config)
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'vcs'

/**
 * The plugin core: registers the vcs service.
 *
 */
export default { name, apply }
