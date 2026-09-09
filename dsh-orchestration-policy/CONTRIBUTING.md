# Contributing

Thanks for helping with `dsh-orchestration-policy`. This is a small,
dependency-light monorepo; keep it that way.

## Ground rules

- **Stay pinned to the fork.** This repo mirrors `packages/orchestration/policy`
  in the [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness);
  when the fork evolves the policy (config knobs, guard matrix, prompt text),
  bring the change here too (and vice versa).
- **No new runtime dependencies beyond the published harness peers.**
  The only peers are `@deepseek-ai/cordis` and `@deepseek-ai/dsh-system-prompt`
  (both published); everything else in `devDependencies` exists solely to run
  the ported test suites against the published harness stack.
- **Never weaken the specs.** `tests/policy.spec.ts` is a faithful port of the
  fork's unit suite (config resolution, guard matrix, prompt rendering,
  posture resolution, reporting rules) and `tests/wave.e2e.spec.ts` exercises
  the same fail-closed fan-out story over a real temp git repository. Keep
  every assertion.
- Keep `check` strict: the repo type-checks `src` and `tests` together.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck (src + tests)
pnpm -r test       # policy unit tests + wave E2E
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish @hy-sde-org/dsh-orchestration-policy
```
