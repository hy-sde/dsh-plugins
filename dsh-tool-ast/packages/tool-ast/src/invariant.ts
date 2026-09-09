/**
 * Package-owned invariant companion for `@hy-sde-org/dsh-tool-ast`.
 * @module @hy-sde-org/dsh-tool-ast/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@hy-sde-org/dsh-tool-ast'

/** Cordis companion plugin name. */
export const name = 'tool-ast-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: exec acquisition relations are owned by the subprocess seam this model-facing
 * adapter reaches; the seams own their lifecycle streams.
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
