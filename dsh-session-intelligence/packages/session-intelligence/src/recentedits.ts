/**
 * Recent-edits feed: file paths from Edit/Write-style tool calls across
 * sessions, grouped per path, newest edit first.
 *
 * Ported semantics from agentsview (MIT, Kenn Software): the arg-path
 * extraction `parser.ResolveFilePathFromJSON` (`internal/parser/content.go`,
 * tries `file_path` → `path` → `filePath` → `file`) and the recent-edits
 * grouping/ordering of `internal/duckdb/recentedits.go` (category in
 * Edit/Write, non-empty path, rank per path by timestamp desc / session desc
 * / ordinal desc / call_index desc; rows ordered by last edit desc; up to K
 * edits inlined per file). This is a pure in-process port: sessions are
 * walked directly (no DB), the only "project" is the one sessions dir.
 *
 * @module @hy-sde-org/dsh-session-intelligence/recentedits
 */

import { normalizeToolCategory } from './engine/taxonomy.ts'
import type { HealthSessionLike } from './adapter/dsh.ts'

/** One edit occurrence (an Edit/Write tool call with a resolved path). */
export interface EditOccurrence {
  readonly sessionId: string
  /** Event time of the tool/call, epoch milliseconds. */
  readonly timestamp: number
  readonly messageOrdinal: number
  readonly callIndex: number
  readonly toolName: string
  readonly category: 'Edit' | 'Write'
  readonly filePath: string
}

/** One file's recent-edit summary, edits inlined newest-first. */
export interface RecentEditFile {
  readonly filePath: string
  readonly editCount: number
  readonly lastEditedAt: number
  readonly lastSessionId: string
  readonly edits: readonly EditOccurrence[]
}

/** Collect options: optional path substring filter and inline cap. */
export interface RecentEditsOptions {
  /** Case-insensitive substring filter on the file path (`ILIKE`-style). */
  readonly path?: string
  /** Maximum inlined edits per file (agentsview `MaxEditsPerFile`). Default 3. */
  readonly perFile?: number
}

/**
 * Extract the file path from a tool call's raw input JSON, trying
 * `file_path`, `path`, `filePath`, then `file` (agentsview
 * `ResolveFilePathFromJSON`). Returns "" for invalid JSON or no path key.
 */
export function resolveFilePath(inputJson: string): string {
  if (inputJson === '') return ''
  try {
    const parsed: unknown = JSON.parse(inputJson)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
    const record = parsed as Record<string, unknown>
    for (const key of ['file_path', 'path', 'filePath', 'file']) {
      const value = record[key]
      if (typeof value === 'string' && value !== '') return value
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Walk sessions and return the recent-edits feed: distinct non-empty paths
 * touched by Edit/Write category calls, sorted by most-recent edit (ties:
 * session id desc, message ordinal desc, call index desc), each with up to
 * `perFile` inlined occurrences newest-first. Inherited (seeded) events are
 * skipped.
 */
export function collectRecentEdits(
  sessions: readonly HealthSessionLike[],
  options: RecentEditsOptions = {},
): readonly RecentEditFile[] {
  const byPath = new Map<string, EditOccurrence[]>()
  for (const session of sessions) {
    for (const occurrence of sessionEditOccurrences(session)) {
      const list = byPath.get(occurrence.filePath)
      if (list === undefined) byPath.set(occurrence.filePath, [occurrence])
      else list.push(occurrence)
    }
  }

  const filter = options.path
  const files: RecentEditFile[] = []
  for (const [filePath, occurrences] of byPath) {
    if (filter !== undefined) {
      const needle = filter.toLowerCase()
      if (!filePath.toLowerCase().includes(needle)) continue
    }
    const newestFirst = occurrences.slice().sort(compareOccurrences)
    files.push({
      filePath,
      editCount: occurrences.length,
      lastEditedAt: newestFirst[0]!.timestamp,
      lastSessionId: newestFirst[0]!.sessionId,
      edits: newestFirst.slice(0, options.perFile ?? 3),
    })
  }

  return files.sort((left, right) => {
    if (right.lastEditedAt !== left.lastEditedAt) return right.lastEditedAt - left.lastEditedAt
    if (right.lastSessionId !== left.lastSessionId) return right.lastSessionId.localeCompare(left.lastSessionId)
    const rightFirst = right.edits[0]!
    const leftFirst = left.edits[0]!
    if (rightFirst.messageOrdinal !== leftFirst.messageOrdinal) {
      return rightFirst.messageOrdinal - leftFirst.messageOrdinal
    }
    if (rightFirst.callIndex !== leftFirst.callIndex) return rightFirst.callIndex - leftFirst.callIndex
    return right.filePath.localeCompare(left.filePath)
  })
}

/** Order occurrences newest-first; ties by session id, ordinal, call index. */
function compareOccurrences(left: EditOccurrence, right: EditOccurrence): number {
  if (right.timestamp !== left.timestamp) return right.timestamp - left.timestamp
  if (right.sessionId !== left.sessionId) return right.sessionId.localeCompare(left.sessionId)
  if (right.messageOrdinal !== left.messageOrdinal) return right.messageOrdinal - left.messageOrdinal
  return right.callIndex - left.callIndex
}

/** One session's Edit/Write occurrences (skips inherited events). */
function sessionEditOccurrences(session: HealthSessionLike): EditOccurrence[] {
  const occurrences: EditOccurrence[] = []
  let lastMessageOrdinal = -1
  let ordinalCounter = 0
  for (const event of session.events) {
    if (event.seq < (session.inheritedEventCount ?? 0)) continue
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      lastMessageOrdinal = ordinalCounter
      ordinalCounter++
      continue
    }
    if (event.type !== 'tool/call') continue
    const data = event.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
    const payload = data as Record<string, unknown>
    const name = typeof payload.name === 'string' ? payload.name : ''
    if (name === '') continue
    const category = normalizeToolCategory(name)
    if (category !== 'Edit' && category !== 'Write') continue
    const inputJson = typeof payload.arguments === 'string' ? payload.arguments : ''
    const filePath = resolveFilePath(inputJson)
    if (filePath === '') continue
    const callIndex = occurrences.filter(o => o.messageOrdinal === Math.max(lastMessageOrdinal, 0)).length
    occurrences.push({
      sessionId: session.id,
      timestamp: event.time,
      messageOrdinal: Math.max(lastMessageOrdinal, 0),
      callIndex,
      toolName: name,
      category,
      filePath,
    })
  }
  return occurrences
}
