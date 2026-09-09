/**
 * Model-facing `ast_edit`: structural rewrite via the packaged ast-grep engine. Preview mode
 * (the default) runs the engine with `--rewrite` and returns the proposed per-file hunks without
 * touching the filesystem; `apply: true` then rewrites each matched file through `ctx.fs` —
 * read-verify, compute the new text, and atomically write with the fs observation/version guard
 * and the deployment's sandbox policy.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 * @module @hy-sde-org/dsh-tool-ast/edit
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, DiffResultView, ToolRunContext, ToolResult } from '@deepseek-ai/dsh-tools'
import {
  AstError,
  AST_STRICTNESSES,
  byteOffsetToIndex,
  buildAstGrepArgv,
  parseAstMatches,
  runAstGrep,
  toWorkspaceTarget,
} from './core.ts'
import type { AstStrictness } from './core.ts'

/** Default cap on per-file rewrite hunks retained inline by one `ast_edit` call. */
export const AST_EDIT_MAX_FILES = 200

/** Default cap on bytes of a single before/after hunk preview. */
export const AST_EDIT_MAX_HUNK_BYTES = 4000

/** Resolved `ast_edit` caps — plugin config after defaulting (see `Config` in index.ts). */
export interface AstEditToolCaps {
  engine: { rawOutputMaxBytes: number; graceMs: number; stderrMaxBytes: number }
  maxFiles: number
  maxHunkBytes: number
  maxMetaBytes: number
  timeoutMs: number
}

/** Validated `ast_edit` arguments after defaulting. */
export interface AstEditInput {
  pat: string
  rewrite: string
  path: string | undefined
  include: string | undefined
  lang: string | undefined
  strictness: AstStrictness | undefined
  apply: boolean
}

/** The schema-typed raw arguments. */
interface AstEditToolArgs {
  pat: string
  rewrite: string
  path?: string
  include?: string
  lang?: string
  strictness?: AstStrictness
  apply?: boolean
}

/**
 * Validate value constraints the schema DSL can't express: non-blank `pat` and, when given,
 * non-blank `path`/`include`/`lang` and a known strictness. `rewrite` may be empty (a deletion).
 * @param args - the schema-validated raw tool arguments.
 * @returns the validated input with `apply` defaulted to false.
 */
export function parseAstEditArgs(args: AstEditToolArgs): AstEditInput {
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
  return { pat: args.pat, rewrite: args.rewrite, path, include, lang, strictness, apply: args.apply ?? false }
}

/** One proposed or applied file rewrite. */
export interface AstEditFileValue {
  /** Workdir-relative display path. */
  path: string
  /** Number of replacements for this file. */
  replacements: number
  /** Previewed `before` text (first hunk, byte-capped); `null` when the file is unchanged. */
  before: string | null
  /** Previewed `after` text (first hunk, byte-capped); `null` when the file is unchanged. */
  after: string | null
  /** True when this file was actually written (apply mode only). */
  applied: boolean
}

/** Model-facing `ast_edit` result value. */
export interface AstEditResultValue {
  files: AstEditFileValue[]
  /** Total replacements across all files. */
  total: number
  /** True when apply mode actually rewrote files. */
  applied: boolean
}

/** The sandbox policy adapter (resolves a per-execution policy and maps denial markers), mirroring tool-fs mutation tools. */
export class MutationPolicy {
  private readonly policy: SandboxPolicyService | undefined

  constructor(ctx: Context) {
    this.policy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
    if (ctx.fs.sandboxMode !== undefined && this.policy === undefined) {
      throw new Error('tool-ast: the mounted filesystem confines but ctx.sandboxPolicy is missing')
    }
  }

  /**
   * Resolve the per-execution sandbox policy.
   * @param exec - the tool-run context identifying the executing session.
   * @returns the resolved policy for this execution, or `undefined` when unobfuscated.
   */
  resolve(exec: ToolRunContext): SandboxExecutionPolicy | undefined {
    return this.policy?.resolve({
      ...exec.agent === undefined ? {} : { session: exec.agent.session },
    })
  }

  /**
   * Map a sandbox denial to the deployment's canonical denial marker.
   * @param error - the thrown filesystem error.
   * @param policy - the resolved policy this execution ran under.
   * @returns the mapped (or unchanged) error.
   */
  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
    const mode = (policy as SandboxExecutionPolicy).mode
    return new FsError(sandboxDenialMarker(mode), 'FS_SANDBOX_DENIED', { cause: error })
  }
}

/** Reconstruct a file's new text by applying rewrite hunks in descending byte-offset order. */
interface RewriteHunk {
  replacement: string
  byteStart: number
  byteEnd: number
}

function applyRewrites(content: string, hunks: readonly RewriteHunk[], path: string): string {
  const ordered = [...hunks].sort((a, b) => b.byteStart - a.byteStart)
  let result = content
  for (const hunk of ordered) {
    const startIndex = byteOffsetToIndex(result, hunk.byteStart)
    const endIndex = byteOffsetToIndex(result, hunk.byteEnd)
    if (startIndex === undefined || endIndex === undefined) {
      throw new AstError(`rewrite for ${path} referenced a byte range outside the file; aborting apply`, 'AST_FAILED')
    }
    // Descending order means earlier splice positions are still valid after later splices.
    result = result.slice(0, startIndex) + hunk.replacement + result.slice(endIndex)
  }
  return result
}

/** Preview one side of a hunk to the byte cap, preserving UTF-8 boundaries and marking the cut. */
function previewHunkSide(text: string, maxBytes: number): string | null {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const marker = ' … (truncated)'
  let result = text
  let byteLength = Buffer.byteLength(text, 'utf8')
  while (byteLength + Buffer.byteLength(marker, 'utf8') > maxBytes && result.length > 0) {
    byteLength -= Buffer.byteLength(result[result.length - 1] ?? '', 'utf8')
    result = result.slice(0, -1)
  }
  return `${result}${marker}`
}

/** Build the before/after preview pair for one file from the reconstructed hunks. */
function hunkPreview(before: string, after: string, maxBytes: number): { before: string | null; after: string | null } {
  if (before === after) return { before: null, after: null }
  return { before: previewHunkSide(before, maxBytes), after: previewHunkSide(after, maxBytes) }
}

/**
 * Register the `ast_edit` tool and its system-prompt guidance. Sets up the sandbox policy adapter first.
 * @param ctx - the Cordis context to register the tool and guidance on.
 * @param caps - the resolved `ast_edit` caps for this plugin instance.
 * @param policy - the sandbox policy adapter for mapping execution-time denials.
 */
export function applyAstEditTool(ctx: Context, caps: AstEditToolCaps, policy: MutationPolicy): void {
  ctx.systemPrompt.section({
    name: 'tool:ast-edit',
    order: 106,
    text:
      'Use ast_edit for STRUCTURAL rewrite: replace every node matching an AST pattern with a template that can reference captured metavars ($NAME). '
      + 'It always PREVIEWS first (apply defaults to false) so you can verify the hunks; pass apply: true to actually write the files. '
      + 'Rewrites are 1:1 structural substitutions: a capture cannot expand into sibling nodes unless the grammar permits it at that position.',
  })

  const tool = defineTool({
    name: 'ast_edit',
    description: 'Structurally rewrite source files by AST pattern. By default it PREVIEWS the proposed hunks without writing anything; set apply: true to write the files. '
      + 'Supports ast-grep pattern syntax: `$NAME` captures one node referenced in the rewrite as `$NAME`. Every matched node is rewritten; there is no interactive selection.',
    parameters: {
      pat: { type: 'string', required: true, description: 'AST pattern to match, in ast-grep syntax. Must be non-empty.' },
      rewrite: { type: 'string', required: true, description: 'Replacement template. Captured metavariables from pat substitute here (e.g. `$NAME`). Empty rewrite deletes the matched node.' },
      path: { type: 'string', description: 'File or directory to search (or several roots separated by ";"). Defaults to the session workspace; a relative path resolves against it.' },
      include: { type: 'string', description: 'One glob filter for which files to rewrite (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
      lang: { type: 'string', description: 'Force the language for pattern + targets (e.g. "Python", "Rust", "TypeScript"). Normally inferred from file extensions.' },
      strictness: { type: 'string', enum: [...AST_STRICTNESSES], description: 'How strictly the pattern node kinds must match. "smart" is the default; "ast" ignores comments and trivia.' },
      apply: { type: 'boolean', description: 'true to write the rewrites to disk; false (default) previews only.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                replacements: { type: 'integer', required: true },
                before: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                after: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                applied: { type: 'boolean', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
          applied: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatAstEditOutput(value) }],
      presentationMeta: (_args, value) => ({
        files: value.files.map(({ path, before, after }) => ({ path, before, after })),
        applied: value.applied,
        total: value.total,
      }),
    },
    async execute(args: AstEditToolArgs, exec) {
      const input = parseAstEditArgs(args)
      const run = await runAstGrep(ctx, exec, 'ast_edit', buildAstGrepArgv({ ...input, rewrite: input.rewrite }), caps.engine)
      if (run.noMatches) return { files: [], total: 0, applied: false }

      const records = parseAstMatches(run.stdout)
      const files = new Map<string, { path: string; hunks: RewriteHunk[] }>()
      for (const record of records) {
        if (record.rewrite === undefined) continue
        const target = toWorkspaceTarget(record.file, run.workdir)
        let entry = files.get(target)
        if (entry === undefined) {
          entry = { path: target, hunks: [] }
          files.set(target, entry)
        }
        entry.hunks.push(record.rewrite)
      }
      if (files.size === 0) return { files: [], total: 0, applied: false }

      const result: AstEditFileValue[] = []
      let total = 0
      for (const [target, entry] of files) {
        if (result.length >= caps.maxFiles) break
        total += entry.hunks.length
        const sandboxPolicy = policy.resolve(exec)
        const targetObject = await resolveTarget(ctx, target, exec.signal)
        const info = await statExisting(ctx, targetObject, exec)
        if (info === undefined) {
          throw new FsError(`cannot rewrite "${targetObject.displayPath}": not found`, 'FS_NOT_FOUND')
        }
        const before = await ctx.fs.readText(targetObject, exec.signal)
        const after = applyRewrites(before, entry.hunks, targetObject.displayPath)
        const preview = hunkPreview(before, after, caps.maxHunkBytes)
        const fileValue: AstEditFileValue = {
          path: targetObject.displayPath,
          replacements: entry.hunks.length,
          ...preview,
          applied: false,
        }

        if (input.apply) {
          if (after === before) {
            fileValue.applied = false
          } else {
            // Record the observation this tool's own read establishes, so the
            // edit-intent waterfall has a version — the same contract the read
            // tool satisfies before a normal edit. No prior `read` call needed.
            ctx.emit('fs/observed', targetObject, { kind: 'present', version: info.version }, exec)
            const intent = await ctx.waterfall('fs/edit-intent', targetObject, exec, () => undefined)
            let outcome
            try {
              outcome = await ctx.fs.writeText(
                targetObject,
                after,
                intent === undefined
                  ? { kind: 'replaceIfVersion', version: info.version }
                  : { kind: 'replaceIfVersion', version: intent.version },
                exec.signal,
                sandboxPolicy,
              )
            } catch (error: unknown) {
              throw policy.mapError(error, sandboxPolicy)
            }
            ctx.emit('fs/observed', targetObject, { kind: 'present', version: outcome.version }, exec)
            fileValue.applied = true
          }
        }
        result.push(fileValue)
      }

      return { files: result, total, applied: input.apply }
    },
    presentCall: presentAstEditCall,
    presentResult: presentAstEditResult,
  })

  ctx.tools.register(tool)
}

/**
 * Present a pending `ast_edit` call as a search-ish card carrying the intended roots.
 * @param args - the schema-validated raw tool arguments.
 * @returns the generic search call view.
 */
export function presentAstEditCall(args: AstEditToolArgs): GenericCallView {
  const roots = args.path === undefined
    ? []
    : args.path.split(';').filter(part => part.length > 0).map(part => ({ path: part }))
  return {
    card: 'generic',
    kind: 'search',
    title: `ast_edit ${args.pat} → ${args.rewrite}${args.apply ? ' (apply)' : ' (preview)'}`,
    ...roots.length > 0 ? { locations: roots } : {},
  }
}

/**
 * Present a completed `ast_edit` result from its persisted meta as a diff card.
 * @param _args - the raw tool arguments (unused for presentation).
 * @param result - the completed tool result carrying the persisted meta.
 * @returns the diff result view, or `undefined` when the result is an error or lacks parseable meta.
 */
export function presentAstEditResult(_args: AstEditToolArgs, result: ToolResult): DiffResultView | undefined {
  if (result.isError) return undefined
  const parsed = result.meta as { files?: { path: string; before: string | null; after: string | null }[]; applied?: boolean } | undefined
  if (parsed === undefined || !Array.isArray(parsed.files)) return undefined
  const diffs = parsed.files.flatMap(({ path, before, after }) => {
    if (before === null || after === null || before === after) return []
    return [{ path, oldText: before, newText: after }]
  })
  return {
    card: 'diff',
    title: parsed.applied ? 'ast_edit applied rewrites' : 'ast_edit rewrite preview',
    diffs,
  }
}

/** Format the model-facing `ast_edit` output: a header and per-file rows with hunks in preview. */
function formatAstEditOutput(value: AstEditResultValue): string {
  const header = value.applied
    ? `Applied ${value.total} replacement${value.total === 1 ? '' : 's'} across ${value.files.length} file${value.files.length === 1 ? '' : 's'}`
    : `Preview: ${value.total} replacement${value.total === 1 ? '' : 's'} across ${value.files.length} file${value.files.length === 1 ? '' : 's'}`
  if (value.files.length === 0) return value.applied ? `${header}. No matches.` : `${header}. No engine matches.`
  const sections = value.files.map((file) => {
    const state = file.applied ? 'rewrote' : file.replacements > 0 ? 'proposes' : 'leaves unchanged'
    const base = ` ${file.path}: ${file.replacements} replacement${file.replacements === 1 ? '' : 's'} ${state}`
    if (value.applied || file.before === null || file.after === null) return base
    return `${base}\n  before: ${file.before}\n  after:  ${file.after}`
  })
  return `${header}\n${sections.join('\n')}`
}

async function resolveTarget(ctx: Context, path: string, signal: AbortSignal): Promise<FsTarget> {
  return ctx.fs.resolve(path, { signal })
}

interface StatExecContext {
  signal: AbortSignal
  agent?: { session: object } | undefined
}

async function statExisting(
  ctx: Context,
  target: FsTarget,
  exec: StatExecContext,
): Promise<FsInfo | undefined> {
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) return undefined
  if (info.type !== 'file') {
    throw new FsError(`cannot rewrite "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return info
}
