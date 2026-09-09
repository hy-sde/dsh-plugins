/**
 * Agentic browser for the DeepSeek Harness: `ctx.browser`, a host-plane
 * browser service (launch with stealth, CDP-attach, and local relay over the
 * user's own tabs via the companion Chrome extension) that the browser tool
 * in `@hy-sde-org/dsh-tool-browser` resolves.
 *
 * Port of omp (oh-my-pi)'s browser tool — with stealth + relay/CDP-attach
 * (see LICENSE). The service holds no durable state and
 * owns its browser process(es) per session, so it mounts in the base bundle
 * alongside `ctx.git` / `ctx.memory`; the model-facing tools resolve it from
 * a preset row.
 * @module @hy-sde-org/dsh-browser
 */

import { Context } from '@deepseek-ai/cordis'
import { BrowserService } from './service.ts'
import type { BrowserConfig } from './types.ts'

export * from './types.ts'
export * from './aria.ts'
export * from './stealth.ts'
export * from './service.ts'
export * from './relay/kind.ts'
export * from './relay/protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The browser service: tabs over launch/CDP-attach/relay backends. */
    browser: BrowserService
  }
}

export { BrowserService } from './service.ts'

/**
 * Register `ctx.browser`. Host-plane row: browser processes must be shared
 * across sessions within one process so tabs survive; the service is disposed
 * with its owning context.
 * @param ctx - the host-plane plugin context.
 * @param config - service configuration (browser path, viewport, relay).
 */
export function apply(ctx: Context, config: BrowserConfig = {}): void {
  void new BrowserService(ctx, config)
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'browser'

export default { name, apply }
