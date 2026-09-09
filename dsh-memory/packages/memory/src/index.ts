/**
 * Agent-curated long-horizon memory (`ctx.memory`): a host-plane service with
 * a backend registry and a shipped local backend. The model-facing
 * retain/recall/reflect/memory_edit/learn tools are provided by
 * `@hy-sde-org/dsh-tool-memory`; this package owns the durable store.
 *
 * Port of omp (oh-my-pi)'s memory surface for the DeepSeek Harness — see
 * LICENSE. Only the `local` backend ships; the registry keeps the
 * seam open for Hindsight/Mnemopi-style providers later.
 * @module @hy-sde-org/dsh-memory
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@hy-sde-org/dsh-internal-urls'
import { LocalMemoryBackend } from './local.ts'
import type { LocalMemoryConfig } from './local.ts'
import { MemoryProtocolHandler } from './memory-protocol.ts'
import { MemoryService } from './service.ts'
import type { Config } from './service.ts'

export * from './types.ts'
export * from './service.ts'
export * from './local.ts'
export * from './frame-codec.ts'
export { MemoryProtocolHandler, MEMORY_ROOT_NAMESPACE } from './memory-protocol.ts'
export type { MemoryProtocolDeps } from './memory-protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The memory service: durable, project-scoped memory with a backend registry. */
    memory: MemoryService
  }
  interface Events {
    /**
     * A durable memory mutation (`save`/`learn`/`edit`/`clear`) committed for
     * one project; `cwd` identifies the project whose files changed. In-process
     * consumers (caches, watchers) refresh on this notification. Emitted after
     * the write lands, so listeners never observe half-applied state.
     * @mode emit
     * @param payload Project-root cwd whose memory changed.
     */
    'memory/change'(payload: { cwd: string }): void
  }
}

/** Plugin configuration. */
export interface MemoryConfig extends Config {
  /** Backend id; only `local` ships (defaults to the first registered). */
  backend?: string
  /** Memory root override (`~` and `$HOME` expand); defaults to `<harness home>/memories`. */
  root?: string
  /** Baseline importance when a save omits it (default 0.7). */
  defaultImportance?: number
  /** Default result cap for one search (default 10). */
  searchLimit?: number
}

/**
 * Register `ctx.memory` and mount the shipped `local` backend. Host-plane row:
 * memory is durable project-scoped data that crosses sessions, so it does not
 * live behind a preset realm. Handler registration is an effect scoped to the
 * mounting fiber, so stop/update removes the backend with it.
 *
 * The `memory://` internal-URL scheme registers into the shared
 * `ctx.internalUrls` registry exactly once per process (this package mounts
 * as one host-plane row in the base bundle). The registration lives behind
 * `ctx.inject` so compositions without the registry stay unaffected.
 */
export function apply(ctx: Context, config: MemoryConfig = {}): void {
  const service = config.backend === undefined
    ? new MemoryService(ctx)
    : new MemoryService(ctx, { backend: config.backend })
  // The shipped provider mounts only when it is the selected one; a custom
  // `backend` id (or a provider added to the registry elsewhere) leaves the
  // selection to that provider, and an unmatched id surfaces loudly through
  // `mustResolve` at first use.
  if (config.backend === undefined || config.backend === 'local') {
    const localConfig: LocalMemoryConfig = {
      ...config.root !== undefined ? { root: config.root } : {},
      ...config.defaultImportance !== undefined ? { defaultImportance: config.defaultImportance } : {},
      ...config.searchLimit !== undefined ? { searchLimit: config.searchLimit } : {},
    }
    const local = new LocalMemoryBackend(localConfig)
    ctx.effect(() => service.register(local))
  }
  ctx.inject(['internalUrls'], (iuCtx) => {
    iuCtx.effect(() => iuCtx.internalUrls.register(new MemoryProtocolHandler({
      backend: () => service.resolve(),
    })))
  })
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'memory'

export default apply
