# Contributing

Thanks for helping with `dsh-openwiki`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** for `@hy-sde-org/dsh-openwiki` beyond
  `yaml` and `zod` (the upstream engine's own deps) and no new
  `@deepseek-ai` dependencies for `@hy-sde-org/dsh-tool-openwiki` beyond its
  declared peers (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-invariants`,
  `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-tools`). Runtime Node
  builtins are fine (the host runs Node).
- **The engine must stay in-process and deterministic.** Never introduce an
  external `openwiki` CLI dependency or a model/network dependency — the
  whole point is that the determinist engine core runs inside the plugin with
  no extra services. It may spawn `git` for source fingerprinting, exactly
  like upstream.
- **Preserve the per-file upstream attribution headers and the on-disk
  format compatibility** (`.run.json`, `.page-manifest.json`,
  `.last-update.json`, `.claims/` sidecars, OKF front matter) — MIT, see
  `THIRD-PARTY-NOTICES.md`.
- Keep the WikiFs seam: the engine only ever touches the repository through
  `WikiFs`; new internal consumers must not add direct `fs` calls.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck of both packages
pnpm -r test       # openwiki + tool-openwiki tests
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish openwiki then tool-openwiki
```
