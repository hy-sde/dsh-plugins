/**
 * Engine for the tsfork device tools: binary resolution, project resolution,
 * one-shot spawn with closed stdin (the Go tsc never reads stdin, and a
 * half-open pipe is the classic wrapper-hang), capped output capture,
 * diagnostic parsing, and the build stamp parked next to the binary. Pure
 * `node:child_process` + `node:fs` — the tools layer owns schemas, prompt
 * guidance, and presentation.
 * @module @hy-sde-org/dsh-tool-tsfork/core
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Stable error vocabulary surfaced to the model. */
export type TsforkErrorCode =
  | 'binary_missing'
  | 'binary_not_executable'
  | 'project_missing'
  | 'spawn_failed'

/** Error thrown for deterministic, model-actionable failures. */
export class TsforkError extends Error {
  readonly code: TsforkErrorCode
  readonly detail: string | undefined

  constructor(code: TsforkErrorCode, message: string, detail?: string) {
    super(detail ? `${message} (${detail})` : message)
    this.name = 'TsforkError'
    this.code = code
    this.detail = detail
  }
}

/** Where this deployment parks the compiler (expandable `~`). */
export const TSFORK_DEFAULT_BINARY = '~/.dsh/tsfork/tsc'
/** Per-call process timeout when nothing else is configured (15 min: a full cold gate fits). */
export const TSFORK_DEFAULT_TIMEOUT_MS = 900_000
/** Cap on captured stdout/stderr bytes per side (default 4MB). */
export const TSFORK_MAX_OUTPUT_BYTES = 4_000_000
/** Cap on parsed diagnostics kept in the payload; counts stay exact beyond the cap. */
export const TSFORK_MAX_DIAGNOSTICS = 500

/** Expand a leading `~/` (or bare `~`) against the current home directory. */
export function expandTilde(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * Resolve the compiler binary to a real, executable file path.
 * @throws TsforkError `binary_missing` / `binary_not_executable`.
 */
export function resolveBinary(binary: string): string {
  const resolved = path.resolve(expandTilde(binary))
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new TsforkError('binary_missing', `tsfork compiler binary not found: ${resolved}`, binary)
  }
  if (!stat.isFile()) {
    throw new TsforkError('binary_missing', `tsfork compiler binary is not a file: ${resolved}`, binary)
  }
  try {
    fs.accessSync(resolved, fs.constants.X_OK)
  } catch {
    throw new TsforkError('binary_not_executable', `tsfork compiler binary is not executable: ${resolved}`, binary)
  }
  return fs.realpathSync(resolved)
}

/**
 * Resolve a `-b` project argument: a tsconfig file or a directory that
 * contains a tsconfig.json, against `cwd` when relative.
 * @throws TsforkError `project_missing`.
 */
export function resolveProjectPath(project: string, cwd: string): string {
  const abs = path.isAbsolute(project) ? project : path.resolve(cwd, project)
  if (fs.existsSync(abs)) return abs
  const inner = path.join(abs, 'tsconfig.json')
  if (fs.existsSync(inner)) return abs
  throw new TsforkError(
    'project_missing',
    `tsconfig project not found: ${abs} (looked for the path itself and for tsconfig.json inside it)`,
    project,
  )
}

/** Options for one compiler invocation. */
export interface TsforkRunOptions {
  /** Compiler binary (expandable `~`; resolved once by the caller). */
  binary: string
  /** argv after the binary, verbatim. */
  args: readonly string[]
  /** Working directory (expandable `~`; default process.cwd()). */
  cwd?: string | undefined
  /** Per-call timeout; on expiry the child gets SIGTERM then SIGKILL. */
  timeoutMs?: number | undefined
  /** Go scheduler cap written to the child env as GOMAXPROCS. */
  gomaxprocs?: number | undefined
  /** Cap on captured stdout/stderr bytes per side. */
  maxOutputBytes?: number | undefined
}

/** One completed (or timed-out) compiler invocation. */
export interface TsforkRun {
  /** Process exit code; null when killed by a signal or timed out before exit. */
  code: number | null
  signal: string | null
  timedOut: boolean
  wallMs: number
  stdout: string
  stderr: string
  truncated: boolean
}

/**
 * Spawn the compiler once and await its completion. Timed-out runs RESOLVE
 * (with `timedOut: true` and partial output) rather than reject — a timeout is
 * a valid, model-actionable result. Spawn failures (ENOENT, EACCES) reject
 * with TsforkError `spawn_failed`.
 */
export function runTsfork(options: TsforkRunOptions): Promise<TsforkRun> {
  const cwd = options.cwd === undefined ? process.cwd() : path.resolve(expandTilde(options.cwd))
  const timeoutMs = options.timeoutMs ?? TSFORK_DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? TSFORK_MAX_OUTPUT_BYTES
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (options.gomaxprocs !== undefined) env.GOMAXPROCS = String(options.gomaxprocs)

  return new Promise<TsforkRun>((resolve, reject) => {
    const started = Date.now()
    // stdio[0] = 'ignore': a held-open stdin pipe is the classic CLI-wrapper hang.
    const child = spawn(options.binary, [...options.args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes >= maxOutputBytes) { truncated = true; return }
      out.push(chunk)
      outBytes += chunk.length
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= maxOutputBytes) { truncated = true; return }
      err.push(chunk)
      errBytes += chunk.length
    })

    let escalate: NodeJS.Timeout | undefined
    // On timeout: SIGTERM now, SIGKILL 5s later — the escalation is scheduled
    // by the timeout, never at spawn (a spawn-time timer would kill healthy
    // long runs at exactly 5s).
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      escalate = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, 5_000)
    }, timeoutMs)

      const finish = (code: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (escalate !== undefined) clearTimeout(escalate)
      resolve({
        code,
        signal,
        timedOut,
        wallMs: Date.now() - started,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
      })
    }

    child.on('error', (cause: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(escalate)
      reject(new TsforkError('spawn_failed', `failed to spawn ${options.binary}: ${cause.message}`, cause.code))
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** One parsed tsc/tsgo diagnostic line. */
export interface TsforkDiagnostic {
  file: string | null
  line: number | null
  column: number | null
  code: string
  severity: 'error' | 'warning'
  message: string
}

export interface ParsedDiagnostics {
  diagnostics: TsforkDiagnostic[]
  errorCount: number
  warningCount: number
  truncated: boolean
}

const DIAGNOSTIC_LINE =
  /^(?:(?<file>.*?)(?:\((?<line>\d+),(?<column>\d+)\))?: )?(?<severity>error|warning) (?<code>TS\d+): (?<message>.+)$/

/**
 * Parse tsc/tsgo's default (non-pretty) diagnostics from combined output.
 * Lines without a diagnostic shape (summaries, notes) are ignored — they stay
 * reachable through the payload's `outputTail`.
 */
export function parseDiagnostics(output: string, cap: number = TSFORK_MAX_DIAGNOSTICS): ParsedDiagnostics {
  const diagnostics: TsforkDiagnostic[] = []
  let errorCount = 0
  let warningCount = 0
  let truncated = false
  for (const line of output.split('\n')) {
    const match = DIAGNOSTIC_LINE.exec(line.trimEnd())
    if (!match?.groups) continue
    const { file, line: lineNo, column, severity, code, message } = match.groups
    if (severity === 'error') errorCount += 1
    else warningCount += 1
    if (diagnostics.length >= cap) { truncated = true; continue }
    diagnostics.push({
      file: file ? file : null,
      line: lineNo === undefined ? null : Number(lineNo),
      column: column === undefined ? null : Number(column),
      code: code ?? '',
      severity: (severity ?? 'error') as 'error' | 'warning',
      message: message ?? '',
    })
  }
  return { diagnostics, errorCount, warningCount, truncated }
}

/** Extract `7.1.0-dev` from the compiler's `Version 7.1.0-dev` banner. */
export function parseVersionLine(output: string): string | null {
  const match = /Version (\S+)/.exec(output)
  return match?.[1] ?? null
}

/**
 * Read the build stamp parked next to the binary (`<dir>/VERSION`), if any —
 * records source branch, commit, and toolchain for provenance.
 */
export function readStamp(binary: string): string | null {
  try {
    return fs.readFileSync(path.join(path.dirname(binary), 'VERSION'), 'utf8').trim() || null
  } catch {
    return null
  }
}
