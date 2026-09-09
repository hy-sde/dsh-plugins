---
description: "Model-facing Logseq CLI tools for driving a Logseq database graph from the terminal: list, show, search, Datalog query, upsert, remove, and graph/server lifecycle with deterministic JSON output."
kind: "package-reference"
---

# @hy-sde-org/dsh-tool-logseq

English | [中文](README.zh.md)

## Summary

`dsh-tool-logseq` lets an agent drive a Logseq database graph from the terminal: list, show, search, Datalog-query, upsert, and remove blocks, pages, tags, properties, tasks, and assets, plus graph and server lifecycle actions. Choose it over the desktop-app MCP bridge when you want deterministic JSON output, Datalog querying, structured task upserts, or fully headless operation — the MCP bridge needs the app open and lacks removal, Datalog, and task commands. The tools run the installed `logseq` CLI on every call, so the CLI must be installed and each call pays one process spawn; the cheapest path is to batch writes into single `logseq_upsert` calls and start a headless server with `logseq_server start`.

## Table of Contents

- [Tool surface](#tool-surface)
- [Why CLI over MCP](#why-cli-over-mcp)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Model-facing [Logseq](https://logseq.com/) CLI tools that drive a Logseq database graph directly from the terminal. The surface is the local alternative to the desktop-app MCP bridge: besides the read/write basics it adds what the MCP bridge cannot do — Datalog `query`, `remove`, first-class `task` upserts, and graph/server lifecycle — all wrapped from the installed `logseq` CLI (`opam exec -- dune build @bundle`, or the prebuilt binary).

## Tool surface

- `logseq_list [entityType=page] [limit] [offset] [sort] [order] [fields] [includeBuiltIn] [journalOnly] [includeHidden] [withProperties] [withExtends] [taskStatus] [taskPriority] [content]` — list pages, tags, properties, tasks, nodes or assets from the graph with entity-specific toggles.
- `logseq_show [page | id | uuid] [level] [pageHierarchy] [linkedReferences]` — render the block/page tree as text.
- `logseq_search [entityType] [content] [limit]` — full-text search over blocks/pages/properties/tags.
- `logseq_query [query | name] [inputs] [limit]` — Datascript query (structural questions one hop can't answer).
- `logseq_upsert [entityType] [...]` — create/update blocks, pages, tags, properties and tasks; tasks get structured `status`/`priority`/`scheduled`/`deadline`, tags/properties are EDN-mapped, never embedded in content.
- `logseq_remove [entityType] [id|uuid|page|name]` — permanent removal (use only when certain).
- `logseq_graph [action] [...]` — validate/info/export (edn|sqlite)/import/backup lifecycle.
- `logseq_server [action]` — list/start/stop/restart/cleanup the db-worker-node servers; `start` enables fully headless operation without the desktop app.

## Why CLI over MCP

The desktop MCP bridge serves the same graph when the app is open, but requires the app + token header, has no Datalog, no removal, no task commands, and dumps large raw schemas into every request. The CLI wrapper is deterministic JSON (`--output json` → `{"status":"ok","data":…}`), headless-capable, full-surface, and compact. Keep the MCP row around disabled if you want a zero-maintenance fallback.

## Configuration

```ts
import { Context } from '@deepseek-ai/cordis'
import toolLogseqPackage from '@hy-sde-org/dsh-tool-logseq'

const ctx = new Context()
ctx.plugin(toolLogseqPackage, {
  cliPath: 'logseq', // CLI executable (default: on PATH)
  graph: 'llm-wiki', // always pass --graph <name>
  timeoutMs: 60000, // per-call process timeout
  maxItems: 50, // cap on rendered list/search items
})
```

Setting `graph` makes every call explicit about its target graph. The plugin activation invariant fails fast with an install hint when the CLI is missing.

## Model Experience

### Tool schemas

#### What the model sees

Tool descriptions + schemas encode the CLI contract so the model prefers the CLI path over the MCP bridge, batches writes one logical change per call, and uses structured task status instead of TODO markers in content.

#### Token effect

Eight hand-authored schemas are added once to the request prefix (~1–2 KB total), far smaller than the MCP `upsertNodes` schema on every call; results are compact renders (capped by `maxItems`), so token cost stays bounded regardless of graph size.

#### KV Cache effect

All schemas are static; per-call args vary but never condition the request prefix. Cached prefixes stay valid across calls.

### Result values

#### What the model sees

Structured enumerations and query rows as plain data, plus the CLI's human tree text for `show`. Human error envelopes (`Error (...)` prints) surface as `LogseqCliError` with argv attached, never as fake success.

#### Token effect

List/search results are capped (`maxItems`, default 50) and summarized; query rows are flattened to compact lines; server/graph tables pass through small plain text.

#### KV Cache effect

Results are per-call snapshots; no read-back that would change the model's rerun prefix.

### Prompt section

#### What the model sees

One `logseq:tools` card: prefer CLI over MCP, one logical change per call, existence-checks before create, removals are permanent, tasks use structured status, and `logseq_server` start for headless use.

#### Token effect

Six short lines added once to the request prefix; negligible per turn.

#### KV Cache effect

Static section text — no invalidation.

## Known Limitations and Deferred Work

- **CLI must be installed** — the tools spawn `logseq`; there is no bundled binary (the CLI is built from the logseq repo). The activation invariant gives an install hint and `cliPath` supports a non-PATH binary.
- **Per-call process spawn** — each tool call starts a fresh CLI process (the CLI's own model). High-frequency shells (many separate edits) cost process startups; batch structured changes in single `logseq_upsert` calls instead.
- **Graph server required** — the graph needs a db-worker-node server; the tools reuse the running one (including the desktop app's) or `logseq_server start` launches a headless one. A stopped server surfaces as a CLI error, not a clean retry path.
- **JSON shapes are read at runtime** — `list/search/query` item fields follow the CLI's JSON contract; if a future CLI changes shape, the compact renders degrade gracefully rather than crashing.
- **No asset upload** — `logseq_upsert`/`logseq_list` cover assets only via the generic node/asset listing; binary asset ingestion stays a file/CLI concern for now.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
