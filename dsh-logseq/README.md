# dsh-logseq — headless LLM-wiki (Logseq CLI graph service + tools) for DeepSeek Harness

Two standalone packages, installable as **one plugin family** for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-logseq-graph` | the service: host-plane `ctx.wikiGraph` backed by the installed `logseq` CLI (+ `invariant` companion) | yes |
| `@hy-sde-org/dsh-tool-logseq` | the model-facing `logseq_*` tools (list/show/search/query/upsert/remove/graph/server) + `logseq:tools` prompt section | yes |

This is the DeepSeek Harness `packages/logseq` family — the `logseq-graph`
host service and the `logseq` CLI tools — ported to the hy-sde npm scope as a
**standalone plugin family with zero upstream harness changes**: every
`@deepseek-ai` dependency resolves from the npm registry at the `0.1.2-rc.1`
baseline, so it installs on official DeepSeek Harness releases
(`dsh-v0.1.2-rc.1` and later) exactly as it runs in the fork. The service row
ships as a normal package (no `cordis.patch.yml` inside — see
[Mounting](#mounting)), and the tool row ships as an agent-plane plugin.

## Summary

The `logseq/` family gives agents a headless LLM-wiki backed by the
[Logseq](https://github.com/logseq/logseq) CLI:

- [`logseq-graph/`](packages/logseq/logseq-graph/README.md) — host graph
  service (`ctx.wikiGraph`): page/block trees, tags, properties, Datalog
  queries, upserts/removals, and the `logseq_server` lifecycle, projected to
  plain-JSON wire types.
- [`tool-logseq/`](packages/logseq/tool-logseq/README.md) — model-facing
  `logseq_*` tools: list/show/search/query/upsert/remove/graph/server with
  deterministic JSON output, plus a `logseq:tools` prompt card.

In the upstream harness, the web GUI's wiki drawer reads/writes the graph
through this service via the host API proxy's `wiki` domain, and the browser
drawer (`dsh-client-ui-wiki`) is a separate package — neither ships here. This
standalone publishes the service + tool surface only.

## Table of Contents

- [Install](#install)
- [Mounting](#mounting)
- [License](#license)

-----

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-logseq-graph @hy-sde-org/dsh-tool-logseq
```

### From this repository (pre-publish)

```bash
pnpm install            # workspace setup
pnpm -r build
pnpm --filter packages/logseq/logseq-graph pack
pnpm --filter packages/logseq/tool-logseq pack
dsh plugin --profile web add <tarball-or-catalog-url>.tgz
```

`prepack` rebuilds `dist/`, so the tarball is always current. Then bring the
service row plus the tool row together in your composition as described under
[Mounting](#mounting).

## Mounting

Unlike `dsh-browser`, this family ships **no `cordis.patch.yml` and no
ready-made agent preset**: the port scope is the `.ts` surface only, and the
upstream harness wires these rows in its own web-app bundle patch. Add the two
rows to your composition by hand:

- **Service row (host plane)** — `ctx.wikiGraph` is consumed by the host API
  proxy / wiki drawer rows in the upstream harness, so it belongs in the host
  composition, not behind a preset realm:

  ```yaml
  - id: logseq-graph
    name: '@hy-sde-org/dsh-logseq-graph'
    config:
      graph: llm-wiki
  ```

- **Tool row (agent plane)** — the tools resolve `tools` + `systemPrompt`
  from the agent bundle; add it to the agent preset:

  ```yaml
  - id: tool-logseq
    name: '@hy-sde-org/dsh-tool-logseq'
    config: {}
  ```

`@hy-sde-org/dsh-tool-logseq` declares `@hy-sde-org/dsh-logseq-graph` as a
peer (and a `workspace:*` sibling dep in this repo) so the family ships and
resolves together.

## License

MIT — see `LICENSE`. Derived from the DeepSeek Harness logseq packages
(`@deepseek-ai/dsh-logseq-graph`, `@deepseek-ai/dsh-tool-logseq`, MIT) — see
`THIRD-PARTY-NOTICES.md`.
