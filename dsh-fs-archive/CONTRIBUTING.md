# Contributing

Thanks for helping with `dsh-fs-archive`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies.** The archive engine is pure TypeScript over
  Node's standard library only (`node:crypto`, `node:fs`, `node:path`,
  `node:util`, `node:zlib`). Its only peers are `@deepseek-ai/cordis` and
  `@deepseek-ai/dsh-invariants`, used exclusively by the optional
  `./invariant` companion. Do not add runtime deps.
- **Preserve the per-file upstream attribution headers**
  (`Ported from @oh-my-pi/...` — MIT, see `THIRD-PARTY-NOTICES.md`).
- **Stay pinned to the fork.** This repo mirrors
  `packages/fs/fs-archive` in the [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness);
  when the fork backports upstream archive-engine fixes, bring them here too
  (and vice versa for fixes that originate standalone).
- Keep `check` strict: the repo type-checks `src` and `tests` together.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck (src + tests)
pnpm -r test       # 33 archive-engine tests
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish @hy-sde-org/dsh-fs-archive
```
