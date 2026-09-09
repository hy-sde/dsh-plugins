# Third-party notices

This repository contains ports and vendored logic from the following
projects. Each entry lists the exact surface it covers.

## agentsview — MIT

**Project:** https://github.com/kenneth/agentsview `go.kenn.io/agentsview`
(Kenn Software)

**License:** MIT. See [LICENSE](./LICENSE).

**Ported surface** (`packages/session-intelligence/src/engine/*` and the DSH
event mapping in `packages/session-intelligence/src/adapter/dsh.ts`):

- `internal/signals/outcome.go` → `src/engine/outcome.ts`
  (`classifyOutcome`, give-up patterns, terminal-API-error handling, recency).
- `internal/signals/toolhealth.go` → `src/engine/toolhealth.ts`
  (`isFailure` + content heuristics, retry counting, edit-churn window).
- `internal/signals/heuristics.go` → `src/engine/heuristics.ts`
  (short/unstructured/missing-criteria/duplicate/no-context/runaway signals).
- `internal/signals/context.go` → `src/engine/context.ts`
  (mid-task compaction detection, >30% token-drop counting, model window
  sizes and pressure ratios).
- `internal/signals/score.go` → `src/engine/score.ts` (penalty model,
  basis categories, A–F grading).
- `internal/sync/signal_compute.go` (and `internal/parser/deepseek_harness.go`)
  → `src/adapter/dsh.ts` (DSH event → signals input mapping, incl.
  `computeFinalStreak`).
- `internal/parser/content.go` (`ResolveFilePathFromJSON`) and
  `internal/duckdb/recentedits.go` (grouping/ordering, `MaxEditsPerFile`) →
  `src/recentedits.ts` (the `session_recent_edits` feed).

## @hy-sde-org/dsh-tool-session-insights — MIT

**Project:** `@hy-sde-org/dsh-tool-session-insights` (hy-sde), now superseded.

**License:** MIT.

**Merged surface:** the tool-frequency aggregator
(`packages/session-intelligence/src/insights/analyze.ts`) and its markdown
renderer (in `packages/session-intelligence/src/presentation.ts`) were moved
unchanged from that package, so `session_insights` reports the same numbers.

## @deepseek-ai/dsh-session-persistence-jsonl — MIT

**Project:** DeepSeek Harness (`packages/session/persistence-jsonl`).

**License:** MIT.

**Ported surface:** `projectKey` path encoding in
`packages/session-intelligence/src/cli.ts` (resolving a workspace path to the
sessions project directory the JSONL backend writes).

## @hy-sde-org/dsh-zstd-frame — MIT

**Project:** `@hy-sde-org/dsh-zstd-frame` (hy-sde).

**License:** MIT.

**Used surface:** multi-frame zstd decoding of `session.jsonl.zstd`
(`scanZstdFrames`, `createZstdFrameDecoder`, `decompressZstdPrefix`) in
`packages/session-intelligence/src/cli.ts`.

---

Everything else in this repository is original work by hy-sde, licensed
MIT (see [LICENSE](./LICENSE)).
