/**
 * Package-owned invariant companion for `@hy-sde-org/dsh-tool-codebase-memory`.
 * @module @hy-sde-org/dsh-tool-codebase-memory/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { checkCodebaseMemoryCli } from './cli-check.ts'

const PACKAGE_NAME = '@hy-sde-org/dsh-tool-codebase-memory'

/** Cordis companion plugin name. */
export const name = 'tool-codebase-memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the activation invariant: the `codebase-memory-mcp` CLI must resolve
 * and run, otherwise the tools would error on every call. Config-level
 * `cliPath` overrides are per-call concerns; the companion check uses the PATH
 * default.
 */
const install: InvariantInstaller = async (_ctx, fail) => {
  try {
    await checkCodebaseMemoryCli()
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

/** Standalone availability probe re-export (usable outside the registry). */
export { checkCodebaseMemoryCli } from './cli-check.ts'
