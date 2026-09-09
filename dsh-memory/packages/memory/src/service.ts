/**
 * The `ctx.memory` service: a registry of memory backends plus the selection
 * and thin delegation used by the memory tools. Host-plane — memory is
 * durable project-scoped data that easily outlives one session, so the
 * service lives in the base bundle and per-session tool packages resolve it.
 * @module @hy-sde-org/dsh-memory/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  MemoryBackend,
  MemoryContext,
  MemoryEditInput,
  MemoryEditOp,
  MemoryEditResult,
  MemorySaveInput,
  MemorySaveResult,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryStatus,
  MemorySummaries,
} from './types.ts'

/** Plugin configuration. */
export interface Config {
  /** Backend id to delegate to; defaults to the first registered backend. */
  backend?: string
}

/** Routing/selection state for the service. */
interface ServiceState {
  backends: Map<string, MemoryBackend>
  selected: string | undefined
}

/**
 * The public `ctx.memory` service. Backends register into the registry; the
 * service resolves the configured (or first) backend and delegates every
 * operation. Mutations emit `memory/change` so in-process consumers (tool
 * prompt caches) can invalidate without re-reading on every assembly.
 */
export class MemoryService extends Service {
  private readonly state: ServiceState = { backends: new Map(), selected: undefined }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'memory')
    this.state.selected = config.backend
  }

  /**
   * Register (or replace) a backend by id; the first registration also becomes
   * the selection when none is configured.
   * @param backend - backend to register under {@link MemoryBackend.id backend.id}.
   * @returns disposer that removes this backend and clears the selection if it was the selection.
   */
  register(backend: MemoryBackend): () => void {
    this.state.backends.set(backend.id, backend)
    if (this.state.selected === undefined) this.state.selected = backend.id
    return () => {
      if (this.state.backends.get(backend.id) === backend) {
        this.state.backends.delete(backend.id)
        if (this.state.selected === backend.id) this.state.selected = undefined
      }
    }
  }

  /**
   * Remove the backend for `id`.
   * @param id - backend id to remove.
   * @returns true when a backend was removed, false when none matched.
   */
  unregister(id: string): boolean {
    if (this.state.backends.delete(id)) {
      if (this.state.selected === id) this.state.selected = undefined
      return true
    }
    return false
  }

  /**
   * The selected backend (configured id when registered, else the first
   * registered).
   * @returns the active backend, or undefined when none is registered.
   */
  resolve(): MemoryBackend | undefined {
    const selected = this.state.selected
    if (selected !== undefined && this.state.backends.has(selected)) {
      return this.state.backends.get(selected)
    }
    return this.state.backends.values().next().value
  }

  /**
   * Every registered backend id.
   * @returns registered backend ids.
   */
  backendIds(): string[] {
    return [...this.state.backends.keys()]
  }

  /**
   * Backend availability and scope for the calling session's project.
   * @param context - session identity (cwd) the status describes.
   * @returns the resolved backend's status.
   */
  async status(context: MemoryContext): Promise<MemoryStatus> {
    const backend = this.mustResolve()
    return backend.status(context)
  }

  /**
   * Store one memory entry (the `retain` tool's service path). Emits
   * `memory/change` for the project after the write lands.
   * @param context - session identity (cwd) whose project receives the entry.
   * @param input - content, optional context, source, and importance.
   * @returns whether something was stored plus a human result line.
   */
  async save(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult> {
    const backend = this.mustResolve()
    const result = await backend.save(context, input)
    this.emitChange(context)
    return result
  }

  /**
   * Append a durable lesson (the `learn` tool's service path). Emits
   * `memory/change` for the project after the write lands.
   * @param context - session identity (cwd) whose project receives the lesson.
   * @param input - lesson content, optional context, source, importance.
   * @returns whether something was stored plus a human result line.
   */
  async learn(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult> {
    const backend = this.mustResolve()
    const result = await backend.learn(context, input)
    this.emitChange(context)
    return result
  }

  /**
   * Relevance-ranked search over the project's bank, lessons, and summary.
   * @param context - session identity (cwd) whose project is searched.
   * @param query - natural-language query.
   * @param options - result cap override (`limit`) when provided.
   * @returns ranked matching entries.
   */
  async search(context: MemoryContext, query: string, options?: MemorySearchOptions): Promise<MemorySearchResult> {
    return this.mustResolve().search(context, query, options)
  }

  /**
   * Apply a memory edit (`update`/`forget`/`invalidate` by recall id). Emits
   * `memory/change` for the project after the write lands.
   * @param context - session identity (cwd) whose project is edited.
   * @param op - edit operation.
   * @param input - target id plus operation fields.
   * @returns the edit outcome status.
   */
  async edit(context: MemoryContext, op: MemoryEditOp, input: MemoryEditInput): Promise<MemoryEditResult> {
    const backend = this.mustResolve()
    const result = await backend.edit(context, op, input)
    this.emitChange(context)
    return result
  }

  /**
   * The project's injectable memory block plus its raw parts.
   * @param context - session identity (cwd) whose project summaries are read.
   * @returns summary/learned/bank text and the combined injection block.
   */
  async summaries(context: MemoryContext): Promise<MemorySummaries> {
    return this.mustResolve().summaries(context)
  }

  /**
   * Wipe one project's memory root. Emits `memory/change` for the project.
   * @param context - session identity (cwd) whose project is cleared.
   * @returns a promise that settles once the root is removed.
   */
  async clear(context: MemoryContext): Promise<void> {
    const backend = this.mustResolve()
    await backend.clear(context)
    this.emitChange(context)
  }

  private mustResolve(): MemoryBackend {
    const backend = this.resolve()
    if (backend === undefined) {
      throw new Error('memory: no memory backend is registered')
    }
    return backend
  }

  private emitChange(context: MemoryContext): void {
    this.ctx.emit('memory/change', { cwd: context.cwd })
  }
}
