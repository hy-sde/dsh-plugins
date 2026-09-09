/**
 * The `memory://` internal-URL handler: exposes the caller's project memory
 * (via `ctx.memory`) to the read/grep tools as FS-shaped URLs through the
 * shared `ctx.internalUrls` registry. Ported in shape from oh-my-pi
 * (`coding-agent/src/internal-urls/memory-protocol.ts`), MIT, adapted to the
 * harness's backend registry instead of file-backed roots.
 *
 * URL forms:
 * - `memory://root` — the project's consolidated memory overview (summary +
 *   learned lessons + working bank, the same block prompt injection uses).
 * - `memory://<id>` — one stored entry in full (bank rows by recall id,
 *   `lesson_*` lessons, `summary_0`). Reads are scoped to the calling
 *   session's cwd project; id addressing is optional on the backend, and a
 *   backend without id-addressable entries returns the corrective
 *   "not addressable" error (the omp HINDSIGHT_UNADDRESSABLE pattern).
 *
 * Every resolved resource is immutable: agents never rewrite durable memory
 * through a file-shaped URL; `memory_edit` is the mutation surface.
 * @module @hy-sde-org/dsh-memory/memory-protocol
 */

import type {
  InternalResource,
  ParsedInternalUrl,
  ProtocolHandler,
  ResolveContext,
  UrlCompletion,
} from '@hy-sde-org/dsh-internal-urls'
import type { MemoryBackend, MemoryContext, MemoryEntryView } from './types.ts'

/** The `root` namespace: the project's consolidated memory overview. */
export const MEMORY_ROOT_NAMESPACE = 'root'
/** Completion cap on enumerated entry ids (bank can grow without bound). */
export const MEMORY_ENTRY_COMPLETION_LIMIT = 50

/** What the handler needs from the memory package: the selected backend. */
export interface MemoryProtocolDeps {
  /** The selected backend, or undefined when none is registered. */
  backend(): MemoryBackend | undefined
}

/** Scope the read to the calling session's project; needs a cwd. */
function memoryContextOf(context: ResolveContext | undefined): MemoryContext | undefined {
  if (context?.cwd === undefined || context.cwd.length === 0) return undefined
  return {
    cwd: context.cwd,
    ...context.signal !== undefined ? { signal: context.signal } : {},
  }
}

/** One-line content preview for completion labels. */
function preview(entry: MemoryEntryView): string {
  const line = entry.content.replace(/\s+/g, ' ').trim()
  return line.length <= 72 ? line : `${line.slice(0, 72)}…`
}

/** Render one entry with its metadata header, mirroring omp's frontmatter shape. */
function renderMemoryEntry(namespace: string, entry: MemoryEntryView): string {
  const header: string[] = [`id: ${namespace}`]
  header.push(`source: ${entry.source}`)
  if (entry.importance !== undefined) header.push(`importance: ${entry.importance}`)
  if (entry.timestamp !== undefined) header.push(`timestamp: ${entry.timestamp}`)
  if (entry.readonly === true) header.push('readonly: true')
  return `${header.join('\n')}\n\n${entry.content}`
}

/**
 * The `memory://` protocol handler. Binds every read to the calling session's
 * project (ResolveContext.cwd); a cwd-less caller cannot scope a project and
 * gets a corrective pointer to `recall` instead.
 */
export class MemoryProtocolHandler implements ProtocolHandler {
  readonly scheme = 'memory'
  readonly immutable = true

  constructor(private readonly deps: MemoryProtocolDeps) {}

  async resolve(url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource> {
    const namespace = url.rawHost
    if (namespace.length === 0) {
      throw new Error('memory:// URL requires a namespace: memory://root or memory://<id>')
    }
    const memoryContext = memoryContextOf(context)
    if (memoryContext === undefined) {
      throw new Error(
        'memory:// needs the calling session\u2019s working directory to scope the project. Use `recall` to search or `reflect` to synthesize memory instead.',
      )
    }
    const backend = this.deps.backend()
    if (backend === undefined) {
      throw new Error('memory: no memory backend is registered')
    }

    if (namespace === MEMORY_ROOT_NAMESPACE) {
      return this.resolveRoot(url, backend, memoryContext)
    }
    if (url.pathSegments.length > 0) {
      throw new Error(`Invalid memory:// URL: memory://${namespace} does not take a path. Use memory://root (overview) or memory://<id> (one entry).`)
    }

    if (backend.readEntry === undefined) {
      throw new Error(
        `The "${backend.id}" memory backend is not addressable via memory://<id>. Recall results are final — use \`recall\` to search or \`reflect\` to synthesize.`,
      )
    }
    const entry = await backend.readEntry(memoryContext, namespace)
    if (entry === undefined) {
      throw new Error(
        `Memory ${namespace} does not exist in this project (or was retired). Use \`recall\` to list available ids, or \`memory_edit\` to update an id you hold.`,
      )
    }
    const content = renderMemoryEntry(namespace, entry)
    const notes = [`Full entry (${entry.source}) from project memory.`, 'Mutation surface: `memory_edit` (update/forget/invalidate).']
    return {
      url: url.href,
      content,
      contentType: 'text/markdown',
      immutable: true,
      size: Buffer.byteLength(content, 'utf-8'),
      notes,
    }
  }

  /** `memory://root` — the project's consolidated overview block. */
  private async resolveRoot(
    url: ParsedInternalUrl,
    backend: MemoryBackend,
    memoryContext: MemoryContext,
  ): Promise<InternalResource> {
    if (url.pathSegments.length > 0) {
      throw new Error(
        'Invalid memory:// URL: this port is backend-shaped, not file-shaped — memory://root takes no path. Read memory://root for the overview or memory://<id> for one entry.',
      )
    }
    const summaries = await backend.summaries(memoryContext)
    const content = summaries.block.trim()
    if (content.length === 0) {
      return {
        url: url.href,
        content: 'Project memory is empty. Use `retain` to store a fact or `learn` for a lesson.',
        contentType: 'text/markdown',
        notes: ['No summary, lessons, or working entries for this project yet.'],
      }
    }
    return {
      url: url.href,
      content,
      contentType: 'text/markdown',
      immutable: true,
      size: Buffer.byteLength(content, 'utf-8'),
      notes: [`Project memory via the "${summaries.backend}" backend (summary + lessons + working bank).`],
    }
  }

  async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
    const memoryContext = memoryContextOf(context)
    if (memoryContext === undefined) return []
    const backend = this.deps.backend()
    if (backend === undefined) return []
    const completions: UrlCompletion[] = [
      { value: MEMORY_ROOT_NAMESPACE, description: 'Project memory overview (summary + lessons + bank)' },
    ]
    if (backend.listEntries !== undefined) {
      const entries = await backend.listEntries(memoryContext, MEMORY_ENTRY_COMPLETION_LIMIT)
      for (const entry of entries) {
        completions.push({ value: entry.id, label: `memory://${entry.id}`, description: preview(entry) })
      }
    } else if (backend.readEntry !== undefined) {
      completions.push({ value: '<id>', description: 'Full memory entry by id (from recall)' })
    }
    return completions
  }
}
