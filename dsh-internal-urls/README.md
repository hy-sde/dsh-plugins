<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-internal-urls`](https://www.npmjs.com/package/@hy-sde-org/dsh-internal-urls) · [`@hy-sde-org/dsh-tool-fs-internal-urls`](https://www.npmjs.com/package/@hy-sde-org/dsh-tool-fs-internal-urls) · [`@hy-sde-org/dsh-tool-fs-search-internal-urls`](https://www.npmjs.com/package/@hy-sde-org/dsh-tool-fs-search-internal-urls)
<!-- MIRROR-NOTE:END -->

# dsh-internal-urls — FS-shaped internal URLs for DeepSeek Harness

Three standalone packages, installable as **one plugin** for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-internal-urls` | the plugin: host-plane `ctx.internalUrls` registry service + shipped `conflict://` / `issue://` / `pr://` handlers (bundle row + preset example) | yes |
| `@hy-sde-org/dsh-tool-fs-internal-urls` | agent-scope shadow of `read`/`write`/`edit` that routes internal URLs (fork `dsh-tool-fs` + routing) | yes (via preset) |
| `@hy-sde-org/dsh-tool-fs-search-internal-urls` | agent-scope shadow of `grep` that searches internal-URL resources (fork `dsh-tool-fs-search` + routing) | yes (via preset) |

This is the oh-my-pi `internal-urls` system, ported onto the harness as a
**standalone plugin with zero upstream harness changes**: the
registry row ships as a `cordis.patch.yml` bundle, the routing tools ship as
agent-scope shadows in a ready-to-copy preset, and every `@deepseek-ai`
dependency resolves from the npm registry at the `0.2.0-rc.2` baseline — so
it installs on official DeepSeek Harness releases (`dsh-v0.2.0-rc.2` and
later) exactly as it runs in the hy-sde fork.

## Why shadows, not replaced tools

The official harness ships `read`/`write`/`edit` (from `dsh-tool-fs`) and
`grep` (from `dsh-tool-fs-search`) host-wide, with no internal-URL routing
(that exists only in the hy-sde fork). A second `read`-owner anywhere on the
host plane fails boot — so the routing tools mount at the **agent plane**,
where harness scoped-tools semantics let the session's own registration
shadow the global one. Only sockets using this preset get the routing; every
other scope keeps the stock tools byte-for-byte.

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- DeepSeek Harness `0.2.0-rc.2` or newer including the standard `dsh` CLI —
  the packages' `@deepseek-ai/*` peer range is `^0.2.0-rc.2`
  (`@deepseek-ai/cordis` pins `~4.0.4`);
- an agent preset to mount the two shadow-tool rows in — the registry row
  inserts itself on install, but the `read`/`write`/`edit`/`grep` routing
  only exists inside a preset that mounts the shadow packages (see
  [Install](#install)).

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh@0.2.0-rc.2 pnpm
dsh --version
```

## Install

### Direct from npm (published)

All three packages are published on the npm registry under the `hy-sde-org`
organization (version `0.2.0-rc.2`):

```bash
dsh plugin --profile web add @hy-sde-org/dsh-internal-urls \
  @hy-sde-org/dsh-tool-fs-internal-urls \
  @hy-sde-org/dsh-tool-fs-search-internal-urls
```

Then copy the preset from `packages/internal-urls/examples/agent-preset/`:

```bash
mkdir -p ~/.dsh/.agent-presets/my-urls
cp packages/internal-urls/examples/agent-preset/agent.cordis.yml \
   packages/internal-urls/examples/agent-preset/preset.yml \
   ~/.dsh/.agent-presets/my-urls/
```

and select it in the Web UI preset picker (or `dsh agent`).

### From the git checkout (pre-publish / development)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @hy-sde-org/dsh-internal-urls build

IU_TGZ="$(cd dsh-internal-urls/packages/internal-urls && pnpm pack --pack-destination /tmp | tail -n 1)"
FS_TGZ="$(cd dsh-internal-urls/packages/tool-fs-internal-urls && pnpm pack --pack-destination /tmp | tail -n 1)"
SEARCH_TGZ="$(cd dsh-internal-urls/packages/tool-fs-search-internal-urls && pnpm pack --pack-destination /tmp | tail -n 1)"
dsh plugin --profile web add "$IU_TGZ" "$FS_TGZ" "$SEARCH_TGZ"
```

### Verify

```bash
dsh web --dump-config        # the internal-urls row is present in the base bundle
```

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-internal-urls
dsh plugin --profile web remove @hy-sde-org/dsh-tool-fs-internal-urls
dsh plugin --profile web remove @hy-sde-org/dsh-tool-fs-search-internal-urls
# remove the preset directory you copied from examples/agent-preset/ as well
```

## What the bundle does

`@hy-sde-org/dsh-internal-urls`'s `cordis.patch.yml` inserts exactly one row
into the profile composition on install: the host-plane `internal-urls`
service (the resolver registry; per-session conflict histories are keyed
inside the service). It touches **no existing row**, so `dsh plugin add`
never breaks boot on a stock release. The two agent-plane tool rows are not
inserted anywhere; they live in the copied preset
(`examples/agent-preset/`) beside your other preset rows.

## Development

```bash
pnpm install
pnpm -r build      # build internal-urls first, then the two shadow packages
pnpm -r check      # strict typecheck
pnpm -r test       # 58 unit tests + 10 end-to-end routing tests
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish in dependency order
```

> **Build order note.** `pnpm -r build` (recursive) resolves workspace deps
> through package `exports` (→ `dist`), so run it once before
> `pnpm -r check`/`test` from a clean clone; the distributions then exist and
> type resolution succeeds.

## License and attribution

This package is licensed MIT — the same license as its upstream
[oh-my-pi](https://github.com/can1357/oh-my-pi). The internal-URL system is
ported from oh-my-pi (MIT License, © Mario Zechner 2025, © Can Bölük
2025-2026); the upstream copyright holders are recorded in LICENSE next to
this package's own notice, and the upstream notice text is reproduced in
full in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Layout

```
packages/internal-urls/                @hy-sde-org/dsh-internal-urls — the registry service + handlers
  cordis.patch.yml                        the installable bundle (host row)
  examples/agent-preset/                  the ready-to-copy preset (tool rows)
packages/tool-fs-internal-urls/        @hy-sde-org/dsh-tool-fs-internal-urls — read/write/edit shadow
packages/tool-fs-search-internal-urls/ @hy-sde-org/dsh-tool-fs-search-internal-urls — grep shadow
```
