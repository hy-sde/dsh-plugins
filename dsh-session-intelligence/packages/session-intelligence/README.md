# @hy-sde-org/dsh-session-intelligence

Session health intelligence for DeepSeek Harness: the **`session_health`**
tool classifies how past sessions actually went (**completed / abandoned /
errored / unknown** with confidence), grades them **A–F** (penalty-based, with
basis categories and per-signal penalties), and reports the signals behind
each grade — tool failures/retries/edit-churn, prompt-quality heuristics
(short prompts, unstructured starts, missing success criteria, duplicate
prompts, runaway tool loops), and context pressure (compactions, mid-task
compactions, peak tokens vs the model's window). Ships with a standalone CLI
over the same engine.

Ports agentsview's (MIT, Kenn Software) `internal/signals` engine
(`outcome.go`, `toolhealth.go`, `heuristics.go`, `context.go`, `score.go`)
into this package as a pure TypeScript engine; the DSH event adapter maps the
harness session log (`user/message`, `assistant/message`, `tool/call`,
`tool/result`, `compaction/*`) onto the engine inputs the same way agentsview's
`internal/sync/signal_compute.go` maps the DeepSeek Harness event model. See
`THIRD-PARTY-NOTICES.md`.

## What it does

- Scans the **caller workspace's** sessions through the deployment's
  `sessionQuery` service — no filesystem access, no realm, no persistence of
  its own.
- Reduces one session's event stream into: outcome + confidence, health
  score + grade + basis + penalties, tool-health signals, heuristic signals,
  compaction/mid-task counts, peak context tokens, model (when recorded), and
  context pressure ratio.
- Skips inherited seeded prefixes (subagent children ignore their parent's
  events); unreadable sessions are counted and reported, never fatal.
- Returns either a full per-session report (action `session`) or a health
  table across the most-recent sessions (action `recent`).
- The sibling **`session_recent_edits`** tool lists the workspace's recently
  edited files: paths from Edit/Write tool calls across past sessions,
  grouped per file, newest edit first (arg-path extraction ports agentsview's
  `ResolveFilePathFromJSON`; grouping/ordering ports its `RecentEdits`).
- The **`session_insights`** tool ranks tool-call frequency (highest →
  lowest) with per-tool session coverage and error counts — merged from the
  superseded `@hy-sde-org/dsh-tool-session-insights`. `bash` calls are broken
  down into the commands they run (`ls`, `rg`, `grep`, `git`, …), one row per
  command, so the busiest tool no longer hides what actually executed.

## Tool arguments

`session_health`:

| arg | type | notes |
| --- | --- | --- |
| `action` | string (required) | `"session"` (full report) or `"recent"` (health table) |
| `sessionId` | string | required for `action: "session"`; id shown in `recent` output |
| `limit` | number | max most-recent sessions for `action: "recent"` (default 20) |
| `since` | string | ISO-8601; only sessions created at/after it |

`session_recent_edits`:

| arg | type | notes |
| --- | --- | --- |
| `path` | string | case-insensitive substring filter on file paths |
| `limit` | number | max files returned (default 50) |
| `perFile` | number | inlined recent edits per file (default 3) |
| `since` | string | ISO-8601; only sessions created at/after it |

`session_insights` (merged from dsh-tool-session-insights):

| arg | type | notes |
| --- | --- | --- |
| `action` | string (required) | `"tool-frequency"` |
| `workspace` | string | absolute path; must equal the caller workspace (defaults to it) |
| `limit` | number | max most-recent sessions scanned (default 200) |
| `top` | number | return only the top N tools |
| `since` | string | ISO-8601; only sessions created at/after it |

## Engine API (same numbers as the tool)

```ts
import { analyzeSession } from '@hy-sde-org/dsh-session-intelligence'
const signals = analyzeSession({ id, createdAt, events })
// signals.outcome, signals.score, signals.toolHealth, signals.heuristics,
// signals.compactionCount, signals.midTaskCompactionCount, signals.pressureMax
```

The pure engine entry points (`classifyOutcome`, `computeToolHealth`,
`analyzeHeuristics`, `computeContextPressure`, `countMidTaskCompactions`,
`computeHealthScore`, `normalizeToolCategory`) are exported from `./engine`
and from the package root for embedding and testing.

## Mount

```yaml
- id: hy-sde-tool-session-intelligence
  name: '@hy-sde-org/dsh-session-intelligence'
```

The deployment must mount `tools`, `systemPrompt`, and `sessionQuery`
(stock base bundle does). Configuration keys: `maxSessions` (default 200),
`recentLimit` (default 20), `timeoutMs` (default 60000). See
[`cordis.patch.yml`](./cordis.patch.yml) and
[`examples/agent-preset/`](./examples/agent-preset/) for a ready-made preset.

## CLI

```bash
node dist/cli.js --cwd /Users/hui/Documents/workspace --recent --limit 20
node dist/cli.js --cwd /Users/hui/Documents/workspace --session session-<id>
node dist/cli.js --cwd /Users/hui/Documents/workspace --edits --path src --limit 30
node dist/cli.js --cwd /Users/hui/Documents/workspace --frequency --top 20
node dist/cli.js /Users/hui/.dsh/sessions/--Users-hui-Documents-workspace--
```

Reads `session.jsonl.zstd` (multi-frame zstd, torn-tail tolerant) or
`session.jsonl` from each session directory; honors `DSH_HOME` (default
`~/.dsh`).

## License

MIT — see [LICENSE](../../LICENSE). The signals engine and the event mapping
are ports of agentsview (MIT, Kenn Software); `cli.ts` ports the `projectKey`
path encoding from `@deepseek-ai/dsh-session-persistence-jsonl` (MIT, DeepSeek
Harness); zstd artifacts are read via `@hy-sde-org/dsh-zstd-frame`. See
[`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md).
