/**
 * Readiness probe for the relay's CDP-discovery endpoint — the fork's answer
 * to oh-my-pi's `probe.ts` (b4c96b126e: diagnosed stale relay after omp
 * upgrades). A cold extension service worker dials the relay seconds after it
 * starts, so the first `connectOverCDP` against a fresh relay fails on a 503
 * unless the caller waits for the `/json/version` transition to 200 first.
 *
 * Deliberately forgiving: expiry never throws (the subsequent
 * `connectOverCDP` surfaces its own, more precise error), and a marker
 * mismatch never fails the wait — a relay from another build that still
 * serves the discovery endpoint stays usable (0f0910f42b: capability match
 * beats version match).
 * @module @hy-sde-org/dsh-browser/relay/probe
 */

/** Total time budget for the readiness wait (a cold SW dial lands within 1-10s; keep the wait bounded below CDP timeouts). */
export const RELAY_READY_BUDGET_MS = 3_000
/** Poll cadence between probes. */
export const RELAY_READY_POLL_MS = 100
/** Per-probe HTTP timeout, so one wedged endpoint cannot eat the whole budget. */
const PROBE_TIMEOUT_MS = 1_000

export interface WaitForRelayReadyOptions {
  /** Total budget; expiry resolves without error. Default {@link RELAY_READY_BUDGET_MS}. */
  budgetMs?: number
  /** Poll cadence. Default {@link RELAY_READY_POLL_MS}. */
  pollMs?: number
  /** Abort signal; an aborted wait resolves immediately. */
  signal?: AbortSignal
}

/**
 * Poll `/json/version` until the relay answers 200 with a JSON body (the
 * extension dialed) or the budget expires. Resolves in every case — the
 * result only shapes how long the caller waits, never whether it proceeds.
 * @param baseUrl - relay base URL (trailing slashes tolerated).
 * @param opts - budget, poll cadence, abort signal.
 */
export async function waitForRelayReady(baseUrl: string, opts: WaitForRelayReadyOptions = {}): Promise<void> {
  const budgetMs = opts.budgetMs ?? RELAY_READY_BUDGET_MS
  const pollMs = opts.pollMs ?? RELAY_READY_POLL_MS
  const deadline = Date.now() + budgetMs
  const base = baseUrl.replace(/\/+$/, '')
  for (;;) {
    if (opts.signal?.aborted) return
    if (await relayReady(base)) return
    if (Date.now() >= deadline) return
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

/** One `/json/version` probe: true when the endpoint answered 200 with a parseable JSON body. */
async function relayReady(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (response.status !== 200) return false
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null
  } catch {
    return false
  }
}
