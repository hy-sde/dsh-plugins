/**
 * Package-owned invariant companion for `@hy-sde-org/dsh-internal-urls`.
 * @module @hy-sde-org/dsh-internal-urls/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@hy-sde-org/dsh-internal-urls'

/** Cordis companion plugin name. */
export const name = 'internal-urls-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime event invariant: the router validates handlers at registration
 * time (scheme shape, single handler per scheme), and every resolution result
 * passes through the router which stamps immutability. The conflict history is
 * session-scoped mutable state that the read/write tools verify against the
 * file contents before every splice, so no global event carries opaque data
 * worth asserting here.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
