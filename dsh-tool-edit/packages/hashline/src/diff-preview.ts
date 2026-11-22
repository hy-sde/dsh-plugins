/**
 * Re-number a unified diff that uses the `+<lineNum>|content` /
 * `-<lineNum>|content` / ` <lineNum>|content` line format into a compact
 * current-file preview. Removed lines are counted for stats and post-edit
 * offset tracking, but omitted from the preview. Added and context lines are
 * anchored to their post-edit positions so a follow-up edit can reuse visible
 * concrete lines directly. Long contiguous added runs and blank gap rows are
 * summarized with a `…` marker instead of echoing every inserted line.
 *
 * This is intentionally decoupled from the diff producer: anything that
 * emits the `<sign><lineNum>|<content>` shape works.
 * Ported from @oh-my-pi/hashline (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import type { CompactDiffOptions, CompactDiffPreview } from './types.ts'

const DEFAULT_ADDED_RUN_CONTEXT_LINES = 2

const PREVIEW_ELISION_MARKER = '…'
const RAW_ELISION_MARKERS = new Set(['', '...', PREVIEW_ELISION_MARKER, `+${PREVIEW_ELISION_MARKER}`])

function appendPreviewLine(output: string[], line: string): void {
  const normalized = RAW_ELISION_MARKERS.has(line) ? PREVIEW_ELISION_MARKER : line
  // Elision markers never stack: omitted removed lines between two markers
  // would otherwise leave them adjacent. A leading marker is dropped outright.
  if (normalized === PREVIEW_ELISION_MARKER && (output.length === 0 || output[output.length - 1] === PREVIEW_ELISION_MARKER)) {
    return
  }
  output.push(normalized)
}

interface ParsedDiffLine {
  kind: '+' | '-' | ' '
  lineNumber: number
  content: string
}

function normalizeAddedRunContext(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ADDED_RUN_CONTEXT_LINES
  return Math.max(1, Math.trunc(value))
}

function parseNumberedDiffLine(line: string): ParsedDiffLine | undefined {
  const kind = line[0]
  if (kind !== '+' && kind !== '-' && kind !== ' ') return undefined

  const body = line.slice(1)
  const sep = body.indexOf('|')
  if (sep === -1) return undefined

  const lineNumber = Number.parseInt(body.slice(0, sep), 10)
  if (!Number.isFinite(lineNumber)) return undefined

  return { kind, lineNumber, content: body.slice(sep + 1) }
}

function appendAddedRun(output: string[], run: string[], edgeLines: number): void {
  if (run.length === 0) return

  const collapseThreshold = edgeLines * 2 + 1
  if (run.length <= collapseThreshold) {
    for (const text of run) appendPreviewLine(output, text)
    return
  }

  for (let i = 0; i < edgeLines; i++) appendPreviewLine(output, run[i] ?? '')
  appendPreviewLine(output, PREVIEW_ELISION_MARKER)
  for (let i = run.length - edgeLines; i < run.length; i++) appendPreviewLine(output, run[i] ?? '')
}

export function buildCompactDiffPreview(diff: string, options: CompactDiffOptions = {}): CompactDiffPreview {
  const lines = diff.length === 0 ? [] : diff.split('\n')
  const addedRunContext = normalizeAddedRunContext(options.maxAddedRunContext ?? options.maxUnchangedRun)
  let addedLines = 0
  let removedLines = 0
  const formatted: string[] = []
  const addedRun: string[] = []
  // True while the current added run re-emits rows the fork's producer paired
  // with a removed run (unchanged-but-renumbered middle): those keep the fork's
  // 2-row collapse so elided renumbered rows never register as seen.
  let addedRunPaired = false

  const flushAddedRun = (): void => {
    appendAddedRun(formatted, addedRun, addedRunPaired ? DEFAULT_ADDED_RUN_CONTEXT_LINES : addedRunContext)
    addedRun.length = 0
  }

  // External diff producers number `+` lines with the post-edit line number,
  // `-` lines with the pre-edit line number, and context lines with the
  // pre-edit line number. To emit fresh line numbers usable for follow-up
  // edits, convert context-line numbers to post-edit positions by tracking
  // the running offset (added so far - removed so far) as we walk the diff.
  for (const line of lines) {
    const parsed = parseNumberedDiffLine(line)
    if (!parsed) {
      flushAddedRun()
      appendPreviewLine(formatted, line)
      continue
    }

    switch (parsed.kind) {
      case '+': {
        addedLines++
        addedRun.push(`${parsed.lineNumber}:${parsed.content}`)
        break
      }
      case '-':
        flushAddedRun()
        removedLines++
        addedRunPaired = true
        break
      default: {
        flushAddedRun()
        addedRunPaired = false
        const newLineNumber = parsed.lineNumber + addedLines - removedLines
        appendPreviewLine(formatted, `${newLineNumber}:${parsed.content}`)
        break
      }
    }
  }
  flushAddedRun()
  while (formatted.length > 0 && formatted[formatted.length - 1] === PREVIEW_ELISION_MARKER) formatted.pop()

  return { preview: formatted.join('\n'), addedLines, removedLines }
}
