/**
 * FS-shaped internal URL schemes for the read/grep/write tools: one resolver
 * registry (`ctx.internalUrls`) under which protocol handlers register and
 * dispatch `conflict://` / `pr://` / `issue://` reads and writes.
 *
 * Host-plane: the service crosses sessions, so this package mounts as a row in
 * the base bundle — one registry per process, per-session state (the conflict
 * history) keyed by session. The tool packages consume it with `ctx.get`.
 * @module @hy-sde-org/dsh-internal-urls
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-fs'
import { ConflictHistory, ConflictProtocolHandler } from './conflict.ts'
import type { ConflictFileBridge } from './conflict.ts'
import { defaultRepoFromCwd } from './gh.ts'
import { IssueProtocolHandler, PrProtocolHandler, gitHubCliOf } from './issue-pr.ts'
import { AgentProtocolHandler } from './agent-protocol.ts'
import { sessionQueryOutputStore } from './session-query-store.ts'
import { InternalUrlRouter } from './router.ts'
import type { InternalResource, ProtocolHandler, ResolveContext, UrlCompletion, WriteContext } from './types.ts'

export * from './types.ts'
export * from './parse.ts'
export * from './router.ts'
export * from './conflict.ts'
export * from './gh.ts'
export * from './issue-pr.ts'
export * from './agent-protocol.ts'
export * from './session-query-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The internal-URL resolver registry (read/grep/write routing seam). */
    internalUrls: InternalUrlsService
  }
}

/**
 * The public `ctx.internalUrls` service: the resolver registry plus per-session
 * conflict histories the read tool populates and the conflict handler consumes.
 */
export class InternalUrlsService extends Service {
  private readonly router = new InternalUrlRouter()
  private readonly histories = new Map<string, ConflictHistory>()

  constructor(ctx: Context) {
    super(ctx, 'internalUrls')
  }

  /** Register (or replace) the handler for its scheme. Returns a disposer. */
  register(handler: ProtocolHandler): () => void {
    return this.router.register(handler)
  }

  /** Remove the handler for a scheme; false when none was registered. */
  unregister(scheme: string): boolean {
    return this.router.unregister(scheme)
  }

  /** Every registered scheme. */
  schemes(): string[] {
    return this.router.schemes()
  }

  /** Whether `input` is a hierarchical `scheme://` URL with a registered handler. */
  canHandle(input: string): boolean {
    return this.router.canHandle(input)
  }

  /** Resolve an internal URL through its registered handler. */
  resolve(input: string, context?: ResolveContext): Promise<InternalResource> {
    return this.router.resolve(input, context)
  }

  /** Write an internal URL through its registered handler. */
  write(input: string, content: string, context?: WriteContext): Promise<void> {
    return this.router.write(input, content, context)
  }

  /** Candidate completions for `scheme://<query>`, or `null` when unsupported. */
  complete(scheme: string, query: string, context?: ResolveContext): Promise<UrlCompletion[] | null> {
    return this.router.complete(scheme, query, context)
  }

  /**
   * The conflict history for one session (all calls sharing a key see the same
   * history). Calls without a session key share a process-level history.
   */
  conflicts(sessionKey: string | undefined): ConflictHistory {
    const key = sessionKey ?? '<no-session>'
    let history = this.histories.get(key)
    if (history === undefined) {
      history = new ConflictHistory()
      this.histories.set(key, history)
    }
    return history
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'internal-urls'

/** The plugin needs `ctx.fs` before the conflict handler's file bridge exists. */
export const inject = ['fs']

export type { SandboxExecutionPolicy }

/** Build the conflict handler's file bridge over the mounted `ctx.fs`. */
function conflictFileBridgeOf(ctx: Context): ConflictFileBridge {
  return {
    async readFile(absolutePath: string, signal?: AbortSignal): Promise<string> {
      const target = await ctx.fs.resolve(absolutePath, signal !== undefined ? { signal } : undefined)
      return ctx.fs.readText(target, signal)
    },
    async writeFile(absolutePath: string, content: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<void> {
      const target = await ctx.fs.resolve(absolutePath, signal !== undefined ? { signal } : undefined)
      // Forward the write tool's resolved policy so a `conflict://` mutation
      // keeps the same confinement as a plain `write` of the backing file.
      await ctx.fs.writeText(target, content, undefined, signal, sandboxPolicy as SandboxExecutionPolicy | undefined)
    },
  }
}

/**
 * Register `ctx.internalUrls` and its shipped handlers (`conflict://`,
 * `issue://`, `pr://`, `agent://`). Constructing the Service registers `ctx.internalUrls`
 * for the mounting fiber; handler registrations are effects scoped to the same
 * fiber, so stop/update removes every handler with it.
 */
export function apply(ctx: Context): void {
  const disposers: Array<() => void> = []
  const service = new InternalUrlsService(ctx)
  ctx.effect(() => {
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  disposers.push(service.register(new ConflictProtocolHandler({
    historyFor: sessionKey => service.conflicts(sessionKey),
    bridge: conflictFileBridgeOf(ctx),
  })))

  const cli = gitHubCliOf(ctx)
  const ghDeps = {
    cli,
    defaultRepo: (cwd: string, signal: AbortSignal | undefined) => defaultRepoFromCwd(ctx, cwd, signal),
  }
  disposers.push(service.register(new IssueProtocolHandler(ghDeps)))
  disposers.push(service.register(new PrProtocolHandler(ghDeps)))
  // The `agent://` scheme registers unconditionally; the session-query store
  // behind it is an OPTIONAL peer (`@deepseek-ai/dsh-session-query`), resolved
  // lazily at resolve time, so a deployment without the service keeps the
  // handler mounted and surfaces its corrective "outputs unavailable" error.
  disposers.push(service.register(new AgentProtocolHandler({
    outputStore: () => sessionQueryOutputStore(ctx.get('sessionQuery')),
  })))
}

export default apply
