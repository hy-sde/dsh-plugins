# @hy-sde-org/dsh-memory

**Agent-curated long-horizon memory** for DeepSeek Harness — the `ctx.memory`
service and its provider registry, ported from the [@oh-my-pi](https://github.com/oh-my-pi)
coding-agent memory surface (the port lives in the
[hy-sde fork](https://github.com/hy-sde/deepseek-harness)). Memory is durable,
**project-scoped** data the agent curates itself with the
`retain`/`recall`/`reflect`/`memory_edit`/`learn` tools (shipped by
`@hy-sde-org/dsh-tool-memory`), and it is **reloaded at the start of the next
session** through prompt injection. It complements DSH's session-query and
compaction instead of overlapping them: those replay conversation history,
this bank answers "what did we decide / prefer / learn here?" across sessions.

This is a **standalone plugin build**: the harness integration (the host-plane
`memory` row) ships in `cordis.patch.yml`, and the agent-plane tools live in
`@hy-sde-org/dsh-tool-memory`. Nothing in the upstream DeepSeek Harness
(`dsh-v0.1.2-rc.1` and later) needs to change.

Only the **`local` backend** ships. The registry keeps the seam open for
Hindsight/Mnemopi-style providers later — a future provider registers one
`MemoryBackend` and the same tools work unchanged.

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

Both packages are published on the npm registry under the `hy-sde-org`
organization (`@hy-sde-org/dsh-memory` and `@hy-sde-org/dsh-tool-memory`,
version `0.1.2-rc.1`). Add the service, then mount the tools via a preset:

```bash
# one command; the tool package comes in as a transitive dependency
dsh plugin --profile web add @hy-sde-org/dsh-memory @hy-sde-org/dsh-tool-memory
```

Then copy `examples/agent-preset/` from the installed package (or this repo)
to `~/.dsh/.agent-presets/<id>/` and select it in the Web UI preset picker
(or `dsh agent`). The preset row uses `@hy-sde-org/dsh-tool-memory`.

### From the git checkout (pre-publish / development)

```bash
git clone git@github.com:hy-sde/dsh-memory.git
cd dsh-memory
pnpm install
pnpm run build

MEMORY_TGZ="$(cd packages/memory && pnpm pack --silent --pack-destination /tmp)"
TOOLMEMORY_TGZ="$(cd packages/tool-memory && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$MEMORY_TGZ" "$TOOLMEMORY_TGZ"
```

## Layout

The service is host-plane: the store is durable project data that crosses
sessions, so `cordis.patch.yml` inserts one row into the profile; the
per-session tools resolve it. Data lives under `<harness home>/memories/<project>/`
where `<project>` is an encoded absolute cwd — one memory root per project,
shared by every session and tool on it.

Each project root holds three artifacts:

- `bank.jsonl.zstd` — editable working entries written by `retain` (id,
  content, context, source, importance, timestamps, active flag). Backs
  `memory_edit`. On-disk container is the same zstd frame format the harness
  session logs use: each save batch is one checksummed Zstandard frame
  (concatenated, append-only, self-healing). The pre-rename plaintext
  `bank.jsonl` is still read and is migrated on the first write; set
  `compression: 'none'` in `LocalMemoryConfig` for the original line-append
  format. The codec ships inside this package (`/frame-codec` subpath,
  `node:zlib`-only).
- `learned.md` — newest-first, deduped, capped (100) lesson bullets written by
  `learn`; the same format and normalization omp keeps. Survives
  consolidation; `learn` writes are injection-neutralized and secret-redacted.
- `memory_summary.md` — optional consolidated summary (hand- or tool-maintained)
  that `recall`, `reflect`, and prompt injection surface.

## Service API

```ts ignore-check
const memory = ctx.memory                       // MemoryService
await memory.save({ cwd }, { content, context, source, importance })
await memory.learn({ cwd }, { content, context })
await memory.search({ cwd }, 'query', { limit: 10 })
await memory.edit({ cwd }, 'update' | 'forget' | 'invalidate', { id, content, importance, replacementId })
await memory.summaries({ cwd })                 // { summary?, learned?, block }
await memory.status({ cwd })
await memory.clear({ cwd })
```

Backends register into the service: `memory.register(backend)` returns a
disposer, and `memory.resolve()` returns the configured (default: first)
backend. Mutations emit `memory/change` (`{ cwd }`) so in-process consumers
can invalidate caches.

A `MemoryBackend` is a dozen methods over `@hy-sde-org/dsh-memory/types`;
the shipped one, `LocalMemoryBackend`, is pure-node (`node:fs`) with an
in-process per-file write chain so concurrent saves from sibling sessions can
never drop each other's writes.

## `memory://` internal URLs

When the host composition mounts `@hy-sde-org/dsh-internal-urls` (the shared
registry behind the read/grep tools), this plugin registers a `memory://`
scheme in `ctx.internalUrls` — once per process, via `ctx.inject`, and it is a
graceful no-op in compositions without the registry. Every resolved resource
is `immutable: true`: agents never rewrite durable memory through a
file-shaped URL; `memory_edit` is the mutation surface.

Two URL forms:

- `memory://root` — the project's consolidated memory overview (summary +
  learned lessons + working bank, the same block prompt injection uses).
  An empty project reads a "Project memory is empty" pointer instead.
- `memory://<id>` — one stored entry in full, with a metadata header
  (`id`, `source`, `importance`, `timestamp`, `readonly`). Ids are the same
  ones `recall`/`reflect` surface: bank rows by their `m_*` id, lessons as
  `lesson_<hash>` (read-only), and the consolidated summary as `summary_0`
  (read-only). Reads are scoped to the calling session's project (`cwd`).

Corrective errors, following the upstream oh-my-pi
(`coding-agent/src/internal-urls/memory-protocol.ts`) HINDSIGHT_UNADDRESSABLE
pattern:

- **not addressable** — the selected backend has no `readEntry` (a
  non-addressable store): "The `…` memory backend is not addressable via
  memory://\<id\>", pointing back at `recall`/`reflect`.
- **not found** — the id does not exist in this project (or was retired):
  "Memory `…` does not exist in this project", pointing at `recall`/`memory_edit`.
- a missing namespace, a missing cwd, an unregistered backend, and paths under
  `root`/an id all get their own corrective messages.

Completions: `complete()` returns `root` plus every addressable entry id
(`listEntries`, newest first, capped at 50) with a one-line content preview;
a backend that only implements `readEntry` falls back to a `<id>` placeholder,
and one with neither completes only `root`. The `memory://` scheme never
takes a path (backend-shaped, not file-shaped).

## Config (the `memory` row)

| Key | Default | Meaning |
|---|---|---|
| `root` | `<harness home>/memories` | Memory root (`~`/`$HOME` expand). |
| `backend` | first registered | Backend id the service delegates to. |
| `defaultImportance` | `0.7` | Baseline importance when a save omits it. |
| `searchLimit` | `10` | Default result cap for one search. |

Per-entry caps: bank content 4000 chars, bank context 800, lesson content
2000, lesson context 400, lessons capped at 100 newest-first. All stored text
passes injection-neutralization (control chars, `<`/backticks, `~~~` fences)
then secret-redaction, on write and on read.

## Tests

```sh
pnpm -r --filter @hy-sde-org/dsh-memory test
```
