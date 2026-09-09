---
description: "Model-facing codebase-memory tools that run one-shot queries against the local codebase-memory daemon, spawning the CLI once per call and sharing the same daemon the stdio MCP client fronts."
kind: "package-reference"
---

# @hy-sde-org/dsh-tool-codebase-memory

English | [中文](README.zh.md)

## Summary

`dsh-tool-codebase-memory` exposes the local codebase-memory daemon as model-facing `codebase_*` tools that run one-shot queries from the terminal. Each call spawns `codebase-memory-mcp cli --json <tool>` once and parses the raw MCP result envelope against the same daemon the MCP server fronts, so indexes, project mutation locks, and the index supervisor are fully shared — warm daemon calls cost ~0.2 s. Choose it over the stdio MCP client row when you want one process per call, tightened schemas, and per-preset configuration instead of a long-lived server inside every session, keeping the MCP row disabled as a zero-maintenance fallback. The main boundary is that the curated schemas are a hand-maintained mirror of the CLI's input schemas, so a codebase-memory release that adds tools needs this package updated.

## Table of Contents

- [Tool surface](#tool-surface)
- [Why CLI over MCP](#why-cli-over-mcp)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Model-facing [codebase-memory](https://github.com/DeusData/codebase-memory-mcp) tools that run one-shot queries against the local codebase-memory daemon from the terminal. The surface is the local alternative to the stdio MCP client row: instead of holding a long-lived MCP server inside every session, each call spawns `codebase-memory-mcp cli --json <tool>` once and parses the raw MCP result envelope — **the same daemon the MCP server fronts**, so indexes, project mutation locks and the index supervisor are fully shared. Warm daemon calls cost ~0.2 s on this machine (cold spawn ~1.3 s; `codebase-memory-mcp daemon start` keeps one warm).

## Tool surface

- `codebase_list_projects` — all indexed projects (name, root path, git state); the vocabulary source for `project` everywhere else.
- `codebase_index_repository [repoPath] [mode=full|moderate|fast|cross-repo-intelligence] [targetProjects] [name] [persistence]` — index a repo once, query it repeatedly.
- `codebase_index_status [project]` — node/edge counts, freshness, skipped & partially-parsed files, last run's logfile.
- `codebase_search_graph [query|namePattern|semanticQuery|label|filePattern|limit|offset|...]` — the primary finder: definitions, implementations, relationships; pages with `limit`/`offset` until `has_more` is false.
- `codebase_query_graph [query] [maxRows]` — raw Cypher over the graph (multi-hop, aggregation, cross-service), including complexity/loop hot-path properties.
- `codebase_trace_path [functionName] [direction] [depth] [mode=calls|data_flow|cross_service] [...]` — callers/callees, value flow, cross-service hops.
- `codebase_get_code_snippet [qualifiedName] [includeNeighbors]` — source of one symbol, no file hunting.
- `codebase_get_graph_schema [project]` — node labels + edge types (Cypher vocabulary).
- `codebase_get_architecture [path] [aspects]` — packages/services/dependencies + Leiden clusters over the call/import graph.
- `codebase_search_code [pattern] [mode=compact|full|files] [filePattern|pathFilter|limit]` — grep-augmented, deduped into containing functions, ranked.
- `codebase_detect_changes [baseBranch|since|depth|scope]` — git diff mapped onto the graph: what a change touches.
- `codebase_manage_adr [mode=get|update|sections] [content] [sections]` — read/write Architecture Decision Records.
- `codebase_ingest_traces [traces]` — fold `{caller, callee, count}` runtime traces into the graph.
- `codebase_delete_project [project]` — destructive; use only for superseded indexes.

## Why CLI over MCP

The MCP client row (`@deepseek-ai/dsh-mcp-client` with `command: codebase-memory-mcp`) works, but it keeps a long-lived stdio server running inside **every** session and exposes all tools verbatim with the `mcp__codebase__*` prefix. The CLI wrapper spawns per call and exits — nothing to recycle, nothing to crash, nothing warm in the session — with clean `codebase_*` names, tightened schemas, and per-preset configuration. Functionally identical: the `cli` mode executes through the same daemon (`main_local_cli_daemon_execute` → `cbm_daemon_application_client_tool`), which is exactly what made the logseq CLI-first pivot viable. Keep the MCP row around disabled if you want a zero-maintenance fallback.

## Configuration

```ts
import { Context } from '@deepseek-ai/cordis'
import toolCodebaseMemoryPackage from '@hy-sde-org/dsh-tool-codebase-memory'

const ctx = new Context()
ctx.plugin(toolCodebaseMemoryPackage, {
  cliPath: 'codebase-memory-mcp', // CLI executable (default: on PATH)
  project: 'deepseek-harness', // default project for tools that can omit it
  timeoutMs: 60000, // per-call process timeout (index calls use indexTimeoutMs)
  indexTimeoutMs: 600000, // timeout for codebase_index_repository
  maxChars: 200000, // cap on rendered JSON payload before explicit truncation
})
```

Setting `project` makes every call explicit about its graph target while still allowing overrides. The plugin activation invariant fails fast with an install hint when the CLI is missing. Verify at any time with `codebase-memory-mcp cli list_projects`.

## Model Experience

### Tool schemas

#### What the model sees

Fourteen hand-authored `codebase_*` schemas (see the [tool surface](#tool-surface)) encode the graph contract so the model prefers graph answers (`codebase_search_graph` / `codebase_trace_path` / `codebase_get_code_snippet`) over repeated grep/read cycles, pages with `limit`/`offset`, and indexes new repos before relying on answers.

#### Token effect

Fourteen static schemas are added once to the request prefix (~3–5 KB total), far smaller than streaming fifteen MCP schemas with their full paragraphs into every session; results are JSON payloads capped by `maxChars` (default 200000), so a runaway Cypher cannot blow the context.

#### KV Cache effect

All schemas are static; per-call args vary but never condition the request prefix. Cached prefixes stay valid across calls.

### Result values

#### What the model sees

Structured JSON payloads parsed out of the MCP result envelope (content text is JSON too — the wrapper re-parses it), so the model sees the same objects the MCP tools returned, e.g. `search_graph`'s `{total, results, has_more}` tree rows. Tool errors (`isError: true` in the envelope, exit 0 under `--json`) surface as `CodebaseMemoryCliError` with argv/exit code attached — never as fake success.

#### Token effect

Payloads are passed through and truncated only past the `maxChars` cap with an explicit marker; the CLI's own `limit`/`offset` paging is the primary cost control.

#### KV Cache effect

Results are per-call snapshots; no read-back that would change the model's rerun prefix.

### Prompt section

#### What the model sees

One `codebase:tools` card: index before asking, prefer graph answers over repeated greps, page with `limit`/`offset`, Cypher for what the curated tools cannot express, `codebase_delete_project` is destructive.

#### Token effect

Six short lines added once to the request prefix; negligible per turn.

#### KV Cache effect

Static section text — no invalidation.

## Known Limitations and Deferred Work

- The curated schemas are a hand-maintained mirror of the CLI's input schemas; a codebase-memory release that adds tools needs this package updated (the harness's MCP row auto-follows — a good reason to keep it as a disabled fallback).
- `check_index_coverage` is declared by the binary's tool table but not dispatchable through `cli` ("unknown tool"), so it is intentionally not wrapped.
- No host-plane service or GUI surface: the binary already ships a graph visualizer at `localhost:9749`; an in-GUI drawer (like the logseq wiki pane) is future work.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
