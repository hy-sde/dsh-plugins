/**
 * Minimal text-shape normalization: line-ending detection / round-trip and
 * BOM stripping. The patcher uses these to canonicalize text to LF before
 * applying edits and to restore the original shape on write-back.
 *
 * Ported from @oh-my-pi/hashline (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */

export type LineEnding = '\r\n' | '\n'

/** Detect the first line ending style in `content`. Defaults to LF when neither is present. */
export function detectLineEnding(content: string): LineEnding {
  const crlfIdx = content.indexOf('\r\n')
  const lfIdx = content.indexOf('\n')
  if (lfIdx === -1) return '\n'
  if (crlfIdx === -1) return '\n'
  return crlfIdx < lfIdx ? '\r\n' : '\n'
}

/**
 * Normalize every CRLF pair to LF. A lone CR (progress-bar logs) stays
 * content, as grep, `wc -l` and editors count lines (oh-my-pi 69df14cfa8).
 */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Re-encode LF text with the requested line ending. */
export function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

const TRAILING_WHITESPACE = /\p{White_Space}+$/u

/**
 * Trim trailing Unicode White_Space — Rust `str::trim_end` semantics, the
 * set the patch parser accepts after section headers. `String.prototype
 * .trimEnd` diverges both ways: it misses U+0085 and trims U+FEFF
 * (oh-my-pi 5e53baff0f).
 */
export function trimEndWhitespace(line: string): string {
  return line.replace(TRAILING_WHITESPACE, '')
}

export interface BomResult {
  /** Either the empty string or the BOM sequence (currently UTF-8 BOM). */
  bom: string
  /** Text with any leading BOM removed. */
  text: string
}

/** Strip a UTF-8 BOM if present and return both the BOM and the trailing text. */
export function stripBom(content: string): BomResult {
  return content.startsWith('\uFEFF') ? { bom: '\uFEFF', text: content.slice(1) } : { bom: '', text: content }
}
