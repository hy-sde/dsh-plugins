# Contributing

Thanks for helping with `dsh-llm-slots`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies.** The admission plugin is pure TypeScript;
  its only runtime dependency is `@deepseek-ai/schemastery` (the config schema)
  and its peers are `@deepseek-ai/cordis`, `@deepseek-ai/dsh-invariants`, and
  `@deepseek-ai/dsh-llm` (types + the `llm/stream` event), used exclusively by
  the plugin and the optional `./invariant` companion. Do not add runtime deps.
- **Stay pinned to the fork.** This repo mirrors `packages/llm/llm-slots` in
  the [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness);
  when the fork evolves the gate or the admission waterfall hook, bring the
  change here too (and vice versa).
- Keep `check` strict: the repo type-checks `src` and `tests` together.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck (src + tests)
pnpm -r test       # frame-primitive tests
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish @hy-sde-org/dsh-llm-slots
```
