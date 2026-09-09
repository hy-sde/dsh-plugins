/**
 * Package-owned invariant companion for `@hy-sde-org/dsh-zstd-frame`.
 * @module @hy-sde-org/dsh-zstd-frame/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@hy-sde-org/dsh-zstd-frame'

/** Cordis companion plugin name. */
export const name = 'zstd-frame-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the frame layout algebra is enforced by the test suite
 * and the structural scan rejects corrupt input at runtime.
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
