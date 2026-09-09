/**
 * Pure session-log reduction: tool-call frequency, session coverage, and
 * per-tool error counts for one workspace.
 *
 * Backend-agnostic by design: the harness-backed tool feeds `SessionEventLike`
 * rows from `ctx.sessionQuery.readSession`, and the standalone CLI feeds rows
 * parsed directly from the on-disk JSONL artifacts — both share this one
 * aggregator so both surfaces report identical numbers.
 *
 * A `tool/call` event is one model-issued tool invocation counted by `name`;
 * a `tool/result` event whose `error` field (or `isError` content) is present
 * counts as one error for that tool, attributed through `callId` (results
 * always follow their call inside one session). Seeded logs carry an inherited
 * prefix that belongs to the parent session; those events (seq below
 * {@link SessionLike.inheritedEventCount}) are skipped so a workspace count
 * never double-counts a subagent child's inherited calls.
 *
 * Merged from @hy-sde-org/dsh-tool-session-insights (superseded by this
 * package; the aggregator is unchanged so both surfaces report identical
 * numbers).
 *
 * @module @hy-sde-org/dsh-session-intelligence/insights/analyze
 */

import { normalizeToolCategory } from '../engine/taxonomy.ts'
import type { ToolCategory } from '../engine/types.ts'

/** One raw session event reduced to the fields this package understands. */
export interface SessionEventLike {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

/** A session's header facts plus its reduced event stream. */
export interface SessionLike {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  /**
   * Number of inherited (seeded) events at the log start. Events with
   * `seq < inheritedEventCount` belong to the parent session and are skipped.
   * Absent means the session is unseeded.
   */
  readonly inheritedEventCount?: number
  readonly events: readonly SessionEventLike[]
}

/** One tool's aggregated usage across the analyzed sessions. */
export interface ToolFrequencyRow {
  /** The tool name as recorded in `tool/call` events. */
  readonly tool: string
  /**
   * The command name run inside a `bash` call (first shell word of each
   * command in the call's `command` field, e.g. `ls`, `rg`, `git`). A bash
   * call with several commands (`&&`, `;`, newlines) contributes one row per
   * command; errors of such a call are attributed to its first command.
   * Absent for non-bash tools and unparseable calls.
   */
  readonly command?: string
  /**
   * Normalized category (Read/Edit/Write/Bash/Grep/Glob/Task/Tool/Other)
   * from the agentsview taxonomy; see {@link normalizeToolCategory}.
   */
  readonly category: ToolCategory
  /** Total model-issued invocations. */
  readonly calls: number
  /** Distinct sessions in which the tool was used at least once. */
  readonly sessions: number
  /** Tool-execution errors (`tool/result` with an error / isError). */
  readonly errors: number
  /** Earliest call time in Unix epoch milliseconds. */
  readonly firstSeen: number
  /** Latest call time in Unix epoch milliseconds. */
  readonly lastSeen: number
}

/** Complete tool-frequency analysis for one workspace. */
export interface ToolFrequencyReport {
  /** The analyzed workspace (absolute path or sessions directory). */
  readonly workspace: string
  /** Sessions whose event stream contributed to the counts. */
  readonly sessionsAnalyzed: number
  /** Sessions that could not be read (corrupt / missing / read failure). */
  readonly sessionReadFailures: number
  /** Total counted `tool/call` events. */
  readonly toolCalls: number
  /** Total counted `tool/result` events. */
  readonly toolResults: number
  /** Distinct tool names. */
  readonly distinctTools: number
  /** Earlist counted call time, or `null` when no calls were seen. */
  readonly callsStart: number | null
  /** Latest counted call time, or `null` when no calls were seen. */
  readonly callsEnd: number | null
  /** Inherited (parent-session) tool calls skipped as double-count guard. */
  readonly inheritedToolCallsSkipped: number
  /**
   * Per-tool CALL counts (one per `tool/call` event), sorted descending —
   * unlike {@link rows}, command rows are not broken out here, so these sum
   * to {@link toolCalls} and are the right basis for tool-level shares.
   */
  readonly toolCallsByTool: readonly { readonly tool: string; readonly calls: number }[]
  /** Per-tool rows sorted by call count descending, ties by tool name. */
  readonly rows: readonly ToolFrequencyRow[]
}

/** Mutable accumulator for one (tool, command) pair while reducing. */
interface MutableRow {
  readonly tool: string
  readonly command?: string
  calls: number
  readonly sessionIds: Set<string>
  errors: number
  firstSeen: number
  lastSeen: number
}

/** Composite map key for one (tool, command) pair. */
function rowKey(tool: string, command: string | undefined): string {
  return command === undefined ? tool : `${tool}\u0000${command}`
}

interface AggregateInput {
  readonly workspace: string
  readonly sessions: readonly SessionLike[]
  readonly sessionReadFailures: number
}

/** Tool name used for errors whose `callId` never matched a call in-session. */
export const UNMATCHED_RESULT_TOOL = '(unknown)'

/** Count one workspace's tool calls, results, and errors. */
export function analyzeSessions(input: AggregateInput): ToolFrequencyReport {
  const rows = new Map<string, MutableRow>()
  const distinctTools = new Set<string>()
  const toolCallTotals = new Map<string, number>()
  let toolCalls = 0
  let toolResults = 0
  let inheritedToolCallsSkipped = 0
  let callsStart: number | null = null
  let callsEnd: number | null = null

  for (const session of input.sessions) {
    const inherited = session.inheritedEventCount ?? 0
    const callsByCallId = new Map<string, { readonly name: string; readonly command?: string }>()
    const countedResults = new Set<string>()

    for (const event of session.events) {
      if (event.seq < inherited) {
        if (event.type === 'tool/call') inheritedToolCallsSkipped += 1
        continue
      }

      if (event.type === 'tool/call') {
        const call = toolCallData(event.data)
        if (call === undefined) continue
        toolCalls += 1
        distinctTools.add(call.name)
        toolCallTotals.set(call.name, (toolCallTotals.get(call.name) ?? 0) + 1)
        const commands = call.name === 'bash' ? bashCommands(call.arguments) : []
        callsByCallId.set(call.callId, {
          name: call.name,
          ...(commands[0] !== undefined ? { command: commands[0] } : {}),
        })
        if (callsStart === null || event.time < callsStart) callsStart = event.time
        if (callsEnd === null || event.time > callsEnd) callsEnd = event.time
        if (commands.length === 0) {
          recordUsage(session.id, call.name, undefined, event.time, rows)
        } else {
          for (const command of commands) {
            recordUsage(session.id, call.name, command, event.time, rows)
          }
        }
        continue
      }

      if (event.type === 'tool/result') {
        const result = toolResultData(event.data)
        if (result === undefined) continue
        // Compaction re-logs completed tool results beside `compaction/prune`
        // rows; count each callId once, preserving the first occurrence.
        if (countedResults.has(result.callId)) continue
        countedResults.add(result.callId)
        toolResults += 1
        const caller = callsByCallId.get(result.callId)
        const tool = caller?.name ?? UNMATCHED_RESULT_TOOL
        if (resultHasError(result.data)) {
          recordError(session.id, tool, caller?.command, rows)
        }
      }
    }
  }

  const sorted = [...rows.values()].sort((a, b) => {
    if (b.calls !== a.calls) return b.calls - a.calls
    if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1
    const aCommand = a.command ?? ''
    const bCommand = b.command ?? ''
    return aCommand < bCommand ? -1 : aCommand > bCommand ? 1 : 0
  })

  return {
    workspace: input.workspace,
    sessionsAnalyzed: input.sessions.length,
    sessionReadFailures: input.sessionReadFailures,
    toolCalls,
    toolResults,
    distinctTools: distinctTools.size,
    callsStart,
    callsEnd,
    inheritedToolCallsSkipped,
    toolCallsByTool: [...toolCallTotals.entries()]
      .map(([tool, calls]) => ({ tool, calls }))
      .sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : 1)),
    rows: sorted.map(row => ({
      tool: row.tool,
      ...(row.command !== undefined ? { command: row.command } : {}),
      category: normalizeToolCategory(row.tool),
      calls: row.calls,
      sessions: row.sessionIds.size,
      errors: row.errors,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
    })),
  }
}

/** Apply one usage increment (a counted tool call) to a (tool, command) row. */
function recordUsage(
  sessionId: string,
  tool: string,
  command: string | undefined,
  time: number,
  rows: Map<string, MutableRow>,
): void {
  const key = rowKey(tool, command)
  const row = rows.get(key) ?? {
    tool,
    ...(command !== undefined ? { command } : {}),
    calls: 0,
    sessionIds: new Set<string>(),
    errors: 0,
    firstSeen: time,
    lastSeen: time,
  }
  row.calls += 1
  row.sessionIds.add(sessionId)
  if (time < row.firstSeen) row.firstSeen = time
  if (time > row.lastSeen) row.lastSeen = time
  rows.set(key, row)
}

/** Apply one counted tool error without changing the call count. */
function recordError(
  sessionId: string,
  tool: string,
  command: string | undefined,
  rows: Map<string, MutableRow>,
): void {
  const key = rowKey(tool, command)
  const row = rows.get(key) ?? {
    tool,
    ...(command !== undefined ? { command } : {}),
    calls: 0,
    sessionIds: new Set<string>(),
    errors: 0,
    firstSeen: 0,
    lastSeen: 0,
  }
  row.errors += 1
  row.sessionIds.add(sessionId)
  rows.set(key, row)
}

/** Narrow one `tool/call` event's `data` to the fields the count needs. */
function toolCallData(
  data: unknown,
): { readonly callId: string; readonly name: string; readonly arguments?: unknown } | undefined {
  if (!isRecord(data)) return undefined
  const { callId, name } = data
  if (typeof callId !== 'string' || typeof name !== 'string') return undefined
  return {
    callId,
    name,
    ...(data.arguments !== undefined ? { arguments: data.arguments } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Bash command extraction                                             */
/* ------------------------------------------------------------------ */

/** Shell wrapper words skipped when picking the executed command. */
const COMMAND_WRAPPERS = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'xargs'])

/**
 * Extract the executed command names from a `bash` tool call's `arguments`
 * field (the recorded shape is a JSON string of `{ command, description }`).
 * The command text is split on `;`, `&&`, `||`, and newlines (quote-aware —
 * a separator inside `'…'`/`"…"` does not split; a heredoc body belongs to
 * the command that opens it). Each piece contributes its first shell word —
 * so `"ls -la; rg foo"` yields `['ls', 'rg']`. `cd`/shell builtins count
 * like any other command.
 * @returns the command names, `[]` when nothing parseable was recorded.
 */
export function bashCommands(argumentsValue: unknown): string[] {
  const commandText = parseCommandText(argumentsValue)
  if (commandText === undefined) return []
  const names: string[] = []
  for (const piece of splitCommandPieces(commandText)) {
    const name = firstCommandWord(piece)
    if (name !== undefined) names.push(name)
  }
  return names
}

/**
 * Split one command line into its shell command pieces. Handles single/double
 * quotes (separators inside quotes are literal) and heredocs (`<<'EOF'` … EOF
 * stays one piece with the opening command, so a JS/Python body never leaks
 * its code words, e.g. `const`/`import`, into the command list).
 */
function splitCommandPieces(command: string): string[] {
  const pieces: string[] = []
  let current = ''
  let heredocDelim: string | undefined

  const flush = (): void => {
    if (current.trim() !== '') pieces.push(current)
    current = ''
  }

  for (const line of command.split('\n')) {
    if (heredocDelim !== undefined) {
      const trimmed = line.trim()
      const delimiterMatch = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(trimmed)
      if (trimmed === heredocDelim) {
        heredocDelim = undefined
        current += `\n${line}`
        continue
      }
      if (delimiterMatch !== null && delimiterMatch[1] === heredocDelim) {
        // Closing delimiter followed by more commands on the same line,
        // e.g. `EOF; ls`: the body piece closes here, the rest splits.
        heredocDelim = undefined
        current += `\n${delimiterMatch[1]}`
        flush()
        const remainder = delimiterMatch[2] ?? ''
        if (remainder.trim() !== '') {
          splitLinePieces(remainder, flush, ch => { current += ch })
        }
        continue
      }
      current += `\n${line}`
      continue
    }
    const opened = heredocDelimiter(line)
    if (opened !== undefined) {
      heredocDelim = opened
      current += `\n${line}`
      continue
    }
    splitLinePieces(line, flush, ch => { current += ch })
  }
  flush()
  return pieces
}

/** The heredoc delimiter a line opens, if any (`cat <<'EOF'` → `EOF`). */
function heredocDelimiter(line: string): string | undefined {
  const match = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/.exec(line)
  return match?.[1]
}

/**
 * Whether an `&` is part of a redirection (`2>&1`, `>&`, `&>`) rather than a
 * command separator — those must not split a piece.
 */
function isRedirectAmp(line: string, index: number): boolean {
  const next = line[index + 1]
  if (next === '&') return false
  if (next === '>') return true
  const previous = line[index - 1]
  return previous !== undefined
    && ((previous >= '0' && previous <= '9') || previous === '>')
}

/** Emit separator-delimited pieces of one line, respecting quotes. */
function splitLinePieces(
  line: string,
  flush: () => void,
  append: (char: string) => void,
): void {
  let inSingle = false
  let inDouble = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? ''
    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      append(char)
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble
      append(char)
    } else if (!inSingle && !inDouble && (char === ';' || char === '|' || (char === '&' && !isRedirectAmp(line, index)))) {
      flush()
      if (line[index + 1] === char) index += 1
    } else {
      append(char)
    }
  }
  // A newline ends a command piece (like the separators above).
  flush()
}

/** The raw command text from a bash call's `arguments`, if any. */
function parseCommandText(argumentsValue: unknown): string | undefined {
  if (typeof argumentsValue !== 'string') return undefined
  const trimmed = argumentsValue.trim()
  if (trimmed === '') return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isRecord(parsed) && typeof parsed.command === 'string' && parsed.command.trim() !== '') {
      return parsed.command
    }
    // Valid JSON without a usable `command` field carries no command text.
    return undefined
  } catch {
    // Not JSON: treat the whole arguments value as the command line.
    return trimmed
  }
}

/** First shell word of one command piece, skipping env assignments/wrappers. */
function firstCommandWord(piece: string): string | undefined {
  let rest = piece.trim()
  if (rest === '') return undefined
  // Strip leading environment assignments: `FOO=1 BAR="x y" cmd ...`
  for (;;) {
    const match = /^[A-Za-z_][A-Za-z0-9_]*(?:=("[^"]*"|'[^']*'|\S+))\s*/.exec(rest)
    if (match === null) break
    rest = rest.slice(match[0].length)
  }
  const word = rest.split(/\s+/)[0]
  if (word === undefined || word === '') return undefined
  const candidate = word.includes('/') ? word.slice(word.lastIndexOf('/') + 1) : word
  if (candidate === '') return undefined
  if (COMMAND_WRAPPERS.has(candidate)) {
    const next = rest.replace(word, '').trim().split(/\s+/)[0]
    const nextBase = next === undefined ? undefined
      : next.includes('/') ? next.slice(next.lastIndexOf('/') + 1) : next
    return nextBase === undefined || nextBase === '' ? undefined : nextBase
  }
  return candidate
}

/**
 * Narrow one `tool/result` event's `data` to identity + the raw data.
 * Call identity is `data.message.source.callId` in the recorded shape (with a
 * top-level `callId` tolerated for robustness).
 */
function toolResultData(
  data: unknown,
): { readonly callId: string; readonly data: Record<string, unknown> } | undefined {
  if (!isRecord(data)) return undefined
  const callId = typeof data.callId === 'string'
    ? data.callId
    : isRecord(data.message) && isRecord(data.message.source) && typeof data.message.source.callId === 'string'
      ? data.message.source.callId
      : undefined
  if (callId === undefined) return undefined
  return { callId, data }
}

/** Whether a `tool/result` data record carries an error outcome. */
function resultHasError(data: Record<string, unknown>): boolean {
  if (data.error !== undefined) return true
  const message = data.message
  if (!isRecord(message) || !Array.isArray(message.content)) return false
  return message.content.some(block => isRecord(block) && block.isError === true)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
