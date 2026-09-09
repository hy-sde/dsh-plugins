/**
 * The `agent://` internal-URL handler: exposes session-backed subagent outputs
 * to the read/grep tools through the shared `ctx.internalUrls` registry.
 * Ported from the DeepSeek Harness fork's subagent package
 * (`packages/subagent/subagent/src/agent-protocol.ts`, commit 3bb1d95d88),
 * which is itself shaped after oh-my-pi
 * (`coding-agent/src/internal-urls/agent-protocol.ts`), MIT. omp resolves
 * `Id.md` artifact files under every registered session's artifact directory;
 * this port resolves child SESSION ids (the harness's durable subagent
 * identity) through the session-query service, selecting the child's final
 * assistant output with the same rule the subagent seam uses.
 *
 * URL forms:
 * - `agent://<id>` — one subagent's final assistant output (child session id).
 * - `agent://<id>/<childId>` — a nested child output; every segment after the
 *   first must be a session whose `header.parentSession` is the previous
 *   segment (the omp analogue of dot-qualified `Parent.Child` ids).
 *
 * Not supported in this port (see Known Limitations): the omp `?q=` / path
 * JSON extraction forms. Agent outputs here are markdown (assistant message
 * content), not jq-able documents — structured `outputSchema` results are
 * runtime values of a run, not persisted JSON sidecars — so extraction is
 * reported as an explicit error instead of silently mis-resolving.
 *
 * Every resolved resource is immutable: agents never rewrite a child output
 * through a file-shaped URL.
 * @module @hy-sde-org/dsh-internal-urls/agent-protocol
 */

import type {
  InternalResource,
  ParsedInternalUrl,
  ProtocolHandler,
  ResolveContext,
  UrlCompletion,
} from './types.ts'

/** Completion cap: enumerating every subagent session loads the listing only. */
export const AGENT_COMPLETION_LIMIT = 200

/**
 * Minimal structural subset of the session-query session header — the fields
 * the handler reads: `id`, `origin`, `parentSession`, `createdAt`. The
 * published `@deepseek-ai/dsh-session-query@0.0.1-rc.1` surfaces these through
 * `listSessions()` (records) and `readSession()` (snapshot) over
 * `@deepseek-ai/dsh-session` headers; the handler stays independent of both
 * packages so tests (and the optional-peer deployment) can stub the seam.
 */
export interface AgentSessionHeader {
  /** Logical session id — a subagent output id is a child session id. */
  id: string
  /**
   * Session origin. The harness marks subagent child sessions with
   * `origin: 'subagent'` (see `@deepseek-ai/dsh-session` `SessionHeader`);
   * only those sessions are subagent outputs.
   */
  origin?: string
  /** Id of the session that started this one; the nested-path walking key. */
  parentSession?: string
  /** Creation timestamp in ms since epoch, when recorded. */
  createdAt?: number
}

/** Minimal content-block shape carried by assistant-message content. */
export interface AgentContentBlock {
  type: string
  text?: string
}

/** Minimal session-event shape the output fold reads (`assistant/message`). */
export interface AgentSessionEvent {
  type: string
  sessionId: string
  data?: {
    message?: { content?: readonly AgentContentBlock[] }
    chunk?: { type?: string; text?: string }
  }
}

/**
 * The read-only session surface the handler needs — a structural subset of the
 * session-query service (`listSessions` headers + one `readSession` log), so
 * tests can stub it without mounting the real service.
 */
export interface AgentOutputStore {
  /** List the live-preferred logical session corpus (headers only). */
  listSessions(signal?: AbortSignal): Promise<Array<{ header: AgentSessionHeader }>>
  /** Read one complete session log (events in model-history order). */
  readSession(sessionId: string): Promise<{ session: AgentSessionHeader; events: AgentSessionEvent[] }>
}

/** What the handler needs from the mounting package: the output store. */
export interface AgentProtocolDeps {
  /** The session-query-backed output store, or undefined when not mounted. */
  outputStore(): AgentOutputStore | undefined
}

function notASubagentError(id: string, header: AgentSessionHeader | undefined): Error {
  const origin = header?.origin ?? 'none'
  return new Error(
    `agent:// URL: '${id}' is not a subagent output (session origin: ${origin}). Use \`session://${id}\` to read its transcript, or \`agent://<subagent-session-id>\` for a child output.`,
  )
}

function unknownIdError(id: string, available: readonly string[]): Error {
  const hint = available.length > 0 ? `Known subagent output ids: ${available.slice(0, 20).join(', ')}${available.length > 20 ? ', …' : ''}` : 'No session-backed subagent outputs are known.'
  return new Error(`agent:// URL: unknown output id '${id}'. ${hint}`)
}

/** Known subagent output ids, for corrective errors and completions. */
async function knownIds(store: AgentOutputStore, signal: AbortSignal | undefined): Promise<string[]> {
  const records = await store.listSessions(signal)
  return records
    .filter(record => record.header.origin === 'subagent')
    .map(record => record.header.id)
    .sort()
}

/**
 * Select the last non-empty assistant message; when none exists, fall back to
 * the accumulated streamed text (the same canonical rule the subagent seam
 * uses to settle a child's final output).
 */
function finalAssistantOutput(events: readonly AgentSessionEvent[]): AgentContentBlock[] | undefined {
  let message: AgentContentBlock[] | undefined
  const partial: string[] = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (content !== undefined && content.length > 0) message = [...content]
    } else if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
      const text = event.data.chunk.text
      if (text !== undefined && text.length > 0) partial.push(text)
    }
  }
  if (message !== undefined) return message
  const text = partial.join('')
  return text.length > 0 ? [{ type: 'text', text }] : undefined
}

function flattenOutput(events: readonly AgentSessionEvent[]): string {
  const blocks = finalAssistantOutput(events)
  if (blocks === undefined) {
    return 'No final assistant output yet — the child may still be running or produced no text.'
  }
  // `AgentContentBlock` is a loose structural type (the seam is independent
  // of the llm package), so non-text blocks simply carry no text to append.
  const text = blocks.map(block => block.text ?? '').join('')
  if (text.length === 0) {
    return 'The child finished without a non-empty assistant message.'
  }
  return text
}

/** One-line completion description: creation time of the child session. */
function completionDescription(header: AgentSessionHeader): string {
  const created = Number.isFinite(header.createdAt) ? new Date(header.createdAt as number).toISOString() : 'unknown time'
  return `Subagent output created ${created}`
}

/** The `agent://` protocol handler, bound to one session output store. */
export class AgentProtocolHandler implements ProtocolHandler {
  readonly scheme = 'agent'
  readonly immutable = true

  constructor(private readonly deps: AgentProtocolDeps) {}

  async resolve(url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource> {
    const outputId = url.rawHost
    if (outputId.length === 0) {
      throw new Error('agent:// URL requires a subagent output id: agent://<id>')
    }
    const query = url.searchParams.get('q')
    if (query !== null && query.length > 0) {
      throw new Error(
        'agent:// ?q= JSON extraction is not supported in this port: agent outputs are markdown, not jq-able documents. Read agent://<id> for the full output.',
      )
    }
    const store = this.deps.outputStore()
    if (store === undefined) {
      throw new Error('agent:// outputs are unavailable: the session-query service is not mounted, so no session-backed subagent output can be read.')
    }

    const ids = [outputId, ...url.pathSegments]
    if (ids.length === 1) {
      return this.resolveOne(url, store, outputId, context?.signal)
    }
    return this.resolveNested(url, store, ids, context?.signal)
  }

  /** `agent://<id>` — one subagent session's final output. */
  private async resolveOne(
    url: ParsedInternalUrl,
    store: AgentOutputStore,
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<InternalResource> {
    let snapshot: { session: AgentSessionHeader; events: AgentSessionEvent[] }
    try {
      snapshot = await store.readSession(id)
    } catch (_error: unknown) {
      throw unknownIdError(id, await knownIds(store, signal))
    }
    if (snapshot.session.origin !== 'subagent') throw notASubagentError(id, snapshot.session)
    return this.buildResource(url, snapshot.session, snapshot.events, [])
  }

  /** `agent://<id>/<child>/…` — walk the parentSession chain to a nested child. */
  private async resolveNested(
    url: ParsedInternalUrl,
    store: AgentOutputStore,
    ids: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<InternalResource> {
    const records = await store.listSessions(signal)
    const byId = new Map<string, AgentSessionHeader>()
    for (const record of records) byId.set(record.header.id, record.header)

    const [first, ...rest] = ids
    if (first === undefined) {
      throw new Error('agent:// URL: internal error: empty id chain')
    }
    let current = first
    for (const child of rest) {
      const childHeader = byId.get(child)
      if (childHeader === undefined || childHeader.parentSession !== current) {
        const available = [...byId.values()]
          .filter(header => header.parentSession === current && header.origin === 'subagent')
          .map(header => header.id)
          .sort()
        const hint = available.length > 0 ? ` Direct children of '${current}': ${available.slice(0, 20).join(', ')}${available.length > 20 ? ', …' : ''}` : ''
        throw new Error(`agent:// URL: no subagent '${child}' under '${current}'.${hint}`)
      }
      current = child
    }
    const finalHeader = byId.get(current)
    if (finalHeader === undefined) throw unknownIdError(current, [...byId.values()].filter(h => h.origin === 'subagent').map(h => h.id))
    if (finalHeader.origin !== 'subagent') throw notASubagentError(current, finalHeader)

    const snapshot = await store.readSession(current)
    const ancestors = ids.slice(0, -1)
    return this.buildResource(url, snapshot.session, snapshot.events, ancestors)
  }

  /** Render the selected output; `ancestors` are the nested path segments ("" at root). */
  private buildResource(
    url: ParsedInternalUrl,
    header: AgentSessionHeader,
    events: AgentSessionEvent[],
    ancestors: readonly string[],
  ): InternalResource {
    const content = flattenOutput(events)
    const notes = [
      `Subagent output of session '${header.id}' (read-only).`,
      ...ancestors.length > 0 ? [`Resolved through: ${[...ancestors, header.id].join(' / ')}.`] : [],
    ]
    return {
      url: url.href,
      content,
      contentType: 'text/markdown',
      immutable: true,
      size: Buffer.byteLength(content, 'utf-8'),
      notes,
    }
  }

  async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
    const store = this.deps.outputStore()
    if (store === undefined) return []
    const records = await store.listSessions(context?.signal)
    const completions: UrlCompletion[] = []
    for (const record of records) {
      if (record.header.origin !== 'subagent') continue
      completions.push({ value: record.header.id, label: `agent://${record.header.id}`, description: completionDescription(record.header) })
      if (completions.length >= AGENT_COMPLETION_LIMIT) break
    }
    return completions
  }
}
