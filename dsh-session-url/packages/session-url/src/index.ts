/**
 * The `session://` internal-URL scheme, registered into the shared
 * internal-URL registry (`ctx.internalUrls`) so internal-URL-aware read/grep
 * tools can navigate the harness's own session history as files.
 *
 * Host-plane: the handler lives with the registry it extends and reads the
 * live-preferred logical corpus from `ctx.sessionQuery` — an exact-read
 * service that works even when a deployment disables content search
 * (`openAt: 'never'`); only `session://search` degrades there.
 *
 * Standalone port: `@hy-sde-org/dsh-session-url` vendors the small
 * parse/router/types surface of the fork-only `@deepseek-ai/dsh-internal-urls`
 * (see src/vendor/internal-urls) so it can compile and test with no dependency
 * on an unpublished package. At runtime the plugin still consumes the real
 * registry service (`ctx.internalUrls`), e.g. the standalone
 * `@hy-sde-org/dsh-internal-urls` package.
 * @module @hy-sde-org/dsh-session-url
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import { SessionProtocolHandler } from './handler.ts'
import type { ProtocolHandler } from './vendor/internal-urls/types.ts'

export * from './handler.ts'
export { SessionProtocolHandler }

/**
 * The minimal `ctx.internalUrls` surface this plugin consumes (structural).
 * The real service comes from the internal-URL registry package
 * (`@hy-sde-org/dsh-internal-urls`); only the `register` shape is needed here,
 * so the vendored types keep the package dependency-free.
 */
export interface InternalUrlRegistry {
  /** Register (or replace) the handler for its scheme. Returns a disposer. */
  register(handler: ProtocolHandler): () => void
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'session-url'

/**
 * Services this row requires to register the scheme handler. Declared as hard
 * injects so Cordis guarantees activation order: the sqlite engine publishes
 * `sessionQuery` synchronously at the start of its own apply, and this plugin
 * must not race ahead of it. When an assembly provides neither `internalUrls`
 * nor `sessionQuery`, the row simply stays dormant ("waiting for …") instead
 * of throwing and failing boot.
 */
export const inject = ['internalUrls', 'sessionQuery']

/**
 * Register the `session://` scheme into the mounted internal-URL registry.
 * Requires both `ctx.internalUrls` and `ctx.sessionQuery` (declared above).
 */
export function apply(ctx: Context): void {
  const internalUrls = ctx.get('internalUrls') as InternalUrlRegistry | undefined
  if (internalUrls === undefined) {
    throw new Error('session-url requires ctx.internalUrls (mount the internal-URL registry package first)')
  }
  const disposer = internalUrls.register(new SessionProtocolHandler(ctx.sessionQuery))
  ctx.effect(() => {
    return () => {
      disposer()
    }
  })
}

/** Cordis plugin object (loader reads `inject` from this shape). */
export default { name, inject, apply }
