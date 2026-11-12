/**
 * Stateful, line-oriented classifier for hashline diff text.
 *
 * Format shape:
 * ```
 * [path/to/file.ts#1A2B]
 * replace 5.=7:
 * +literal new line
 * ```
 * Ported from @oh-my-pi/hashline (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import {
  describeAnchorExamples,
  HL_CUT_KEYWORD,
  HL_FILE_HASH_LENGTH,
  HL_FILE_HASH_SEP,
  HL_FILE_PREFIX,
  HL_FILE_SUFFIX,
  HL_HEADER_COLON,
  HL_MOVE_KEYWORD,
  HL_PAYLOAD_REPLACE,
  HL_PUT_KEYWORD,
  HL_REM_KEYWORD,
} from './format.ts'
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from './messages.ts'
import type { Anchor, Cursor, ParsedRange } from './types.ts'

const CHAR_LINE_FEED = 10
const CHAR_CARRIAGE_RETURN = 13
const CHAR_ZERO = 48
const CHAR_NINE = 57
const CHAR_HASH = 35
const CHAR_TAB = 9
const CHAR_SPACE = 32
const CHAR_HYPHEN = 45
const CHAR_DOT = 46
const CHAR_EQUALS = 61
const CHAR_ELLIPSIS = 0x2026
const CHAR_LESS_THAN = 60
const CHAR_GREATER_THAN = 62
const CHAR_STAR = 42
const CHAR_DOLLAR = 36
const CHAR_AT = 64
const CHAR_UNDERSCORE = 95
const CHAR_LEFT_BRACKET = 91
const CHAR_RIGHT_BRACKET = 93

const CHAR_UPPER_A = 65
const CHAR_UPPER_F = 70
const CHAR_LOWER_A = 97
const CHAR_LOWER_F = 102
const CHAR_PAYLOAD_REPLACE = HL_PAYLOAD_REPLACE.charCodeAt(0)
const CHAR_COLON = HL_HEADER_COLON.charCodeAt(0)
const FILE_PREFIX_LENGTH = HL_FILE_PREFIX.length
const FILE_SUFFIX_LENGTH = HL_FILE_SUFFIX.length

function isDigitCode(code: number): boolean {
  return code >= CHAR_ZERO && code <= CHAR_NINE
}

function isNonZeroDigitCode(code: number): boolean {
  return code > CHAR_ZERO && code <= CHAR_NINE
}

function isHexDigitCode(code: number): boolean {
  return (
    isDigitCode(code) ||
		(code >= CHAR_UPPER_A && code <= CHAR_UPPER_F) ||
		(code >= CHAR_LOWER_A && code <= CHAR_LOWER_F)
  )
}

function isWhitespaceCode(code: number): boolean {
  return code === CHAR_SPACE || (code >= CHAR_TAB && code <= CHAR_CARRIAGE_RETURN)
}

function skipWhitespace(line: string, index: number, end = line.length): number {
  while (index < end && isWhitespaceCode(line.charCodeAt(index))) index++
  return index
}

function trimEndIndex(line: string): number {
  let end = line.length
  while (end > 0 && isWhitespaceCode(line.charCodeAt(end - 1))) end--
  return end
}

function isEmptyLine(line: string): boolean {
  return line.length === 0
}

function markerLineEquals(line: string, marker: string): boolean {
  const end = trimEndIndex(line)
  return end === marker.length && line.startsWith(marker)
}

export function splitHashlineLines(text: string): string[] {
  if (text.length === 0) return ['']
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== CHAR_LINE_FEED) continue
    let end = index
    if (end > start && text.charCodeAt(end - 1) === CHAR_CARRIAGE_RETURN) end--
    lines.push(text.slice(start, end))
    start = index + 1
  }
  if (start < text.length) {
    let end = text.length
    if (end > start && text.charCodeAt(end - 1) === CHAR_CARRIAGE_RETURN) end--
    lines.push(text.slice(start, end))
  }
  return lines
}

export function cloneCursor(cursor: Cursor): Cursor {
  if (cursor.kind === 'before_anchor') return { kind: 'before_anchor', anchor: { ...cursor.anchor } }
  if (cursor.kind === 'after_anchor') return { kind: 'after_anchor', anchor: { ...cursor.anchor } }
  return cursor
}

interface NumberScan {
  line: number
  nextIndex: number
}

function scanLineNumber(line: string, index: number, end: number): NumberScan | null {
  if (index >= end || !isNonZeroDigitCode(line.charCodeAt(index))) return null
  let lineNumber = 0
  let nextIndex = index
  while (nextIndex < end) {
    const code = line.charCodeAt(nextIndex)
    if (!isDigitCode(code)) break
    lineNumber = lineNumber * 10 + (code - CHAR_ZERO)
    if (!Number.isSafeInteger(lineNumber)) return null
    nextIndex++
  }
  return { line: lineNumber, nextIndex }
}

/** Parse a bare line-number anchor. Throws on malformed input. */
export function parseLid(raw: string, lineNum: number): Anchor {
  const end = trimEndIndex(raw)
  const numberStart = skipWhitespace(raw, 0, end)
  const number = scanLineNumber(raw, numberStart, end)
  if (number === null || skipWhitespace(raw, number.nextIndex, end) !== end) {
    throw new Error(
      `line ${lineNum}: expected a line number such as ${describeAnchorExamples('119')}; ` +
				`got ${JSON.stringify(raw)}. Use ${HL_FILE_PREFIX}PATH${HL_FILE_HASH_SEP}hash${HL_FILE_SUFFIX} from your latest read for file-version binding.`,
    )
  }
  return { line: number.line }
}

interface RangeScan {
  range: ParsedRange
  nextIndex: number
  hadSeparator: boolean
}

/**
 * Range separator scanner. Canonical input is `.=`, while parsing remains
 * deliberately lenient for model output: `-`, `=`, `.`, `..`, `…`, mixed
 * runs, and whitespace-only separators all recover to the same range.
 */
function scanRangeSeparator(line: string, index: number, end: number): number | null {
  let cursor = index
  let consumedSeparator = false
  while (cursor < end) {
    const code = line.charCodeAt(cursor)
    if (
      isWhitespaceCode(code) ||
			code === CHAR_HYPHEN ||
			code === CHAR_DOT ||
			code === CHAR_EQUALS ||
			code === CHAR_ELLIPSIS
    ) {
      cursor++
      consumedSeparator = true
      continue
    }
    break
  }
  if (!consumedSeparator || cursor >= end || !isNonZeroDigitCode(line.charCodeAt(cursor))) return null
  return cursor
}

/**
 * Recover a dangling range separator: the run after `N` contains at least one
 * non-whitespace separator char but no end number (`244.=:`, `5-`, `12.. @reg`).
 * Models write this intending an open range; it collapses to `N.=N`. Returns
 * the index past the run only when what follows is `:`, `@`, or end-of-header —
 * anything else keeps the header on the strict rejection path.
 */
function scanDanglingSeparator(line: string, index: number, end: number): number | null {
  let cursor = index
  let sawSeparatorChar = false
  while (cursor < end) {
    const code = line.charCodeAt(cursor)
    if (code === CHAR_HYPHEN || code === CHAR_DOT || code === CHAR_EQUALS || code === CHAR_ELLIPSIS) {
      sawSeparatorChar = true
      cursor++
      continue
    }
    if (isWhitespaceCode(code)) {
      cursor++
      continue
    }
    break
  }
  if (!sawSeparatorChar) return null
  if (cursor < end) {
    const code = line.charCodeAt(cursor)
    if (code !== CHAR_COLON && code !== CHAR_AT) return null
  }
  return cursor
}

function scanHeaderRange(line: string, index = 0, end = trimEndIndex(line), allowSingle = false): RangeScan | null {
  const numberStart = skipWhitespace(line, index, end)
  const start = scanLineNumber(line, numberStart, end)
  if (start === null) return null
  const afterFirst = scanRangeSeparator(line, start.nextIndex, end)
  if (afterFirst === null) {
    if (!allowSingle) return null
    const dangling = scanDanglingSeparator(line, start.nextIndex, end)
    if (dangling !== null) {
      return {
        range: { start: { line: start.line }, end: { line: start.line } },
        nextIndex: dangling,
        hadSeparator: true,
      }
    }
    return {
      range: { start: { line: start.line }, end: { line: start.line } },
      nextIndex: skipWhitespace(line, start.nextIndex, end),
      hadSeparator: false,
    }
  }
  const endNumber = scanLineNumber(line, afterFirst, end)
  if (endNumber === null) return null
  return {
    range: { start: { line: start.line }, end: { line: endNumber.line } },
    nextIndex: skipWhitespace(line, endNumber.nextIndex, end),
    hadSeparator: true,
  }
}

export type BlockTarget =
	| { kind: 'replace'; range: ParsedRange; register?: string }
	| { kind: 'block'; anchor: Anchor; register?: string }
	| { kind: 'insert_before'; anchor: Anchor; register?: string }
	| { kind: 'insert_after'; anchor: Anchor; register?: string }
	| { kind: 'insert_after_block'; anchor: Anchor; register?: string }
	| { kind: 'cut'; range: ParsedRange; register?: string }
	| { kind: 'cut_block'; anchor: Anchor; register?: string }
	| { kind: 'bof'; register?: string }
	| { kind: 'eof'; register?: string }
	| { kind: 'rem' }
	| { kind: 'move'; dest: string }

/** Targets that may carry a `@register` suffix (everything but the file-level ops). */
type RegisterableTarget = Exclude<BlockTarget, { kind: 'rem' } | { kind: 'move' }>

interface TargetScan {
  target: BlockTarget
  nextIndex: number
  /**
	 * Whether the header carried a trailing `:`. The parser uses it to tell a
	 * literal insertion awaiting body rows (`PUT >40:`) from a bodyless
	 * anonymous paste (`PUT >40`).
	 */
  hadColon: boolean
}

function scanKeyword(line: string, index: number, end: number, keyword: string): number | null {
  if (!line.startsWith(keyword, index)) return null
  const next = index + keyword.length
  if (next < end) {
    const code = line.charCodeAt(next)
    if (!isWhitespaceCode(code) && code !== CHAR_COLON) return null
  }
  return next
}

interface ColonScan {
  nextIndex: number
  hadColon: boolean
}

function consumeOptionalColon(line: string, index: number, end: number): ColonScan {
  const cursor = skipWhitespace(line, index, end)
  if (cursor < end && line.charCodeAt(cursor) === CHAR_COLON) {
    return { nextIndex: skipWhitespace(line, cursor + 1, end), hadColon: true }
  }
  return { nextIndex: cursor, hadColon: false }
}

/** Maximum accepted register-name length; anything longer fails the header parse. */
const REGISTER_NAME_MAX = 64

function isRegisterNameCode(code: number): boolean {
  return (
    isDigitCode(code) ||
		(code >= CHAR_UPPER_A && code <= 90) ||
		(code >= CHAR_LOWER_A && code <= 122) ||
		code === CHAR_UNDERSCORE ||
		code === CHAR_HYPHEN
  )
}

/** Scan a `@name` register reference. */
function scanRegister(line: string, index: number, end: number): { name: string; nextIndex: number } | null {
  if (index >= end || line.charCodeAt(index) !== CHAR_AT) return null
  const start = index + 1
  let cursor = start
  while (cursor < end && isRegisterNameCode(line.charCodeAt(cursor))) cursor++
  if (cursor === start || cursor - start > REGISTER_NAME_MAX) return null
  return { name: line.slice(start, cursor), nextIndex: cursor }
}

/**
 * Finish a `PUT`/`CUT` header: optional `@register`, optional trailing `:`.
 * The parser decides whether a body is required; the tokenizer only records
 * the shape.
 */
function finishTargetScan(line: string, index: number, end: number, target: RegisterableTarget): TargetScan {
  let cursor = skipWhitespace(line, index, end)
  const register = scanRegister(line, cursor, end)
  if (register !== null) {
    target = { ...target, register: register.name }
    cursor = register.nextIndex
  }
  const colon = consumeOptionalColon(line, cursor, end)
  return { target, nextIndex: colon.nextIndex, hadColon: colon.hadColon }
}

/**
 * Scan the locator of a `PUT` header:
 *   span — `5` / `5-9` (replace lines), `5*` (replace the block opening at 5)
 *   gap  — `<5` / `>5` (insert), `>5*` (after the block's end), `<1` (head), `>$` (tail)
 */
function scanPutTarget(line: string, index: number, end: number): TargetScan | null {
  const cursor = skipWhitespace(line, index, end)
  if (cursor >= end) return null
  const sigil = line.charCodeAt(cursor)
  if (sigil === CHAR_LESS_THAN || sigil === CHAR_GREATER_THAN) {
    const isAfter = sigil === CHAR_GREATER_THAN
    const probe = skipWhitespace(line, cursor + 1, end)
    if (isAfter && probe < end && line.charCodeAt(probe) === CHAR_DOLLAR) {
      return finishTargetScan(line, probe + 1, end, { kind: 'eof' })
    }
    const anchor = scanLineNumber(line, probe, end)
    if (anchor === null) return null
    let next = anchor.nextIndex
    let block = false
    if (next < end && line.charCodeAt(next) === CHAR_STAR) {
      block = true
      next++
    }
    if (isAfter) {
      return finishTargetScan(
        line,
        next,
        end,
        block
          ? { kind: 'insert_after_block', anchor: { line: anchor.line } }
          : { kind: 'insert_after', anchor: { line: anchor.line } },
      )
    }
    // `<N*` is the same gap as `<N`: a block anchored at N begins on line N,
    // so "before the block" is "before line N". The star is dropped.
    // `<1` is head — mapped to `bof` so it stays position-stable (never
    // anchor-scoped) and works when creating empty files.
    return finishTargetScan(
      line,
      next,
      end,
      anchor.line === 1 ? { kind: 'bof' } : { kind: 'insert_before', anchor: { line: anchor.line } },
    )
  }
  const range = scanHeaderRange(line, cursor, end, true)
  if (range === null) return null
  const next = range.nextIndex
  if (next < end && line.charCodeAt(next) === CHAR_STAR) {
    // Block locators are single opening lines (`N*`), never ranges.
    if (range.hadSeparator) return null
    return finishTargetScan(line, next + 1, end, { kind: 'block', anchor: { line: range.range.start.line } })
  }
  return finishTargetScan(line, next, end, { kind: 'replace', range: range.range })
}

/** Scan the locator of a `CUT` header: `N.=M` or `N*` (block). */
function scanCutTarget(line: string, index: number, end: number): TargetScan | null {
  const range = scanHeaderRange(line, index, end, true)
  if (range === null) return null
  const next = range.nextIndex
  if (next < end && line.charCodeAt(next) === CHAR_STAR) {
    if (range.hadSeparator) return null
    return finishTargetScan(line, next + 1, end, { kind: 'cut_block', anchor: { line: range.range.start.line } })
  }
  return finishTargetScan(line, next, end, { kind: 'cut', range: range.range })
}

/* jscpd:ignore-start -- hashline tokenizer and input parsing keep independent unquote helpers for the same hashline path syntax. */
function unquotePath(pathText: string): string {
  if (pathText.length < 2) return pathText
  const first = pathText[0]
  const last = pathText[pathText.length - 1]
  if ((first === '"' || first === "'") && first === last) return pathText.slice(1, -1)
  return pathText
}
/* jscpd:ignore-end */

function scanMoveDest(line: string, index: number, end: number): string | null {
  const cursor = skipWhitespace(line, index, end)
  if (cursor >= end) return null
  const first = line.charCodeAt(cursor)
  if (first === 34 /* " */ || first === 39 /* ' */) {
    const quote = line[cursor]
    let next = cursor + 1
    while (next < end) {
      const ch = line[next]
      if (ch === '\\' && next + 1 < end) {
        next += 2
        continue
      }
      if (ch === quote) {
        const after = skipWhitespace(line, next + 1, end)
        return after === end ? unquotePath(line.slice(cursor, next + 1)) : null
      }
      next++
    }
    return null
  }
  return unquotePath(line.slice(cursor, end).trim())
}

function scanHunkAnchor(line: string, start: number, end: number): TargetScan | null {
  const cursor = skipWhitespace(line, start, end)

  const remEnd = scanKeyword(line, cursor, end, HL_REM_KEYWORD)
  if (remEnd !== null) {
    const next = skipWhitespace(line, remEnd, end)
    if (next !== end) return null
    return { target: { kind: 'rem' }, nextIndex: next, hadColon: false }
  }
  const moveEnd = scanKeyword(line, cursor, end, HL_MOVE_KEYWORD)
  if (moveEnd !== null) {
    const dest = scanMoveDest(line, moveEnd, end)
    if (dest === null || dest.length === 0) return null
    return { target: { kind: 'move', dest }, nextIndex: end, hadColon: false }
  }
  const putEnd = scanKeyword(line, cursor, end, HL_PUT_KEYWORD)
  if (putEnd !== null) return scanPutTarget(line, putEnd, end)
  const cutEnd = scanKeyword(line, cursor, end, HL_CUT_KEYWORD)
  if (cutEnd !== null) return scanCutTarget(line, cutEnd, end)
  return null
}

interface ParsedHunkHeader {
  target: BlockTarget
  hadColon: boolean
}

function tryParseHunkHeader(line: string): ParsedHunkHeader | null {
  const end = trimEndIndex(line)
  const start = skipWhitespace(line, 0, end)
  if (start >= end) return null
  const scan = scanHunkAnchor(line, start, end)
  if (scan === null) return null
  if (scan.nextIndex !== end) return null
  return { target: scan.target, hadColon: scan.hadColon }
}
/**
 * Whether `text` would parse as a hunk header on its own (`PUT …`, `CUT …`,
 * `REM`, `MV …`). Used to catch an op row mistakenly written as a `+` body row,
 * which the applier would otherwise insert into the file as literal text.
 */
export function isHunkHeaderText(text: string): boolean {
  const end = trimEndIndex(text)
  const lead = skipWhitespace(text, 0, end)
  const isHunkLead =
    text.startsWith(HL_PUT_KEYWORD, lead) ||
		text.startsWith(HL_CUT_KEYWORD, lead) ||
		text.startsWith(HL_REM_KEYWORD, lead) ||
		text.startsWith(HL_MOVE_KEYWORD, lead)
  return isHunkLead && tryParseHunkHeader(text) !== null
}

/**
 * Parse a fused one-line `PUT <locator>: <inline>` hunk — a header and its
 * first body row written on the same line. The colon-terminated header grammar
 * itself reads trailing text as a syntax error, and session logs show models
 * fusing them constantly (`PUT 54: -`, `PUT <111:  deltaFiles: string[]`),
 * so the parser recovers them as header + first payload row.
 *
 * Returns null unless a colon is present AND non-empty inline content follows
 * it, so plain headers keep their existing single meaning. Inline content is
 * taken from the raw colon position: a single leading space is the `: `
 * separator and is stripped; a deeper leading run is authored indentation and
 * stays verbatim.
 */
export function tryParseInlinePutHeader(line: string): { target: BlockTarget; inline: string } | null {
  const end = trimEndIndex(line)
  const start = skipWhitespace(line, 0, end)
  if (start >= end) return null
  const putEnd = scanKeyword(line, start, end, HL_PUT_KEYWORD)
  if (putEnd === null) return null
  const scan = scanPutTarget(line, putEnd, end)
  if (scan === null || !scan.hadColon || scan.nextIndex >= end) return null
  if ('register' in scan.target && scan.target.register !== undefined) return null
  // Re-locate the header colon on the raw line: consumeOptionalColon skips the
  // whitespace after `:`, which would shear the inline row's indentation.
  const colonAt = line.indexOf(HL_HEADER_COLON, putEnd)
  if (colonAt < 0 || colonAt >= scan.nextIndex) return null
  const raw = line.slice(colonAt + HL_HEADER_COLON.length, end)
  const inline = raw.startsWith(' ') && !raw.startsWith('  ') ? raw.slice(1) : raw
  // `PUT 17:=17` (a count-style typo for the `17.=17` range): the would-be
  // inline content is a range fragment, not text — leave it for the generic
  // op-shape diagnostic instead of writing `=17` into the file. Whitespace
  // between `=` and the digit still counts (`PUT 17:= 17`), because the
  // range separator scanner is whitespace-lenient and models emit both.
  if (/^\s*=\s*\d/.test(inline)) return null
  return { target: scan.target, inline }
}

/**
 * Whether the line is a `CUT <locator>: <inline>` fusion. CUT takes no body,
 * so there is nothing sensible to recover — the parser rejects these with a
 * targeted message instead of the generic payload error.
 */
export function isInlineCutWithBody(line: string): boolean {
  const end = trimEndIndex(line)
  const start = skipWhitespace(line, 0, end)
  if (start >= end) return false
  const cutEnd = scanKeyword(line, start, end, HL_CUT_KEYWORD)
  if (cutEnd === null) return false
  const scan = scanCutTarget(line, cutEnd, end)
  return scan !== null && scan.hadColon && scan.nextIndex < end
}

/**
 * Inner text of a bracketed op row (`[CUT 20]`, `[PUT >19:]`): the text
 * between the outermost brackets when it leads with a hunk keyword. Null for
 * everything else — including ordinary bracketed text like Markdown links —
 * so only op-shaped `[…]` lines opt into hunk parsing. The keyword must be
 * op-shaped (followed by whitespace, a colon, or the end of the inner text),
 * so keyword-PREFIXED section headers (`[PUT.txt#1A2B]`, `[REMOTE.md#AB12]`,
 * `[MVVM.vue#AB12]`) stay section headers.
 */
export function bracketedOpInnerText(line: string): string | null {
  const end = trimEndIndex(line)
  const start = skipWhitespace(line, 0, end)
  if (start >= end) return null
  if (line.charCodeAt(start) !== CHAR_LEFT_BRACKET) return null
  if (line.charCodeAt(end - 1) !== CHAR_RIGHT_BRACKET) return null
  const inner = line.slice(start + 1, end - 1)
  const innerEnd = trimEndIndex(inner)
  const innerStart = skipWhitespace(inner, 0, innerEnd)
  if (innerStart >= innerEnd) return null
  const isOpLead =
    scanKeyword(inner, innerStart, innerEnd, HL_PUT_KEYWORD) !== null ||
    scanKeyword(inner, innerStart, innerEnd, HL_CUT_KEYWORD) !== null ||
    scanKeyword(inner, innerStart, innerEnd, HL_REM_KEYWORD) !== null ||
    scanKeyword(inner, innerStart, innerEnd, HL_MOVE_KEYWORD) !== null
  return isOpLead ? inner : null
}

function tryParseHeader(line: string): { path: string; fileHash?: string } | null {
  if (!line.startsWith(HL_FILE_PREFIX)) return null
  const end = trimEndIndex(line)
  if (FILE_PREFIX_LENGTH + FILE_SUFFIX_LENGTH >= end) return null
  if (!line.endsWith(HL_FILE_SUFFIX, end)) return null
  const bodyEnd = end - FILE_SUFFIX_LENGTH
  if (FILE_PREFIX_LENGTH >= bodyEnd) return null

  // The snapshot tag, when present, is the trailing `#XXXX` block inside the
  // bracketed header. We detect it from the suffix so the path may
  // legitimately contain whitespace (e.g. `OneDrive - Company/file.ts`).
  let pathEnd = bodyEnd
  let fileHash: string | undefined
  const trailingHashStart = bodyEnd - HL_FILE_HASH_LENGTH - 1
  if (trailingHashStart >= FILE_PREFIX_LENGTH && line.charCodeAt(trailingHashStart) === CHAR_HASH) {
    let allHex = true
    for (let probe = trailingHashStart + 1; probe < bodyEnd; probe++) {
      if (!isHexDigitCode(line.charCodeAt(probe))) {
        allHex = false
        break
      }
    }
    if (allHex) {
      pathEnd = trailingHashStart
      fileHash = line.slice(trailingHashStart + 1, bodyEnd).toUpperCase()
    }
  }

  // The hashline header grammar uses `#` as the path/tag separator. A valid
  // trailing 4-hex tag disambiguates the path, so a tagged path may itself
  // contain `#` (yadm alt files: `conf.yaml##hostname.home`). Only when no
  // tag was detected does an untagged `#` in the path body mean the header
  // is malformed — short tags (`#1A2`), non-hex tags (`#1A2G`), over-long
  // tags (`#1A2B5`), stale-tag copy-paste (`#1A2B copied from read`), or
  // line-suffixed tags (`#1A2B:42`). Surface the focused diagnostic instead
  // of silently mis-routing the edit or reporting a missing tag downstream.
  if (fileHash === undefined) {
    for (let i = FILE_PREFIX_LENGTH; i < pathEnd; i++) {
      if (line.charCodeAt(i) === CHAR_HASH) return null
    }
  }

  if (pathEnd === FILE_PREFIX_LENGTH) return null
  const path = line.slice(FILE_PREFIX_LENGTH, pathEnd)
  return fileHash !== undefined ? { path, fileHash } : { path }
}

interface TokenBase {
  lineNum: number
}

export type Token =
	| (TokenBase & { kind: 'blank' })
	| (TokenBase & { kind: 'envelope-begin' })
	| (TokenBase & { kind: 'envelope-end' })
	| (TokenBase & { kind: 'abort' })
	| (TokenBase & { kind: 'header'; path: string; fileHash?: string })
	| (TokenBase & { kind: 'op-block'; target: BlockTarget; hadColon: boolean })
	| (TokenBase & { kind: 'payload-literal'; text: string })
	| (TokenBase & { kind: 'raw'; text: string })

function classifyLine(line: string, lineNum: number): Token {
  if (isEmptyLine(line)) return { kind: 'blank', lineNum }
  if (markerLineEquals(line, BEGIN_PATCH_MARKER)) return { kind: 'envelope-begin', lineNum }
  if (markerLineEquals(line, END_PATCH_MARKER)) return { kind: 'envelope-end', lineNum }
  if (markerLineEquals(line, ABORT_MARKER)) return { kind: 'abort', lineNum }
  const firstCode = line.charCodeAt(0)
  if (firstCode === CHAR_LEFT_BRACKET) {
    // A bracketed op (`[CUT 20]`, `[PUT >19:]`) is a hunk header wrapped in
    // brackets, not a `[path#tag]` section header — the header branch below
    // would otherwise swallow it as a file literally named "CUT 20" (or as
    // an untagged placeholder section). A valid inner op parses as an
    // op-block; a malformed one (`[PUT 17:=17]`) returns raw for the generic
    // op-shape diagnostic — unless the line is ALSO a well-formed TAGGED
    // section header, which falls through to the header branch. Two tagged
    // shapes win over ops: PUT/CUT/REM targets reject `#` outright (their
    // hunk parse fails), and a MOVE whose dest ends in `#`+4-hex reads as a
    // tag, not a destination — so `[MV notes.md#AB12]` (file "MV notes.md")
    // stays a header while `[MV new.md]` stays a move op. Untagged
    // fallbacks stay raw so a malformed op cannot mint a phantom section.
    const inner = bracketedOpInnerText(line)
    if (inner !== null) {
      const hunk = tryParseHunkHeader(inner)
      if (hunk !== null) {
        if (hunk.target.kind !== 'move') {
          return { kind: 'op-block', lineNum, target: hunk.target, hadColon: hunk.hadColon }
        }
        const header = tryParseHeader(line)
        if (header === null || header.fileHash === undefined) {
          return { kind: 'op-block', lineNum, target: hunk.target, hadColon: hunk.hadColon }
        }
        // Tagged-header-shaped move: fall through to the header branch.
      } else {
        const header = tryParseHeader(line)
        if (header === null || header.fileHash === undefined) {
          return { kind: 'raw', lineNum, text: line }
        }
        // Tagged-header-shaped: fall through to the header branch below.
      }
    }
  }
  if (line.startsWith(HL_FILE_PREFIX)) {
    const header = tryParseHeader(line)
    if (header !== null) {
      return header.fileHash !== undefined
        ? { kind: 'header', lineNum, path: header.path, fileHash: header.fileHash }
        : { kind: 'header', lineNum, path: header.path }
    }
  }
  const lead = skipWhitespace(line, 0)
  const isHunkLead =
    line.startsWith(HL_PUT_KEYWORD, lead) ||
		line.startsWith(HL_CUT_KEYWORD, lead) ||
		line.startsWith(HL_REM_KEYWORD, lead) ||
		line.startsWith(HL_MOVE_KEYWORD, lead)
  if (isHunkLead) {
    const hunk = tryParseHunkHeader(line)
    if (hunk !== null) return { kind: 'op-block', lineNum, target: hunk.target, hadColon: hunk.hadColon }
  }
  if (firstCode === CHAR_PAYLOAD_REPLACE) return { kind: 'payload-literal', lineNum, text: line.slice(1) }
  return { kind: 'raw', lineNum, text: line }
}

export class Tokenizer {
  #buffer = ''
  #nextLineNum = 1
  #closed = false

  feed(chunk: string): Token[] {
    if (this.#closed) throw new Error('Tokenizer is closed; call reset() before reusing.')
    if (chunk.length === 0) return []
    this.#buffer = this.#buffer ? this.#buffer + chunk : chunk
    return this.#drainCompleteLines()
  }

  end(): Token[] {
    if (this.#closed) return []
    this.#closed = true
    const buf = this.#buffer
    this.#buffer = ''
    if (buf.length === 0) return []
    let stop = buf.length
    if (buf.charCodeAt(stop - 1) === CHAR_CARRIAGE_RETURN) stop--
    return [classifyLine(buf.slice(0, stop), this.#nextLineNum++)]
  }

  reset(): void {
    this.#buffer = ''
    this.#nextLineNum = 1
    this.#closed = false
  }

  tokenizeAll(text: string): Token[] {
    this.reset()
    const first = this.feed(text)
    const last = this.end()
    return last.length === 0 ? first : first.concat(last)
  }

  tokenize(line: string, lineNum = 0): Token {
    return classifyLine(line, lineNum)
  }

  isOp(line: string): boolean {
    return tryParseHunkHeader(line) !== null
  }

  isHeader(line: string): boolean {
    return tryParseHeader(line) !== null
  }

  isEnvelopeMarker(line: string): boolean {
    return (
      markerLineEquals(line, BEGIN_PATCH_MARKER) ||
			markerLineEquals(line, END_PATCH_MARKER) ||
			markerLineEquals(line, ABORT_MARKER)
    )
  }

  #drainCompleteLines(): Token[] {
    const tokens: Token[] = []
    const buf = this.#buffer
    let start = 0
    for (let index = 0; index < buf.length; index++) {
      if (buf.charCodeAt(index) !== CHAR_LINE_FEED) continue
      let stop = index
      if (stop > start && buf.charCodeAt(stop - 1) === CHAR_CARRIAGE_RETURN) stop--
      tokens.push(classifyLine(buf.slice(start, stop), this.#nextLineNum++))
      start = index + 1
    }
    this.#buffer = start < buf.length ? buf.slice(start) : ''
    return tokens
  }
}

export type { ParsedRange } from './types.ts'
