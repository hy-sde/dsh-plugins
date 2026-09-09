/**
 * The `ctx.av` service: a thin, read-only wrapper around the Automic Vault CLI
 * via the `ctx.subprocess` seam. Host-plane — the service holds no durable
 * state and shells out per call, so one instance serves every session; the
 * model-facing tools live in `@hy-sde-org/dsh-tool-av` and resolve this host
 * instance.
 *
 * The service resolves the `av` executable (config → `DSH_AV_PATH` → PATH),
 * probes it once per call with `av --version`, and parses the JSON surfaces
 * `av scan --json`, `av doctor [tool] --json`, `av detectors --json` and
 * `av hardeners --json`, plus `av list` (secret NAMES only — a hard limit).
 * It never invokes the value-releasing verbs (`av inject` / `av proxy` /
 * `av save` / `av harden`): those stay human-in-the-loop in a terminal the
 * user controls.
 * @module @hy-sde-org/dsh-av/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type {
  AvProbe,
  DetectorsReport,
  DoctorReport,
  HardenersReport,
  ScanReport,
} from './types.ts'

/** Plugin configuration for the av service. */
export interface Config {
  /** `av` executable name or path (default `av`, resolved through PATH). */
  avPath?: string
  /** Per-command wall-clock budget in ms (default 120000). */
  timeoutMs?: number
  /** In-memory cap on one collected stdout (default 8 MiB). */
  maxStdoutBytes?: number
  /** Retained stderr tail bytes (default 64 KiB). */
  maxStderrBytes?: number
  /** SIGTERM→SIGKILL grace in ms (default 5000). */
  graceMs?: number
}

/** A failed `av` invocation: exit status plus stderr retained for the agent. */
export class AvCommandError extends Error {
  /** Process exit code of the failed av command (null when the process never exited). */
  readonly exitCode: number | null
  /** Captured stderr of the failed av command. */
  readonly stderr: string

  constructor(message: string, options: { exitCode: number | null; stderr: string; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.exitCode = options.exitCode
    this.stderr = options.stderr
  }
}

/** One completed subprocess run. */
export interface CommandRun {
  stdout: string
  exitCode: number
  killed: boolean
  stderr: string
}

/** Default per-command timeout. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Default stdout collection cap. */
export const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_GRACE_MS = 5_000
const VERSION_PREFIX = 'av '

/** The `ctx.av` service. */
export class AvService extends Service {
  private readonly avPath: string
  private readonly timeoutMs: number
  private readonly maxStdoutBytes: number
  private readonly maxStderrBytes: number
  private readonly graceMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'av')
    this.avPath = config.avPath ?? process.env.DSH_AV_PATH ?? 'av'
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxStdoutBytes = config.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
    this.maxStderrBytes = config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
    this.graceMs = config.graceMs ?? DEFAULT_GRACE_MS
  }

  /* ── availability probe ──────────────────────────────────────────────── */

  /**
   * Check whether the `av` CLI is reachable and answering `av --version`.
   * Never throws: an unavailable binary, launch failure, or timeout surfaces
   * as `{ available: false, reason }`.
   * @returns reachability, CLI version when present, and a human reason on failure.
   */
  async probe(): Promise<AvProbe> {
    try {
      const run = await this.run(['--version'], { cwd: process.cwd() })
      if (run.exitCode !== 0) {
        return { available: false, reason: `av --version exited ${run.exitCode}: ${run.stderr.trim()}` }
      }
      const firstLine = run.stdout.split('\n', 1)[0] ?? ''
      const version = firstLine.startsWith(VERSION_PREFIX) ? firstLine.slice(VERSION_PREFIX.length).trim() : firstLine.trim()
      return { available: true, ...version.length > 0 ? { version } : {} }
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /* ── read-only surfaces ──────────────────────────────────────────────── */

  /**
   * Audit the Mac for supported credential exposures and hazards
   * (`av scan --json`).
   * @param detectors - optional detector-name filter (from `detectors()`); empty means all.
   * @returns the parsed `av scan --json` report.
   */
  async scan(detectors: readonly string[] = []): Promise<ScanReport> {
    const argv = detectors.length > 0 ? ['scan', '--json', ...detectors] : ['scan', '--json']
    const run = await this.runChecked(argv, { cwd: process.cwd() })
    return this.parseJson(run.stdout, 'av scan') as ScanReport
  }

  /**
   * Verify installed hardening (`av doctor [tool] --json`).
   * @param selector - optional tool name (e.g. `gh`); empty means all.
   * @returns the parsed `av doctor [tool] --json` report.
   */
  async doctor(selector?: string): Promise<DoctorReport> {
    const argv = selector === undefined || selector.length === 0 ? ['doctor', '--json'] : ['doctor', selector, '--json']
    const run = await this.runChecked(argv, { cwd: process.cwd() })
    return this.parseJson(run.stdout, 'av doctor') as DoctorReport
  }

  /**
   * Print detector metadata (`av detectors --json`).
   * @returns the parsed report.
   */
  async detectors(): Promise<DetectorsReport> {
    const run = await this.runChecked(['detectors', '--json'], { cwd: process.cwd() })
    return this.parseJson(run.stdout, 'av detectors') as DetectorsReport
  }

  /**
   * Print hardener metadata (`av hardeners --json`).
   * @returns the parsed report.
   */
  async hardeners(): Promise<HardenersReport> {
    const run = await this.runChecked(['hardeners', '--json'], { cwd: process.cwd() })
    return this.parseJson(run.stdout, 'av hardeners') as HardenersReport
  }

  /**
   * List saved secret names (`av list`). NAMES only — never values; the
   * value-releasing verbs are deliberately out of this service's surface.
   * @returns sorted saved secret names (only names, never values).
   */
  async list(): Promise<string[]> {
    const run = await this.runChecked(['list'], { cwd: process.cwd() })
    return run.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  }

  /* ── low-level runner ─────────────────────────────────────────────────── */

  private subprocess(): SubprocessRuntime {
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error('av service requires the subprocess seam: load @deepseek-ai/dsh-subprocess-local')
    }
    return subprocess
  }

  /**
   * Run one `av` command. A non-zero exit code is returned as data on the run
   * (callers decide whether it is an error); only a launch failure, a signal
   * kill, or a timeout throws {@link AvCommandError}.
   * @param argv - av arguments (never shell-interpreted).
   * @param options - cwd (required), abort signal, stdin text, timeout override.
   * @returns exit code, collected stdout/stderr, and killed flag; throws {@link AvCommandError} on launch/timeout/signal failures.
   */
  async run(
    argv: readonly string[],
    options: { cwd: string; signal?: AbortSignal | undefined; stdin?: string | undefined; timeoutMs?: number },
  ): Promise<CommandRun> {
    const { cwd, signal, stdin } = options
    if (signal?.aborted) {
      throw new AvCommandError('av command was aborted before it could start', { exitCode: null, stderr: '' })
    }
    const limit = options.timeoutMs ?? this.timeoutMs
    const controller = new AbortController()
    // Mutable through the timeout closure; a record keeps the flag out of TS's
    // synchronous narrowing so the concurrent timer branch stays reachable.
    const state = { timedOut: false }
    const timer = setTimeout(() => {
      state.timedOut = true
      controller.abort()
    }, limit)
    const forward = () => {
      controller.abort()
    }
    if (signal !== undefined) {
      signal.addEventListener('abort', forward, { once: true })
    }
    let handle: SubprocessHandle
    try {
      handle = this.subprocess().spawn({
        argv: [this.avPath, ...argv],
        cwd,
        graceMs: this.graceMs,
        stdio: {
          stdin: stdin === undefined ? 'ignore' : { data: stdin },
          stdout: { maxBytes: this.maxStdoutBytes },
          stderr: { maxBytes: this.maxStderrBytes },
        },
        signal: controller.signal,
      } satisfies SubprocessSpawnSpec)
    } catch (error: unknown) {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', forward)
      if (signal?.aborted) {
        throw new AvCommandError('av command was aborted before completion', { exitCode: null, stderr: '', cause: error })
      }
      if (state.timedOut) {
        throw new AvCommandError(`av ${argv[0] ?? ''} timed out after ${limit}ms`, { exitCode: null, stderr: '', cause: error })
      }
      throw new AvCommandError(`av ${argv[0] ?? ''} could not start (launch failed)`, {
        exitCode: null,
        stderr: '',
        cause: error,
      })
    }
    let outcome: SubprocessOutcome
    try {
      outcome = await handle.done
    } catch (error: unknown) {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', forward)
      if (state.timedOut) {
        throw new AvCommandError(`av ${argv[0] ?? ''} timed out after ${limit}ms`, { exitCode: null, stderr: '', cause: error })
      }
      throw new AvCommandError(`av ${argv[0] ?? ''} could not start (launch failed)`, {
        exitCode: null,
        stderr: '',
        cause: error,
      })
    }
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', forward)
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout === undefined || stderr === undefined) {
      throw new AvCommandError(`av ${argv[0] ?? ''} produced no collected output streams`, {
        exitCode: null,
        stderr: '',
      })
    }
    if (state.timedOut) {
      throw new AvCommandError(`av ${argv[0] ?? ''} timed out after ${limit}ms`, { exitCode: null, stderr: stderr.text })
    }
    if (outcome.signal !== null) {
      throw new AvCommandError(`av ${argv[0] ?? ''} was killed by signal ${outcome.signal}`, {
        exitCode: outcome.exitCode,
        stderr: stderr.text,
      })
    }
    // After the signal-kill branch above, the process exited on its own:
    // the signal is null and the exit code is a real number.
    return { stdout: stdout.text, exitCode: outcome.exitCode ?? 0, killed: false, stderr: stderr.text }
  }

  /** Run one `av` command and require a clean exit (exit 0). */
  private async runChecked(
    argv: readonly string[],
    options: { cwd: string; signal?: AbortSignal | undefined; timeoutMs?: number },
  ): Promise<CommandRun> {
    const run = await this.run(argv, options)
    if (run.exitCode !== 0) {
      throw new AvCommandError(`av ${argv[0] ?? ''} exited ${run.exitCode}: ${run.stderr.trim() || run.stdout.trim()}`, {
        exitCode: run.exitCode,
        stderr: run.stderr,
      })
    }
    return run
  }

  /** Parse one JSON surface; keep the report shape terse on failure. */
  private parseJson(stdout: string, surface: string): unknown {
    try {
      return JSON.parse(stdout)
    } catch (error) {
      throw new AvCommandError(`${surface} produced unparseable output`, {
        exitCode: null,
        stderr: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
