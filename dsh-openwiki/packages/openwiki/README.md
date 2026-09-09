# @hy-sde-org/dsh-openwiki

Standalone port of the [openwiki](https://github.com/langchain-ai/openwiki)
0.4.3 **deterministic engine core** (MIT-licensed; attribution preserved in
the module headers): the model-free repository wiki machinery that upstream
pairs with DeepAgents. This port removed the DeepAgents/CLI coupling — the
engine runs in-process behind a minimal `WikiFs` filesystem seam, so no
external `openwiki` CLI is needed. Repositories written by either engine are
interoperable because the on-disk formats are identical.

## Surface

Pure TypeScript library (only `zod` + `yaml` deps), organized as `src/*`:

- **Lifecycle** — resumable repository-page-job orchestration
  (`begin` / `submit_plan` / `next_page` / `submit_page` / `finish`) with a
  durable `.run.json` checkpoint, git source fingerprinting, update no-op
  detection, and a `.page-manifest.json` correctness ledger
  (`generation/*`, `agent/utils.ts`).
- **Claims** — Grounded Claims core (add/confirm/update/retract mutations),
  the code-brain store/session/runtime with `.claims/` sidecar persistence and
  verification, and the repository evidence resolver that maps
  `repo://path#L20-L48` resources to opaque `repo-lines-v1:sha256:` versions
  with relocation anchors (`claims/*`).
- **OKF** — OKF v0.2 front matter validation/repair, generated provenance,
  index-labels, recursive concept-index synchronization, claim-sources, and
  claims-verification projection (`okf/*`).
- **Validation** — Mermaid fence validation (jsdom/mermaid optional, graceful
  heuristic fallback) and wiki-internal-link validation with broken-link
  stamping (`mermaid/*`, `agent/wiki-link-validator.ts`).
- **Setup + fs** — `.openwikiignore` load, managed AGENTS.md/CLAUDE.md
  snippets + `INSTRUCTIONS.md` wiki goal, recoverable init wiki replacement,
  and the standalone `WikiFs`/`createNodeWikiFs` seam (`agent/*`, `fs/*`).
- **Integration** — the transport-neutral `HostSessionManager` + zod
  protocol (`openwiki_begin` … `openwiki_finish`) and Git repository-root
  resolution (`integrations/core/*`).

## Usage

The engine is normally consumed by `@hy-sde-org/dsh-tool-openwiki`, which
registers the five lifecycle tools. Direct use (e.g. an automated pipeline)
goes through `HostSessionManager`:

```ts
import { HostSessionManager, resolveRepositoryRoot } from '@hy-sde-org/dsh-openwiki'

const manager = HostSessionManager.create({ host: 'pipeline' })
const { view } = await manager.begin({ root: '/repo', mode: 'init' })
// ... submitPlan / nextPage / submitPage / finish over the same manager
```

## WikiFs

The engine touches the repository only through `WikiFs` (preset methods
`ls` / `readRaw` / `write` / `edit` / `delete` over virtual `/openwiki/...`
paths with root containment). `createNodeWikiFs({ root })` provides the Node
implementation; custom backends can provide their own.

## License

MIT — see the repository [`LICENSE`](../../LICENSE). Ported from openwiki
0.4.3, Copyright (c) 2026 langchain-ai (MIT), attribution preserved per file.
