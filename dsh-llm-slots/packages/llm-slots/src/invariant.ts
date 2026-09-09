/** Package-owned model-slot admission accounting invariants. @module @hy-sde-org/dsh-llm-slots/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ModelSlotsStats } from './index.ts'

const PACKAGE_NAME = '@hy-sde-org/dsh-llm-slots'

/** Cordis companion plugin name. */
export const name = 'llm-slots-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Read live admission stats, or `undefined` when the plugin is not mounted. */
function readStats(ctx: Context): ModelSlotsStats | undefined {
  const slots = ctx.get('modelSlots')
  if (slots === undefined) return undefined
  try {
    return slots.stats()
  } catch {
    // A service mid-teardown may throw; absence of stats makes the checks inert.
    return undefined
  }
}

/**
 * Assert the gate's structural accounting around one model call, as far as a
 * single observer can see it without coupling to concurrent streams:
 *
 * - `running` stays within `[0, capacity]` at settlement — a value above
 *   capacity means acquisitions leaked past the budget; a negative value means
 *   releases outran acquisitions. Cross-stream interleaving cannot break this
 *   bound, so the check never races a sibling.
 * - `waiting` never goes negative.
 * - `acquiredTotal` is monotonic across the observed call (it only counts
 *   acquisitions and never decreases, regardless of concurrent streams).
 *
 * A missing service (plugin not mounted on the checked root, or mid-teardown)
 * makes every check inert rather than failing.
 */
async function* inspected(
  _options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
  fail: InvariantFailure,
  stats: () => ModelSlotsStats | undefined,
): AsyncIterable<StreamChunk> {
  const before = stats()
  try {
    yield* next()
  } finally {
    const after = stats()
    if (before === undefined || after === undefined) return
    if (after.running < 0 || after.running > after.capacity) {
      fail(`model-slot accounting broken after one call: running=${after.running} outside [0, ${after.capacity}]`)
    }
    if (after.waiting < 0) {
      fail(`model-slot waiting counter went negative: ${after.waiting}`)
    }
    if (after.acquiredTotal < before.acquiredTotal) {
      fail(`model-slot acquiredTotal decreased: ${after.acquiredTotal} < ${before.acquiredTotal}`)
    }
  }
}

/** Install admission-accounting checks around every model call. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('llm/stream', (options, next) => inspected(options, next, fail, () => readStats(ctx)), { global: true })
}

/**
 * Register the model-slot invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
