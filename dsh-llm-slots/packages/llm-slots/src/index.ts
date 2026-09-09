/**
 * Host-wide model-slot admission control (`ctx.modelSlots`).
 *
 * The deployment runs a handful of concurrent model providers behind one local
 * inference endpoint (typically 2–3 slots, ~1M context each). Without admission
 * control the main agent's own turns, running subagents, and workflow fan-out
 * can stack dozens of simultaneous LLM bursts against that endpoint, so every
 * call slows to endpoint-queue latency and the "N concurrent" budget becomes
 * meaningless. This plugin makes the model budget explicit and host-global:
 *
 * - It decides FIFO at the `llm/stream` waterfall — the single chokepoint
 *   every model-backed call crosses (main agent loops, in-process subagents,
 *   worker-thread children, workflows, title/compaction side-requests),
 *   regardless of which session or context initiated it.
 * - The budget itself lives in a module-global gate, so every derived context
 *   and plugin instance shares one host-wide pool. Capacity is configured at
 *   mount (`llm-slots` row, default 3) and can be raised/lowered at runtime
 *   through `ctx.modelSlots.setCapacity()`.
 * - A call waiting for a slot holds no LLM work; its AbortSignal applies
 *   through the wait, so cancellation during admission surfaces as an
 *   AbortError upstream instead of leaking a straggler slot.
 * - One logical call holds one slot for its full lifetime (including adapter
 *   retries), which also caps retry-storm concurrency: a failing endpoint
 *   cannot fan out unbounded retries against the same pool.
 *
 * The plugin deliberately reads no LLM service state: it only listens on the
 * shared event bus, so it mounts in any context (root or child) and is trivially
 * testable without a model adapter.
 *
 * Conceptually inspired by firstmate (https://github.com/kunchenguid/firstmate),
 * MIT, © 2026 Kun Chen — its per-agent harness/model allocation at intake.
 * No firstmate code is included.
 *
 * @module @hy-sde-org/dsh-llm-slots
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'llm-slots'

/** Plugin configuration on the `llm-slots` row. */
export interface Config {
  /** Master switch; `false` bypasses admission entirely (default true). */
  enabled?: boolean
  /** Host-wide concurrent model-slot budget (default 3). */
  capacity?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  capacity: z.natural().min(1).max(64).default(3),
})

/** Schemastery configuration for the slots service (runtime capacity controls). */
export interface ModelSlotsConfig {
  /** Whether admission is currently enforced. */
  enabled: boolean
  /** Current host-wide concurrent model-slot budget. */
  capacity: number
}

/** Live admission snapshot exposed for operators and the GUI. */
export interface ModelSlotsStats {
  /** Whether admission is currently enforced. */
  enabled: boolean
  /** Current host-wide concurrent model-slot budget. */
  capacity: number
  /** Slots currently held by in-flight model calls. */
  running: number
  /** Calls currently queued, waiting FIFO for a slot. */
  waiting: number
  /** Lifetime acquisitions served by this gate (pool-granted and queue-granted). */
  acquiredTotal: number
}

/** One queued admission waiting for a freed slot. */
interface Waiter {
  /** Grant the slot: dequeues and resolves the acquire promise. */
  grant: () => void
  /** Reject the acquire promise on caller cancellation. */
  reject: (error: Error) => void
  /** Remove the waiter's cancellation listener when the wait ends. */
  cleanup: () => void
}

/** Error thrown when a queued admission is cancelled while waiting for a slot. */
function admissionAborted(): Error {
  return Object.assign(new Error('model-slot wait cancelled'), { name: 'AbortError' })
}

/**
 * Host-global FIFO model-slot gate. One instance per process (regardless of
 * how many contexts mount {@link apply}), so the budget is genuinely global.
 */
export class ModelSlotGate {
  /** Whether admission is currently enforced. */
  enabled = true
  /** Current concurrent-slot budget. */
  capacity = 3
  /** Slots currently held by in-flight model calls. */
  running = 0
  /** Calls currently queued, waiting FIFO for a slot. */
  waiting = 0
  /** Lifetime acquisitions served by this gate. */
  acquiredTotal = 0
  private readonly queue: Waiter[] = []

  /**
   * Acquire one model slot, resolving immediately when one is free or the gate
   * is disabled, and buffering FIFO otherwise. The caller's signal cancels the
   * wait: an aborted waiter is dropped from the queue and its promise rejects
   * with an AbortError — it never receives a freed slot.
   * @param signal - optional caller cancellation observed during the wait only.
   * @returns `true` when the caller holds a slot, or `false` when admission is
   *   disabled and the call bypasses the budget.
   */
  acquire(signal?: AbortSignal): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false)
    if (this.running < this.capacity) {
      this.running += 1
      this.acquiredTotal += 1
      return Promise.resolve(true)
    }
    this.waiting += 1
    return new Promise<boolean>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          this.waiting -= 1
          this.acquiredTotal += 1
          waiter.cleanup()
          resolve(true)
        },
        reject: (error: Error) => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) {
            this.queue.splice(index, 1)
            this.waiting -= 1
          }
          waiter.cleanup()
          reject(error)
        },
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      }
      const onAbort = (): void => { waiter.reject(admissionAborted()) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
    })
  }

  /**
   * Release one held slot, granting a waiting acquirer FIFO when one is queued.
   * @throws on a release with nothing held (programmer error — each acquire
   *   path must pair with exactly one release).
   */
  release(): void {
    if (this.running === 0) {
      throw new Error('model-slot gate released with no held slot')
    }
    this.running -= 1
    const next = this.queue.shift()
    if (next !== undefined) {
      // The freed slot transfers directly to the head waiter: it consumes the
      // free capacity without another running increment/decrement pair.
      this.running += 1
      next.grant()
    }
  }

  /**
   * Apply a module-config change (enabled switch / capacity) at runtime.
   * @param config - the new module configuration.
   */
  reconfigure(config: ModelSlotsConfig): void {
    this.enabled = config.enabled
    this.capacity = config.capacity
  }

  /**
   * Transient stats snapshot.
   * @returns the current gate statistics.
   */
  snapshot(): ModelSlotsStats {
    return {
      enabled: this.enabled,
      capacity: this.capacity,
      running: this.running,
      waiting: this.waiting,
      acquiredTotal: this.acquiredTotal,
    }
  }
}

/** Process-global gate shared by every mounted instance and derived context. */
let gate: ModelSlotGate | undefined

/**
 * Resolve the process-global gate, creating it on first use.
 * @returns the shared process-global gate.
 */
export function globalModelSlotGate(): ModelSlotGate {
  gate ??= new ModelSlotGate()
  return gate
}

/** Reset the process-global gate identity. Test-only. */
export function resetGlobalModelSlotGate(): void {
  gate = undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelSlots: ModelSlotsService
  }
}

/**
 * Host service exposing the global gate: live stats and runtime capacity
 * controls. Constructed inside {@link apply}; registered with the mounting
 * fiber, so stop/update removes it.
 */
export class ModelSlotsService extends Service {
  private readonly track: ModelSlotGate

  constructor(ctx: Context, gate: ModelSlotGate) {
    super(ctx, 'modelSlots')
    this.track = gate
  }

  /**
   * Transient admission snapshot for operators and the GUI.
   * @returns the current slot-gate stats.
   */
  stats(): ModelSlotsStats {
    return this.track.snapshot()
  }

  /**
   * Toggle admission enforcement (independent of capacity).
   * @param enabled - whether admission is enforced.
   */
  setEnabled(enabled: boolean): void {
    this.track.reconfigure({ enabled, capacity: this.track.capacity })
  }

  /**
   * Change the host-wide slot budget; a shrink takes effect as calls drain.
   * @param capacity - the new slot budget (clamped to >= 1).
   */
  setCapacity(capacity: number): void {
    const clamped = Math.max(1, Math.trunc(capacity))
    this.track.reconfigure({ enabled: this.track.enabled, capacity: clamped })
  }

  /**
   * Wrap one `llm/stream` waterfall tail in the admission gate: acquire a slot
   * before the first chunk is requested and hold it until the stream settles
   * (finish, error, or consumer abort). Aborting while queued rejects the
   * acquire, which surfaces as a thrown AbortError to the stream consumer.
   * @param options - the full model request; `signal` cancels the wait.
   * @param next - the downstream waterfall tail.
   * @returns a stream that begins only after a slot is held.
   */
  async *wrap(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    // A `false` grant means admission is disabled: the call bypasses the
    // budget entirely, so no paired release runs.
    if (!(await this.track.acquire(options.signal))) {
      yield* next()
      return
    }
    try {
      yield* next()
    } finally {
      this.track.release()
    }
  }
}

/**
 * Install host-wide model-slot admission: configure the global gate, expose
 * `ctx.modelSlots`, and listen at `llm/stream`. Mount exactly once per host in
 * a shared-row composition (`dsh-base` ships the row); additional mounts share
 * the same global budget and are safe but redundant.
 * @param ctx - the mounting context (assumed to be the host root).
 * @param config - admission switch and slot budget.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const { enabled, capacity } = Config(config) as { enabled: boolean; capacity: number }
  const track = globalModelSlotGate()
  track.reconfigure({ enabled, capacity })
  const service = new ModelSlotsService(ctx, track)
  ctx.on('llm/stream', (options, next) => service.wrap(options, next), { global: true, prepend: true })
}

export default apply
