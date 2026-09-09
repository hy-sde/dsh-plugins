# Contributing

Thanks for helping with `dsh-vcs`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies beyond the declared set.** The service is a
  thin wrapper over the `ctx.subprocess` seam; its only runtime dependency is
  `effect` (the effect-driven runner) with `@deepseek-ai/cordis` and
  `@deepseek-ai/dsh-subprocess` as peers. Do not add runtime deps.
- **Stay pinned to the fork.** This repo mirrors `packages/vcs/vcs` in the
  [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness);
  when the fork evolves the vcs surface, bring the change here too (and vice
  versa).
- The `pi-vcs` CLI is **user-installed** (like `av`): this repo ships only
  the TypeScript service, never the binary. Tests use a fake `pi-vcs` shim.
- Keep `check` strict: the repo type-checks `src` and `tests` together.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck (src + tests)
pnpm -r test       # service tests over a fake pi-vcs shim
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish @hy-sde-org/dsh-vcs
```
