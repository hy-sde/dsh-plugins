# dsh-vcs — native vcs service for DeepSeek Harness

A standalone public package: **`@hy-sde-org/dsh-vcs`** — the host-plane
`ctx.vcs` service: a thin, read-only wrapper around the user-installed
`pi-vcs` CLI (the narrow native slice of the oh-my-pi vcs surface, rendered
in-process by gitoxide) over the `ctx.subprocess` seam. It exposes
repo-info / rev-diff / staged-diff / worktree-diff / status / branch plus a
HEAD-change watch companion, every text surface byte-compatible with the
corresponding `git diff` output.

Published **standalone** so any DeepSeek Harness installation can mount
`ctx.vcs` without depending on the fork that originally hosted
`@deepseek-ai/dsh-vcs`. The package is purely additive and feature-detected:
`ctx.git` (TS/git-CLI) stays the default path, and `ctx.vcs` resolves only
when a `pi-vcs` binary is reachable (config → `DSH_VCS_PATH` → PATH) and
probing clean. No jj backend, no mutation verbs.

> The `pi-vcs` binary is **not** shipped by this package — build it from
> `native/pi-vcs-cli/` in the
> [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness)
> (a Rust crate over gitoxide) and install it on PATH, exactly like the `av`
> CLI.

## Install & mount

```bash
pnpm add @hy-sde-org/dsh-vcs
# or: npm install @hy-sde-org/dsh-vcs
dsh plugin --profile web add @hy-sde-org/dsh-vcs
```

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
