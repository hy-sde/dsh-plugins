# Contributing

Thanks for helping with `dsh-session-intelligence`. This is a small,
dependency-light package; keep it that way.

## Ground rules

- **No new runtime dependencies** beyond the declared peers
  (`@deepseek-ai/cordis`, session-persistence seam) and no new
  `@deepseek-ai` dependencies for `@hy-sde-org/dsh-session-intelligence`
  beyond its declared peers.
- **The engine stays read-only and local.** Never send session content to a
  network service; the whole point is that health signals derive in-process
  from the local sessions directory.
- **Preserve the per-file upstream attribution headers**
  (port of agentsview's `internal/signals`, MIT — see
  `THIRD-PARTY-NOTICES.md`).
- Regression tests fixture derived session logs (JSONL), never rely on a live
  harness session directory for deterministic assertions.

## Validation

```bash
pnpm install
pnpm -r --filter './packages/*' check    # tsc --noEmit
pnpm -r --filter './packages/*' test     # vitest run
pnpm -r --filter './packages/*' build    # tsc -p tsconfig.build.json
pnpm run release:check                   # non-publishing release gate
```

Every behavioral change needs a direct regression test covering normal, edge,
and failure behavior.
