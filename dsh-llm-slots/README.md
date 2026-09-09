# dsh-llm-slots — model-slot admission control for DeepSeek Harness

A standalone public package: **`@hy-sde-org/dsh-llm-slots`** — host-wide
**model-slot admission control** (`ctx.modelSlots`) for the DeepSeek Harness.
Deployments running several concurrent model providers behind one local
inference endpoint get a shared FIFO budget over every model call, decided at
the `llm/stream` waterfall — the single chokepoint every model-backed call
crosses (main agent loops, in-process subagents, worker-thread children,
workflows, title/compaction side-requests) — so 2–3 local inference slots
stay predictable instead of stacking dozens of simultaneous bursts.

Published **standalone** so any official DeepSeek Harness installation can
mount the same admission row without depending on the fork that originally
hosted `@deepseek-ai/dsh-llm-slots` (which is not on npm and not in upstream
stock).

**Provenance:** conceptually inspired by
[firstmate](https://github.com/kunchenguid/firstmate) (MIT, © 2026 Kun Chen) —
its per-agent harness/model allocation at intake. No firstmate code is included.

## Install

```bash
pnpm add @hy-sde-org/dsh-llm-slots
# or: npm install @hy-sde-org/dsh-llm-slots
```

Node `>=22.19.0`. Peers: `@deepseek-ai/cordis ^4.0.2`,
`@deepseek-ai/dsh-llm ^0.1.2-rc.1`, `@deepseek-ai/dsh-invariants ^0.1.2-rc.1`;
runtime dependency `@deepseek-ai/schemastery ^3.18.2`.

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
