<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-llm-slots`](https://www.npmjs.com/package/@hy-sde-org/dsh-llm-slots)
<!-- MIRROR-NOTE:END -->

# dsh-llm-slots — model-slot admission control for DeepSeek Harness

A standalone public package: **`@hy-sde-org/dsh-llm-slots`** — host-wide
**model-slot admission control** (`ctx.modelSlots`) for the DeepSeek Harness.
Deployments running several concurrent model providers behind one local
inference endpoint get a shared FIFO budget over every model call, decided at
the `llm/stream` waterfall — the single chokepoint every model-backed call
crosses (main agent loops, in-process subagents, worker-thread children,
workflows, title/compaction side-requests) — so 2–3 local inference slots
stay predictable instead of stacking dozens of simultaneous bursts.

| Identity | Value |
| --- | --- |
| Package | `@hy-sde-org/dsh-llm-slots` |
| Plugin id | none ships — the package carries no `cordis.patch.yml`; the deployment authors its own row (e.g. `id: llm-slots`, see Use) |
| Seam | `ctx.modelSlots` (`ModelSlotsService`), admission decided FIFO at the `llm/stream` waterfall |

> **Conceptually inspired by
> [firstmate](https://github.com/kunchenguid/firstmate)** (MIT, © 2026 Kun Chen) —
> its per-agent harness/model allocation at intake. No firstmate code is included.

## Why

Without a shared budget, one wave of concurrent work — main agent loops,
in-process subagents, worker-thread children, workflows, title/compaction
side-requests — stacks dozens of simultaneous model calls against a local
endpoint that only fits a few. This package is the host-wide counterweight:
one FIFO budget over every model call, decided at the `llm/stream` waterfall,
so 2–3 local inference slots stay predictable.

Published **standalone** so any official DeepSeek Harness installation can
mount the same admission row without depending on the fork that originally
hosted `@deepseek-ai/dsh-llm-slots` (which is not on npm and not in upstream
stock).

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- peers `@deepseek-ai/cordis` `~4.0.4`, `@deepseek-ai/dsh-invariants`
  `^0.2.0-rc.2`, and `@deepseek-ai/dsh-llm` `^0.2.0-rc.2`, plus the runtime
  dependency `@deepseek-ai/schemastery` `~3.18.4` — npm resolves all of them
  on install.

## Install

```bash
pnpm add @hy-sde-org/dsh-llm-slots
# or: npm install @hy-sde-org/dsh-llm-slots
```

### From source (validate this checkout or hack on the gate)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @hy-sde-org/dsh-llm-slots build

SLOTS_TGZ="$(cd dsh-llm-slots/packages/llm-slots && pnpm pack --pack-destination /tmp | tail -n 1)"
pnpm add "$SLOTS_TGZ"
```

`pnpm pack` runs the normal `prepack` build and produces a tarball containing
`dist/`.

No `dsh` routes apply: no bundle row ships, so `dsh plugin add` is not an
install path and there is no `dsh web --dump-config` row to verify — mount
the service row in your own composition (see Use).

## Use

Mount the plugin once per host in a shared-row composition:

```yaml
- id: llm-slots
  name: '@hy-sde-org/dsh-llm-slots'
  config:
    enabled: true
    capacity: 3
```

Then `ctx.modelSlots` exposes live admission stats and runtime controls:

```ts
ctx.modelSlots.stats()        // { enabled, capacity, running, waiting, acquiredTotal }
ctx.modelSlots.setEnabled(false)
ctx.modelSlots.setCapacity(1) // shrink applies as in-flight calls drain
```

The plugin deliberately reads no LLM service state — it only listens on the
shared event bus — so it mounts in any context (root or child) and is testable
without a model adapter.

## Development

```bash
pnpm install
pnpm -r check       # strict typecheck (src + tests)
pnpm -r test        # gate + admission tests
pnpm -r build       # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish to npm
```

## Layout

```
packages/llm-slots/   @hy-sde-org/dsh-llm-slots — the model-slot gate + admission plugin
  src/index.ts                     ModelSlotGate / ModelSlotsService / apply()
  src/invariant.ts                 optional Cordis ./invariant companion
  tests/gate.spec.ts               FIFO gate unit tests
  tests/admission.spec.ts          llm/stream waterfall admission tests
```

## License and attribution

This repo is licensed MIT — see [LICENSE](LICENSE) (© 2026 hy-sde). The
admission control — the `ModelSlotGate` FIFO gate, the `ModelSlotsService`
exposing `ctx.modelSlots`, and the `apply()` hook into the `llm/stream`
waterfall — is derived from the DeepSeek Harness codebase (MIT, © 2026
DeepSeek); the provenance is aggregated in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The
[firstmate](https://github.com/kunchenguid/firstmate) inspiration is
conceptual only (its per-agent harness/model allocation at intake) — no
firstmate code is included. This is a separately installable package; the
harness remains the property of its own project.
