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

## The surface

- **Three backends** — `app.path` spawns a stealth-patched browser binary
  (14 omp-puppeteer init scripts + stripped launch flags + spoofed
  UA/client-hints), `app.cdp_url` attaches to any real Chrome-family CDP
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

```bash
pnpm install --global @deepseek-ai/dsh
```

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

## License

MIT — see `LICENSE`. Derived from oh-my-pi (MIT) and the bundled Playwright
ARIA snapshot sources (Apache-2.0, Microsoft) — see `THIRD-PARTY-NOTICES.md`.
