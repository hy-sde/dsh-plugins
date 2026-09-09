# Contributing

Thanks for helping with `dsh-tool-subagent-report`. This is a small,
dependency-light monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** beyond `@deepseek-ai/schemastery` (schema
  validation), and no new `@deepseek-ai` dependencies beyond the declared
  peers.
- **The ported report tool must stay standalone.** Never re-introduce the
  harness-internal `@deepseek-ai/dsh-tool-subagent-report` as a source
  dependency — the whole point is that this plugin works on deliveries of
  DeepSeek Harness that carry the fork's subagent report channel. The
  standalone surface is `ctx.subagents` (report channel), `ctx.tools`, and
  `ctx.systemPrompt`.
- **Keep the fork contract.** `src/report-contract.ts` declares the fork-only
  subagent report surface (`registerContinuableSetup`, `reportFrom`, report
  content/delivery types, open-decisions ledger). The host subagent service
  verifies sender identity and admission; this package only formats and
  validates the report.
- Preserve the per-file upstream attribution headers
  (`Ported from @deepseek-ai/dsh-tool-subagent-report — MIT, see
  THIRD-PARTY-NOTICES.md`).

## Workflow

1. Make your change in `packages/tool-subagent-report`.
2. `pnpm -r check` and `pnpm -r test` (the child-scope registration suite
   runs against the published agent-loop stack plus the local subagent report
   seam).
3. Add/extend a spec next to the behavior you changed.
4. `pnpm -r build`, then `bash scripts/release-public.sh --check`.
5. Open a PR against `main`.

## Releasing

Release authority lives with the maintainers. The flow is guarded by
`scripts/release-public.sh` (clean tree, checks, tests, build, pack, org
membership, absence check, interactive confirm) and publishes the single
package via `pnpm publish` so `workspace:*` specs are rewritten.
