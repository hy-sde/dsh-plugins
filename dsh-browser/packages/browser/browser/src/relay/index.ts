/**
 * Local relay server + wire protocol for driving the user's own Chrome tabs
 * via the companion MV3 extension (assets under src/assets).
 *
 * Ported from omp (oh-my-pi, MIT — see LICENSE).
 * The server impersonates Chrome's CDP discovery endpoint
 * (`/json/version`, `/json`, `WS /cdp`) and bridges it to the extension's
 * `chrome.debugger` over `WS /ext`; `bridge.ts` multiplexes every downstream
 * CDP connection over the extension's single debugger attachment per tab.
 * @module @hy-sde-org/dsh-browser/relay
 */

export { startRelayServer, type RelayServer, type RelayServerOptions } from './server.ts'
export { RelayBridge } from './bridge.ts'
export { resolveRelayKind, DEFAULT_RELAY_URL, type RelayKind, type ResolveRelayKindOptions } from './kind.ts'
export type { ExtToRelayMessage, RelayRpcRequest, RelayToExtMessage, TabSnapshot } from './protocol.ts'
