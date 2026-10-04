<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-vcs`](https://www.npmjs.com/package/@hy-sde-org/dsh-vcs)
<!-- MIRROR-NOTE:END -->

# dsh-vcs — native vcs service for DeepSeek Harness

A standalone public package: **`@hy-sde-org/dsh-vcs`** — the host-plane
`ctx.vcs` service: a thin, read-only wrapper around the user-installed
`pi-vcs` CLI (the narrow native slice of the oh-my-pi vcs surface, rendered
in-process by gitoxide) over the `ctx.subprocess` seam. It exposes
repo-info / rev-diff / staged-diff / worktree-diff / status / branch plus a
HEAD-change watch companion, every text surface byte-compatible with the
corresponding `git diff` output.

## Why

Published **standalone** so any DeepSeek Harness installation can mount
`ctx.vcs` without depending on the fork that originally hosted
`@deepseek-ai/dsh-vcs`. The package is purely additive and feature-detected:
`ctx.git` (TS/git-CLI) stays the default path, and `ctx.vcs` resolves only
when a `pi-vcs` binary is reachable (config → `DSH_VCS_PATH` → PATH) and
probing clean. No jj backend, no mutation verbs.

## Prerequisites

- Node.js 22.19 or newer (the package's `engines` floor) with npm and pnpm on `PATH`;
- a DeepSeek Harness installation including the standard `dsh` CLI — the peer baseline
  is `@deepseek-ai/cordis ~4.0.4` and `@deepseek-ai/dsh-subprocess ^0.2.0-rc.2`;
- the `pi-vcs` binary — **not** shipped by this package. Build it from
  `native/pi-vcs-cli/` in the [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness)
  (a Rust crate over gitoxide) and install it on PATH, exactly like the `av` CLI.

## Quick start

### Route A — published npm package (recommended)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-vcs
```

You can also depend on the package from your own tooling: `pnpm add @hy-sde-org/dsh-vcs`
(or `npm install @hy-sde-org/dsh-vcs`).

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install

VCS_TGZ="$(cd dsh-vcs/packages/vcs && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$VCS_TGZ"
cd ..
```

### Verify

```bash
dsh web --dump-config
```

The composed tree must show a `vcs` row loading `@hy-sde-org/dsh-vcs` (stock INSERT
patch form). `ctx.vcs` itself resolves lazily — only when a `pi-vcs` binary is
reachable (config → `DSH_VCS_PATH` → PATH) and probing clean.

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-vcs
```

## What the bundle does

The bundle ships a `cordis.patch.yml` (stock INSERT patch form) that adds the
`vcs` row to the profile's base composition — host-plane, stateless per call,
one instance across sessions. Peers: `@deepseek-ai/cordis` and
`@deepseek-ai/dsh-subprocess` (the host must mount a subprocess
implementation, e.g. `@deepseek-ai/dsh-subprocess-local`). No model-facing
tools ship here, so no agent preset is needed.

## Development

```bash
pnpm install
pnpm -r check       # strict typecheck (src + tests)
pnpm -r test        # service tests over a fake pi-vcs shim
pnpm -r build       # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish to npm
```

## Layout

```
packages/vcs/   @hy-sde-org/dsh-vcs — the host ctx.vcs service
  src/index.ts                Cordis plugin registration (apply → ctx.vcs)
  src/service.ts              VcsService + VcsCommandError + effect runner
  src/types.ts                CLI JSON payload types (repo-info/status/watch)
  tests/service.spec.ts       18 tests over a fake pi-vcs shim
  cordis.patch.yml            host-plane row insert (stock INSERT form)
```

## License and attribution

This package is licensed MIT — the same license as the DeepSeek Harness codebase it is
derived from (MIT, © 2026 DeepSeek). The `ctx.vcs` service's CLI resolution + probe,
git-compatible diff/status surfaces, structured `VcsCommandError` taxonomy, and
HEAD-change watch companion derive from the fork's `@deepseek-ai/dsh-vcs`; the
upstream copyright holders are recorded in LICENSE next to this package's own notice,
and the derived-module provenance is aggregated in THIRD-PARTY-NOTICES.md.
