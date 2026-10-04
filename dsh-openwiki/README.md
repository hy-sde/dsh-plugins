<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-openwiki`](https://www.npmjs.com/package/@hy-sde-org/dsh-openwiki) · [`@hy-sde-org/dsh-tool-openwiki`](https://www.npmjs.com/package/@hy-sde-org/dsh-tool-openwiki)
<!-- MIRROR-NOTE:END -->

# dsh-openwiki — OpenWiki evidence-wiki engine + lifecycle tools for DeepSeek Harness

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

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- for `@hy-sde-org/dsh-tool-openwiki` — DeepSeek Harness `0.2.0-rc.2` or
  newer, peer range `^0.2.0-rc.2` (`@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-system-prompt`,
  `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-util-values`);
- for `@hy-sde-org/dsh-openwiki` — the `jsdom` (`^29.1.1`) and `mermaid`
  (`^11.16.0`) peers, resolved by your install.

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh@0.2.0-rc.2 pnpm
dsh --version
```

## Quick start

### Route A — published npm packages (recommended)

Neither package ships a `cordis.patch.yml` bundle row, so there is no
`dsh plugin add` route: install both as plain dependencies (the tool
package resolves the engine):

```bash
pnpm add @hy-sde-org/dsh-openwiki @hy-sde-org/dsh-tool-openwiki
```

### Route B — mount the tool row from an agent preset

Mount the tool package as an agent-plane row (see
[`packages/tool-openwiki/examples/agent-preset/`](packages/tool-openwiki/examples/agent-preset)
for a ready-to-copy preset). The `openwiki:tools` prompt section wires
`codebase_*` tools in as the structural-discovery layer alongside the
lifecycle tools.

### From this repository (pre-publish / development)

```bash
pnpm install
pnpm -r check     # strict typecheck
pnpm -r test      # engine + tool tests (engine suite covers a real git repo)
pnpm -r build     # tsc → dist
```

### Verify

No bundle row ships, so nothing appears in `dsh web --dump-config` by
design. Verification is session-level: with the preset row mounted, the
agent session registers the five lifecycle tools — `openwiki_begin`,
`openwiki_submit_plan`, `openwiki_next_page`, `openwiki_submit_page`,
`openwiki_finish` — plus the `openwiki:tools` prompt section.

### Uninstall

Remove the agent-plane `tool-openwiki` row from your preset, then drop the
dependency from the installing project:

```bash
pnpm remove @hy-sde-org/dsh-openwiki @hy-sde-org/dsh-tool-openwiki
```

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md), and
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## License

MIT — see [`LICENSE`](LICENSE). Ported portions retain upstream attribution;
the openwiki engine core is Copyright (c) 2026 langchain-ai (MIT). The
upstream notice text is reproduced in full in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
