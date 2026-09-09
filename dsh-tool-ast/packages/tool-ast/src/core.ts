/**
 * The AST engine: packaged `@ast-grep/cli` binary resolution, process acquisition, argv building,
 * and JSON-stream parsing for `ast_grep` (structural search) and `ast_edit` (structural rewrite).
 *
 * A native ast-grep binary ships inside the `@ast-grep/cli` npm dependency (its postinstall hard-links
 * the platform binary from the matching `@ast-grep/cli-<platform>` optional package to the package
 * root), so — exactly like the ripgrep tool — the correct engine arrives with `pnpm install` on every
 * supported platform without a system `ast-grep` install. The binary is a subpath-resolvable file
 * (`@ast-grep/cli/ast-grep`), resolved by `createRequire` from this module's own location.
 *
 * All model input travels as separate argv elements — there is no shell layer — so a hostile pattern
 * stays inert. Working directory is the calling agent's session cwd via `exec.agent.session.header.cwd`;
 * `exec.signal` is forwarded so the cooperative tool timeout (`@deepseek-ai/dsh-tool-call-timeout-policy`)
 * and caller cancellation terminate the process tree.
 *
 * The JSON-stream output is one match object per line. Each match carries the matched node text, a
 * zero-based `range` (line/column/byte offsets), the containing line, and the language; a rewrite run
 * additionally carries the `replacement` text and the byte range it replaces (`replacementOffsets`).
 * Non-match processing is stream-line-based: a line that is not a JSON object is a failure
 * (`AST_RAW_OUTPUT_OVERFLOW`/`AST_FAILED`), mirroring the ripgrep tool's strict parse.
 *
 * Exit semantics: exit 0 is success with matches; exit 1 is success with zero matches (`noMatches`)
 * AND an otherwise-empty stderr — a non-empty stderr at exit 1 is failure (`AST_FIND_ERROR`, e.g. a
 * missing path is reported as `ERROR: ...`); any other exit code is failure (`AST_USAGE_ERROR` for
 * user-correctable invocation errors surfaced by the CLI, otherwise `AST_FAILED`). Abort during spawn
 * or execution is `AST_ABORTED`.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 * @module @hy-sde-org/dsh-tool-ast/core
 */

import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Default cooperative tool-call timeout budget (ms), enforced via `exec.signal`. */
export const AST_TIMEOUT_MS = 30_000

/** Default terminate grace period for the ast-grep process (ms). */
export const AST_GRACE_MS = 3_000

/** Default max retained stderr tail (bytes) — a diagnostic excerpt only. */
export const AST_STDERR_MAX_BYTES = 64 * 1024

/** Default cap on raw stdout the tool will parse (bytes). */
export const AST_RAW_OUTPUT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Stable, machine-routable codes for AST-tool failures. Package-owned (not `FsErrorCode`/`SearchErrorCode`)
 * because these tools are spawn-backed structural analysis, not filesystem or ripgrep operations:
 * `AST_FIND_ERROR` — ast-grep reported a find/arg error on stderr (missing path etc.); `AST_USAGE_ERROR`
 * — the CLI rejected the invocation (unsupported language, invalid strictness, malformed pattern
 * syntax); `AST_FAILED` — the engine could not run or its output could not be parsed; `AST_RAW_OUTPUT_OVERFLOW`
 * — raw output exceeded the cap or stayed truncated; `AST_ABORTED` — cooperative timeout or caller
 * cancellation cut the run short; `AST_BINARY_UNAVAILABLE` — the packaged binary could not be resolved;
 * `AST_FILE_CHANGED` — an `ast_edit` file changed between the scan and its application.
 */
export type AstErrorCode =
  | 'AST_FIND_ERROR'
  | 'AST_USAGE_ERROR'
  | 'AST_FAILED'
  | 'AST_RAW_OUTPUT_OVERFLOW'
  | 'AST_ABORTED'
  | 'AST_BINARY_UNAVAILABLE'
  | 'AST_FILE_CHANGED'

/** Typed AST-tool failure. Extends {@link HarnessError} with a stable {@link AstErrorCode} and chains `cause`. */
export class AstError extends HarnessError {
  override readonly code: AstErrorCode

  constructor(message: string, code: AstErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/** The completed acquisition of one `ast-grep` run: the raw stdout plus resolved workdir. */
export interface AstRun {
  /** Complete raw stdout of the `--json=stream` run (a JSON object per match line). */
  stdout: string
  /** True when ast-grep exited 1: a successful run with zero matches. */
  noMatches: boolean
  /** The resolved working directory the command ran in (the display-relativization base). */
  workdir: string
}

/** The minimum strictness names ast-grep accepts; used for schema enum + validation. */
export const AST_STRICTNESSES = ['cst', 'smart', 'ast', 'relaxed', 'signature', 'template'] as const

/** A valid `--strictness` name for `ast-grep run`; the schema enum and validation share this. */
export type AstStrictness = (typeof AST_STRICTNESSES)[number]

const cachedPath = (() => {
  let promise: Promise<string> | undefined
  return () => (promise ??= resolveAstGrepBinary())
})()

/**
 * Resolve the packaged `@ast-grep/cli` binary path, memoized. The binary lives at the package root
 * after the CLI's postinstall hard-links the platform optional dependency's executable there, and is
 * reachable as the subpath `@ast-grep/cli/ast-grep` (the package publishes no `exports` map, so the
 * subpath resolves to the on-disk file). `createRequire` from this module resolves it against the
 * installed tree regardless of the caller's `process.cwd()`.
 * @returns the absolute path to the native ast-grep executable.
 * @throws AstError `AST_BINARY_UNAVAILABLE` when the package (or its postinstalled binary) is missing.
 */
export function astGrepPath(): Promise<string> {
  return cachedPath()
}

function resolveAstGrepBinary(): Promise<string> {
  return Promise.resolve().then(() => {
    try {
      const require = createRequire(import.meta.url)
      const resolved = require.resolve('@ast-grep/cli/ast-grep')
      return resolved
    } catch (error: unknown) {
      throw new AstError(
        'ast tooling could not resolve its packaged @ast-grep/cli binary (is the optional platform package installed?)',
        'AST_BINARY_UNAVAILABLE',
        { cause: error instanceof Error ? error : undefined },
      )
    }
  })
}

/**
 * Build the `ast-grep run` argv for one tool call: the literal engine flags plus the model-supplied
 * pattern, optional rewrite template, language override, strictness, and glob filter, then the resolved
 * target paths. `--color never` keeps any plaintext output deterministic; `--json=stream` selects the
 * line-delimited match stream. Empty targets are omitted so ast-grep defaults to the workdir (`.`).
 * @param opts - the resolved, validated tool inputs.
 * @returns the complete argv vector (every element a literal; no shell layer).
 */
export function buildAstGrepArgv(opts: {
  pat: string
  rewrite?: string | undefined
  path?: string | undefined
  include?: string | undefined
  lang?: string | undefined
  strictness?: AstStrictness | undefined
}): string[] {
  const argv = ['run', '--color', 'never', '--json=stream', '--pattern', opts.pat]
  if (opts.rewrite !== undefined) argv.push('--rewrite', opts.rewrite)
  if (opts.lang !== undefined) argv.push('--lang', opts.lang)
  if (opts.strictness !== undefined) argv.push('--strictness', opts.strictness)
  if (opts.include !== undefined) argv.push('--globs', opts.include)
  for (const root of splitRoots(opts.path)) argv.push(root)
  return argv
}

/** Split a model `path` into roots (multipart via `;`), dropping empties. */
function splitRoots(path: string | undefined): string[] {
  if (path === undefined) return []
  return path.split(';').map(part => part.trim()).filter(part => part.length > 0)
}

/**
 * Run the packaged ast-grep binary with a plain argv vector and return its complete raw stdout.
 *
 * The working directory is the calling agent's session cwd (`exec.agent.session.header.cwd`) when
 * available, else `process.cwd()`. `exec.signal` is forwarded so the cooperative tool timeout and
 * caller cancellation terminate the process tree. The spawn is a plain `ctx.subprocess` call, so
 * relative target paths resolve against the workdir and `ast-grep` reads its per-project
 * `sgconfig.yml` for custom language configs.
 *
 * Outcome classification:
 * - exit 0 → matches present (`noMatches: false`)
 * - exit 1 → success with zero matches when stderr is empty; otherwise `AST_FIND_ERROR` with the
 *   stderr excerpt (a missing path is reported on stderr as `ERROR: ...` by ast-grep with exit 1)
 * - exit 2 → `AST_USAGE_ERROR` (CLI rejected the invocation; stderr carries the fixable message)
 * - anything else → `AST_FAILED`
 *
 * Aborts during the await become `AST_ABORTED` regardless of exit code; launch-time throws (the
 * binary resolution, a NUL in argv, a misbehaving seam) become `AST_FAILED` with the original as
 * `cause` unless the call was already aborted.
 *
 * @param ctx - the plugin context; execution uses its `subprocess` service.
 * @param exec - the tool-execution context; supplies the session cwd and the abort signal.
 * @param toolName - `ast_grep` or `ast_edit`, used in error messages.
 * @param argv - the ast-grep arguments (every model value an unquoted argv element).
 * @param caps - the resolved engine caps (raw output, grace, stderr) and the cooperative timeout.
 * @returns the complete stdout, the zero-result flag, and the resolved workdir.
 */
export async function runAstGrep(
  ctx: Context,
  exec: ToolExecution,
  toolName: string,
  argv: readonly string[],
  caps: { rawOutputMaxBytes: number; graceMs: number; stderrMaxBytes: number },
): Promise<AstRun> {
  if (exec.signal.aborted) {
    throw new AstError(`${toolName} was aborted before completion (tool timeout or caller cancellation)`, 'AST_ABORTED')
  }
  const cwd = exec.agent?.session.header.cwd
  const workdir = cwd ?? process.cwd()
  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv: [await astGrepPath(), ...argv],
      cwd: workdir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: caps.rawOutputMaxBytes },
        stderr: { maxBytes: caps.stderrMaxBytes },
      },
      graceMs: caps.graceMs,
      signal: exec.signal,
    } satisfies SubprocessSpawnSpec)
  } catch (error: unknown) {
    // The signal can abort while the spawn is awaited; the static narrowing that
    // proves this re-check "always false" cannot see AbortSignal state changes.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (exec.signal.aborted) {
      throw new AstError(`${toolName} was aborted before completion (tool timeout or caller cancellation)`, 'AST_ABORTED')
    }
    throw new AstError(`${toolName} could not start its engine (ast-grep launch failed)`, 'AST_FAILED', { cause: error })
  }
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new AstError(`${toolName} could not start its engine (ast-grep launch failed)`, 'AST_FAILED', { cause: error })
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) {
    throw new AstError(`${toolName} engine produced no collected output streams`, 'AST_FAILED')
  }
  // The signal can abort while the run is awaited; the static narrowing that
  // proves this re-check "always false" cannot see AbortSignal state changes.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (exec.signal.aborted) {
    throw new AstError(`${toolName} was aborted before completion (tool timeout or caller cancellation)`, 'AST_ABORTED')
  }
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new AstError(`${toolName} engine was killed by signal ${outcome.signal ?? '(unknown)'}`, 'AST_FAILED')
  }
  if (outcome.exitCode === 1 && stderr.text.trim().length === 0) {
    // ast-grep's "no match" exit is success-with-zero: exit 1 with a clean stderr.
    const text = stdout.text
    if (text.length > 0) throw new AstError(`${toolName} engine printed output without exit 0`, 'AST_FAILED')
    return { stdout: text, noMatches: true, workdir }
  }
  if (outcome.exitCode !== 0) {
    throw classifyAstFailure(toolName, outcome.exitCode, stderr)
  }
  const text = completeStdout(toolName, stdout, caps.rawOutputMaxBytes)
  if (text.length === 0) return { stdout: text, noMatches: true, workdir }
  // exit 0 guarantees at least one parseable match line; the parser enforces it.
  return { stdout: text, noMatches: false, workdir }
}

/** Classify a nonzero-exit ast-grep run into the tool's error vocabulary. */
function classifyAstFailure(toolName: string, exitCode: number, stderr: SubprocessOutputRead): AstError {
  let message = stderr.text
  if (message.startsWith('\u{FEFF}')) message = message.slice(1)
  const excerpt = stderr.lossy && message.length > 0 ? `${message} [stderr truncated]` : message
  // ast-grep writes missing/invalid target paths as `ERROR: <path>: ...` with exit 1 —
  // a find-time error, distinct from clap's lowercase `error:` usage diagnostics.
  if (/^ERROR:/um.test(message.trimStart())) {
    return new AstError(`${toolName} could not search the requested target: ${excerpt.trim() || 'see engine output'}`, 'AST_FIND_ERROR')
  }
  if (exitCode === 2 || /^error:/imu.test(message.trimStart())) {
    return new AstError(`${toolName} was rejected by ast-grep: ${excerpt.trim() || 'see engine output'}`, 'AST_USAGE_ERROR')
  }
  return new AstError(`${toolName} engine failed (exit ${exitCode}): ${excerpt.trim() || 'no diagnostic output'}`, 'AST_FAILED')
}

/** Bound raw stdout to the parse cap, failing `AST_RAW_OUTPUT_OVERFLOW` when the cap was hit or stayed truncated. */
function completeStdout(toolName: string, stdout: SubprocessOutputRead, maxBytes: number): string {
  const text = stdout.text
  if (text === '') return ''
  if (stdout.lossy) {
    throw new AstError(
      `${toolName} raw engine output exceeded the ${maxBytes}-byte cap; narrow the pattern, path, or include filter`,
      'AST_RAW_OUTPUT_OVERFLOW',
    )
  }
  return text
}

/** One parsed match from the `--json=stream` output. */
export interface AstMatchRecord {
  /** The matched node's source text. */
  text: string
  /** The containing line's full text (may include the match). */
  lines: string
  /** The file as the engine printed it (workdir-relative when the target was workdir-relative). */
  file: string
  /** Zero-based start line of the match. */
  startLine: number
  /** Zero-based start column of the match. */
  startColumn: number
  /** Byte offsets of the match within the file (as read by the engine), when present. */
  byteStart?: number
  byteEnd?: number
  /** Captured metavariables: name → matched text, in declaration order (single + multi, flattened). */
  captures: ReadonlyMap<string, string> | undefined
  /** The engine's language label for the file, when present. */
  language?: string
  /** The rewrite replacement text and byte range, when this run carried `--rewrite`. */
  rewrite?: { replacement: string; byteStart: number; byteEnd: number }
}

/** Parse one `--json=stream` line into a match record, or return `undefined` for a non-match line. */
function parseMatchRecord(line: string): AstMatchRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as {
    text?: unknown
    lines?: unknown
    file?: unknown
    range?: { start?: unknown; end?: unknown; byteOffset?: unknown } | null
    metaVariables?: { single?: unknown; multi?: unknown }
    language?: unknown
    replacement?: unknown
    replacementOffsets?: { start?: unknown; end?: unknown } | null
  }
  if (typeof record.text !== 'string' || typeof record.file !== 'string' || typeof record.range !== 'object' || record.range === null) {
    return undefined
  }
  const start = record.range.start as { line?: unknown; column?: unknown } | undefined
  if (typeof start?.line !== 'number' || typeof start.column !== 'number') return undefined
  const byteOffset = record.range.byteOffset as { start?: unknown; end?: unknown } | undefined
  const match: AstMatchRecord = {
    text: record.text,
    lines: typeof record.lines === 'string' ? record.lines : '',
    file: record.file,
    startLine: start.line,
    startColumn: start.column,
    captures: undefined,
    ...(typeof byteOffset?.start === 'number' && typeof byteOffset.end === 'number'
      ? { byteStart: byteOffset.start, byteEnd: byteOffset.end }
      : {}),
    ...(typeof record.language === 'string' ? { language: record.language } : {}),
  }
  captureVariables(record, match)
  if (typeof record.replacement === 'string'
    && typeof record.replacementOffsets === 'object' && record.replacementOffsets !== null
    && typeof record.replacementOffsets.start === 'number' && typeof record.replacementOffsets.end === 'number') {
    match.rewrite = { replacement: record.replacement, byteStart: record.replacementOffsets.start, byteEnd: record.replacementOffsets.end }
  }
  return match
}

/** Flatten ast-grep's `single` metavariables into an ordered name→text map. */
function captureVariables(record: { metaVariables?: { single?: unknown; multi?: unknown } }, match: AstMatchRecord): void {
  const single = record.metaVariables?.single
  let captures: Map<string, string> | undefined
  if (typeof single === 'object' && single !== null) {
    captures = new Map()
    for (const [name, value] of Object.entries(single)) {
      const text = (value as { text?: unknown } | null | undefined)?.text
      if (typeof text === 'string') captures.set(name, text)
    }
    if (captures.size === 0) captures = undefined
  }
  match.captures = captures
}

/**
 * Parse the complete `--json=stream` stdout into match records, in output order. Every non-blank
 * line must be a parseable match object rooted with the engine's `range`; anything else fails
 * `AST_FAILED` (never silently dropped) — mirroring the ripgrep tool's complete-output parse.
 * @param stdout - the complete raw `--json=stream` stdout.
 * @returns the parsed matches in engine order.
 * @throws AstError `AST_FAILED` for any malformed record.
 */
export function parseAstMatches(stdout: string): AstMatchRecord[] {
  const matches: AstMatchRecord[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const match = parseMatchRecord(line)
    if (match === undefined) {
      throw new AstError('ast-grep emitted a malformed JSON line; treating the run as failed', 'AST_FAILED')
    }
    matches.push(match)
  }
  return matches
}

/**
 * Convert an ast-grep byte range inside the LF-decoded text this host reads into JS string indices.
 * ast-grep reports byte offsets into the file as it read it; the tool reads the same file through
 * `ctx.fs.readText` (raw decode, no normalization beyond the backend's contract) and must splice a
 * rewrite at the same position. Byte offsets are counted over the file's UTF-8 encoding; this scans
 * the decoded string once accumulating per-code-point byte lengths.
 * @param content - the file text (same bytes the engine parsed).
 * @param startByte - inclusive byte offset of the replaced range.
 * @returns the JS string index for `startByte`, or `undefined` when the offset falls past the end.
 */
export function byteOffsetToIndex(content: string, startByte: number): number | undefined {
  let byteCursor = 0
  for (let index = 0; index <= content.length; index += 1) {
    if (byteCursor === startByte) return index
    if (byteCursor > startByte) return undefined
    if (index === content.length) break
    byteCursor += utf8Length(content.codePointAt(index) ?? 0)
  }
  return undefined
}

/** UTF-8 encoded length in bytes of one code point. */
function utf8Length(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

/**
 * Map a match's workdir-relative display path to its absolute target for `ctx.fs` resolution.
 * `file` is printed relative to the run workdir when the target was relative; absolute target paths
 * stay absolute. The caller joins the same workdir, so this mirrors `toWorkdirRelative`'s inverse.
 * @param file - the engine-printed path.
 * @param workdir - the resolved workdir.
 * @returns the join when `file` is relative; `file` unchanged when absolute.
 */
export function toWorkspaceTarget(file: string, workdir: string): string {
  if (isAbsolute(file)) return file
  return join(workdir, file)
}
