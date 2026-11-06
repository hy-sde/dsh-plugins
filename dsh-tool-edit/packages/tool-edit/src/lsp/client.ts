/**
 * A Language Server Protocol client (text-document subset) driving one
 * server process. Covers exactly what the edit tool needs: initialize,
 * didOpen/didChange, textDocument/formatting, and the publishDiagnostics
 * notifications feeding diagnostic collection. Request correlation and
 * deadlines run on the trimmed Effect core (`@hy-sde-org/effect`).
 *
 * All public operations degrade instead of throw when the server is
 * unavailable: callers observe `undefined` and continue with edit-only.
 * @module @hy-sde-org/dsh-tool-edit/lsp
 */

import { Deferred, Effect, Scheduler } from '@hy-sde-org/effect'
import type { LspMessage, StdioLspProcess } from './stdio.ts'
import { spawnLspProcess, splitCommand } from './stdio.ts'

/** Time after which an unanswered request is abandoned (and the server suspect). */
const REQUEST_TIMEOUT_MS = 60_000
/** Seconds for `initialize` before the server is declared unresponsive. */
const INIT_TIMEOUT_MS = 20_000
// Effect's default scheduler dispatches on `setImmediate`, which vitest fake
// timers replace without advancing; pinning the sync scheduler keeps awaited
// runPromises live under fake timers (same pin as every Effect consumer).
const syncScheduler = new Scheduler.MixedScheduler('sync')

/** LSP severity constants (1=error, 2=warning, 3=info, 4=hint). */
export const SEVERITY = { error: 1, warning: 2, info: 3, hint: 4 } as const

/** One LSP diagnostic as surfaced to the edit result. */
export interface EditLspDiagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  severity?: number
  message: string
  source?: string
  code?: string | number | { value: string | number; target: string } | undefined
}

/** Language-negotiation result for one server. */
export interface LspStatus {
  ready: boolean
  serverPid: number | undefined
}


interface OpenDocument {
  uri: string
  version: number
  languageId: string
}

/** Derive a coarse LSP `languageId` from a file extension. */
export function languageIdFromPath(filePath: string, fallback = 'typescript'): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'tsx':
      return 'typescriptreact'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'jsx':
      return 'javascriptreact'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    case 'md':
      return 'markdown'
    case 'yaml':
    case 'yml':
      return 'yaml'
    default:
      return fallback
  }
}

/** Convert a filesystem path to a `file://` URI. */
export function pathToUri(filePath: string): string {
  const normalized = filePath.replace(/\\/gu, '/')
  const encoded = normalized
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

/**
 * One text-document-oriented LSP client. Lazily spawns and bootstraps the
 * server on first use; every method resolves `undefined` on any failure so
 * higher layers can drop to pass-through editing.
 */
export class TextDocumentLspClient {
  private process: StdioLspProcess | undefined
  private pending = new Map<number, Deferred.Deferred<unknown, Error>>()
  private nextId = 1
  private documents = new Map<string, OpenDocument>()
  private diagnosticsByUri = new Map<string, EditLspDiagnostic[]>()
  private starting: Promise<void> | undefined
  private startError: string | undefined
  private disposed = false
  private readonly command: string
  private readonly spawnCwd: string | undefined

  /** @param command - server command line (default in the provider). */
  constructor(command: string, spawnCwd?: string) {
    this.command = command
    this.spawnCwd = spawnCwd
  }

  /** Whether the server is (or can still be) expected to answer. */
  get available(): boolean {
    return !this.disposed && this.startError === undefined
  }

  /** Boot the server if needed; resolves even on failure (then unavailable). */
  private async ensureStarted(): Promise<void> {
    if (this.disposed || this.startError !== undefined) return
    if (this.starting !== undefined) {
      await this.starting.catch(() => undefined)
      return
    }
    this.starting = this.start().catch(error => {
      if (this.startError === undefined) this.startError = errorMessage(error)
    })
    await this.starting.catch(() => undefined)
  }

  private async start(): Promise<void> {
    const lspProcess = spawnLspProcess(this.command, this.spawnCwd)
    if (lspProcess.pid === undefined) {
      // Synchronous spawn failure: the wrapper already delivered onClose.
      throw new Error('lsp client: spawn failed')
    }
    this.process = lspProcess
    lspProcess.onMessage(message => this.dispatch(message))
    await this.initialize()
  }

  private initialize(): Promise<void> {
    const lspProcess = this.process
    if (!lspProcess) return Promise.reject(new Error('lsp client: no process'))
    const self = this
    return Effect.runPromise(
      Effect.gen(function*() {
        // Three sources race the handshake: the initialize request, the
        // server exiting, and the deadline. First settlement wins and the
        // losers — including the request fiber and its scope-owned timer —
        // are interrupted and released.
        const closed = yield* Deferred.make<never, Error>()
        lspProcess.onClose(() => {
          Deferred.doneUnsafe(closed, Effect.fail(new Error('lsp server exited during initialize')))
        })
        const deadline = Effect.sleep(INIT_TIMEOUT_MS).pipe(
          Effect.flatMap(() => Effect.fail(new Error('lsp client: initialize timed out'))),
        )
        yield* Effect.raceAllFirst([
          self.requestEffect(lspProcess, 'initialize', {
            processId: typeof process !== 'undefined' && typeof process.pid === 'number' ? process.pid : null,
            clientInfo: { name: 'dsh-tool-edit', version: '0.1.1-rc.2' },
            capabilities: {
              textDocument: {
                synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
                formatting: { dynamicRegistration: false },
              },
              workspace: {
                workspaceFolders: true,
              },
            },
            rootUri: null,
          }),
          Deferred.await(closed),
          deadline,
        ])
        self.notify('initialized', {})
      }),
      { scheduler: syncScheduler },
    )
  }

  /** One-time message router: responses → pending, notifications → store. */
  private dispatch(message: LspMessage): void {
    const method = message.method
    if (typeof message.id === 'number' && method === undefined) {
      const deferred = this.pending.get(message.id)
      if (deferred) {
        this.pending.delete(message.id)
        if (message.error !== undefined) {
          Deferred.doneUnsafe(
            deferred,
            Effect.fail(new Error(`lsp server error: ${JSON.stringify(message.error)}`)),
          )
        } else {
          Deferred.doneUnsafe(deferred, Effect.succeed(message.result))
        }
      }
      return
    }
    if (method === 'textDocument/publishDiagnostics') {
      const params = message.params as
        | { uri?: unknown; version?: unknown; diagnostics?: unknown }
        | undefined
      if (params && typeof params.uri === 'string' && Array.isArray(params.diagnostics)) {
        this.diagnosticsByUri.set(params.uri, params.diagnostics as EditLspDiagnostic[])
      }
    }
    // Other notifications (e.g. window/logMessage) are intentionally ignored.
  }

  /**
   * One JSON-RPC request as an Effect. Correlation (the pending entry), the
   * answer deadline, and their cleanup are scope-owned: the release
   * finalizer drops the entry and clears the timer on every exit path —
   * response, timeout, disposal, interruption — replacing per-site
   * clearTimeout bookkeeping. The failure carries the original Error by
   * identity, so facades rethrow exactly what the server produced.
   */
  private requestEffect(
    lspProcess: StdioLspProcess,
    method: string,
    params: unknown,
  ): Effect.Effect<unknown, Error> {
    const pending = this.pending
    const id = this.nextId++
    return Effect.scoped(
      Effect.gen(function*() {
        // `Effect.gen` takes a `function*`, which does not close over the
        // class `this`; the map is captured as a local above instead.
        const deferred = yield* Deferred.make<unknown, Error>()
        const settleFailure = (error: Error): void => {
          pending.delete(id)
          Deferred.doneUnsafe(deferred, Effect.fail(error))
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            pending.set(id, deferred)
            lspProcess.send({ jsonrpc: '2.0', id, method, params })
            const timer = setTimeout(() => {
              if (!pending.has(id)) return
              settleFailure(new Error(`lsp client: request ${method} timed out`))
            }, REQUEST_TIMEOUT_MS)
            return timer
          }),
          timer =>
            Effect.sync(() => {
              clearTimeout(timer)
              pending.delete(id)
            }),
        )
        // Effect.gen's success value is the generator's completion value —
        // the awaited answer must be RETURNED, not just yielded into a local.
        return yield* Deferred.await(deferred)
      }),
    )
  }

  private requestRaw(method: string, params: unknown): Promise<unknown> {
    const lspProcess = this.process
    if (!lspProcess) return Promise.reject(new Error('lsp client: no process'))
    return Effect.runPromise(this.requestEffect(lspProcess, method, params), { scheduler: syncScheduler })
  }

  private notify(method: string, params: unknown): void {
    this.process?.send({ jsonrpc: '2.0', method, params })
  }

  /**
   * Ensure the document for `uri` is open with the given text (didOpen on
   * first sight, didChange afterwards, versioned per document).
   */
  private async syncDocument(uri: string, languageId: string, text: string): Promise<void> {
    await this.ensureStarted()
    if (!this.available) return
    const existing = this.documents.get(uri)
    if (existing === undefined) {
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 0, text },
      })
      this.documents.set(uri, { uri, version: 0, languageId })
    } else {
      const version = existing.version + 1
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      })
      this.documents.set(uri, { uri, version, languageId })
    }
  }

  /** Operations on one open document. */

  /** Request formatting edits for the current text; null when none apply. */
  async format(uri: string, languageId: string, text: string): Promise<string | null | undefined> {
    await this.syncDocument(uri, languageId, text)
    if (!this.available) return undefined
    // The LSP `textDocument/formatting` RESULT IS the edits array itself.
    const edits = (await this.requestRaw('textDocument/formatting', {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    }).catch(() => null)) as unknown
    if (!Array.isArray(edits) || edits.length === 0) return null
    return applyEdits(text, edits as readonly { newText?: unknown; range?: unknown }[])
  }

  /**
   * Latest diagnostics published by the server for this URI. A short settle
   * delay bridges the server's publish-after-change latency; the version is
   * advisory only (we always keep the newest arrival).
   */
  async collectDiagnostics(uri: string, languageId: string, text: string): Promise<EditLspDiagnostic[] | undefined> {
    await this.syncDocument(uri, languageId, text)
    if (!this.available) return undefined
    await new Promise(resolve => setTimeout(resolve, 120))
    return this.diagnosticsByUri.get(uri)
  }

  /** Shut the server down gracefully if it is running, then kill. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const process = this.process
    if (process) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          process.dispose()
          resolve()
        }, 2_000)
        process.onClose(() => {
          clearTimeout(timer)
          resolve()
        })
        try {
          process.send({ jsonrpc: '2.0', method: 'shutdown', params: null })
          process.send({ jsonrpc: '2.0', method: 'exit', params: null })
        } catch {
          // fall through to kill below
        }
      })
    }
    // Fail every in-flight request. Per-request deadline timers are cleared
    // by each request's own scope release as its Deferred settles — there is
    // no timer bookkeeping left at this level.
    for (const deferred of this.pending.values()) {
      Deferred.doneUnsafe(deferred, Effect.fail(new Error('lsp client: disposed')))
    }
    this.pending.clear()
  }

  /** Current boot state for diagnostics/tests. */
  status(): LspStatus {
    return {
      ready: this.available && this.process !== undefined && this.process.pid !== undefined,
      serverPid: this.process?.pid,
    }
  }
}

/** Apply LSP text edits (newText with optional range) in order. */
function applyEdits(text: string, edits: readonly { newText?: unknown; range?: unknown }[]): string {
  let result = text
  // LSP edits are sorted ascending by position; applying in order requires
  // offset math per range. We rebuild from the end to keep offsets stable.
  const resolved: { start: number; end: number; newText: string }[] = []
  for (const edit of edits) {
    if (typeof edit.newText !== 'string') continue
    const range = edit.range as
      | { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } }
      | undefined
    if (!range || typeof range.start?.line !== 'number' || typeof range.end?.line !== 'number') {
      // Insert at EOF when no usable range.
      resolved.push({ start: text.length, end: text.length, newText: edit.newText })
      continue
    }
    const start = offsetAt(text, range.start.line, range.start.character as number)
    const end = offsetAt(text, range.end.line, range.end.character as number)
    resolved.push({ start, end, newText: edit.newText })
  }
  resolved.sort((a, b) => b.start - a.start) // apply tail-first so positions hold
  for (const edit of resolved) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end)
  }
  return result
}

/** Character offset of a (line, character) position in a text. */
function offsetAt(text: string, line: number, character: number): number {
  const lines = text.split('\n')
  const clampedLine = Math.max(0, Math.min(line, lines.length - 1))
  const lineText = lines[clampedLine] ?? ''
  const clampedChar = Math.max(0, Math.min(character, lineText.length))
  let offset = 0
  for (let index = 0; index < clampedLine; index++) offset += lines[index]!.length + 1
  return offset + clampedChar
}

/** Exposed for tests. */
export const _internals = {
  splitCommand,
  pathToUri,
  languageIdFromPath,
  applyEdits,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
