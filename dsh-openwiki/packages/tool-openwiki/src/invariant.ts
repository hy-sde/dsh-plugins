/**
 * Package-owned invariant companion for `@hy-sde-org/dsh-tool-openwiki`.
 * @module @hy-sde-org/dsh-tool-openwiki/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { HostSessionManager } from '@hy-sde-org/dsh-openwiki'

const PACKAGE_NAME = '@hy-sde-org/dsh-tool-openwiki'

/** Cordis companion plugin name. */
export const name = 'tool-openwiki-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the activation invariant: the standalone deterministic engine must
 * load and construct its transport-neutral adapter. A missing/broken
 * `@hy-sde-org/dsh-openwiki` link fails boot immediately instead of
 * surfacing on the first lifecycle call.
 */
const install: InvariantInstaller = (_ctx, fail) => {
  try {
    HostSessionManager.create({ host: 'invariant-probe', producerActor: 'invariant-probe' })
  } catch (err) {
    fail((err as Error).message)
  }
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
