<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-session-intelligence`](https://www.npmjs.com/package/@hy-sde-org/dsh-session-intelligence)
<!-- MIRROR-NOTE:END -->

# dsh-session-intelligence — session health intelligence for DeepSeek Harness

English · [中文（子包 README）](./packages/session-intelligence/README.zh.md)

Session health intelligence for [DeepSeek
Harness](https://github.com/deepseek-ai/deepseek-harness) — port of
agentsview's (MIT, Kenn Software) `internal/signals` engine: outcome
classification (completed/abandoned/errored/unknown), penalty-based A–F
health grades with basis + penalties, tool-health signals,
prompt/workflow heuristics, and context-pressure signals. Powers the
`session_health` tool and a standalone CLI. See
[`packages/session-intelligence/README.md`](./packages/session-intelligence/README.md)
for the engine API, tool argument tables, and the CLI reference.

| Identity | Value |
| --- | --- |
| Package | `@hy-sde-org/dsh-session-intelligence` |
| Plugin row id | `hy-sde-tool-session-intelligence` (host row) |
| Tools | `session_health` (`action: "recent"` / `"session"`), `session_recent_edits`, `session_insights` |
| CLI | `dsh-session-intelligence` (`bin`) over the same engine |

> **Based on [agentsview](https://github.com/kenneth/agentsview) (MIT, Kenn
> Software)** — the signals engine (`internal/signals/*` → `src/engine/*`) and
> the DSH event mapping (`internal/sync/signal_compute.go` → `src/adapter/dsh.ts`)
> are ports of agentsview's Go implementation; `session_insights` was merged
> unchanged from the superseded `@hy-sde-org/dsh-tool-session-insights`; the
> CLI's `projectKey` path encoding ports
> `@deepseek-ai/dsh-session-persistence-jsonl`. See
> [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Why

How did past sessions in this workspace actually go? Without signals, the
answer is a guess. `session_health` classifies each session's outcome
(**completed / abandoned / errored / unknown** with confidence) and grades it
**A–F** with the basis categories and per-signal penalties behind the grade —
tool failures/retries/edit churn, prompt-quality heuristics (short prompts,
unstructured starts, missing success criteria, duplicate prompts, runaway tool
loops), and context pressure (compactions, mid-task compactions, peak tokens
vs the model's window). Check it before repeating a failed approach, after a
crash to see how far the session got, or to audit which tools burn errors
(`session_insights`) and which files past sessions touched
(`session_recent_edits`).

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- a DeepSeek Harness release carrying the `0.2.0-rc.2` peer range —
  `@deepseek-ai/cordis ~4.0.4` and `@deepseek-ai/dsh-llm`,
  `@deepseek-ai/dsh-session-query`, `@deepseek-ai/dsh-system-prompt`,
  `@deepseek-ai/dsh-timeout`, `@deepseek-ai/dsh-tools` `^0.2.0-rc.2` —
  including the standard `dsh` CLI;
- the host services `tools`, `systemPrompt`, and `sessionQuery` mounted — the
  stock base bundle does (the row consumes them; it needs no realm, no
  filesystem access, and no persistence of its own);
- no API keys — nothing else.

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh pnpm
dsh --version
```

## Quick start

### Route A — published npm package (recommended)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-session-intelligence
```

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
PACKAGE_TARBALL="$(cd dsh-session-intelligence/packages/session-intelligence && pnpm pack --pack-destination /tmp | tail -n 1)"
dsh plugin --profile web add "$PACKAGE_TARBALL"
```

`pnpm pack` runs the normal `prepack` build and produces a tarball containing
`dist/`. A direct `github:<this-repo>` dependency does not contain built output
and is not a supported install path — always install the built tarball (or the
published package).

### Verify the composed configuration

```bash
dsh web --dump-config
```

The composed tree must show the `hy-sde-tool-session-intelligence` row loading
`@hy-sde-org/dsh-session-intelligence`.

### Run

```bash
dsh web
```

Then, in the session (the tools are scoped to the caller workspace):

```text
session_health { action: "recent", limit: 20 }                   # health table: outcome, grade, signals
session_health { action: "session", sessionId: "session-<id>" }  # full report behind a grade
session_recent_edits { path: "src", limit: 30 }                  # recently edited files, newest first
session_insights { action: "tool-frequency", top: 20 }           # tool ranking with error counts
```

`action: "recent"` returns a health table across the most-recent sessions;
`action: "session"` returns the full report (basis categories, penalties,
tool-health and heuristic details) for one `sessionId`. Sessions that cannot
be read are counted and reported, never fatal.

The same engine ships as a standalone CLI (`bin: dsh-session-intelligence`, or
`node dist/cli.js` from the package directory) — it reads
`session.jsonl.zstd` (multi-frame zstd, torn-tail tolerant) or
`session.jsonl` from the sessions directory and honors `DSH_HOME` (default
`~/.dsh`):

```bash
dsh-session-intelligence --cwd /Users/you/Documents/my-project --recent --limit 20
dsh-session-intelligence --cwd /Users/you/Documents/my-project --session session-<id>
dsh-session-intelligence --cwd /Users/you/Documents/my-project --edits --path src --limit 30
dsh-session-intelligence --cwd /Users/you/Documents/my-project --frequency --top 20
```

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-session-intelligence
```

## What the bundle does

The package declares a DSH bundle (`dsh.bundle.patch` → `cordis.patch.yml`),
so `dsh plugin` installs it and applies its patch: one plain host row
(`hy-sde-tool-session-intelligence`), like the official harness's own
`tool-session-query` row. It consumes the deployment's host services —
`tools` (stock base), `systemPrompt` (stock base), and `sessionQuery` (stock
base mounts `@deepseek-ai/dsh-session-query` with the sqlite index backend) —
so it needs no realm, no filesystem access, and no persistence of its own:
the tools are scoped to the caller workspace by `sessionQuery.filterSessions`
with a `cwd` clause, and unreadable sessions are counted and reported.

Each session's event stream (`user/message`, `assistant/message`,
`tool/call`, `tool/result`, `compaction/*`) is reduced into: outcome +
confidence, health score + grade + basis + penalties, tool-health signals,
heuristic signals, compaction/mid-task counts, peak context tokens, the model
(when recorded), and the context-pressure ratio. Inherited seeded prefixes are
skipped, so subagent children ignore their parent's events.

## Configuration

All options are optional; the row's `config:` fills the defaults.

| Option | Default | Purpose |
| --- | --- | --- |
| `maxSessions` | `200` | maximum sessions scanned |
| `recentLimit` | `20` | default table size for `session_health { action: "recent" }` |
| `timeoutMs` | `60000` | tool-call budget |

```yaml
- id: hy-sde-tool-session-intelligence
  name: '@hy-sde-org/dsh-session-intelligence'
  config:
    maxSessions: 200
    recentLimit: 20
    timeoutMs: 60000
```

## Compatibility

| Component | Supported contract |
| --- | --- |
| Node.js | 22.19 or newer (`engines.node >=22.19.0`) |
| DeepSeek Harness | `0.2.0-rc.2` peer range (`@deepseek-ai/cordis ~4.0.4`; `dsh-llm`, `dsh-session-query`, `dsh-system-prompt`, `dsh-timeout`, `dsh-tools` `^0.2.0-rc.2`) |
| Host services | `tools`, `systemPrompt`, `sessionQuery` (the stock base bundle mounts all three) |
| Session artifacts | `session.jsonl.zstd` (multi-frame zstd via `@hy-sde-org/dsh-zstd-frame`) or `session.jsonl` (CLI path) |

Upstream seam-contract changes require a new package release and contract
review.

## Development

```bash
pnpm install
pnpm -r check        # tsc --noEmit
pnpm -r test         # vitest run
pnpm -r build        # tsc -p tsconfig.build.json
```

The engine is importable with the same numbers the tool reports:
`analyzeSession({ id, createdAt, events })` from
`@hy-sde-org/dsh-session-intelligence` (see the
[sub-package README](packages/session-intelligence/README.md) for the pure
entry points and the full tool-argument tables).

## License and attribution

MIT — see [LICENSE](./LICENSE). Ports of agentsview (MIT, Kenn Software) and
`dsh-session-persistence-jsonl` (MIT) are attributed in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md); zstd artifacts are read
via `@hy-sde-org/dsh-zstd-frame`.

This plugin is a separate installable package; the harness remains the
property of its own project.
