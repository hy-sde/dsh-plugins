/**
 * Agentic Automic Vault plumbing for the DeepSeek Harness: `ctx.av`, a
 * host-plane, read-only Automic Vault CLI service (scan / doctor / detectors /
 * hardeners / list over the subprocess seam) that the vault tools in
 * `@hy-sde-org/dsh-tool-av` resolve.
 *
 * The service is stateless per call, so it lives in the base bundle like
 * `ctx.git` / `ctx.browser`. It never releases stored Secret Values: the
 * value-touching verbs (`av inject` / `av proxy` / `av save` / `av harden`)
 * stay human-in-the-loop in a terminal the user controls.
 * @module @hy-sde-org/dsh-av
 */

import { Context } from '@deepseek-ai/cordis'
import { AvService } from './service.ts'
import type { Config } from './service.ts'

export * from './types.ts'
export * from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The av service: read-only Automic Vault CLI queries over subprocess. */
    av: AvService
  }
}

export { AvCommandError } from './service.ts'

/**
 * Register `ctx.av`. Host-plane row: the service owns no durable state and
 * shells out per call, so one instance across sessions is correct.
 * @param ctx - the host or agent-plane context (needs the `subprocess` seam).
 * @param config - service configuration (av path, timeouts, caps).
 */
export function apply(ctx: Context, config: Config = {}): void {
  new AvService(ctx, config)
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'av'

/**
 * The plugin core: registers the av services.
 *
 */
export default { name, apply }
