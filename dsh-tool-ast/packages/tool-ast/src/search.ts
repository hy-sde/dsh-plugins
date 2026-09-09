/**
 * Model-facing `ast_grep`: structural code search via the packaged ast-grep engine. One read-only
 * tool whose inputs (`pat`, optional `path` roots, `include` glob filter, `lang`/`strictness`
 * overrides) build an `ast-grep run --json=stream` argv; executed through `ctx.subprocess`; matches
 * are parsed, capped, and rendered grouped by file. No state, no writes.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 * @module @hy-sde-org/dsh-tool-ast/search
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, SearchResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import {
  AstError,
  AST_RAW_OUTPUT_MAX_BYTES,
  AST_STRICTNESSES,
  buildAstGrepArgv,
  parseAstMatches,
  runAstGrep,
  toWorkspaceTarget,
} from './core.ts'
import type { AstStrictness } from './core.ts'

/** Default cap on flat matches retained inline by one `ast_grep` call. */
export const AST_GREP_MAX_MATCHES = 100

/** Default cap in bytes on one matched node's preview text (the cut preserves a safe bound). */
export const AST_GREP_MAX_NODE_BYTES = 2000

/** Resolved `ast_grep` caps — plugin config after defaulting (see `Config` in index.ts). */
export interface AstGrepToolCaps {
  engine: { rawOutputMaxBytes: number; graceMs: number; stderrMaxBytes: number }
  maxMatches: number
  maxNodeBytes: number
  maxMetaBytes: number
  timeoutMs: number
}

/** Validated `ast_grep` arguments after defaulting. */
export interface AstGrepInput {
  pat: string
  path: string | undefined
  include: string | undefined
  lang: string | undefined
  strictness: AstStrictness | undefined
}

/** The schema-typed raw arguments. */
interface AstGrepToolArgs {
  pat: string
  path?: string
  include?: string
  lang?: string
  strictness?: AstStrictness
}

/**
 * Validate value constraints the schema DSL can't express: a non-blank `pat` and, when given, a
 * non-blank `path`/`include`/`lang` and a known strictness.
 * @param args - the schema-validated raw tool arguments.
 * @returns the validated input with optionals defaulted to `undefined`.
 */
export function parseAstGrepArgs(args: AstGrepToolArgs): AstGrepInput {
  if (args.pat.trim().length === 0) throw new Error('pat must be a non-empty string')
  const path = args.path?.trim()
  if (path !== undefined && path.length === 0) throw new Error('path must be a non-empty string')
  const include = args.include?.trim()
  if (include !== undefined && include.length === 0) throw new Error('include must be a non-empty string')
  const lang = args.lang?.trim()
  if (lang !== undefined && lang.length === 0) throw new Error('lang must be a non-empty string')
  const strictness = args.strictness
  if (strictness !== undefined && !(AST_STRICTNESSES as readonly string[]).includes(strictness)) {
    throw new Error(`strictness must be one of ${AST_STRICTNESSES.join(', ')}`)
  }
  return { pat: args.pat, path, include, lang, strictness }
}

/** One rendered match with its previewed node text and captures. */
export type AstGrepMatchValue = {
  /** Workdir-relative display path. */
  path: string
  /** One-based line number of the match start. */
  lineNumber: number
  /** One-based column number of the match start. */
  columnNumber: number
  /** Previewed matched-node text (bytes capped). */
  text: string
  /** Captures (`$NAME` → matched text) in declaration order, when the pattern bound any. */
  captures?: Array<{ name: string; value: string }>
}

/** Model-facing `ast_grep` result value. */
export interface AstGrepResultValue {
  /** Retained matches after the cap. */
  matches: AstGrepMatchValue[]
  /** Total matches the engine reported before any cap. */
  total: number
  /** True when `total` exceeds the retained `matches.length`. */
  truncated: boolean
}

/** Preview one node's text to the cap, preserving UTF-8 boundaries and marking the cut. */
function previewText(text: string, maxNodeBytes: number, truncatedMarker: string): string {
  if (Buffer.byteLength(text, 'utf8') <= maxNodeBytes) return text
  // Truncate by iterating code points so we never split a surrogate pair, approximating the
  // byte cap conservatively (a multi-byte code point may push slightly under the cap).
  let result = text
  let byteLength = Buffer.byteLength(text, 'utf8')
  while (byteLength > maxNodeBytes && result.length > 0) {
    const last = result.length - 1
    byteLength -= Buffer.byteLength(result[last] ?? '', 'utf8')
    result = result.slice(0, last)
  }
  return `${result}${truncatedMarker}`
}

/**
 * Format the grouped model-facing body: per file, then `Line N:col: text` rows plus captures.
 * @param matches - the retained, capped matches to format.
 * @param truncatedMarker - marker appended to previews that were cut.
 * @returns the grouped, line-oriented match body.
 */
export function formatAstGrepMatches(matches: readonly AstGrepMatchValue[], truncatedMarker: string): string {
  const byFile = new Map<string, AstGrepMatchValue[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  const sections: string[] = []
  for (const [path, group] of byFile) {
    const rows = group.map((match) => {
      const captures = match.captures === undefined || match.captures.length === 0
        ? ''
        : ` — captures: ${match.captures.map(({ name, value }) => `$${name} = ${previewText(value, 200, truncatedMarker)}`).join('; ')}`
      return `Line ${match.lineNumber}:${match.columnNumber}: ${match.text}${captures}`
    })
    sections.push(`${path}\n${rows.join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * Render a bounded `ast_grep` output: a count header, the grouped matches, and an omission footer.
 * @param retained - the matches kept after the cap, already previewed.
 * @param total - the total matches the engine reported before any cap.
 * @param truncatedMarker - marker appended to previews that were cut.
 * @returns the rendered model-facing output.
 */
export function formatAstGrepOutput(retained: AstGrepMatchValue[], total: number, truncatedMarker: string): string {
  const header = retained.length === total
    ? `Found ${total} ${total === 1 ? 'match' : 'matches'}`
    : `Found ${retained.length} of ${total} matches`
  const body = formatAstGrepMatches(retained, truncatedMarker)
  if (body.length === 0) return header
  if (!(retained.length < total)) return `${header}\n\n${body}`
  return `${header}\n\n${body}\n\n(matches beyond the first ${retained.length} are omitted; narrow the pattern or path)`
}

/** Structurally make separate files' matches a serializable meta body. */
export interface AstGrepMeta {
  /** The retained matches (already capped and previewed). */
  matches: AstGrepMatchValue[]
  /** Total matches the engine reported. */
  total: number
}

/**
 * Cap the serialized `presentationMeta` by dropping trailing files until it fits `maxBytes`.
 * @param value - the completed result value to serialize into meta.
 * @param maxBytes - the upper bound on the serialized meta size.
 * @returns a meta-sized match list (a suffix may be dropped) and the unchanged total.
 */
export function astGrepMeta(value: AstGrepResultValue, maxBytes: number): { matches: AstGrepMatchValue[]; total: number } {
  const meta = { matches: value.matches, total: value.total } satisfies { matches: AstGrepMatchValue[]; total: number }
  const bytes = Buffer.byteLength(JSON.stringify(meta), 'utf8')
  if (bytes <= maxBytes) return meta
  let matches = value.matches
  let trimmed = { matches, total: value.total } satisfies { matches: AstGrepMatchValue[]; total: number }
  // Drop whole matches from the end until the meta fits; keeps the search card honest about scope.
  while (matches.length > 0) {
    matches = matches.slice(0, -1)
    trimmed = { matches, total: value.total }
    if (Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= maxBytes) return trimmed
  }
  return { matches: [], total: value.total }
}

/**
 * Present a pending `ast_grep` call as a generic search card.
 * @param args - the schema-validated raw tool arguments.
 * @returns the generic search call view.
 */
export function presentAstGrepCall(args: AstGrepToolArgs): GenericCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: `ast_grep ${args.pat}${args.path !== undefined ? ` in ${args.path}` : ''}`,
    locations: args.path !== undefined ? args.path.split(';').filter(part => part.length > 0).map(part => ({ path: part })) : [],
  }
}

/**
 * Present a completed `ast_grep` result from its persisted meta as a search card.
 * @param _args - the raw tool arguments (unused for presentation).
 * @param result - the completed tool result carrying the persisted meta.
 * @returns the search result view, or `undefined` when the result is an error or lacks parseable meta.
 */
export function presentAstGrepResult(_args: AstGrepToolArgs, result: ToolResult): SearchResultView | undefined {
  if (result.isError) return undefined
  const parsed = result.meta as AstGrepMeta | undefined
  if (parsed === undefined || !Array.isArray(parsed.matches) || typeof parsed.total !== 'number') return undefined
  const byFile = new Map<string, { lineNumber: number; line: string }[]>()
  for (const match of parsed.matches) {
    const group = byFile.get(match.path)
    const row = { lineNumber: match.lineNumber, line: match.text }
    if (group !== undefined) group.push(row)
    else byFile.set(match.path, [row])
  }
  return {
    card: 'search',
    shape: 'matches',
    truncated: parsed.matches.length < parsed.total,
    total: parsed.total,
    files: [...byFile.entries()].map(([path, matches]) => ({ path, matches })),
  }
}

/**
 * Register the `ast_grep` tool and its system-prompt guidance.
 * @param ctx - the Cordis context to register the tool and guidance on.
 * @param caps - the resolved `ast_grep` caps for this plugin instance.
 */
export function applyAstGrepTool(ctx: Context, caps: AstGrepToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:ast-grep',
    order: 105,
    text:
      'Use ast_grep for STRUCTURAL code search (syntax-aware, not textual): find every function, call, class, or declaration matching a tree pattern. Patterns use metavariables like $NAME (bind one node) or $_ (wildcard); e.g. `console.log($MSG)` finds every console.log call. Prefer ast_grep over grep when the shape matters (e.g. "all calls to foo()", "every class implementing X"). A pattern that is only "kinda text-like" is often better served by grep.',
  })

  const tool = defineTool({
    name: 'ast_grep',
    description: 'Structurally search source files by AST pattern. Returns matching nodes with line numbers, grouped by file. '
      + `Returns the first ${caps.maxMatches} matches inline; a capped result reports the total. `
      + 'Supports ast-grep pattern syntax: `$NAME` captures one node, `$_` matches any single node, `$$$NAME` captures zero+ nodes. Use read on a matched file for surrounding context.',
    parameters: {
      pat: { type: 'string', required: true, description: 'AST pattern to match, in ast-grep syntax. Must be non-empty.' },
      path: { type: 'string', description: 'File or directory to search (or several roots separated by ";"). Defaults to the session workspace; a relative path resolves against it.' },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
      lang: { type: 'string', description: 'Force the language for pattern + targets (e.g. "Python", "Rust", "TypeScript"). Normally inferred from file extensions.' },
      strictness: { type: 'string', enum: [...AST_STRICTNESSES], description: 'How strictly the pattern node kinds must match. "smart" is the default; "ast" ignores comments and trivia; "signature" matches node kinds without text.' },
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
                columnNumber: { type: 'integer', required: true },
                text: { type: 'string', required: true },
                captures: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string', required: true },
                      value: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatAstGrepOutput(value.matches, value.total, ' (truncated)'),
      }],
      presentationMeta: (_args, value) => astGrepMeta(value, caps.maxMetaBytes),
    },
    async execute(args: AstGrepToolArgs, exec) {
      const input = parseAstGrepArgs(args)
      const run = await runAstGrep(ctx, exec, 'ast_grep', buildAstGrepArgv(input), caps.engine)
      if (run.noMatches) return { matches: [], total: 0, truncated: false }

      const retained: AstGrepMatchValue[] = []
      let total = 0
      for (const record of parseAstMatches(run.stdout)) {
        total += 1
        if (retained.length >= caps.maxMatches) continue
        const text = previewText(record.text, caps.maxNodeBytes, ' (truncated)')
        retained.push({
          path: toWorkspaceTarget(record.file, run.workdir),
          lineNumber: record.startLine + 1,
          columnNumber: record.startColumn + 1,
          text,
          ...record.captures === undefined ? {} : {
            captures: [...record.captures.entries()].map(([name, value]) => ({
              name,
              value: previewText(value, 200, ' (truncated)'),
            })),
          },
        })
      }
      return { matches: retained, total, truncated: total > retained.length }
    },
    presentCall: presentAstGrepCall,
    presentResult: presentAstGrepResult,
  })
  ctx.tools.register(tool)
}

export { AstError, AST_RAW_OUTPUT_MAX_BYTES }
