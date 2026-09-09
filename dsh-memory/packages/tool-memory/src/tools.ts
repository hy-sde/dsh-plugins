/**
 * Model-facing long-horizon memory tools: `retain`, `recall`, `reflect`,
 * `memory_edit`, and `learn` over the host `ctx.memory` service. Pure tool
 * surface — all storage lives in `@hy-sde-org/dsh-memory`.
 * @module @hy-sde-org/dsh-tool-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  MemoryContext,
  MemorySaveInput,
  MemorySearchItem,
  MemorySearchResult,
} from '@hy-sde-org/dsh-memory'
import {
  formatSessionMention, mineCandidateOf, mineFingerprint, resolveSessionQuery, searchSessionHistory, sessionLabel,
} from './session-history.ts'

/** Session-history recall tuning (wired from tool config in index.ts). */
export interface SessionHistoryConfig {
  /** Whether `recall`/`reflect` merge past-session hits. Defaults to true. */
  enabled: boolean
  /** Max session hits merged into one recall result. */
  limit: number
}

export const DEFAULT_SESSION_HISTORY: SessionHistoryConfig = { enabled: true, limit: 3 }

/** Search the bank, then merge best-effort past-session hits when configured. */
export async function memorySearchWithHistory(
  ctx: Context,
  exec: ToolRunContext,
  query: string,
  options: { limit: number; history: SessionHistoryConfig },
): Promise<MemorySearchResult> {
  const result = await ctx.memory.search(memoryContextOf(exec), query, { limit: options.limit })
  if (!options.history.enabled) return result
  const history = await searchSessionHistory(ctx, exec, query, options.history.limit)
  if (history.length === 0) return result
  return { ...result, count: result.items.length + history.length, items: [...result.items, ...history] }
}

/** Extract the calling session's project cwd, falling back to the process cwd. */
export function sessionCwd(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/** One tool-call's memory context over the calling session. */
export function memoryContextOf(exec: ToolRunContext): MemoryContext {
  return { cwd: sessionCwd(exec), signal: exec.signal }
}

const IMPORTANCE_RETAIN = 0.75
const IMPORTANCE_LEARN = 0.8

/* ── retain ─────────────────────────────────────────────────────────────── */

interface RetainItem { content: string; context?: string }
interface RetainArgs { items: RetainItem[] }
interface RetainValue { stored: number; message: string }

export function applyRetainTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'retain',
    description:
      'Store one or more facts in long-term project memory for future sessions. '
      + 'Use for durable, reusable knowledge: user preferences, project decisions, architectural choices — anything that '
      + 'improves future responses. Not for ephemeral task state. Each item must be specific and self-contained (who, what, '
      + 'when, why). Batch related facts per call; entries are deduplicated and consolidated.',
    parameters: {
      items: {
        type: 'array',
        description: 'Memories to retain',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'Information to remember' },
            context: { type: 'string', description: 'Optional source context' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stored: { type: 'integer', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value: RetainValue) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => false,
    async execute(args: RetainArgs, exec) {
      const memory = ctx.memory
      const context = memoryContextOf(exec)
      let stored = 0
      let firstId: string | undefined
      for (const item of args.items) {
        const input: MemorySaveInput = {
          content: item.content,
          ...item.context !== undefined && item.context.length > 0 ? { context: item.context } : {},
          source: 'retain',
          importance: IMPORTANCE_RETAIN,
        }
        const result = await memory.save(context, input)
        stored += result.stored
        firstId ??= result.id
      }
      const noun = stored === 1 ? 'memory' : 'memories'
      const suffix = stored > 0 && firstId !== undefined ? ` (first id: ${firstId})` : ''
      return { stored, message: `${stored} ${noun} stored.${suffix}` }
    },
    presentCall: (args: RetainArgs): GenericCallView | undefined => {
      const count = args.items.length
      return { card: 'generic', title: 'Retain', rawInput: count === 1 ? args.items[0]?.content : `${count} memories` }
    },
  }))
}

/* ── recall ─────────────────────────────────────────────────────────────── */

interface RecallArgs { query: string; limit?: number }
interface RecallValue { query: string; count: number; items: MemorySearchItem[]; message: string }

function formatRecall(query: string, result: MemorySearchResult): string {
  if (result.count === 0) return `No relevant memories found for "${query}".`
  const lines = [`Found ${result.count} relevant ${result.count === 1 ? 'memory' : 'memories'} (as of ${new Date().toISOString().slice(0, 19)}Z):\n`]
  result.items.forEach((item, index) => {
    const id = item.id ?? (item.source === 'session' ? sessionLabel(item.sessionId ?? '?') : '?')
    const meta = [
      item.source ?? '',
      item.timestamp?.slice(0, 10) ?? '',
      item.sessionId !== undefined
        ? `session ${sessionLabel(item.sessionId)} ${formatSessionMention(item.sessionId)}`
        : '',
    ].filter(Boolean).join(' · ')
    const score = item.score === undefined ? '' : ` · score ${item.score.toFixed(2)}`
    const readonly = item.readonly ? ' · read-only' : ''
    lines.push(`[${index + 1}] ${id}${meta ? ` · ${meta}` : ''}${score}${readonly}`)
    lines.push(`    ${item.content}`)
  })
  return lines.join('\n')
}

export function applyRecallTool(ctx: Context, history: SessionHistoryConfig = DEFAULT_SESSION_HISTORY): void {
  ctx.tools.register(defineTool({
    name: 'recall',
    description:
      'Search long-term project memory; return raw relevance-ranked matching entries. '
      + 'Use proactively before questions about past conversations, user preferences, project decisions, or topics where '
      + 'prior context improves accuracy. `recall` returns specific facts and entries, `reflect` a synthesized answer '
      + 'across many memories. Memory ids returned here round-trip through `memory_edit`.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language search query' },
      limit: { type: 'integer', description: 'Maximum entries to return (default 10)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          message: { type: 'string', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                content: { type: 'string', required: true },
                source: { type: 'string' },
                timestamp: { type: 'string' },
                score: { type: 'number' },
                readonly: { type: 'boolean' },
                importance: { type: 'number' },
                sessionId: { type: 'string' },
                seq: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value: RecallValue) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args: RecallArgs, exec) {
      const limit = args.limit === undefined ? undefined : Math.max(1, Math.min(50, args.limit))
      const result = await memorySearchWithHistory(ctx, exec, args.query, { limit: limit ?? 10, history })
      return { query: result.query, count: result.count, items: result.items, message: formatRecall(args.query, result) }
    },
    presentCall: (args: RecallArgs): GenericCallView | undefined => ({ card: 'generic', title: 'Recall', rawInput: args.query }),
  }))
}

/* ── reflect ─────────────────────────────────────────────────────────────── */

interface ReflectArgs { query: string; context?: string }
interface ReflectValue { query: string; count: number; message: string }

function formatReflect(result: MemorySearchResult): string {
  if (result.count === 0) return 'No relevant information found to reflect on.'
  const sections: string[] = []
  for (const item of result.items) {
    const header = item.source === 'learn'
      ? 'Learned lesson'
      : item.source === 'memory_summary.md'
        ? 'Consolidated summary'
        : `Memory ${item.id ?? ''}${item.timestamp ? ` (${item.timestamp.slice(0, 10)})` : ''}`
    sections.push(`### ${header}\n${item.content}`)
  }
  return `Based on ${result.count} recalled ${result.count === 1 ? 'memory' : 'memories'}:\n\n${sections.join('\n\n')}`
}

export function applyReflectTool(ctx: Context, history: SessionHistoryConfig = DEFAULT_SESSION_HISTORY): void {
  ctx.tools.register(defineTool({
    name: 'reflect',
    description:
      'Synthesize a coherent response from relevant long-term project memories; unlike recall it blends them. '
      + 'Use for open-ended questions spanning many stored facts: "What do you know about this user?", "Summarize project '
      + 'decisions.", "What are my preferences for X?". The optional `context` focuses synthesis on a specific angle. '
      + 'Answer is grounded only in stored memory — verify repository facts before relying on them.',
    parameters: {
      query: { type: 'string', required: true, description: 'Question to answer from memory' },
      context: { type: 'string', description: 'Optional focus context' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value: ReflectValue) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args: ReflectArgs, exec) {
      const result = await memorySearchWithHistory(ctx, exec, args.query, { limit: 20, history })
      return {
        query: result.query,
        count: result.count,
        message: formatReflect(result),
      }
    },
    presentCall: (args: ReflectArgs): GenericCallView | undefined => ({ card: 'generic', title: 'Reflect', rawInput: args.query }),
  }))
}

/* ── memory_edit ─────────────────────────────────────────────────────────── */

interface MemoryEditArgs { op: 'update' | 'forget' | 'invalidate'; id: string; content?: string; importance?: number; replacement_id?: string }
interface MemoryEditValue { status: string; message: string }

export function applyMemoryEditTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'memory_edit',
    description:
      'Edit project memory by id (ids returned by `recall`/`reflect`). Operations: '
      + '`update` replaces content and/or importance; `forget` permanently deletes; `invalidate` softly supersedes, '
      + 'optionally naming a `replacement_id`. Lesson and summary entries are read-only facts. Prefer `invalidate` for '
      + 'stale memory whose history may still be useful; use `forget` only for hard deletion.',
    parameters: {
      op: { type: 'string', required: true, enum: ['update', 'forget', 'invalidate'], description: 'Memory edit operation' },
      id: { type: 'string', required: true, description: 'Memory id from recall output' },
      content: { type: 'string', description: 'Replacement content for update' },
      importance: { type: 'number', description: 'Replacement importance for update (0–1)' },
      replacement_id: { type: 'string', description: 'Replacement memory id for invalidate' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value: MemoryEditValue) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => false,
    async execute(args: MemoryEditArgs, exec) {
      const result = await ctx.memory.edit(memoryContextOf(exec), args.op, {
        id: args.id,
        ...args.content !== undefined ? { content: args.content } : {},
        ...args.importance !== undefined ? { importance: args.importance } : {},
        ...args.replacement_id !== undefined ? { replacement_id: args.replacement_id } : {},
      })
      const message = result.status === 'not_found'
        ? `Memory ${args.id} was not found.`
        : result.status === 'not_editable'
          ? `Memory ${args.id} is a read-only fact; it cannot be edited.`
          : `Memory ${args.id} ${result.status}.`
      return { status: result.status, message }
    },
    presentCall: (args: MemoryEditArgs): GenericCallView | undefined => ({
      card: 'generic',
      title: `Memory edit: ${args.op}`,
      rawInput: args.id,
    }),
  }))
}

/* ── learn ──────────────────────────────────────────────────────────────── */

interface LearnArgs { memory: string; context?: string }
interface LearnValue { stored: number; message: string; id?: string }

export function applyLearnTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'learn',
    description:
      'Capture a reusable lesson in long-term project memory; the durable `memory` payload should stand alone (what, when, why). '
      + 'Use after solving an insight likely to pay off again: a non-obvious fix, a discovered project convention, or a '
      + 'workflow that worked. Capture sparingly and specifically: one strong reusable lesson beats several vague ones. '
      + 'Lessons stay in `learned.md`, are surfaced again at the start of later sessions, and are neutralized against '
      + 'prompt-injection markers before storage.',
    parameters: {
      memory: { type: 'string', required: true, description: 'The durable, self-contained lesson to remember (what, when, why)' },
      context: { type: 'string', description: 'Optional source context for the lesson' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stored: { type: 'integer', required: true },
          message: { type: 'string', required: true },
          id: { type: 'string' },
        },
      },
      render: (_args, value: LearnValue) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => false,
    async execute(args: LearnArgs, exec) {
      const input: MemorySaveInput = {
        content: args.memory,
        ...args.context !== undefined && args.context.length > 0 ? { context: args.context } : {},
        source: 'learn',
        importance: IMPORTANCE_LEARN,
      }
      const result = await ctx.memory.learn(memoryContextOf(exec), input)
      if (result.stored === 0) throw new Error('Lesson was empty after sanitization; nothing stored.')
      return { stored: result.stored, message: result.message, ...result.id !== undefined ? { id: result.id } : {} }
    },
    presentCall: (args: LearnArgs): GenericCallView | undefined => ({ card: 'generic', title: 'Learn', rawInput: args.memory }),
  }))
}

/* ── mine_sessions ───────────────────────────────────────────────────────── */

interface MineArgs { session_id?: string }
interface MineValue { available: boolean; mined: number; sessions: number; message: string }

export function applyMineSessionsTool(
  ctx: Context,
  config: { sessions: number; lessons: number } = { sessions: 3, lessons: 10 },
): void {
  ctx.tools.register(defineTool({
    name: 'mine_sessions',
    description:
      'Harvest reusable lessons from your own past sessions of this project (needs the harness '
      + '`sessionQuery` service; degrades to an unavailable notice without it). Reads the most recent '
      + 'few session logs (or one specific `session_id`), extracts digests from compaction summaries, '
      + 'failures from turn/end error reasons, and all-completed todos, then stores each new lesson '
      + 'through `learn` with the session as provenance. Run occasionally to convert conversation '
      + 'history into durable memory; deduped, so re-running adds nothing new.',
    parameters: {
      session_id: { type: 'string', description: 'Optional explicit session id to mine instead of the recent sessions of this project' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          mined: { type: 'integer', required: true },
          sessions: { type: 'integer', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value: MineValue) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => false,
    async execute(args: MineArgs, exec) {
      const port = resolveSessionQuery(ctx)
      if (port === undefined) {
        return {
          available: false,
          mined: 0,
          sessions: 0,
          message: 'mine_sessions is unavailable: no `sessionQuery` service is mounted in this environment.',
        }
      }
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()

      // Resolve the session set to mine: explicit id, or recent sessions of cwd.
      let sessionIds: string[]
      let title: string | undefined
      if (args.session_id !== undefined && args.session_id.length > 0) {
        sessionIds = [args.session_id]
      } else {
        const records = await port.filterSessions([{ kind: 'cwd', values: [cwd] }])
        const sorted = [...records]
          .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
          .slice(0, config.sessions)
        sessionIds = sorted.map(record => record.header.id)
      }
      if (sessionIds.length === 0) {
        return { available: true, mined: 0, sessions: 0, message: 'No sessions found to mine for this project.' }
      }

      const seen = new Set<string>()
      let mined = 0
      for (const sessionId of sessionIds) {
        let snapshot
        try {
          snapshot = await port.readSession(sessionId)
        } catch {
          continue // missing/corrupt session log — skip rather than fail the run
        }
        if (args.session_id === undefined) {
          try {
            title = await port.readTitle(snapshot.session.id)
          } catch {
            title = undefined
          }
        }
        for (const event of snapshot.events) {
          if (mined >= config.lessons) break
          for (const candidate of mineCandidateOf(event, snapshot.session.id, title)) {
            const fingerprint = mineFingerprint(candidate.content)
            if (seen.has(fingerprint)) continue
            seen.add(fingerprint)
            const input: MemorySaveInput = {
              content: candidate.content,
              context: candidate.context,
              source: 'mine',
              sessionId: snapshot.session.id,
              importance: IMPORTANCE_LEARN,
            }
            const result = await ctx.memory.learn(memoryContextOf(exec), input)
            if (result.stored > 0) mined += 1
          }
        }
      }
      const noun = mined === 1 ? 'lesson' : 'lessons'
      return {
        available: true,
        mined,
        sessions: sessionIds.length,
        message: mined === 0
          ? `Mined ${sessionIds.length} session(s) for this project; no new lessons.`
          : `Mined ${mined} new ${noun} from ${sessionIds.length} session(s) into project memory (deduped).`,
      }
    },
    presentCall: (args: MineArgs): GenericCallView | undefined => ({
      card: 'generic',
      title: 'Mine sessions',
      rawInput: args.session_id ?? 'recent',
    }),
  }))
}
