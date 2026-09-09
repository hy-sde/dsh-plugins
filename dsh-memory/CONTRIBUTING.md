# Contributing

Thanks for helping with `dsh-memory`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** for `@hy-sde-org/dsh-memory` beyond its
  declared peers (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-home-paths`,
  `@deepseek-ai/dsh-invariants`) and no new `@deepseek-ai` dependencies for
  `@hy-sde-org/dsh-tool-memory` beyond its declared peers. Runtime Node
  builtins are fine (the host runs Node).
- **The local backend must stay standalone.** Never depend on a remote memory
  engine or a model/network dependency — the whole point is that the default
  `local` backend works on stock deliveries of DeepSeek Harness with zero
  extra services.
- **Preserve the per-file upstream attribution headers**
  (`Ported from @oh-my-pi/...` — MIT, see `THIRD-PARTY-NOTICES.md`).
- Backend additions keep the registry seam: new providers register into
  `ctx.memory` by id and never change the model-facing tool surface.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck of both packages
pnpm -r test       # memory + tool-memory tests
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish memory then tool-memory
```
