<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-browser`](https://www.npmjs.com/package/@hy-sde-org/dsh-browser) · [`@hy-sde-org/dsh-tool-browser`](https://www.npmjs.com/package/@hy-sde-org/dsh-tool-browser)
<!-- MIRROR-NOTE:END -->

# dsh-browser — agentic browser (stealth + relay/CDP-attach) for DeepSeek Harness

Two standalone packages, installable as **one plugin** for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-browser` | the plugin: host-plane `ctx.browser` service (bundle row + preset example) | yes |
| `@hy-sde-org/dsh-tool-browser` | the model-facing `browser` tool + `browser:tools` prompt section | yes |

This is the oh-my-pi (`omp`) browser tool surface — stealth plus
relay/CDP-attach — ported onto the harness `ctx.browser` service contract as
a **standalone plugin with zero upstream harness changes**: the service row
ships as a `cordis.patch.yml` bundle, the tool row ships as a ready-to-copy
agent preset, and every `@deepseek-ai` dependency resolves from the npm
registry at the `0.1.2-rc.1` baseline — so it installs on official DeepSeek
Harness releases (`dsh-v0.1.2-rc.1` and later) exactly as it runs in the
hy-sde fork.

## Why

An agent's plain `fetch` dies at the first bot wall or fingerprint check,
and the usual workarounds mean accounts, API keys, or brittle one-off glue.
This plugin is the credential-free alternative: a real browser the agent
steers, with the stealth work already done — 14 omp-puppeteer init scripts
with stripped launch flags and spoofed UA/client-hints (`app.path`), the
CloakBrowser Chromium's 71 source-level fingerprint patches for the hardest
walls (`app.patch`), attach to a browser you already run (`app.cdp_url`),
or drive your own Chrome tabs through the relay + companion extension
(`app.relay`). Observations come back as Playwright ARIA snapshots with
actionable `[ref=eN]` ids rather than scraped HTML, and tabs are namespaced
per session id, so concurrent sessions never steer each other's browser.

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- DeepSeek Harness `0.2.0-rc.2` or newer including the standard `dsh` CLI —
  the package's `@deepseek-ai/*` peer range is `^0.2.0-rc.2`
  (`@deepseek-ai/dsh-invariants`; `@deepseek-ai/cordis` pins `~4.0.4`);
- a Chrome-family browser: `app.cdp_url` attaches to a real CDP endpoint and
  `app.relay` drives your own Chrome via the companion MV3 extension; the
  optional `app.patch` backend needs the `cloakbrowser` peer (`>=0.5.0`).

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh@0.2.0-rc.2 pnpm
dsh --version
```

## The surface

- **Four backends** — `app.path` spawns a stealth-patched browser binary
  (14 omp-puppeteer init scripts + stripped launch flags + spoofed
  UA/client-hints), `app.patch` spawns the CloakBrowser Chromium (71
  source-level C++ fingerprint patches, optional `cloakbrowser` peer),
  `app.cdp_url` attaches to any real Chrome-family CDP
  endpoint, and `app.relay`/`DSH_BROWSER_RELAY=1` drives the user's own
  Chrome tabs through the in-process relay + companion MV3 extension.
- **`browser` tool** — `open` (navigate, optional post-load code), `run`
  (JS eval in a tab), `state` (current observation), `close` (one tab, `all`,
  and `kill` spawned browsers). Screenshots write PNG paths the model can
  re-read.
- **ARIA observations** — every open/run/state returns a Playwright ARIA
  snapshot with actionable `[ref=eN]` ids, rendered by the vendored ARIA
  bundle in the page (same technique as omp). `click`/`type` address elements
  by ARIA ref or CSS selector.

Tabs are namespaced per session id, so concurrent sessions never steer each
other's tabs on the shared host browser.

## Install

### Direct from npm (published)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-browser @hy-sde-org/dsh-tool-browser
```

### From this repository (pre-publish)

```bash
pnpm install            # workspace setup
pnpm -r build
pnpm --filter packages/browser/browser pack
pnpm --filter packages/browser/tool-browser pack
dsh plugin --profile web add <tarball-or-catalog-url>.tgz
```

`prepack` rebuilds `dist/`, so the tarball is always current. Then bring the
host row plus the tool row together in your composition as described under
"Mounting" below — or copy the ready-made preset from
`packages/browser/browser/examples/agent-preset/` into
`~/.dsh/.agent-presets/<id>/` and select it in the Web UI.

## Mounting

- **Service row (host plane):** shipped as `cordis.patch.yml` in
  `@hy-sde-org/dsh-browser`; `dsh plugin add` inserts it into the profile's
  base composition. The `insert` form never touches existing rows, so it is
  safe on stock harness installs.
- **Tool row (agent plane):** `- id: tool-browser / name:
  '@hy-sde-org/dsh-tool-browser'` in the agent preset — no realm/isolate, it
  resolves the host instance across the plane boundary.

### Verify

```bash
dsh web --dump-config
```

The composed tree must show the `browser` row loading
`@hy-sde-org/dsh-browser` (the `tool-browser` row comes from your agent
preset).

### Run

```bash
dsh web
```

Ask the agent to open a page with the `browser` tool: `open` navigates and
returns the ARIA snapshot with `[ref=eN]` ids; `run` and `state` evaluate
and re-observe the same tab.

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-browser @hy-sde-org/dsh-tool-browser
```

Also remove the `tool-browser` row from any agent preset that mounts it.

## License

MIT — see `LICENSE`. Derived from oh-my-pi (MIT) and the bundled Playwright
ARIA snapshot sources (Apache-2.0, Microsoft) — see `THIRD-PARTY-NOTICES.md`.
