/**
 * The model-facing `grep` tool: search file contents with a ripgrep regular
 * expression. Execution spawns the packaged ripgrep binary
 * (`@vscode/ripgrep`) directly through the subprocess seam with a plain argv
 * vector using a fixed line-oriented `rg --json` command so file path, line
 * number, and line text parse without colon-splitting ambiguity — this module
 * owns the model-facing schema, argument validation, argv construction,
 * `--json` record parsing, per-line preview retention, match retention,
 * grouping, and formatting; process concerns stay behind `ctx.subprocess`.
 *
 * @module @hy-sde-org/dsh-tool-fs-search-internal-urls/grep
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, SearchResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import type {} from '@hy-sde-org/dsh-internal-urls'
import type { InternalResource } from '@hy-sde-org/dsh-internal-urls'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { GrepMatch } from './search-core.ts'
import { SearchError, gitDirtyPaths, previewLine, rankGrepMatchesByDirty, runRipgrep, toWorkdirRelative, trySaveFormattedResult } from './search-core.ts'
import { grepSearchMeta, searchViewFromMeta } from './presentation.ts'
import { acceptedDirectCallValue } from './direct-call.ts'

/**
 * Default cap on flat matches retained inline by one `grep` call (the
 * `grepMaxMatches` config): the inline PAGE SIZE of a result. 250→50 is the
 * fff/philosophy imported from a search-tool audit (pi-fff's default is 20):
 * a broad grep must hand back a small, ranked, pageable first screen, not a
 * 50KB flood that buries the files that matter. Capped results return a
 * continuation `cursor` and — with a spill backend — the complete result's
 * locator.
 */
export const GREP_MAX_MATCHES = 50

/** Default cap in bytes on one matched-line preview (the `grepMaxLineBytes` config); the cut preserves UTF-8 boundaries. */
export const GREP_MAX_LINE_BYTES = 2000

/** The page slice one `grep` call shows: every match from the cursor offset up to the page size. */
export interface GrepPage {
  /** The page's matches, each line previewed to the per-line budget. */
  items: GrepMatch[]
  /** Every match the search found (the pre-page total). */
  seen: number
  /** Whether more pages exist past this one. */
  truncated: boolean
  /** The flat-match offset this page begins at (0 for the first page). */
  offset: number
  /** The page size this call slices with (the `grepMaxMatches` config). */
  pageSize: number
}

/** Resolved grep-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface GrepToolCaps {
  /** Max flat matches retained inline; later matches go to the formatted spill file. */
  maxMatches: number
  /** Max bytes retained per matched-line preview. */
  maxLineBytes: number
  /** Whether one `git status` probe per call ranks git-dirty files first (the fff git-aware signal). */
  gitRank: boolean
  /** Max bytes of serialized `presentationMeta`; trailing file groups drop past it. */
  maxMetaBytes: number
  /** Cap on the complete raw `rg` stdout the tool will parse. */
  rawOutputMaxBytes: number
  /** Terminate-escalation grace period (ms) for the search process. */
  graceMs: number
  /** Cap on the retained stderr diagnostic tail. */
  stderrMaxBytes: number
  /** Cooperative tool-call budget (ms) attached as `ToolDefinition.timeoutMs`. */
  timeoutMs: number
}

/** Validated `grep` arguments. */
export interface GrepInput {
  pattern: string
  path?: string
  include?: string
  cursor?: string
}

/**
 * The opaque cursor grammar: `offset:<n>`. The tool is the only producer and
 * consumer — the model treats the token as opaque, fff-style, never parses it
 * (a stateless offset lets every page re-run ripgrep deterministically, no
 * server-side cursor store needed).
 *
 * @param offset - the flat-match offset the cursor encodes.
 * @returns the opaque continuation token for that offset.
 */
export function cursorToken(offset: number): string {
  return `offset:${offset}`
}

/**
 * Parse a continuation cursor into its flat-match offset. A malformed token
 * (not `offset:<n>`) is an ordinary argument error: the model may only pass
 * back a token a previous `grep` result returned.
 *
 * @param cursor - the opaque continuation token.
 * @returns the flat-match offset the token encodes.
 */
export function parseCursorToken(cursor: string): number {
  const match = /^offset:(\d+)$/.exec(cursor)
  if (match === null) {
    throw new Error('cursor must be a continuation token returned by a previous grep result; pass it back unchanged with the same pattern, path, and include')
  }
  return Number(match[1])
}

/**
 * Reject an `include` that is not ONE positive glob filter: blank strings,
 * negated patterns (`!…`), and comma-separated lists. A comma inside a brace
 * group is fine — `*.{ts,tsx}` is one glob with alternation, not a list.
 */
function validateInclude(include: string): void {
  if (include.trim().length === 0) throw new Error('include must be a non-empty glob when given')
  if (include.startsWith('!')) throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported')
  let braceDepth = 0
  for (const char of include) {
    if (char === '{') braceDepth++
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === ',' && braceDepth === 0) {
      throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)')
    }
  }
}

/**
 * Validate value constraints the schema DSL can't express: a non-EMPTY
 * `pattern` (whitespace is a legitimate regex), a non-blank `path` when given,
 * and a single positive `include` glob ({@link GrepInput}). Throws a plain
 * `Error` (an ordinary tool argument error) otherwise.
 *
 * @param args - the schema-validated `grep` arguments.
 * @returns the accepted input, unchanged.
 */
export function parseGrepArgs(args: { pattern: string; path?: string; include?: string; cursor?: string }): GrepInput {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  if (args.include !== undefined) validateInclude(args.include)
  if (args.cursor !== undefined) parseCursorToken(args.cursor)
  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    ...args.include !== undefined ? { include: args.include } : {},
    ...args.cursor !== undefined ? { cursor: args.cursor } : {},
  }
}

/**
 * Build the fixed line-oriented `rg --json` argv for one `grep` call. Every
 * model-controlled value ({@link GrepInput.pattern}, {@link GrepInput.path},
 * {@link GrepInput.include}) is a plain argv element — no shell layer exists,
 * so no quoting applies; the pattern and include ride in `--flag=value` form
 * and the target behind `--`, so a leading-dash value can never be parsed as
 * a flag.
 *
 * @param input - the validated arguments.
 * @returns the complete ripgrep argument vector (excluding the binary itself).
 */
export function buildGrepCommand(input: GrepInput): string[] {
  const parts = ['--json', `--regexp=${input.pattern}`]
  if (input.include !== undefined) parts.push(`--glob=${input.include}`)
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/**
 * The uniform malformed-output failure: raw `rg --json` is an internal
 * transport, so missing or invalid response fields cause a search failure, not a partial result.
 */
function malformedRecord(detail: string, cause?: unknown): SearchError {
  return new SearchError(`grep received malformed ripgrep --json output (${detail})`, 'SEARCH_FAILED', cause !== undefined ? { cause } : undefined)
}

/**
 * Parse one `rg --json` NDJSON line into a match, `undefined` for the
 * non-match record types (`begin`/`end`/`context`/`summary`). A line that is
 * not JSON, or a `match` record missing its path / line number / line content,
 * throws {@link SearchError} `SEARCH_FAILED`. A match whose line is not valid
 * UTF-8 (ripgrep sends base64 `bytes` instead of `text`) yields a placeholder
 * preview rather than failing the whole search.
 */
function parseRecord(line: string): GrepMatch | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error: unknown) {
    throw malformedRecord('a line is not JSON', error)
  }
  if (typeof parsed !== 'object' || parsed === null) throw malformedRecord('a record is not an object')
  const record = parsed as { type?: unknown; data?: unknown }
  // Non-match record types (begin/end/context/summary — and any future type)
  // are transport framing, not results: skipped, not malformed.
  if (record.type !== 'match') return undefined
  if (typeof record.data !== 'object' || record.data === null) throw malformedRecord('a match record has no data')
  const data = record.data as { path?: unknown; line_number?: unknown; lines?: unknown }
  const pathText = typeof data.path === 'object' && data.path !== null ? (data.path as { text?: unknown }).text : undefined
  if (typeof pathText !== 'string') throw malformedRecord('a match record has no path text')
  if (typeof data.line_number !== 'number') throw malformedRecord('a match record has no line number')
  if (typeof data.lines !== 'object' || data.lines === null) throw malformedRecord('a match record has no line content')
  const lines = data.lines as { text?: unknown; bytes?: unknown }
  if (typeof lines.text === 'string') {
    return { path: pathText, lineNumber: data.line_number, line: lines.text.replace(/\r?\n$/, '') }
  }
  if (typeof lines.bytes === 'string') {
    return { path: pathText, lineNumber: data.line_number, line: '(line is not valid UTF-8)' }
  }
  throw malformedRecord('a match record has neither line text nor bytes')
}

/**
 * Parse complete `rg --json` stdout into flat matches, in output order (ripgrep
 * emits one file's matches contiguously). Only `match` records are consumed.
 *
 * @param stdout - the complete raw `rg --json` stdout.
 * @returns the flat matches; empty for output with no match records.
 */
export function parseGrepMatches(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const match = parseRecord(line)
    if (match !== undefined) matches.push(match)
  }
  return matches
}

/**
 * Group flat matches by file (first-seen order) into the model-facing body:
 * each file's display path, then one `Line N: <text>` row per match. When
 * `annotations` carries a git status code for a path, the code rides on the
 * file header as ` [<code> in git]` — the fff annotation — so the model sees
 * WHY a dirty file ranks first (it is changing right now).
 *
 * @param matches - the flat matches to render.
 * @param annotations - optional git status codes keyed by display path (`M`, `MM`, `A`, `??`, …).
 * @returns the grouped body text.
 */
export function formatGrepMatches(matches: GrepMatch[], annotations?: ReadonlyMap<string, string>): string {
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  const sections: string[] = []
  for (const [path, group] of byFile) {
    const code = annotations?.get(path)
    const header = code !== undefined && code.length > 0 ? `${path} [${code} in git]` : path
    sections.push(`${header}\n${group.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * Slice the complete ranked match list into one {@link GrepPage}: the
 * `maxMatches` runs starting at the cursor offset, each line previewed to
 * `maxLineBytes`. `seen` stays the pre-page total and `truncated` reports
 * whether any page follows, so text, search card, and continuation cursor
 * always agree — the single page pass both `output.render` and the spill
 * post-execute hook consume.
 *
 * @param matches - every match the search parsed (ranked, in canonical order).
 * @param cursorOffset - the flat-match offset this page starts at (0 for the first page).
 * @param maxMatches - the page size (the `grepMaxMatches` config).
 * @param maxLineBytes - the per-matched-line preview budget in bytes.
 * @returns the page projection.
 */
export function sliceGrepPage(matches: GrepMatch[], cursorOffset: number, maxMatches: number, maxLineBytes: number): GrepPage {
  const items = matches.slice(cursorOffset, cursorOffset + maxMatches)
    .map(match => ({ ...match, line: previewLine(match.line, maxLineBytes) }))
  const seen = matches.length
  return { items, seen, truncated: cursorOffset + items.length < seen, offset: cursorOffset, pageSize: maxMatches }
}

/** `match` / `matches` for a count. */
function matchNoun(count: number): string {
  return count === 1 ? 'match' : 'matches'
}

/** The 1-based page number for a cursor offset at the given page size. */
function pageIndex(offset: number, pageSize: number): number {
  return Math.floor(offset / pageSize) + 1
}

/** The total page count for a result of `seen` matches at the given page size. */
function pageCount(seen: number, pageSize: number): number {
  return Math.max(1, Math.ceil(seen / pageSize))
}

/**
 * The {@link GrepPage} for one tool call: the canonical match list sliced from
 * the call's cursor offset (validated at execute time) at `grepMaxMatches`.
 * The single page pass both `output.render` and the spill post-execute hook
 * consume, so text, search card, and continuation cursor always agree.
 */
function grepPageRetained(args: { cursor?: string }, matches: GrepMatch[], caps: GrepToolCaps): GrepPage {
  const offset = args.cursor !== undefined ? parseCursorToken(args.cursor) : 0
  return sliceGrepPage(matches, offset, caps.maxMatches, caps.maxLineBytes)
}

/** Filter a schema-typed git map (`json`-valued values) down to the real string status codes. */
function toAnnotations(git: Record<string, unknown> | undefined): Map<string, string> | undefined {
  const annotations = new Map<string, string>()
  for (const [path, code] of Object.entries(git ?? {})) {
    if (typeof code === 'string' && code.length > 0) annotations.set(path, code)
  }
  return annotations.size > 0 ? annotations : undefined
}

/** The model-facing text for one `grep` call page, with git annotations riding the file headers. */
function grepPageText(
  args: { cursor?: string },
  value: { matches: GrepMatch[]; git?: Record<string, unknown> },
  caps: GrepToolCaps,
  spillRef: SpillRef | undefined,
): string {
  return formatGrepOutput(grepPageRetained(args, value.matches, caps), spillRef, toAnnotations(value.git))
}

/**
 * Format the model-facing `grep` result for ONE page: a found-count header,
 * the page's matches grouped by file, then — when the result spans further
 * pages — a footer carrying the continuation `cursor` plus (when available)
 * the formatted-spill recovery locator. The omitted count is a budget fact:
 * the search itself completed; the cursor trades the rest back page by page
 * instead of dumping it into context at once (the fff "precise positioning
 * then read" protocol).
 *
 * @param page - the page projection from {@link sliceGrepPage}.
 * @param spillRef - the saved complete-result reference, or `undefined` when unsaved.
 * @param annotations - optional git status codes keyed by display path (fff-style `[M in git]` file headers).
 * @returns the model-facing text.
 */
export function formatGrepOutput(page: GrepPage, spillRef: SpillRef | undefined, annotations?: ReadonlyMap<string, string>): string {
  const { items, seen, truncated, offset, pageSize } = page
  if (seen === 0) return 'No matches found'
  if (items.length === 0) {
    return `No more matches in this result (page ${pageIndex(offset, pageSize)} of ${pageCount(seen, pageSize)})`
  }
  const header = (() => {
    // The first complete page keeps the historical plain header; any truncated
    // page and any later page report "this page's matches of the total".
    if (offset === 0 && !truncated) return `Found ${seen} ${matchNoun(seen)}`
    const base = `Found ${items.length} of ${seen} matches`
    if (offset === 0) return base
    return `${base} (page ${pageIndex(offset, pageSize)} of ${pageCount(seen, pageSize)})`
  })()
  const body = formatGrepMatches(items, annotations)
  if (!truncated) return `${header}\n\n${body}`
  const next = cursorToken(offset + items.length)
  const recovery = spillRef !== undefined
    ? `Full grep result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved.'
  return `${header}\n\n${body}\n\n(${recovery} Continue with cursor="${next}" for the next page.)`
}

/**
 * Pending-call presentation: a search card titled by the pattern (and target /
 * include filter).
 *
 * @param args - the raw tool arguments; `pattern`, `path`, and `include` feed the title.
 * @returns the generic card view (`kind: 'search'`) shown while the call runs.
 */
export function presentGrepCall(args: { pattern: string; path?: string; include?: string }): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  const filter = args.include !== undefined ? ` (${args.include})` : ''
  return { card: 'generic', title: `Grep ${args.pattern}${where}${filter}`, kind: 'search', rawInput: args.pattern }
}

/**
 * Completed-call presentation: the search card projected from the result's
 * `presentationMeta` (matches grouped by file, with the truncation signal). A UI
 * without a search card falls back to the raw `tool/result` content, so the view
 * carries no result text of its own. Malformed or absent metadata (an obsolete or
 * hand-edited replayed log) falls back to the generic card.
 *
 * @param _args - the raw tool arguments; unused, the view derives from the result.
 * @param result - the final model-facing tool result carrying the projected metadata.
 * @returns the search card view, or `undefined` for the generic fallback.
 */
export function presentGrepResult(
  _args: { pattern: string; path?: string; include?: string },
  result: ToolResult,
): SearchResultView | undefined {
  if (result.isError) return undefined
  const view = searchViewFromMeta(result.meta)
  if (view === undefined || view.shape !== 'matches') return undefined
  return view
}

/**
 * Search one internal-URL resource (`conflict://`, `pr://`, …) with the same
 * ripgrep semantics as a filesystem grep. A `sourcePath`-backed resource is
 * searched on disk; a purely virtual resource is materialized to a per-call
 * temp file, searched, and removed — the reported path is always the URL.
 */
async function grepInternalUrl(
  ctx: Context,
  exec: ToolExecution,
  resource: InternalResource,
  input: GrepInput,
  caps: GrepToolCaps,
): Promise<GrepMatch[]> {
  if (resource.isDirectory === true) {
    throw new SearchError(`grep cannot search directory resource "${resource.url}"; read it instead`, 'SEARCH_FAILED')
  }
  const targetPath = resource.sourcePath
  if (targetPath !== undefined) {
    const run = await runRipgrep(ctx, exec, 'grep', buildGrepCommand({ ...input, path: targetPath }), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
    if (run.noMatches) return []
    return parseGrepMatches(run.stdout).map(match => ({ path: resource.url, lineNumber: match.lineNumber, line: match.line }))
  }
  // Virtual resource: feed ripgrep the same content through a temp file so the
  // regex dialect, --glob, and preview caps are unchanged; only the reported
  // path is the URL. The file lives for exactly one call.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-grep-'))
  const file = join(dir, 'resource.txt')
  try {
    writeFileSync(file, resource.content, 'utf8')
    const run = await runRipgrep(ctx, exec, 'grep', buildGrepCommand({ ...input, path: file }), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
    if (run.noMatches) return []
    return parseGrepMatches(run.stdout).map(match => ({ path: resource.url, lineNumber: match.lineNumber, line: match.line }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Register the `grep` tool and its system-prompt guidance.
 *
 * @param ctx - the plugin context; registrations are effects scoped to it, and
 *   execution uses its `subprocess` service.
 * @param caps - the deployment's resolved grep caps (plugin config after defaulting).
 */
export function applyGrepTool(ctx: Context, caps: GrepToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: 'Use the grep tool — not shell grep or rg — to search file contents. Results are ranked so git-modified files come first (marked [M in git]). '
      + `A capped grep returns the first ${caps.maxMatches} matches plus a continuation cursor — pass the cursor back unchanged with the same pattern/path/include to fetch the next page; read the top match instead of paging deep. Use read on a matched file for surrounding context.`,
  })

  const tool = defineTool({
    name: 'grep',
    description: 'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file, ranked so git-modified files come first. '
      + `Returns the first ${caps.maxMatches} matches inline; a capped result returns a continuation cursor — pass it back unchanged (same pattern/path/include) to fetch the next page, or follow the spill locator for the complete result. `
      + 'Use read on a matched file for surrounding context.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for (ripgrep syntax).' },
      path: { type: 'string', description: 'File, directory, or internal URL (e.g. conflict://3, pr://owner/repo/123/diff) to search. Defaults to the session workspace; a relative path resolves against it.' },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
      cursor: { type: 'string', description: 'Opaque continuation token returned by a capped previous result. Pass it back unchanged with the same pattern, path, and include to fetch the next page.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
          git: {
            type: 'object',
            additionalProperties: true,
            description: 'Git-dirty files this search matched, keyed by display path with the compact porcelain status code ("M", "MM", "A", "D", "??", "R", …). Present only when the workdir is inside a git repo and at least one dirty file matched.',
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: grepPageText(args, value, caps, undefined) }],
      presentationMeta: (args, value) =>
        grepSearchMeta(grepPageRetained(args, value.matches, caps), caps.maxMetaBytes),
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args)
      // Internal-URL routing (conflict://, pr:// diff, …): resolve the resource
      // and grep its content through the same ripgrep pipeline.
      const iu = ctx.get('internalUrls')
      if (iu !== undefined && input.path !== undefined && iu.canHandle(input.path)) {
        const cwd = exec.agent?.session.header.cwd
        const sessionKey = exec.agent?.session.header.id
        const resource = await iu.resolve(input.path, {
          ...cwd !== undefined ? { cwd } : {},
          signal: exec.signal,
          ...sessionKey !== undefined ? { sessionKey } : {},
          pathOnly: true,
        })
        return { matches: await grepInternalUrl(ctx, exec, resource, input, caps) }
      }
      const run = await runRipgrep(ctx, exec, 'grep', buildGrepCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
      if (run.noMatches) return { matches: [] }

      const all: GrepMatch[] = []
      for (const raw of parseGrepMatches(run.stdout)) {
        const match: GrepMatch = {
          path: toWorkdirRelative(raw.path, run.workdir),
          lineNumber: raw.lineNumber,
          line: raw.line,
        }
        all.push(match)
      }
      // Git-aware ranking (the fff "modified files first" signal, index-free:
      // one porcelain probe, then a stable partition): dirty files surface on
      // page one instead of being buried behind noise in untouched files.
      if (!caps.gitRank) return { matches: all }
      const dirty = await gitDirtyPaths(ctx, exec)
      if (dirty === undefined) return { matches: all }
      const ranked = rankGrepMatchesByDirty(all, dirty)
      const gitEntries = new Map<string, string>()
      for (const match of ranked) {
        const code = dirty.get(match.path)
        if (!gitEntries.has(match.path) && code !== undefined) gitEntries.set(match.path, code)
      }
      if (gitEntries.size === 0) return { matches: ranked }
      return { matches: ranked, git: Object.fromEntries(gitEntries) }
    },
    presentCall: presentGrepCall,
    presentResult: presentGrepResult,
  })
  ctx.tools.register(tool)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as
      { matches: GrepMatch[]; git?: Record<string, string> } | undefined
    if (value === undefined) return decision
    const matches = value.matches
    if (matches.length <= caps.maxMatches) return decision
    // The spill artifact holds the COMPLETE result: preview each line, but keep
    // every match (no inline cap), so the recovery file is the full search.
    const previewedAll = matches.map(match => ({ ...match, line: previewLine(match.line, caps.maxLineBytes) }))
    const spillRef = await trySaveFormattedResult(
      ctx,
      exec,
      'grep-results.txt',
      `Found ${matches.length} ${matchNoun(matches.length)}\n\n${formatGrepMatches(previewedAll)}`,
    )
    const args = exec.arguments as { cursor?: string; pattern?: string; path?: string; include?: string } | undefined
    return {
      kind: 'accept',
      content: [{
        type: 'text',
        text: formatGrepOutput(grepPageRetained(args ?? {}, matches, caps), spillRef, toAnnotations(value.git)),
      }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}
