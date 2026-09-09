/**
 * Browser relay mode: drive the user's own Chrome tabs through the local CDP
 * relay served in-process by this package (sibling `server.ts`/`bridge.ts`)
 * plus the companion MV3 extension (`src/assets/*.txt`). The relay
 * impersonates Chrome's CDP discovery endpoint, so the whole attached-browser
 * machinery (registry, tab registry) applies unchanged.
 *
 * Ported from oh-my-pi (MIT — see LICENSE).
 * @module @hy-sde-org/dsh-browser/relay/kind
 */

export interface RelayKind {
  kind: 'relay'
  cdpUrl: string
}

/** Default endpoint of the in-process relay server. */
export const DEFAULT_RELAY_URL = 'http://127.0.0.1:9224'

/** Whether the env var disables relay mode when unset-flag semantics apply. */
function parseFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false
  return true
}

export interface ResolveRelayKindOptions {
  /** `browser.relay` setting; `DSH_BROWSER_RELAY=0|1` overrides it. */
  settingEnabled?: boolean
  /** `browser.relayUrl` setting; falls back to {@link DEFAULT_RELAY_URL}. */
  url?: string
}

/**
 * Resolve the relay browser kind, or null when relay mode is disabled.
 * Mirrors omp's `resolveRelayKind`: the setting opts in and the env var is the
 * final override in both directions.
 */
export function resolveRelayKind(
  options?: ResolveRelayKindOptions | null,
  env: Record<string, string | undefined> = process.env,
): RelayKind | null {
  if (!parseFlag(env.DSH_BROWSER_RELAY, options?.settingEnabled ?? false)) {
    return null
  }
  const url = options?.url?.trim() || DEFAULT_RELAY_URL
  return { kind: 'relay', cdpUrl: url.replace(/\/+$/, '') }
}

export type { TabSnapshot, RelayRpcRequest, RelayToExtMessage, ExtToRelayMessage } from './protocol.ts'
