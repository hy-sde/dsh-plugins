<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-memory`](https://www.npmjs.com/package/@hy-sde-org/dsh-memory) · [`@hy-sde-org/dsh-tool-memory`](https://www.npmjs.com/package/@hy-sde-org/dsh-tool-memory)
<!-- MIRROR-NOTE:END -->

# dsh-memory — durable project memory for DeepSeek Harness

Two standalone packages here, installable as **one plugin** for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-memory` | the plugin: host-plane `ctx.memory` service + shipped `local` backend (bundle row + preset example) | yes |
| `@hy-sde-org/dsh-tool-memory` | the model-facing tools (`retain` / `recall` / `reflect` / `memory_edit` / `learn` / `mine_sessions`) + first-turn prompt injection | yes |

(`@hy-sde-org/dsh-memory-extraction`, automatic extraction at compaction
checkpoints, ships from the sibling [`dsh-memory-extraction/`](../dsh-memory-extraction)
workspace directory.)

This is the oh-my-pi agent-memory surface, ported onto the harness
`ctx.memory` service contract as a **standalone
plugin with zero upstream harness changes**: the service row ships as a
`cordis.patch.yml` bundle, the tool row ships as a ready-to-copy agent
preset, and every `@deepseek-ai` dependency resolves from the npm registry at
the `0.2.0-rc.2` baseline — so it installs on official DeepSeek Harness
releases (`dsh-v0.2.0-rc.2` and later) exactly as it runs in the hy-sde fork.

| Identity | Value |
| --- | --- |
| Packages | `@hy-sde-org/dsh-memory` (service) · `@hy-sde-org/dsh-tool-memory` (tools) |
| Plugin ids | `memory` — host-plane service row inserted by the bundle · `tool-memory` — agent-plane preset row |
| Seam | `ctx.memory` + the `memory://` scheme; `retain` / `recall` / `reflect` / `memory_edit` / `learn` / `mine_sessions` tools and the `memory:project` prompt section |

> **Based on [oh-my-pi](https://github.com/can1357/oh-my-pi)** — the agent-memory
> surface (durable project-scoped bank, learned lessons, consolidation, and the
> retain/recall/reflect/memory_edit/learn data model) is ported from oh-my-pi and
> adapted to the DeepSeek Harness `ctx.memory` seam. oh-my-pi is MIT-licensed
> (Mario Zechner, Can Bölük); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Why

Compaction and session boundaries erase working context: the next session
starts from conversation replay, not from what the project decided. This
plugin is the counterweight — durable, **project-scoped** memory the agent
curates itself with the memory tools, **reloaded at the start of the next
session** through prompt injection. It complements DSH's session-query and
compaction instead of overlapping them: those replay conversation history,
this bank answers "what did we decide / prefer / learn here?" across
sessions.

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- DeepSeek Harness `0.2.0-rc.2` or later, including the standard `dsh` CLI;
- no keys and no external services — the shipped `local` backend is pure
  Node (`node:fs`, zstd frame container) storing under
  `<harness home>/memories/<project>/`;
- optional: a host `sessionQuery` service (enables `mine_sessions` and the
  session tier of `recall`) and the `@hy-sde-org/dsh-internal-urls` registry
  (enables `memory://` reads through the read/grep tools) — both degrade
  gracefully when absent.

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh@0.2.0-rc.2 pnpm
dsh --version
```

## Quick start

### Route A — published npm package (recommended)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-memory @hy-sde-org/dsh-tool-memory
```

Then copy the preset from `packages/memory/examples/agent-preset/` to
`~/.dsh/.agent-presets/<id>/` and select it in the Web UI preset picker:

```bash
mkdir -p ~/.dsh/.agent-presets/my-memory
cp packages/memory/examples/agent-preset/agent.cordis.yml \
   packages/memory/examples/agent-preset/preset.yml \
   ~/.dsh/.agent-presets/my-memory/
```

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @hy-sde-org/dsh-memory build

MEMORY_TGZ="$(cd dsh-memory/packages/memory && pnpm pack --pack-destination /tmp | tail -n 1)"
TOOLMEMORY_TGZ="$(cd dsh-memory/packages/tool-memory && pnpm pack --pack-destination /tmp | tail -n 1)"
dsh plugin --profile web add "$MEMORY_TGZ" "$TOOLMEMORY_TGZ"
```

`pnpm pack` runs the normal `prepack` build and produces a tarball containing
`dist/`.

### Verify the composed configuration

```bash
dsh web --dump-config        # the memory row is present in the base bundle
```

### Run

```bash
dsh web
```

The memory tools are model-facing, so exercising them is just conversation,
per the shipped docs:

- *"Remember: we publish via `scripts/release-public.sh --publish`."* — the
  agent calls `retain`; the entry lands in the project bank
  (`bank.jsonl.zstd`).
- Start a **new session** in the same project — the `memory:project` prompt
  section injects `memory_summary.md` + `learned.md` on the very first turn.
- *"What did we decide about publishing?"* — `recall` (or `reflect` for a
  synthesized answer) returns bank entries with ids that round-trip through
  `memory_edit`.
- `read memory://root` (via an internal-URL-aware `read` tool) shows the
  consolidated overview — summary, learned lessons, and the working bank.

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-memory
dsh plugin --profile web remove @hy-sde-org/dsh-tool-memory
# remove the preset directory you copied from examples/agent-preset/ as well
```

Removing the rows does not touch the durable bank under
`<harness home>/memories/<project>/` — that is user data; delete it
separately if you want it gone.

## What the bundle does

`@hy-sde-org/dsh-memory`'s `cordis.patch.yml` inserts exactly one row into
the profile composition on install:

- `memory` → `@hy-sde-org/dsh-memory` — the host-plane `ctx.memory` service
  (durable project-scoped store crossing sessions).

It touches **no existing row**, so `dsh plugin add` never breaks boot on a
stock release. The agent-plane `tool-memory` row is not inserted anywhere; it
lives in the copied preset (`examples/agent-preset/`) beside your other
preset rows, resolving the host service across the plane boundary.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck of both packages
pnpm -r test       # 42 tests (29 memory + 13 tool)
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish memory then tool-memory
```

## Layout

```
packages/memory/       @hy-sde-org/dsh-memory — the service bundle
  cordis.patch.yml        the installable bundle (host row)
  examples/agent-preset/  the ready-to-copy preset (tool row)
packages/tool-memory/  @hy-sde-org/dsh-tool-memory — the tools + prompt section
```

## License and attribution

This repo is licensed MIT — see [LICENSE](LICENSE) (© 2026 hy-sde). The
agent-memory surface — the durable project-scoped `local` backend, the
learned-lessons and consolidation model, and the retain/recall/reflect/
memory_edit/learn tool set — is ported from
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT License, © Mario Zechner
2025, © Can Bölük 2025-2026); the upstream provenance is aggregated in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), together with the
DeepSeek Harness (MIT, © 2026 DeepSeek) service-seam conventions the
`ctx.memory` contract follows. These are separately installable packages;
the harness remains the property of its own project.
