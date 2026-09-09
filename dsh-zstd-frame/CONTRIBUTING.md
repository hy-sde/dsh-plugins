# Contributing

Thanks for helping with `dsh-zstd-frame`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies.** The frame primitives are pure TypeScript
  over `node:zlib` (plus `node:buffer`, `node:util`). Their only peers are
  `@deepseek-ai/cordis` and `@deepseek-ai/dsh-invariants`, used exclusively by
  the optional `./invariant` companion. Do not add runtime deps.
- **Stay pinned to the fork.** This repo mirrors `packages/util/zstd` in the
  [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness);
  when the fork evolves the frame layout or the private-decoder probe, bring
  the change here too (and vice versa).
- Keep `check` strict: the repo type-checks `src` and `tests` together.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck (src + tests)
pnpm -r test       # frame-primitive tests
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish @hy-sde-org/dsh-zstd-frame
```
