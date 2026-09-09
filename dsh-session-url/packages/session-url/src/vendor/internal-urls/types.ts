/**
 * Vendored from fork @deepseek-ai/dsh-internal-urls (packages/fs/internal-urls/src/types.ts) — keep in sync.
 * The published harness does not ship this package, so @hy-sde-org/dsh-session-url vendors the small
 * internal-URL surface it consumes (types + parse + router) to stay dependency-free and standalone.
 */
/**
 * Vocabulary for the internal-URL routing system: FS-shaped `scheme://` URLs
 * (`conflict://`, `pr://`, `issue://`, …) resolved by the read/grep/write
 * tools through one resolver registry (`ctx.internalUrls`).
 *
 * A handler resolves a parsed internal URL to an {@link InternalResource}
 * (text content plus optional backing-file materialization), and may opt into
 * write dispatch so the write tool can mutate remote/meta surfaces instead of
 * a literal file.
 * @module @deepseek-ai/dsh-internal-urls/types
 */

/** MIME tags the model-facing text may claim. */
export type InternalContentType = 'text/markdown' | 'application/json' | 'text/plain'

/**
 * Raw resource payload returned by protocol handlers. The `immutable` flag is
 * applied by the router from {@link ProtocolHandler.immutable}, so handlers do
 * not need to set it themselves.
 */
export interface InternalResource {
  /** Canonical URL that was resolved. */
  url: string
  /** Resolved text content. */
  content: string
  /** MIME type of `content`. */
  contentType: InternalContentType
  /** Content size in bytes, when known. */
  size?: number
  /**
   * Underlying filesystem path, when the resource is backed by a local file
   * (e.g. a future `local://`). The agent-facing display stays `url`; the path
   * is for materializing edits and searches.
   */
  sourcePath?: string
  /** Additional notes about resolution, rendered below the content. */
  notes?: string[]
  /**
   * True when the resolved content cannot be edited by the agent (sealed
   * artifacts, harness docs, machine-generated summaries). Mutable resources
   * (conflict regions) behave like editable files.
   */
  immutable?: boolean
  /**
   * True when the resource is a directory listing rather than file content.
   * `grep` refuses such a resource without a `sourcePath`.
   */
  isDirectory?: boolean
}

/**
 * A single autocomplete candidate for the host/path portion of a `scheme://`
 * URL, produced by {@link ProtocolHandler.complete}.
 */
export interface UrlCompletion {
  /** The text that follows `scheme://` for this candidate. */
  value: string
  /** Human-facing label for the dropdown; defaults to {@link value}. */
  label?: string
  /** Optional one-line description shown beside the candidate. */
  description?: string
}

/**
 * A parsed internal URL (`scheme://host/path?query`). Keeps the raw segments
 * before URL normalization so numeric hosts, casing, and traversal markers
 * survive, and carries the exact input string for byte-exact matching.
 */
export interface ParsedInternalUrl {
  /** Scheme without the `:` (already lowercased), e.g. `conflict`, `pr`. */
  scheme: string
  /** Raw host segment exactly as typed (case preserved, no normalization). */
  rawHost: string
  /** Raw pathname exactly as typed (leading `/` preserved, no normalization). */
  rawPathname: string
  /**
   * Decoded non-empty path segments following the leading slash. Rejects
   * empty, `.`, and `..` segments.
   */
  pathSegments: string[]
  /** Query parameters under `?…` (empty when the input carries none). */
  searchParams: URLSearchParams
  /** Normalized href (`new URL(input).href`). */
  href: string
  /** The exact input string, before any normalization. */
  rawHref: string
}

/**
 * Caller-supplied context threaded into handlers so schemes that resolve
 * against the calling session (default repo, conflict history, cwd-relative
 * files) act on the session that initiated the read/write, never the first
 * session to register.
 */
export interface ResolveContext {
  /** Working directory of the calling session. */
  cwd?: string
  /** The caller's abort signal. */
  signal?: AbortSignal
  /**
   * Opaque per-session key used for session-scoped handler state (e.g.
   * {@link module:@deepseek-ai/dsh-internal-urls/conflict ConflictHistory}).
   */
  sessionKey?: string
  /**
   * When set, handlers that would otherwise materialize expensive content may
   * return the resource shape with `content` empty — callers that only need
   * `sourcePath` (search) pass this so a large resource still resolves without
   * buffering it.
   */
  pathOnly?: boolean
}

/** Caller context for write dispatch to host-owned URI handlers. */
export interface WriteContext {
  /** Working directory of the calling session. */
  cwd?: string
  /** The caller's abort signal. */
  signal?: AbortSignal
  /** Opaque per-session key — see {@link ResolveContext.sessionKey}. */
  sessionKey?: string
  /**
   * Opaque per-call sandbox policy (the write tool's resolved mode + workspace
   * root) forwarded so a handler that mutates a backing file keeps the same
   * confinement semantics as a plain `write` call. Opaque here; the handler's
   * file bridge applies it when calling `ctx.fs`.
   */
  sandboxPolicy?: unknown
}

/**
 * A handler for a specific internal URL scheme (e.g. `conflict://`, `pr://`).
 */
export interface ProtocolHandler {
  /** The scheme without trailing `://` (e.g. `conflict`). */
  readonly scheme: string
  /**
   * Whether resources produced by this handler are immutable (never editable
   * by the agent). `true` suppresses write affordances; `false` marks the
   * resource as writable (e.g. conflict regions).
   */
  readonly immutable: boolean
  /** Resolve an internal URL to its content. Throws a user-friendly error on failure. */
  resolve(url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource>
  /**
   * Optional write hook. When present, the write tool dispatches
   * `write(url, content)` here instead of writing to a filesystem path.
   * Handlers that omit it are read-only.
   */
  write?(url: ParsedInternalUrl, content: string, context?: WriteContext): Promise<void>
  /**
   * Optional autocomplete hook — candidate completions for the host/path
   * portion of a `scheme://` URL. Must be fast and local; omitted by network
   * backed schemes.
   */
  complete?(query?: string, context?: ResolveContext): Promise<UrlCompletion[]>
}
