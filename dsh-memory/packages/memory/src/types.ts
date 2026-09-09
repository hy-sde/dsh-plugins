/**
 * Vocabulary for the agent-curated long-horizon memory system (`ctx.memory`):
 * durable, project-scoped memory banks the agent retains, recalls, reflects
 * over, edits, and learns from — complementary to session-query and
 * compaction (which replay conversation history) rather than overlapping it.
 *
 * A backend owns one storage strategy (local files, a remote memory engine,
 * …). The service keeps a registry of backends and delegates to the selected
 * one. Backends must be self-contained: they own whatever per-project state
 * they create and tear it down on {@link MemoryBackend.clear}.
 * @module @hy-sde-org/dsh-memory/types
 */

/** One memory operation is rooted at the calling session's project. */
export interface MemoryContext {
  /** Absolute working directory of the calling session (the project key). */
  cwd: string
  /** Best-effort cancellation signal; observed before/after underlying IO. */
  signal?: AbortSignal
}

/** Metadata describing one stored memory entry. */
export interface MemoryEntryView {
  /** Stable identifier fit for `memory_edit` (bank ids) or read-only (lessons/summary). */
  id: string
  /** The stored content (previewed at recall; full when edited). */
  content: string
  /** Optional source context captured with the memory. */
  context?: string
  /** Provenance label (`retain`, `learn`, `recall`, `invalidate`, …). */
  source: string
  /** Bag of free-form tags when the backend supports them. */
  tags?: string[]
  /** Recency/importance hints flattened for recall rendering. */
  importance?: number
  /** ISO-8601 timestamp (UTC) of the last write. */
  timestamp?: string
  /** Recall relevance in `[0, 1]` when produced by a search. */
  score?: number
  /** True when the entry is a read-only fact that `memory_edit` cannot touch. */
  readonly?: boolean
}

/** Input to store one memory (`retain` stores items; `learn` stores lessons). */
export interface MemorySaveInput {
  /** The durable, self-contained content to remember. */
  content: string
  /** Optional source context for the fact. */
  context?: string
  /** Provenance label; defaults to `retain`/`learn` at the call sites. */
  source?: string
  /** Importance in `[0, 1]`; defaults to the backend's baseline. */
  importance?: number
  /** Optional originating session id, captured for cross-session provenance. */
  sessionId?: string
}

/** Outcome of one storage call. */
export interface MemorySaveResult {
  /** The assigned stable id, when the backend reports one. */
  id?: string
  /** Number of entries actually stored (0 = sanitized empty). */
  stored: number
  /** Human summary for the calling tool. */
  message: string
}

/** One relevance-ranked hit from a memory search. */
export interface MemorySearchItem {
  /** Stable id — bank ids round-trip through `memory_edit`. */
  id?: string
  /** The matched content (preview). */
  content: string
  /** Provenance label. */
  source?: string
  /** ISO timestamp (UTC) of the entry. */
  timestamp?: string
  /** Relevance in `[0, 1]`. */
  score?: number
  /** True when a `memory_edit update/forget` on this id is rejected. */
  readonly?: boolean
  /** The entry's importance when the backend tracks one. */
  importance?: number
  /** Session id that originated this hit (bank provenance or a session-search hit). */
  sessionId?: string
  /** Event seq within the originating session, when known. */
  seq?: number
}

/** Options for one memory search. */
export interface MemorySearchOptions {
  /** Max hits to return (default 10). */
  limit?: number
  /** Best-effort signal; observed before/after the underlying read. */
  signal?: AbortSignal
}

/** The ranked result of one memory search. */
export interface MemorySearchResult {
  /** The backend that answered. */
  backend: string
  /** The normalized query. */
  query: string
  /** Number of returned hits. */
  count: number
  /** Ordered relevance-ranked items. */
  items: MemorySearchItem[]
}

/** Operations `memory_edit` supports, mirroring omp's mnemopi edits. */
export type MemoryEditOp = 'update' | 'forget' | 'invalidate'

/** Input for {@link MemoryBackend.edit}. */
export interface MemoryEditInput {
  /** Target memory id (bank ids are editable; lesson/summary ids are not). */
  id: string
  /** Replacement content for `update` (required unless `importance` set). */
  content?: string
  /** Replacement importance for `update` (optional, clamped to `[0,1]`). */
  importance?: number
  /** Superseding id for `invalidate` (optional). */
  replacementId?: string
}

/** Outcome of one `memory_edit`. */
export interface MemoryEditResult {
  /** Canonical status word the tool surfaces. */
  status: 'updated' | 'forgotten' | 'invalidated' | 'not_found' | 'not_editable'
  /** Optional qualifier (which store/files were touched). */
  message?: string
}

/** Snapshot describing one backend's active memory store. */
export interface MemoryStatus {
  /** Backend id (`local`, …). */
  backend: string
  /** Whether the backend is active and answering. */
  active: boolean
  /** Whether it accepts writes. */
  writable: boolean
  /** Whether it supports structured search. */
  searchable: boolean
  /** Display scope (memory root / bank id). */
  scope?: string
  /** Count of editable working entries. */
  workingCount?: number
  /** Count of captured lessons. */
  lessonCount?: number
  /** Timestamp (ms epoch) of the most recent write. */
  lastMemoryAt?: number
  /** Optional human note. */
  message?: string
}

/** What a backend can hand to the prompt-injection layer. */
export interface MemorySummaries {
  /** Backend id. */
  backend: string
  /** Consolidated long-term summary (`memory_summary.md`), when present. */
  summary?: string
  /** Captured lessons (`learned.md`), when present. */
  learned?: string
  /** Markdown block combining both, or '' when the store is empty. */
  block: string
}

/** The storage strategy behind `ctx.memory`. */
export interface MemoryBackend {
  /** Stable backend id, e.g. `local`. */
  readonly id: string
  /** Snapshot the store's state. */
  status(context: MemoryContext): Promise<MemoryStatus>
  /** Store one durable memory (retain). */
  save(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult>
  /** Capture one durable lesson (learn). */
  learn(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult>
  /** Semantic/lexical search across the store. */
  search(context: MemoryContext, query: string, options?: MemorySearchOptions): Promise<MemorySearchResult>
  /** Update / forget / invalidate one working entry by id. */
  edit(context: MemoryContext, op: MemoryEditOp, input: MemoryEditInput): Promise<MemoryEditResult>
  /** The material for prompt injection (summary + lessons as one block). */
  summaries(context: MemoryContext): Promise<MemorySummaries>
  /** Wipe all state for one project scope. */
  clear(context: MemoryContext): Promise<void>
  /**
   * Read one stored entry by id (the `memory://<id>` internal-URL read).
   * Optional: only addressable stores implement it (the shipped `local`
   * backend derives bank ids from `edit`; a server-side engine without
   * id-addressable entries leaves it undefined and the `memory://` handler
   * returns the corrective "not addressable" error). Returns `undefined` when
   * the id does not exist in this project's scope.
   */
  readEntry?(context: MemoryContext, id: string): Promise<MemoryEntryView | undefined>
  /**
   * Every addressable entry in this project's scope, newest first — the
   * candidate set for `memory://` completions. Optional for the same reason as
   * {@link MemoryBackend.readEntry}; absent means `memory://<id>` cannot be
   * completed from this store.
   * @param context - session identity (cwd) whose project is listed.
   * @param limit - maximum number of views to return.
   */
  listEntries?(context: MemoryContext, limit: number): Promise<MemoryEntryView[]>
}
