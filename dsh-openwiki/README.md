# dsh-openwiki

Standalone public packages that bring the **OpenWiki** deterministic engine
([langchain-ai/openwiki](https://github.com/langchain-ai/openwiki), MIT) into
DeepSeek Harness as an **in-process plugin** — no external `openwiki` CLI.

| Package | What it is |
| --- | --- |
| [`@hy-sde-org/dsh-openwiki`](packages/openwiki) | The ported deterministic engine core: resumable page-job lifecycle, Grounded Claims store/evidence resolver, OKF front matter + index sync + provenance, Mermaid + wiki-link validation, behind a minimal `WikiFs` seam. |
| [`@hy-sde-org/dsh-tool-openwiki`](packages/tool-openwiki) | The five `openwiki_*` lifecycle tools + `openwiki:tools` prompt section for a DeepSeek Harness agent. |

## Why

OpenWiki turns a repository into a **grounded evidence wiki**: generated pages
under `openwiki/` whose every material Claim is tied to a repository evidence
resource (`repo://path#L#-L#`) and stored in `.claims/` sidecars. The wiki is
durable, diffable, reviewable markdown — readable by agents and humans — while
the engine that produces it is a deterministic, resumable state machine
(`.run.json` ↔ `.page-manifest.json` ↔ `.last-update.json`).

This port keeps OpenWiki's on-disk formats byte-compatible with upstream
0.4, strips the DeepAgents/home/CI coupling, and exposes the lifecycle through
Cordis plugins so any DSH agent session can drive a full
`init → plan → page → finish` run with plain tool calls.

## Packages

```
packages/openwiki        → @hy-sde-org/dsh-openwiki      (engine, in-process)
packages/tool-openwiki   → @hy-sde-org/dsh-tool-openwiki (5 tools + prompt)
```

Both are standalone npm packages; the tool package resolves the engine as a
workspace/`npm` dependency and never needs a forked harness.

## Getting started

```bash
pnpm install
pnpm -r check     # strict typecheck
pnpm -r test      # engine + tool tests (engine suite covers a real git repo)
pnpm -r build     # tsc → dist
```

### Using the tools in a DeepSeek Harness agent preset

Mount the tool package as an agent-plane row (see
[`packages/tool-openwiki/examples/agent-preset/`](packages/tool-openwiki/examples/agent-preset)
for a ready-to-copy preset). The `openwiki:tools` prompt section wires
`codebase_*` tools in as the structural-discovery layer alongside the
lifecycle tools.

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md), and
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## License

MIT — see [`LICENSE`](LICENSE). Ported portions retain upstream attribution;
the openwiki engine core is Copyright (c) 2026 langchain-ai (MIT).
