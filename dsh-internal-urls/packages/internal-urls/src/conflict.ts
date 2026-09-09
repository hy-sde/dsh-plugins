/**
 * Detecting, surfacing, and resolving git merge conflicts through FS-shaped
 * URLs — the `conflict://` protocol. The read tool registers the conflict
 * blocks it surfaces with a per-session history; the agent then resolves one
 * with `write({ path: "conflict://<N>", content })`, or bulk-resolves every
 * registered block with `write({ path: "conflict://*", content })`.
 *
 * Marker shape is strict: only column-0 markers of the exact prefix length
 * followed by either EOL or a single space + label count. Lines that merely
 * start with `<` or `=` never match.
 *
 * Ported from oh-my-pi (`packages/coding-agent/src/tools/conflict-detect.ts`),
 * MIT, adapted to the DeepSeek Harness file-services seam.
 * @module @hy-sde-org/dsh-internal-urls/conflict
 */

import type { InternalResource, ParsedInternalUrl, ProtocolHandler, ResolveContext, WriteContext } from './types.ts'

const OURS_PREFIX = '<<<<<<<'
const BASE_PREFIX = '|||||||'
const SEPARATOR = '======='
const THEIRS_PREFIX = '>>>>>>>'

/** One completed conflict block with its marker line numbers and side bodies. */
export interface ConflictBlock {
  /** 1-indexed line of the `<<<<<<<` marker. */
  startLine: number
  /** 1-indexed line of the `=======` separator. */
  separatorLine: number
  /** 1-indexed line of the `>>>>>>>` marker. */
  endLine: number
  /** 1-indexed line of the `|||||||` base marker (diff3 only). */
  baseLine?: number
  oursLabel?: string
  baseLabel?: string
  theirsLabel?: string
  oursLines: string[]
  baseLines?: string[]
  theirsLines: string[]
}

/**
 * Scan already-collected file lines for completed conflict blocks.
 * `firstLineNumber` is the 1-indexed line number of `lines[0]` (so a windowed
 * read starting at line 200 passes `firstLineNumber: 200`). Only fully-closed
 * blocks are returned.
 */
export function scanConflictLines(lines: readonly string[], firstLineNumber: number): ConflictBlock[] {
  const blocks: ConflictBlock[] = []
  let phase: 'idle' | 'ours' | 'base' | 'theirs' = 'idle'
  let partial: {
    startLine: number
    oursLabel?: string
    oursLines: string[]
    baseLine?: number
    baseLabel?: string
    baseLines?: string[]
    separatorLine?: number
    theirsLines?: string[]
  } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = stripTrailingCr(lines[i] ?? '')
    const ln = firstLineNumber + i

    const oursLabel = matchMarker(line, OURS_PREFIX)
    if (oursLabel !== null) {
      partial = { startLine: ln, ...oursLabel !== '' ? { oursLabel } : {}, oursLines: [] }
      phase = 'ours'
      continue
    }
    if (phase === 'idle' || partial === null) continue

    const baseLabel = matchMarker(line, BASE_PREFIX)
    if (baseLabel !== null) {
      if (phase !== 'ours') {
        partial = null
        phase = 'idle'
        continue
      }
      partial.baseLine = ln
      if (baseLabel !== '') partial.baseLabel = baseLabel
      partial.baseLines = []
      phase = 'base'
      continue
    }

    if (line === SEPARATOR) {
      if (phase === 'ours' || phase === 'base') {
        partial.separatorLine = ln
        partial.theirsLines = []
        phase = 'theirs'
      } else {
        partial = null
        phase = 'idle'
      }
      continue
    }

    const theirsLabel = matchMarker(line, THEIRS_PREFIX)
    if (theirsLabel !== null) {
      if (phase === 'theirs' && partial.separatorLine !== undefined && partial.theirsLines) {
        blocks.push({
          startLine: partial.startLine,
          separatorLine: partial.separatorLine,
          endLine: ln,
          ...partial.baseLine !== undefined ? { baseLine: partial.baseLine } : {},
          ...partial.oursLabel !== undefined ? { oursLabel: partial.oursLabel } : {},
          ...partial.baseLabel !== undefined ? { baseLabel: partial.baseLabel } : {},
          ...theirsLabel !== '' ? { theirsLabel } : {},
          oursLines: partial.oursLines,
          ...partial.baseLines !== undefined ? { baseLines: partial.baseLines } : {},
          theirsLines: partial.theirsLines,
        })
      }
      partial = null
      phase = 'idle'
      continue
    }

    if (phase === 'ours') partial.oursLines.push(line)
    else if (phase === 'base' && partial.baseLines) partial.baseLines.push(line)
    else if (phase === 'theirs' && partial.theirsLines) partial.theirsLines.push(line)
  }

  return blocks
}

/** Return the label after a marker prefix when the line is a valid column-0 marker, or `null` when it isn't. */
function matchMarker(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null
  if (line.length === prefix.length) return ''
  if (line.charCodeAt(prefix.length) !== 32 /* space */) return null
  return line.slice(prefix.length + 1)
}

/**
 * Scan whole-file content (already decoded text) for conflict blocks. Returns
 * only complete blocks; an unclosed opener at EOF yields none.
 */
export function scanConflictsInContent(content: string): ConflictBlock[] {
  return scanConflictLines(content.split('\n'), 1)
}

/** Recorded conflict block keyed by a session-stable id. */
export interface ConflictEntry extends ConflictBlock {
  id: number
  absolutePath: string
  displayPath: string
}

/**
 * Per-session log of conflict regions surfaced by `read`/`:conflicts`. The
 * history is append-only by content identity: re-reading a still-present block
 * reuses its id, so retries never depend on re-reading even after other blocks
 * in the file resolve.
 */
export class ConflictHistory {
  private nextId = 1
  readonly #entries = new Map<number, ConflictEntry>()

  register(input: Omit<ConflictEntry, 'id'>): ConflictEntry {
    for (const existing of this.#entries.values()) {
      if (existing.absolutePath === input.absolutePath && existing.startLine === input.startLine) {
        const merged: ConflictEntry = { ...input, id: existing.id }
        this.#entries.set(existing.id, merged)
        return merged
      }
    }
    const id = this.nextId++
    const entry: ConflictEntry = { ...input, id }
    this.#entries.set(id, entry)
    return entry
  }

  get(id: number): ConflictEntry | undefined {
    return this.#entries.get(id)
  }

  /** Every registered entry in id (insertion) order. */
  entries(): ConflictEntry[] {
    return [...this.#entries.values()]
  }

  /** Drop a single entry by id; used after a successful resolve. */
  invalidate(id: number): void {
    this.#entries.delete(id)
  }

  /** Drop every entry referencing `absolutePath`. */
  invalidatePath(absolutePath: string): void {
    for (const [id, entry] of this.#entries) {
      if (entry.absolutePath === absolutePath) this.#entries.delete(id)
    }
  }
}

/** A side of a conflict block addressable as `conflict://N/<scope>`. */
export type ConflictScope = 'ours' | 'theirs' | 'base'

const CONFLICT_SCOPES = new Set<ConflictScope>(['ours', 'theirs', 'base'])

/** Parsed `conflict://<N>` / `conflict://<N>/<scope>` / `conflict://*` URI. */
export interface ParsedConflictUri {
  /** `"*"` selects every currently-registered conflict (bulk write only). */
  id: number | '*'
  scope?: ConflictScope
}

// Accept an optional `<prefix>:` before the scheme so paths like
// `path/to/file.ts:conflict://3` still resolve; the last `:conflict://` wins.
const CONFLICT_URI_RE = /^(?:(.+):)?conflict:\/\/(.+)$/

/**
 * Parse a `conflict://<N>`, `conflict://<N>/<scope>`, or `conflict://*` URI.
 * Returns `null` for non-conflict paths; throws for a well-formed scheme with
 * an invalid id or scope so the agent gets a clear message.
 */
export function parseConflictUri(raw: string): ParsedConflictUri | null {
  const match = raw.match(CONFLICT_URI_RE)
  if (!match) return null
  const tail = match[2] ?? ''
  const slashIdx = tail.indexOf('/')
  const idPart = slashIdx === -1 ? tail : tail.slice(0, slashIdx)
  const scopePart = slashIdx === -1 ? undefined : tail.slice(slashIdx + 1)

  if (idPart === '*') {
    if (scopePart !== undefined) {
      throw new Error(`Invalid conflict URI '${raw}': wildcard 'conflict://*' does not accept a scope segment. Drop '/${scopePart}' or use a numeric id.`)
    }
    return { id: '*' }
  }
  if (!/^\d+$/.test(idPart)) {
    throw new Error(`Invalid conflict URI '${raw}': must be 'conflict://<N>', 'conflict://<N>/<scope>', or 'conflict://*' where N is a positive integer surfaced by a prior \`read\`.`)
  }
  const id = Number.parseInt(idPart, 10)
  if (!Number.isFinite(id) || id < 1) {
    throw new Error(`Invalid conflict URI '${raw}': id must be ≥ 1.`)
  }

  let scope: ConflictScope | undefined
  if (scopePart !== undefined) {
    if (!CONFLICT_SCOPES.has(scopePart as ConflictScope)) {
      throw new Error(`Invalid conflict URI '${raw}': scope must be one of 'ours', 'theirs', 'base', or omitted (e.g. 'conflict://${id}/theirs').`)
    }
    scope = scopePart as ConflictScope
  }
  return scope !== undefined ? { id, scope } : { id }
}

/** A side of a conflict block that read can render via `conflict://N/<scope>`. */
export function renderConflictRegion(entry: ConflictEntry, scope: ConflictScope | undefined): { lines: string[]; startLine: number } {
  if (scope === 'ours') {
    return { lines: [...entry.oursLines], startLine: entry.startLine + 1 }
  }
  if (scope === 'theirs') {
    return { lines: [...entry.theirsLines], startLine: entry.separatorLine + 1 }
  }
  if (scope === 'base') {
    if (entry.baseLines === undefined || entry.baseLine === undefined) {
      throw new Error(`Conflict #${entry.id} has no base section (2-way merge). 'conflict://${entry.id}/base' is only valid for diff3 conflicts.`)
    }
    return { lines: [...entry.baseLines], startLine: entry.baseLine + 1 }
  }
  const out: string[] = []
  out.push(`${OURS_PREFIX}${entry.oursLabel ? ` ${entry.oursLabel}` : ''}`)
  out.push(...entry.oursLines)
  if (entry.baseLines !== undefined) {
    out.push(`${BASE_PREFIX}${entry.baseLabel ? ` ${entry.baseLabel}` : ''}`)
    out.push(...entry.baseLines)
  }
  out.push(SEPARATOR)
  out.push(...entry.theirsLines)
  out.push(`${THEIRS_PREFIX}${entry.theirsLabel ? ` ${entry.theirsLabel}` : ''}`)
  return { lines: out, startLine: entry.startLine }
}

/**
 * Expand `@ours` / `@theirs` / `@base` / `@both` line tokens against the
 * recorded sections of `entry`. A token only triggers when it is the entire
 * content of a line; other lines pass through verbatim. `@base` throws when
 * the conflict was 2-way (no base recorded).
 */
export function expandContentTokens(content: string, entry: ConflictEntry): string {
  const out: string[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    switch (line) {
      case '@ours':
        out.push(...entry.oursLines)
        break
      case '@theirs':
        out.push(...entry.theirsLines)
        break
      case '@base':
        if (!entry.baseLines) {
          throw new Error(`Conflict #${entry.id} has no base section (2-way merge). \`@base\` is only valid for diff3 conflicts.`)
        }
        out.push(...entry.baseLines)
        break
      case '@both':
        out.push(...entry.oursLines, ...entry.theirsLines)
        break
      default:
        out.push(rawLine)
        break
    }
  }
  return out.join('\n')
}

/**
 * Splice the conflict region recorded in `entry` out of `originalText` and
 * replace it with `replacement`, markers and all sides included. Locates the
 * recorded marker block by content anchored to the recorded start line, so
 * out-of-band edits earlier in the file that shift line numbers don't break
 * resolution. Replacement lines that exactly echo the adjacent context are
 * dropped (the universal "whole function" paste artifact). Returns the new
 * text and how many echo lines were trimmed at each boundary.
 */
export function spliceConflict(
  originalText: string,
  entry: ConflictEntry,
  replacement: string,
): { text: string; trimmedLeading: number; trimmedTrailing: number } {
  const lines = originalText.split('\n')
  const expected = buildRecordedRegion(entry)
  const match = locateRegion(lines, expected, entry.startLine - 1)
  if (!match) {
    throw new Error(
      `Conflict #${entry.id} no longer present in '${entry.displayPath}': the recorded marker block can't be located. The file changed since the conflict was registered — re-read it to re-register conflicts.`,
    )
  }
  const trimmed = normalizeTrailingNewline(replacement)
  let replacementLines = trimmed.split('\n').map(stripTrailingCr)
  const echo = trimBoundaryEcho(replacementLines, lines, match, entry)
  replacementLines = echo.lines
  // CRLF round-trip: recorded sections are LF-normalized, re-apply \r when the
  // matched region used CRLF. The final replacement line only carries \r when
  // another line follows it.
  if (lines[match.startIdx]?.endsWith('\r') === true) {
    const hasFollowingLine = match.endIdx + 1 < lines.length
    replacementLines = replacementLines.map((l, i) => i < replacementLines.length - 1 || hasFollowingLine ? `${l}\r` : l)
  }
  const next = [...lines.slice(0, match.startIdx), ...replacementLines, ...lines.slice(match.endIdx + 1)]
  return { text: next.join('\n'), trimmedLeading: echo.leading, trimmedTrailing: echo.trailing }
}

const MAX_ECHO_LINES = 12

/** Reconstruct the recorded marker block as it should appear in the file. */
function buildRecordedRegion(entry: ConflictBlock): string[] {
  const out: string[] = []
  out.push(`${OURS_PREFIX}${entry.oursLabel ? ` ${entry.oursLabel}` : ''}`)
  out.push(...entry.oursLines)
  if (entry.baseLines !== undefined) {
    out.push(`${BASE_PREFIX}${entry.baseLabel ? ` ${entry.baseLabel}` : ''}`)
    out.push(...entry.baseLines)
  }
  out.push(SEPARATOR)
  out.push(...entry.theirsLines)
  out.push(`${THEIRS_PREFIX}${entry.theirsLabel ? ` ${entry.theirsLabel}` : ''}`)
  return out
}

function locateRegion(
  lines: readonly string[],
  expected: readonly string[],
  preferredIdx: number,
): { startIdx: number; endIdx: number } | null {
  if (expected.length === 0 || expected.length > lines.length) return null
  if (preferredIdx >= 0 && matchesAt(lines, preferredIdx, expected)) {
    return { startIdx: preferredIdx, endIdx: preferredIdx + expected.length - 1 }
  }
  let best: { startIdx: number; endIdx: number } | null = null
  let bestDist = Number.POSITIVE_INFINITY
  const limit = lines.length - expected.length
  for (let i = 0; i <= limit; i++) {
    if (!matchesAt(lines, i, expected)) continue
    const dist = Math.abs(i - preferredIdx)
    if (dist < bestDist) {
      best = { startIdx: i, endIdx: i + expected.length - 1 }
      bestDist = dist
    }
  }
  return best
}

function matchesAt(lines: readonly string[], startIdx: number, expected: readonly string[]): boolean {
  if (startIdx < 0 || startIdx + expected.length > lines.length) return false
  for (let i = 0; i < expected.length; i++) {
    if (stripTrailingCr(lines[startIdx + i] ?? '') !== expected[i]) return false
  }
  return true
}

/** Net `{}`/`()`/`[]` count over lines (string/comment-blind, corroboration only). */
function delimiterBalance(lines: readonly string[]): number {
  let balance = 0
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const ch = line.charCodeAt(i)
      if (ch === 123 || ch === 40 || ch === 91) balance++
      else if (ch === 125 || ch === 41 || ch === 93) balance--
    }
  }
  return balance
}

function trimBoundaryEcho(
  replacement: string[],
  fileLines: readonly string[],
  match: { startIdx: number; endIdx: number },
  entry: ConflictBlock,
): { lines: string[]; leading: number; trailing: number } {
  const oursBalance = delimiterBalance(entry.oursLines)
  const expectedBalance = oursBalance === delimiterBalance(entry.theirsLines) ? oursBalance : null
  const singleEchoJustified = (lines: string[], without: string[]) =>
    expectedBalance !== null
    && delimiterBalance(lines) !== expectedBalance
    && delimiterBalance(without) === expectedBalance

  let lines = replacement
  let trailing = 0
  const after: string[] = []
  for (let i = match.endIdx + 1; i < fileLines.length && after.length < MAX_ECHO_LINES; i++) {
    after.push(stripTrailingCr(fileLines[i] ?? ''))
  }
  for (let k = Math.min(after.length, lines.length - 1); k >= 1; k--) {
    if (!after.slice(0, k).every((line, i) => lines[lines.length - k + i] === line)) continue
    if (k >= 2 || singleEchoJustified(lines, lines.slice(0, -1))) {
      trailing = k
      lines = lines.slice(0, lines.length - k)
    }
    break
  }

  let leading = 0
  const before: string[] = []
  for (let i = match.startIdx - 1; i >= 0 && before.length < MAX_ECHO_LINES; i--) {
    before.unshift(stripTrailingCr(fileLines[i] ?? ''))
  }
  for (let k = Math.min(before.length, lines.length - 1); k >= 1; k--) {
    if (!before.slice(before.length - k).every((line, i) => lines[i] === line)) continue
    if (k >= 2 || singleEchoJustified(lines, lines.slice(1))) {
      leading = k
      lines = lines.slice(k)
    }
    break
  }
  return { lines, leading, trailing }
}

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function normalizeTrailingNewline(replacement: string): string {
  if (replacement.endsWith('\r\n')) return replacement.slice(0, -2)
  if (replacement.endsWith('\n')) return replacement.slice(0, -1)
  return replacement
}

function pickLabel(entries: readonly ConflictEntry[], get: (e: ConflictEntry) => string | undefined): string | undefined {
  for (const e of entries) {
    const label = get(e)
    if (label && label.trim().length > 0) return label
  }
  return undefined
}

function sectionsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const PREVIEW_SIDE_LINES = 6

function appendBody(out: string[], section: readonly string[]): void {
  if (section.length === 0) {
    out.push('(empty)')
    return
  }
  const shown = section.slice(0, PREVIEW_SIDE_LINES)
  for (const line of shown) out.push(line)
  const hidden = section.length - shown.length
  if (hidden > 0) out.push(`… (${hidden} more line${hidden === 1 ? '' : 's'})`)
}

/**
 * Build a compact diff-style footer describing the conflicts registered during
 * a read. Appended to the read output so the agent learns the `conflict://<N>`
 * ids and the resolution protocol.
 */
export function formatConflictWarning(entries: readonly ConflictEntry[]): string {
  if (entries.length === 0) return ''
  const total = entries.length
  const out: string[] = ['', `⚠ ${total} unresolved ${total === 1 ? 'conflict' : 'conflicts'} detected`]

  const oursLabel = pickLabel(entries, e => e.oursLabel)
  const theirsLabel = pickLabel(entries, e => e.theirsLabel)
  const baseLabel = pickLabel(entries, e => (e.baseLines !== undefined ? e.baseLabel : undefined))
  const anyBase = entries.some(e => e.baseLines !== undefined)
  if (oursLabel) out.push(`- ours = ${oursLabel}`)
  if (theirsLabel) out.push(`- theirs = ${theirsLabel}`)
  if (anyBase) out.push(`- base = ${baseLabel ?? '(no label)'}`)
  out.push(
    'NOTICE: Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` to render a single side), or list every registered block with `conflict://*`. Resolve with `write({ path: "conflict://<N>", content })`; writes replace ONLY the marker block (markers + all sides) — never repeat the lines before/after it.',
  )
  out.push(
    '`content` shorthand: a line that is exactly `@ours` / `@theirs` / `@base` / `@both` expands to that recorded section. `@both` is ours-then-theirs — only for additive conflicts where each side adds something different; NEVER for competing edits of the same lines. Per-id bulk: `write({ path: "conflict://*", content: "1: @ours\\n2: @theirs\\n…" })` resolves each listed id with that side in one call; unlisted ids stay registered.',
  )
  out.push(
    'Resolve each block faithfully: keep one side (`@ours`/`@theirs`) or combine them when both intents apply — never invent content beyond the recorded sides. Resolve several conflicts in one turn by issuing multiple `write` calls at once; ids stay valid as earlier blocks are resolved.',
  )

  for (const entry of entries) {
    const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`
    out.push('', `──── #${entry.id}  ${range} ────`)
    const baseEqualsOurs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.oursLines)
    const baseEqualsTheirs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.theirsLines)
    const theirsEqualsOurs = sectionsEqual(entry.theirsLines, entry.oursLines)

    out.push('<<< ours')
    appendBody(out, entry.oursLines)
    if (entry.baseLines !== undefined) {
      if (baseEqualsOurs) out.push('=== base ≡ ours')
      else if (baseEqualsTheirs) out.push('=== base ≡ theirs')
      else {
        out.push('=== base')
        appendBody(out, entry.baseLines)
      }
    }
    if (theirsEqualsOurs) out.push('>>> theirs ≡ ours')
    else {
      out.push('>>> theirs')
      appendBody(out, entry.theirsLines)
    }
  }
  return out.join('\n')
}

/**
 * Render a one-line-per-block index of every registered conflict. Used by the
 * `<path>:conflicts` read selector to give the agent a cheap overview of a
 * heavily-conflicted file without dumping every body.
 */
export function formatConflictSummary(entries: readonly ConflictEntry[], displayPath: string): string {
  const lines: string[] = []
  const total = entries.length
  lines.push(`⚠ ${total} unresolved ${total === 1 ? 'conflict' : 'conflicts'} in ${displayPath || '<file>'}`)
  const oursLabel = pickLabel(entries, e => e.oursLabel)
  const theirsLabel = pickLabel(entries, e => e.theirsLabel)
  const baseLabel = pickLabel(entries, e => (e.baseLines !== undefined ? e.baseLabel : undefined))
  const anyBase = entries.some(e => e.baseLines !== undefined)
  if (oursLabel) lines.push(`- ours = ${oursLabel}`)
  if (theirsLabel) lines.push(`- theirs = ${theirsLabel}`)
  if (anyBase) lines.push(`- base = ${baseLabel ?? '(no label)'}`)
  lines.push(
    'NOTICE: Bulk-resolve with `write({ path: "conflict://*", content })`, or address a single block with `write({ path: "conflict://<N>", content })`. Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` for a single side).',
  )
  lines.push(
    '`content` shorthand: `@ours` / `@theirs` / `@base` / `@both` lines expand to the recorded sections; `@both` = ours-then-theirs (additive conflicts only). Per-id bulk: `"1: @ours\\n2: @theirs"` resolves each listed id in one call. Writes replace ONLY the marker block — never repeat the surrounding lines.',
  )
  lines.push('')
  const idWidth = String(entries[entries.length - 1]?.id ?? 1).length
  for (const entry of entries) {
    const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`
    const kind = entry.baseLines !== undefined ? '  (3-way)' : ''
    lines.push(`#${String(entry.id).padStart(idWidth, ' ')}  ${range}${kind}`)
  }
  return lines.join('\n')
}

/**
 * File access the conflict handler performs resolution through — provided by
 * the service plugin against `ctx.fs` so splice/rewrite keep every seam
 * guarantee (target identity, atomic publish, sandbox policy).
 */
export interface ConflictFileBridge {
  /** Read the whole current file text at `absolutePath`. */
  readFile(absolutePath: string, signal?: AbortSignal): Promise<string>
  /** Replace `absolutePath` with `content` (unconditional atomic write). */
  writeFile(absolutePath: string, content: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<void>
}

/** Context in which the handler mutates files; carries the session key. */
interface HandlerWriteContext {
  sessionKey?: string
  signal?: AbortSignal
  sandboxPolicy?: unknown
}

/**
 * The `conflict://` protocol handler.
 *
 * Reads:
 * - `conflict://<N>` — full recorded marker block, lines prefixed by file line numbers.
 * - `conflict://<N>/ours|theirs|base` — one side only.
 * - `conflict://*` — summary of every currently-registered block.
 *
 * Writes:
 * - `conflict://<N>` — splice the recorded region, replace with `content`
 *   (`@ours`/`@theirs`/`@base`/`@both` line tokens expand).
 * - `conflict://*` — bulk: either one `content` for every registered block,
 *   or per-id lines `"N: @side"` resolving each listed id.
 */
export class ConflictProtocolHandler implements ProtocolHandler {
  readonly scheme = 'conflict'
  readonly immutable = false

  constructor(private readonly deps: {
    historyFor: (sessionKey: string | undefined) => ConflictHistory
    bridge: ConflictFileBridge
  }) {}

  resolve(url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource> {
    const raw = url.rawHref
    const parsed = parseConflictUri(raw)
    if (parsed === null) {
      throw new Error(`Invalid conflict URL: '${raw}' — expected conflict://<N>, conflict://<N>/<scope>, or conflict://*`)
    }
    const history = this.deps.historyFor(context?.sessionKey)
    if (parsed.id === '*') {
      const entries = history.entries()
      const content = entries.length === 0
        ? 'No conflicts registered in this session yet. Read the conflicted file first to register its conflicts.'
        : formatConflictSummary(entries, 'all files')
      return Promise.resolve({
        url: url.href,
        content,
        contentType: 'text/plain',
        size: Buffer.byteLength(content, 'utf-8'),
        notes: entries.length === 0 ? [] : [`${entries.length} registered conflict${entries.length === 1 ? '' : 's'}`],
      })
    }
    const entry = history.get(parsed.id)
    if (entry === undefined) {
      const available = history.entries()
      const hint = available.length > 0
        ? ` Registered ids: ${available.map(e => e.id).join(', ')}.`
        : ' No conflicts are registered in this session yet — read the conflicted file first.'
      throw new Error(`Conflict #${parsed.id} is not registered in this session.${hint}`)
    }
    const { lines } = renderConflictRegion(entry, parsed.scope)
    const content = lines.join('\n')
    const scopeNote = parsed.scope !== undefined
      ? `Showing ${parsed.scope} side of conflict #${parsed.id} in ${entry.displayPath}`
      : `Conflict #${parsed.id} in ${entry.displayPath} (file lines ${entry.startLine}-${entry.endLine})`
    return Promise.resolve({
      url: url.href,
      content,
      contentType: 'text/plain',
      size: Buffer.byteLength(content, 'utf-8'),
      notes: [scopeNote, 'Resolve with `write({ path: "conflict://' + String(parsed.id) + '", content })`. Writes replace ONLY the marker block.'],
    })
  }

  async write(url: ParsedInternalUrl, content: string, context?: WriteContext): Promise<void> {
    const parsed = parseConflictUri(url.rawHref)
    if (parsed === null) {
      throw new Error(`Invalid conflict URL: '${url.rawHref}' — expected conflict://<N> or conflict://*`)
    }
    if (parsed.scope !== undefined) {
      throw new Error(`Invalid conflict URL: '${url.rawHref}' — a scope segment is read-only. Write to conflict://${parsed.id} to resolve the whole block.`)
    }
    const cw: HandlerWriteContext = {
      ...context?.sessionKey !== undefined ? { sessionKey: context.sessionKey } : {},
      ...context?.signal !== undefined ? { signal: context.signal } : {},
      ...context?.sandboxPolicy !== undefined ? { sandboxPolicy: context.sandboxPolicy } : {},
    }
    const history = this.deps.historyFor(cw.sessionKey)

    if (parsed.id === '*') {
      await this.writeBulk(history, content, cw)
      return
    }
    const entry = history.get(parsed.id)
    if (entry === undefined) {
      const available = history.entries()
      const hint = available.length > 0
        ? ` Registered ids: ${available.map(e => e.id).join(', ')}.`
        : ' No conflicts are registered in this session yet — read the conflicted file first.'
      throw new Error(`Conflict #${parsed.id} is not registered in this session.${hint}`)
    }
    await this.resolveEntry(entry, expandContentTokens(content, entry), cw)
  }

  /** Apply the same (token-expanded) content to every registered block. */
  private async writeBulk(history: ConflictHistory, content: string, cw: HandlerWriteContext): Promise<void> {
    const entries = history.entries()
    if (entries.length === 0) {
      throw new Error('conflict://* has nothing to resolve: no conflicts are registered in this session yet. Read the conflicted file first.')
    }
    // Per-id content lines ("N: @side") override the shared body for listed ids.
    const perId = new Map<number, string>()
    const sharedLines: string[] = []
    for (const raw of content.split('\n')) {
      const match = /^(\d+):\s*(.*)$/.exec(raw)
      if (match === null) {
        sharedLines.push(raw)
        continue
      }
      const id = Number.parseInt(match[1] ?? '', 10)
      // Only resolve ids that are actually registered — an unknown id in the
      // per-id content must not be silently ignored.
      if (history.get(id) !== undefined) perId.set(id, match[2] ?? '')
    }
    const shared = sharedLines.join('\n')
    for (const entry of entries) {
      if (perId.has(entry.id)) {
        await this.resolveEntry(entry, expandContentTokens(perId.get(entry.id) ?? '', entry), cw)
      } else if (shared !== '') {
        await this.resolveEntry(entry, expandContentTokens(shared, entry), cw)
      }
    }
  }

  private async resolveEntry(entry: ConflictEntry, replacementBody: string, cw: HandlerWriteContext): Promise<void> {
    const signal = cw.signal
    const original = await this.deps.bridge.readFile(entry.absolutePath, signal)
    const splat = spliceConflict(original, entry, replacementBody)
    await this.deps.bridge.writeFile(entry.absolutePath, splat.text, signal, cw.sandboxPolicy)
    this.deps.historyFor(cw.sessionKey).invalidate(entry.id)
  }
}
