# @hy-sde-org/dsh-llm-slots

Host-wide model-slot admission control (`ctx.modelSlots`) for the DeepSeek
Harness. A deployment that runs a handful of concurrent model providers behind
one local inference endpoint (typically 2–3 slots, ~1M context each) needs an
explicit budget over every model call — otherwise the main agent's turns,
running subagents, and workflow fan-out stack dozens of simultaneous bursts
against the endpoint and every call slows to queue latency.

Published standalone as `@hy-sde-org/dsh-llm-slots`; it mirrors
`@deepseek-ai/dsh-llm-slots` in the [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness)
(the fork-only package is not on npm and not in upstream stock).

## How it works

- **One chokepoint.** Admission decides FIFO at the `llm/stream` waterfall —
  the single boundary every model-backed call crosses (main agent loops,
  in-process subagents, worker-thread children, workflows, title/compaction
  side-requests), regardless of which session or context initiated it.
- **Host-global budget.** The gate lives in module scope, so every derived
  context and plugin instance shares one pool. Capacity is configured on the
  `llm-slots` row (default 3) and adjustable at runtime:
  `ctx.modelSlots.setCapacity(n)`.
- **Cancellable waits.** A call waiting for a slot observes its AbortSignal;
  cancellation while queued surfaces as an AbortError upstream and never
  receives a freed slot.
- **One slot per logical call.** A call holds its slot for its full lifetime,
  including adapter retries, which also prevents a failing endpoint from
  fanning out an unbounded retry storm.

## Composition

Mount once per host in a shared-row composition:

```yaml
- id: llm-slots
  name: '@hy-sde-org/dsh-llm-slots'
  config:
    enabled: true
    capacity: 3
```

Additional mounts share the same global budget and are safe but redundant.

## Service surface

`ctx.modelSlots` exposes:

- `stats()` — `{ enabled, capacity, running, waiting, acquiredTotal }`.
- `setEnabled(boolean)` — toggle admission without touching capacity.
- `setCapacity(number)` — change the budget; a shrink applies as calls drain.

The optional `./invariant` entry registers package-owned admission-accounting
checks with a Cordis host's `ctx.invariants` service and needs
`@deepseek-ai/cordis` + `@deepseek-ai/dsh-invariants` peers only when you use
that entry.

## Development

```sh
pnpm install
pnpm -r check       # strict typecheck (src + tests)
pnpm -r test        # gate + admission tests
pnpm -r build       # tsc -> dist
```

No model-facing tools ship here; the package deliberately reads no LLM service
state (it only listens on the shared event bus), which keeps it trivially
testable and safe to mount in any context.

## Known Limitations and Deferred Work

- The gate is process-global: capacity is not partitioned per provider or per
  session, and the budget never drains below what in-flight calls hold (a
  shrink takes effect as calls finish).
- `acquire()` grants one slot per logical call; there is no priority or
  fair-share scheduling beyond arrival order (FIFO).

## License

MIT. Derived from the DeepSeek Harness codebase; see
`THIRD-PARTY-NOTICES.md` for provenance.
