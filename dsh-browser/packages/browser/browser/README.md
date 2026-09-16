# @hy-sde-org/dsh-browser

The host `ctx.browser` service for the agentic browser tool (ported from omp / oh-my-pi): it owns real browser connections over Chrome DevTools Protocol through [playwright-core CDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp), with four backends — **launch** (stealth-patched browser binary), **patch** (the CloakBrowser Chromium, source-level C++ fingerprint patches, via the optional `cloakbrowser` peer), **attach** (existing CDP endpoint via `cdp_url`), and **relay** (the user's own Chrome tabs through an in-process relay server + companion MV3 extension). Intended to be consumed by [`@hy-sde-org/dsh-tool-browser`](../tool-browser/README.md), never by the model directly. A standalone plugin — no upstream harness changes required; installs on official DeepSeek Harness releases (`0.1.2-rc.1` and later).

## What it does

Registers one host service on the composition (`ctx.browser`). The surface:

- **Backends** — `resolveKind` maps a tool request to `launch` / `patch` / `attach` / `relay`, mirroring omp's kind resolution (`app.path` → spawn, `app.patch` / `usePatch` → CloakBrowser, `app.cdp_url` → attach, `app.relay` / `DSH_BROWSER_RELAY` → relay); `ensureRelay` starts the in-process relay server (default `http://127.0.0.1:9224`, ephemeral port fallback).
- **Tabs** — `open` navigates a named tab (one tab per name, one browser connection per cwd+kind); `run` evaluates JS in a tab; `observe` returns title/url/size + an ARIA snapshot with `[ref=eN]` ids; `click`/`type` address elements by ARIA ref or CSS selector; `screenshot` writes a PNG; `close` closes tabs and, with `kill`, spawned browsers.
- **Stealth** — the 14 omp-puppeteer init scripts run in every launched page (`src/stealth-scripts.ts`, generated), the machine-tell launch flags are suppressed, and a spoofed user-agent + client-hints override is applied on the browser CDP session.

The ARIA snapshot is produced by the bundled Playwright ARIA-snapshot sources (Apache-2.0, Microsoft) vendored as `src/aria-bundle.ts` — the same generated bundle omp uses — so every snapshot carries actionable `[ref=eN]` ids that stay valid until the next snapshot.

## Backends

| kind | resolution | browser |
| --- | --- | --- |
| `launch` | `app.path` (or `browserPath` config) | `chromium.launch({ executablePath, headless, args: STEALTH_LAUNCH_ARGS, ignoreDefaultArgs })` |
| `patch` | `app.patch` / `usePatch` config | `cloakbrowser.launch(...)` — the CloakBrowser Chromium (71 source-level C++ fingerprint patches, per-session randomization) |
| `attach` | `app.cdp_url` | `chromium.connectOverCDP(cdpUrl)` — any real Chrome family endpoint |
| `relay` | `app.relay` / `DSH_BROWSER_RELAY=1` | `chromium.connectOverCDP(relay)` — the relay impersonates Chrome's CDP discovery |

The `patch` backend is powered by the **optional** `cloakbrowser` peer (`npm i cloakbrowser`): a drop-in Playwright replacement whose Chromium is patched at the C++ level (canvas, WebGL, audio, fonts, GPU, screen, WebRTC, network timing, automation signals). The first launch auto-downloads its patched Chromium (~200 MB, cached under `~/.cloakbrowser/`). Because CloakBrowser randomizes fingerprints per session at the browser layer, the dsh-browser UA override and JS init scripts are **deliberately not applied** on this backend. Useful extra flags via `patchOptions`: `proxy`, `geoip` (match timezone+locale to the proxy IP), `humanize` (human-like input). Nothing is guaranteed per site — anti-detection raises the bar, it does not make a site accessible.

The relay (`src/relay/server.ts`, `bridge.ts`, a port of omp's) binds loopback, serves `GET /json/version` (503 until the extension connects), `GET /json`, `WS /cdp` (downstream CDP clients), `WS /ext` (the extension, token-gated when configured), and `GET /ext-assets/*` so the extension can be sideloaded from `chrome://extensions` → Load unpacked. The bridge multiplexes every downstream CDP connection over the extension's one `chrome.debugger` attachment per tab with minted session ids — the same design as `omp browser-relay` (MIT).

## Configuration

- `browserPath` — default executable for `launch` (optional; Playwright resolves one).
- `usePatch` — prefer the CloakBrowser backend when no path/cdp_url/relay is requested (optional; needs the `cloakbrowser` peer).
- `patchOptions` — CloakBrowser launch flags: `proxy` (URL), `geoip` (bool), `humanize` (bool).
- `headless` — default headless (true).
- `viewport` — launch viewport (default 1365×768 @ 1.25).
- `relayUrl` / `relayToken` — relay endpoint and optional extension token.
- `timeoutMs` — default navigation timeout (30000).

The service is host-plane, holds no durable state, and is disposed with its owning context (closes its browsers and stops the relay).
