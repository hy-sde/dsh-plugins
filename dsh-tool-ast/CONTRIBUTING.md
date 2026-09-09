# Contributing

Thanks for helping with `dsh-tool-ast`. This is a small, dependency-light
monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** beyond `@ast-grep/cli` (the native engine)
  and `@deepseek-ai/schemastery` (schema validation), and no new
  `@deepseek-ai` dependencies beyond the declared peers.
- **The ported ast tools must stay standalone.** Never re-introduce the
  harness-internal `@deepseek-ai/dsh-tool-ast` as a source dependency — the
  whole point is that this plugin works on stock deliveries of DeepSeek
  Harness. The standalone surface is `ctx.tools`, `ctx.fs`, `ctx.subprocess`,
  and `ctx.systemPrompt`.
- **Degrade, don't throw in preview.** `ast_edit` with `apply: false` must
  never touch the filesystem; application goes exclusively through the
  `ctx.fs` version-guard flow (`fs/observed` + `fs/edit-intent` + writeText).
- Preserve the per-file upstream attribution headers
  (`Ported from @oh-my-pi/...` — MIT, see `THIRD-PARTY-NOTICES.md`).

## Workflow

1. Make your change in `packages/tool-ast`.
2. `pnpm -r check` and `pnpm -r test` (engine unit tests + the real-engine
   integration suite shipped with the repo).
3. Add/extend a spec next to the behavior you changed.
4. `pnpm -r build`, then `bash scripts/release-public.sh --check`.
5. Open a PR against `main`.

## Releasing

Release authority lives with the maintainers. The flow is guarded by
`scripts/release-public.sh` (clean tree, checks, tests, build, pack, org
membership, absence check, interactive confirm) and publishes the single
package via `pnpm publish` so `workspace:*` specs are rewritten.
