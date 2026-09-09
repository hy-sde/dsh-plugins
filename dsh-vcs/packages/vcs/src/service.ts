/**
 * The `ctx.vcs` service: a thin host-plane wrapper around the `pi-vcs` CLI
 * (the narrow native slice of the omp vcs surface — git rev-diffs and
 * staged diffs rendered in-process by gitoxide, plus a HEAD-change watch
 * companion) via the `ctx.subprocess` seam, modeled on `ctx.av`.
 *
 * Host-plane — the service holds no durable state and shells out per call, so
 * one instance serves every session. It is purely additive and
 * feature-detected: the git service (`ctx.git`, TS/git-CLI) stays the default
 * path, and the tools resolve this service only when a `pi-vcs` binary is
 * reachable (config → `DSH_VCS_PATH` → PATH) and probing clean.
 *
 * The CLI is user-installed like `av`; build from `native/pi-vcs-cli/` in
 * this repository. Without the binary, `probe()` reports `available: false`
 * and the read surfaces throw the launch error — callers degrade to the git
 * service.
 * @module @hy-sde-org/dsh-vcs/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { Effect, Scheduler } from 'effect'
import type {
  VcsDiffMode,
  VcsDiffOptions,
  VcsProbe,
  VcsRepoInfo,
  VcsStatusSummary,
  VcsWatchEvent,
} from './types.ts'

/**
 * Effect's default scheduler dispatches on `setImmediate`; the sync scheduler
 * dispatches on `queueMicrotask`, which vitest's fake timers do not mock. The
 * fork's tests use fake timers heavily, so every plugin-side Effect runtime
 * must pin the sync scheduler or cancel-without-advancing tests deadlock.
 */
const syncScheduler = new Scheduler.MixedScheduler('sync')

/** Plugin configuration for the vcs service. */
export interface Config {
  /** `pi-vcs` executable name or path (default `pi-vcs`, resolved through PATH). */
  vcsPath?: string
  /** Per-command wall-clock budget in ms (default 120000). */
  timeoutMs?: number
  /** In-memory cap on one collected stdout (default 8 MiB). */
  maxStdoutBytes?: number
  /** Retained stderr tail bytes (default 64 KiB). */
  maxStderrBytes?: number
  /** SIGTERM→SIGKILL grace in ms (default 5000). */
  graceMs?: number
  /** Poll interval for {@link watch} in ms (default 1000; forwarded to the CLI). */
  watchIntervalMs?: number
}

/**
 * A failed `pi-vcs` invocation. Carries the structured `code` from the CLI's
 * JSON stderr when the CLI reported one (e.g. `NotARepository`,
 * `RefNotFound`, `ObjectNotFound`, `Backend`, `Unsupported`).
 */
export class VcsCommandError extends Error {
  /** Process exit code of the failed vcs command (null when the process never exited). */
  readonly exitCode: number | null
  /** Captured stderr of the failed vcs command. */
  readonly stderr: string
  /** Structured CLI error code (VcsError taxonomy) when the CLI reported one. */
  readonly code?: string

  constructor(
    message: string,
    options: {
      exitCode: number | null
      stderr: string
      code?: string
      cause?: unknown
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.exitCode = options.exitCode
    this.stderr = options.stderr
    if (options.code !== undefined) this.code = options.code
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
const DEFAULT_WATCH_INTERVAL_MS = 1_000
const VERSION_PREFIX = 'pi-vcs '
const WATCH_READ_POLL_MS = 250

/**
 * Classify a spawn/done failure: an external abort wins, then the deadline,
 * then a plain launch failure — the same priority the hand-rolled
 * try/catch chains used. Pure (module-level) because it is called from inside
 * the `Effect.gen` scheduler body, which does not close over class `this`.
 */
function classifyAttemptError(
  command: string,
  limit: number,
  signal: AbortSignal | undefined,
  state: { timedOut: boolean },
  cause: unknown,
): VcsCommandError {
  if (signal?.aborted) {
    return new VcsCommandError(`pi-vcs ${command} was aborted before completion`, {
      exitCode: null,
      stderr: '',
      cause,
    })
  }
  if (state.timedOut) {
    return new VcsCommandError(`pi-vcs ${command} timed out after ${limit}ms`, {
      exitCode: null,
      stderr: '',
      cause,
    })
  }
  return new VcsCommandError(`pi-vcs ${command} could not start (launch failed)`, {
    exitCode: null,
    stderr: '',
    cause,
  })
}

/** The `ctx.vcs` service. */
export class VcsService extends Service {
  private readonly vcsPath: string
  private readonly timeoutMs: number
  private readonly maxStdoutBytes: number
  private readonly maxStderrBytes: number
  private readonly graceMs: number
  private readonly watchIntervalMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'vcs')
    this.vcsPath = config.vcsPath ?? process.env.DSH_VCS_PATH ?? 'pi-vcs'
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxStdoutBytes = config.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
    this.maxStderrBytes = config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
    this.graceMs = config.graceMs ?? DEFAULT_GRACE_MS
    this.watchIntervalMs = config.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS
  }

  /* ── availability probe ──────────────────────────────────────────────── */

  /**
   * Check whether the `pi-vcs` CLI is reachable and answering
   * `pi-vcs --version`. Never throws: an unavailable binary, launch failure,
   * or timeout surfaces as `{ available: false, reason }`. Feature-detection
   * gate for the read surfaces and the watch companion.
   * @returns reachability, CLI version when present, and a human reason on failure.
   */
  async probe(): Promise<VcsProbe> {
    try {
      const run = await this.run(['--version'], { cwd: process.cwd() })
      if (run.exitCode !== 0) {
        return {
          available: false,
          reason: `pi-vcs --version exited ${run.exitCode}: ${run.stderr.trim()}`,
        }
      }
      const firstLine = run.stdout.split('\n', 1)[0] ?? ''
      const version = firstLine.startsWith(VERSION_PREFIX)
        ? firstLine.slice(VERSION_PREFIX.length).trim()
        : firstLine.trim()
      return { available: true, ...(version.length > 0 ? { version } : {}) }
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /* ── narrow native slice ─────────────────────────────────────────────── */

  /**
   * Resolve repository discovery metadata (`pi-vcs repo-info <dir>`).
   * @param dir - any directory inside the checkout (walked toward the root).
   * @returns repo metadata, or `null` when `dir` is outside any git
   * repository (`NotARepository` is data, not an error).
   */
  async repoInfo(dir: string): Promise<VcsRepoInfo | null> {
    const run = await this.run(['repo-info', dir], { cwd: process.cwd() })
    if (run.exitCode !== 0) {
      const code = this.structuredCode(run.stderr)
      if (code === 'NotARepository') return null
      throw new VcsCommandError(
        `pi-vcs repo-info exited ${run.exitCode}: ${run.stderr.trim() || run.stdout.trim()}`,
        this.withCode({ exitCode: run.exitCode, stderr: run.stderr }, code),
      )
    }
    return this.parseJson(run.stdout, 'pi-vcs repo-info') as VcsRepoInfo
  }

  /**
   * Render the git patch between two revisions (`pi-vcs rev-diff <dir> <base>
   * [<head>]`). Output is git-compatible unified diff text, byte-compatible
   * with the git service's rendering, so existing diff parsers keep working.
   * @param dir - directory inside the checkout.
   * @param base - base revision (rev-parse spec).
   * @param head - head revision; `base`→worktree when omitted.
   * @returns the unified diff text (empty string when the range is clean).
   */
  async revDiff(dir: string, base: string, head?: string): Promise<string> {
    const argv = head === undefined ? ['rev-diff', dir, base] : ['rev-diff', dir, base, head]
    const run = await this.runChecked(argv, { cwd: process.cwd() })
    return run.stdout
  }

  /**
   * Render the staged patch (index vs HEAD) (`pi-vcs staged-diff <dir>`).
   * @param dir - directory inside the checkout.
   * @returns the unified diff text (empty string when nothing is staged).
   */
  async stagedDiff(dir: string): Promise<string> {
    const run = await this.runChecked(['staged-diff', dir], { cwd: process.cwd() })
    return run.stdout
  }

  /**
   * Render the worktree patch (index vs worktree) (`pi-vcs worktree-diff <dir>`),
   * the native counterpart to `git diff`. Untracked files are excluded, like
   * git itself.
   * @param dir - directory inside the checkout.
   * @param signal - optional abort.
   * @returns the unified diff text (empty string when the worktree is clean).
   */
  async worktreeDiff(dir: string, signal?: AbortSignal): Promise<string> {
    const run = await this.runChecked(['worktree-diff', dir], { cwd: process.cwd(), signal })
    return run.stdout
  }

  /**
   * Render one diff range in any CLI output mode. It picks the CLI verb from
   * the selectors (base+head → `rev-diff`, base only → base→worktree, cached →
   * `staged-diff`, none → `worktree-diff`) and appends the mode flag.
   * @param dir - directory inside the checkout.
   * @param options - range/mode selectors (see {@link VcsDiffOptions}).
   * @param signal - optional abort.
   * @returns the raw CLI text: unified diff, one path per line (`name-only`),
   * or `added\tremoved\tpath` lines (`numstat`), byte-compatible with the
   * corresponding `git diff` output.
   */
  async diff(
    dir: string,
    options: VcsDiffOptions & { mode?: VcsDiffMode } = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const modeFlag =
      options.mode === 'name-only' ? '--name-only' : options.mode === 'numstat' ? '--numstat' : ''
    if (options.base === undefined && options.head !== undefined) {
      throw new VcsCommandError('pi-vcs diff: head requires a base revision', {
        exitCode: null,
        stderr: '',
      })
    }
    const verbName =
      options.base !== undefined ? 'rev-diff' : options.cached === true ? 'staged-diff' : 'worktree-diff'
    const verbArgv: string[] = [verbName, dir]
    if (verbName === 'rev-diff') {
      verbArgv.push(options.base ?? '')
      if (options.head !== undefined) verbArgv.push(options.head)
    }
    if (modeFlag.length > 0) verbArgv.push(modeFlag)
    const run = await this.runChecked(verbArgv, { cwd: process.cwd(), signal })
    return run.stdout
  }

  /**
   * Changed-file names (`git diff --name-only`), one per line with the
   * destination path for renames and git's C-quoting preserved.
   * @param dir - directory inside the checkout.
   * @param options - range selectors (see {@link VcsDiffOptions}).
   * @param signal - optional abort.
   * @returns the changed paths, relative to the checkout root.
   */
  async changedFiles(dir: string, options: VcsDiffOptions = {}, signal?: AbortSignal): Promise<string[]> {
    const text = await this.diff(dir, { ...options, mode: 'name-only' }, signal)
    return text.split('\n').filter(line => line.length > 0)
  }

  /**
   * Raw `git diff --numstat` text. Callers parse with the git package's
   * `parseNumstat` (already byte-compatible with this output) when they need
   * typed entries.
   * @param dir - directory inside the checkout.
   * @param options - range selectors (see {@link VcsDiffOptions}).
   * @param signal - optional abort.
   * @returns `added\tremoved\tpath` lines (binary rows show `-`).
   */
  async numstat(dir: string, options: VcsDiffOptions = {}, signal?: AbortSignal): Promise<string> {
    return this.diff(dir, { ...options, mode: 'numstat' }, signal)
  }

  /**
   * Plain status summary counts, mirroring `ctx.git.status` by counting the
   * same `git status --porcelain` columns natively.
   * @param dir - directory inside the checkout.
   * @param signal - optional abort.
   * @returns staged/unstaged/untracked counts.
   */
  async status(dir: string, signal?: AbortSignal): Promise<VcsStatusSummary> {
    const run = await this.runChecked(['status', dir], { cwd: process.cwd(), signal })
    return this.parseJson(run.stdout, 'pi-vcs status') as VcsStatusSummary
  }

  /**
   * The current branch name (`pi-vcs repo-info <dir>`), or undefined on a
   * detached HEAD / outside any checkout.
   * @param dir - directory inside the checkout.
   * @returns the current branch name, or undefined when detached or outside
   * any checkout.
   */
  async branch(dir: string): Promise<string | undefined> {
    const info = await this.repoInfo(dir)
    return info?.branch ?? undefined
  }

  /**
   * Watch a repository for HEAD changes (`pi-vcs watch` companion).
   *
   * Spawns a long-running `pi-vcs watch <dir>` process, decodes its JSON-lines
   * protocol incrementally through the subprocess seam's offset-based reader,
   * and invokes `onChange` per `head` event. The returned disposer
   * terminates the process tree (SIGTERM → grace → SIGKILL) and stops
   * decoding; the process exits 0 on the signal, keeping
   * {@link VcsCommandError} out of the watch surface.
   * @param dir - directory inside the checkout.
   * @param onChange - called once per reported HEAD change.
   * @returns a disposer that stops the companion process and its decoders.
   */
  watch(dir: string, onChange: (event: VcsWatchEvent) => void): () => void {
    let handle: SubprocessHandle
    try {
      handle = this.subprocess().spawn({
        argv: [this.vcsPath, 'watch', dir, '--interval-ms', String(this.watchIntervalMs)],
        cwd: process.cwd(),
        graceMs: this.graceMs,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.maxStdoutBytes },
          stderr: { maxBytes: this.maxStderrBytes },
        },
      } satisfies SubprocessSpawnSpec)
    } catch (error: unknown) {
      throw new VcsCommandError('pi-vcs watch could not start (launch failed)', {
        exitCode: null,
        stderr: '',
        cause: error,
      })
    }

    let buffer = ''
    let offset = 0
    let disposed = false
    const reader = handle.collected.stdout

    const pump = (): void => {
      if (disposed || reader === undefined) return
      const read = reader.readFrom(offset)
      offset = read.nextOffset
      buffer += read.text
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        let event: unknown
        try {
          event = JSON.parse(trimmed)
        } catch {
          continue // partial/framing noise; the next read re-pads the buffer
        }
        if (
          (event as { event?: unknown } | null)?.event === 'head' &&
          typeof (event as Partial<VcsWatchEvent>).seq === 'number'
        ) {
          onChange(event as VcsWatchEvent)
        }
      }
    }
    const timer = setInterval(pump, WATCH_READ_POLL_MS)
    // Retain the outcome promise so an unexpected crash does not surface as an
    // unhandled rejection; the watch surface itself reports nothing (HEAD
    // simply stops moving, and the caller's disposer still cleans up).
    void handle.done.then((outcome: SubprocessOutcome) => {
      clearInterval(timer)
      if (!disposed && outcome.exitCode !== 0 && outcome.exitCode !== null) {
        // An unexpected exit (e.g. the repo vanished) stops events; keep the
        // error internal — probe()/repoInfo() are the error-reporting paths.
        void outcome
      }
    })

    return () => {
      disposed = true
      clearInterval(timer)
      handle.terminate()
    }
  }

  /* ── low-level runner ─────────────────────────────────────────────────── */

  private subprocess(): SubprocessRuntime {
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error(
        'vcs service requires the subprocess seam: load @deepseek-ai/dsh-subprocess-local',
      )
    }
    return subprocess
  }

  /**
   * Run one `pi-vcs` command. A non-zero exit code is returned as data on the
   * run (callers decide whether it is an error); only a launch failure, a
   * signal kill, or a timeout throws {@link VcsCommandError}.
   * @param argv - pi-vcs arguments (never shell-interpreted).
   * @param options - cwd (required), abort signal, stdin text, timeout override.
   * @returns exit code, collected stdout/stderr, and killed flag; throws {@link VcsCommandError} on launch/timeout/signal failures.
   */
  async run(
    argv: readonly string[],
    options: {
      cwd: string
      signal?: AbortSignal | undefined
      stdin?: string | undefined
      timeoutMs?: number
    },
  ): Promise<CommandRun> {
    const { cwd, signal, stdin } = options
    if (signal?.aborted) {
      throw new VcsCommandError('pi-vcs command was aborted before it could start', {
        exitCode: null,
        stderr: '',
      })
    }
    const limit = options.timeoutMs ?? this.timeoutMs
    // `Effect.gen` takes a `function*`, which does not close over the class
    // `this`; capture the internals as locals/arrows instead of aliasing this.
    const vcsPath = this.vcsPath
    const graceMs = this.graceMs
    const maxStdoutBytes = this.maxStdoutBytes
    const maxStderrBytes = this.maxStderrBytes
    const spawnVcs = (spec: SubprocessSpawnSpec): SubprocessHandle => this.subprocess().spawn(spec)
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const controller = new AbortController()
          const state = { timedOut: false }
          // Scope-owned deadline + signal forwarder: the release finalizer
          // clears the timer and detaches the listener on every exit path
          // (success, classified failure, future interruption) instead of
          // three hand-rolled cleanup sites. The timeout stays cooperative:
          // it aborts the child (SIGTERM → grace → SIGKILL via the seam) and
          // classification happens only after the process has settled —
          // `Effect.timeout*` is deliberately not used because it would
          // abandon the source instead of draining it.
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const onAbort = (): void => {
                controller.abort()
              }
              const timer = setTimeout(() => {
                state.timedOut = true
                controller.abort()
              }, limit)
              signal?.addEventListener('abort', onAbort, { once: true })
              return { timer, onAbort }
            }),
            armed =>
              Effect.sync(() => {
                clearTimeout(armed.timer)
                signal?.removeEventListener('abort', armed.onAbort)
              }),
          )
          const spawned = yield* Effect.try(() =>
            spawnVcs({
              argv: [vcsPath, ...argv],
              cwd,
              graceMs,
              stdio: {
                stdin: stdin === undefined ? 'ignore' : { data: stdin },
                stdout: { maxBytes: maxStdoutBytes },
                stderr: { maxBytes: maxStderrBytes },
              },
              signal: controller.signal,
            } satisfies SubprocessSpawnSpec),
          ).pipe(
            Effect.match({
              onSuccess: handle => ({ ok: true as const, handle }),
              onFailure: error => ({ ok: false as const, error }),
            }),
          )
          if (!spawned.ok) {
            return yield* Effect.fail(
              classifyAttemptError(argv[0] ?? '', limit, signal, state, spawned.error),
            )
          }
          const settled = yield* Effect.tryPromise<SubprocessOutcome>(() => spawned.handle.done).pipe(
            Effect.match({
              onSuccess: outcome => ({ ok: true as const, outcome }),
              onFailure: error => ({ ok: false as const, error }),
            }),
          )
          if (!settled.ok) {
            return yield* Effect.fail(
              classifyAttemptError(argv[0] ?? '', limit, signal, state, settled.error),
            )
          }
          const stdout = spawned.handle.collected.stdout?.readFrom(0)
          const stderr = spawned.handle.collected.stderr?.readFrom(0)
          if (stdout === undefined || stderr === undefined) {
            return yield* Effect.fail(
              new VcsCommandError(`pi-vcs ${argv[0] ?? ''} produced no collected output streams`, {
                exitCode: null,
                stderr: '',
              }),
            )
          }
          if (state.timedOut) {
            return yield* Effect.fail(
              new VcsCommandError(`pi-vcs ${argv[0] ?? ''} timed out after ${limit}ms`, {
                exitCode: null,
                stderr: stderr.text,
              }),
            )
          }
          if (settled.outcome.signal !== null) {
            return yield* Effect.fail(
              new VcsCommandError(
                `pi-vcs ${argv[0] ?? ''} was killed by signal ${settled.outcome.signal}`,
                {
                  exitCode: settled.outcome.exitCode,
                  stderr: stderr.text,
                },
              ),
            )
          }
          return {
            stdout: stdout.text,
            exitCode: settled.outcome.exitCode ?? 0,
            killed: false,
            stderr: stderr.text,
          }
        }),
      ),
      { scheduler: syncScheduler },
    )
  }

  /** Run one `pi-vcs` command and require a clean exit (exit 0). */
  private async runChecked(
    argv: readonly string[],
    options: { cwd: string; signal?: AbortSignal | undefined; timeoutMs?: number },
  ): Promise<CommandRun> {
    const run = await this.run(argv, options)
    if (run.exitCode !== 0) {
      throw new VcsCommandError(
        `pi-vcs ${argv[0] ?? ''} exited ${run.exitCode}: ${
          run.stderr.trim() || run.stdout.trim()
        }`,
        this.withCode(
          { exitCode: run.exitCode, stderr: run.stderr },
          this.structuredCode(run.stderr),
        ),
      )
    }
    return run
  }

  /** Add the structured `code` option when the CLI reported one. */
  private withCode(
    options: { exitCode: number | null; stderr: string },
    code: string | undefined,
  ): { exitCode: number | null; stderr: string; code?: string } {
    return code === undefined ? options : { ...options, code }
  }

  /** Pull the structured `code` out of a CLI JSON stderr line, if present. */
  private structuredCode(stderr: string): string | undefined {
    const line = stderr.trim().split('\n', 1)[0] ?? ''
    if (!line.startsWith('{')) return undefined
    try {
      const parsed = JSON.parse(line) as { code?: unknown }
      return typeof parsed.code === 'string' ? parsed.code : undefined
    } catch {
      return undefined
    }
  }

  /** Parse one JSON surface; keep the report shape terse on failure. */
  private parseJson(stdout: string, surface: string): unknown {
    try {
      return JSON.parse(stdout)
    } catch (error) {
      throw new VcsCommandError(`${surface} produced unparseable output`, {
        exitCode: null,
        stderr: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
