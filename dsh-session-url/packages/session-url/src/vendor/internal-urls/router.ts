/**
 * Vendored from fork @deepseek-ai/dsh-internal-urls (packages/fs/internal-urls/src/router.ts) — keep in sync.
 * The published harness does not ship this package, so @hy-sde-org/dsh-session-url vendors the small
 * internal-URL surface it consumes (types + parse + router) to stay dependency-free and standalone.
 */
/**
 * The internal-URL resolver registry: one handler per scheme, reachable by the
 * read/grep/write tools as `ctx.internalUrls`. Handlers are stateless where
 * possible; per-session shared state (ConflictHistory) lives in the service.
 * @module @deepseek-ai/dsh-internal-urls/router
 */

import { parseInternalUrl, extractUriScheme, parseConflictReference } from './parse.ts'
import type {
  InternalResource,
  ParsedInternalUrl,
  ProtocolHandler,
  ResolveContext,
  UrlCompletion,
  WriteContext,
} from './types.ts'

/**
 * Validates a handler registration: a non-empty alphabetic scheme, and a
 * conflict with an existing registration is a programming error (each scheme
 * may have exactly one handler).
 */
export function validateHandler(handler: ProtocolHandler): string {
  const scheme = handler.scheme.toLowerCase()
  if (!/^[a-z][a-z0-9+.-]*$/.test(handler.scheme)) {
    throw new Error(`Internal URL handler: invalid scheme '${handler.scheme}'`)
  }
  return scheme
}

/**
 * One resolver registry. `register`/`unregister` manage the handler table;
 * `canHandle` decides whether a model-supplied path routes away from the
 * filesystem; `resolve`/`write` dispatch to the matching handler.
 */
export class InternalUrlRouter {
  private readonly handlers = new Map<string, ProtocolHandler>()

  /** Register (or replace) the handler for its scheme. Returns a disposer. */
  register(handler: ProtocolHandler): () => void {
    const scheme = validateHandler(handler)
    const prior = this.handlers.get(scheme)
    this.handlers.set(scheme, handler)
    return () => {
      if (this.handlers.get(scheme) === handler) this.handlers.delete(scheme)
      else if (prior !== undefined) this.handlers.set(scheme, prior)
    }
  }

  /** Remove the handler for `scheme`; returns false when none was registered. */
  unregister(scheme: string): boolean {
    return this.handlers.delete(scheme.toLowerCase())
  }

  /** The registered handler for a scheme, or `undefined`. */
  getHandler(scheme: string): ProtocolHandler | undefined {
    return this.handlers.get(scheme.toLowerCase())
  }

  /** Every registered scheme. */
  schemes(): string[] {
    return [...this.handlers.keys()]
  }

  /**
   * Whether `input` is a hierarchical `scheme://` URL (or the `<path>:conflict://`
   * selector form) with a registered handler. This is the single gate the
   * read/grep/write tools consult before touching the filesystem.
   */
  canHandle(input: string): boolean {
    const scheme = extractUriScheme(input)
    if (scheme !== undefined) return this.handlers.has(scheme)
    return parseConflictReference(input) !== null && this.handlers.has('conflict')
  }

  /** Resolve an internal URL through its registered handler. */
  async resolve(input: string, context?: ResolveContext): Promise<InternalResource> {
    const parsed = this.route(input)
    const handler = this.handlers.get(parsed.scheme)
    if (handler === undefined) throw this.unknownScheme(parsed.scheme)
    const resource = await handler.resolve(parsed, context)
    return {
      ...resource,
      // The router stamps immutability so handlers never encode the same fact twice.
      immutable: resource.immutable ?? handler.immutable,
    }
  }

  /** Write an internal URL through its registered handler. */
  async write(input: string, content: string, context?: WriteContext): Promise<void> {
    const parsed = this.route(input)
    const handler = this.handlers.get(parsed.scheme)
    if (handler === undefined) throw this.unknownScheme(parsed.scheme)
    if (handler.write === undefined) {
      throw new Error(`${parsed.scheme}:// URLs are read-only for write; use the protocol-specific tool for mutations.`)
    }
    await handler.write(parsed, content, context)
  }

  /** Candidate completions for `scheme://<query>`, or `null` when the scheme has no completer. */
  async complete(scheme: string, query: string, context?: ResolveContext): Promise<UrlCompletion[] | null> {
    const handler = this.handlers.get(scheme.toLowerCase())
    if (handler?.complete === undefined) return null
    return handler.complete(query, context)
  }

  private route(input: string): ParsedInternalUrl {
    let parsed: ParsedInternalUrl | null = null
    try {
      parsed = parseInternalUrl(input)
    } catch {
      parsed = parseConflictReference(input)
    }
    if (parsed === null || !this.handlers.has(parsed.scheme)) {
      const scheme = extractUriScheme(input) ?? parsed?.scheme
      if (scheme === undefined) throw new Error(`Not an internal URL: ${input}`)
      throw this.unknownScheme(scheme)
    }
    return parsed
  }

  private unknownScheme(scheme: string): Error {
    const available = this.schemes().map(candidate => `${candidate}://`).join(', ')
    return new Error(`Unknown protocol: ${scheme}://\nSupported: ${available || 'none'}`)
  }
}
