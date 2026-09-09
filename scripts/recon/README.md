# Recon harness (Phase 0)

Turns a list of candidate repos into explored, indexed, documented candidates —
the input to the build-or-skip decision in [`WORKFLOW.md`](../../WORKFLOW.md).

## One command

```bash
bash scripts/recon/recon.sh                   # clone/update + index + scaffold + inventory
bash scripts/recon/recon.sh --dry-run         # print the plan, change nothing
bash scripts/recon/recon.sh --no-index        # scaffold only (no codebase-memory index)
bash scripts/recon/recon.sh --list batch.txt  # one-off batch, skips repos.list
bash scripts/recon/recon.sh --mode fast       # index mode (default full)
```

Env: `HSR_HOME` (scratch root, default `$HOME/Documents/github/harvest`), `HSR_MODE`.

Registry: [`repos.list`](./repos.list) — one `<url> [name]` per line, `#` comments.

## What it produces

| Artifact | Where | Purpose |
|---|---|---|
| shallow clone | `$HSR_HOME/repos/<name>` | scratch — local edits are **discarded on re-run** (fetch + hard reset) |
| analysis note | `$HSR_HOME/analysis/<name>.md` | prefilled from `ANALYSIS_TEMPLATE.md` |
| codebase-memory index | project `harvest-<name>` | full-mode graph for structural exploration |
| inventory | `$HSR_HOME/inventory.md` | status/verdict table, rebuilt each run |

Index names are prefixed `harvest-` so they never collide with already-indexed
projects (e.g. the fork is already indexed as `deepseek-harness`).

## The explore loop

1. **run** `recon.sh` (first run of a big repo: index takes a few minutes).
2. **explore**: for each repo, set `status: in-progress` in its note, then use the
   codebase-memory graph (`search_graph` / `query_graph` / `get_architecture` on
   `harvest-<name>`) plus targeted reads to fill sections 0–6.
3. **decide**: set `verdict` in the note's `<!-- recon-meta -->` block
   (`standalone-plugin` / `fork-only` / `extend-existing` / `skip`).
4. **review**: re-run `recon.sh` (or just open `inventory.md`) — the table reflects
   all verdicts, then pick the build list.
5. **build**: follow [`WORKFLOW.md`](../../WORKFLOW.md) — standalone-first for
   anything with a life outside the harness.

Per-repo exploration is a good fan-out: one isolated task per repo (clone → index
already done; the task fills the note and returns the verdict).
