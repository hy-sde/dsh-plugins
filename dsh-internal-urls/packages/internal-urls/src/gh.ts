/**
 * Subprocess-backed accessors for the `issue://` / `pr://` protocols: one
 * unconfined `gh` CLI runner (through the `ctx.subprocess` seam, mirroring the
 * ripgrep spawn shape in `dsh-tool-fs-search`) and a git-remote helper that
 * derives the calling session's default `owner/repo`.
 * @module @hy-sde-org/dsh-internal-urls/gh
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** In-memory cap on one `gh` stdout collection (JSON listings, rendered bodies). */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024
/** Retained stderr diagnostic tail. */
const STDERR_MAX_BYTES = 64 * 1024
/** Terminate-escalation grace period for a child `gh`/`git` process. */
const GRACE_MS = 5_000

/** One completed subprocess run: complete stdout text + exit facts + stderr tail. */
export interface CommandRun {
  /** Complete stdout (the collection shape retains it within the byte cap). */
  stdout: string
  /** Exit code; non-zero means the command failed unless the caller treats it as data. */
  exitCode: number
  /** Whether the process died from a signal (killed/cancelled). */
  killed: boolean
  /** Retained stderr tail. */
  stderr: string
}

/** Thrown when a child command fails: exit or launch. Carries the stderr tail. */
export class CommandFailure extends Error {
  readonly exitCode: number | null
  readonly stderr: string

  constructor(message: string, options: { exitCode: number | null; stderr: string; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.exitCode = options.exitCode
    this.stderr = options.stderr
  }
}

/**
 * Run `argv` (a plain vector, never shell-interpreted) with `cwd` through the
 * subprocess seam, mirroring the ripgrep spawn shape: bounded stdout/stderr
 * collection, abort-signal forwarding, and a signal-kill classification.
 *
 * @param ctx - the plugin context; execution uses its `subprocess` service.
 * @param argv - executable and arguments; `argv[0]` names the program.
 * @param cwd - working directory for the child.
 * @param signal - caller's abort signal (tool cancellation / timeout).
 * @returns the complete stdout, exit facts, and stderr tail.
 * @throws {@link CommandFailure} when the process cannot start or is killed by
 *   a signal. A non-zero EXIT is returned as data — gh uses exit codes.
 */
export async function runCommand(ctx: Context, argv: readonly string[], cwd: string, signal: AbortSignal | undefined): Promise<CommandRun> {
  if (signal?.aborted) throw new CommandFailure('command was aborted before it could start', { exitCode: null, stderr: '' })
  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_STDOUT_BYTES },
        stderr: { maxBytes: STDERR_MAX_BYTES },
      },
      graceMs: GRACE_MS,
      ...(signal !== undefined ? { signal } : {}),
    } satisfies SubprocessSpawnSpec)
  } catch (error: unknown) {
    if (signal?.aborted) {
      throw new CommandFailure('command was aborted before completion', { exitCode: null, stderr: '', cause: error })
    }
    throw new CommandFailure(`${argv[0] ?? 'command'} could not start (launch failed)`, { exitCode: null, stderr: '', cause: error })
  }
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new CommandFailure(`${argv[0] ?? 'command'} could not start (launch failed)`, { exitCode: null, stderr: '', cause: error })
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) {
    throw new CommandFailure(`${argv[0] ?? 'command'} produced no collected output streams`, { exitCode: null, stderr: '' })
  }
  if (outcome.signal !== null) {
    throw new CommandFailure(`${argv[0] ?? 'command'} was killed by signal ${outcome.signal}`, {
      exitCode: outcome.exitCode,
      stderr: stderr.text,
    })
  }
  if (outcome.exitCode === null) {
    throw new CommandFailure(`${argv[0] ?? 'command'} exited without a code`, { exitCode: null, stderr: stderr.text })
  }
  return { stdout: stdout.text, exitCode: outcome.exitCode, killed: false, stderr: stderr.text }
}

/** Shorthand: a non-blank message label for a failed run. */
function ghError(message: string, run: CommandRun): Error {
  const stderr = run.stderr.trim()
  return new Error(stderr.length > 0 ? `${message}: ${stderr}` : message)
}

/** Run one `gh` JSON command; throws a user-friendly error on failure. */
export async function ghJson(ctx: Context, cwd: string, args: readonly string[], signal: AbortSignal | undefined): Promise<unknown> {
  const run = await runCommand(ctx, ['gh', ...args], cwd, signal)
  if (run.exitCode !== 0 || run.killed) throw ghError(`gh ${args[0] ?? ''} failed (exit ${run.exitCode})`, run)
  try {
    return JSON.parse(run.stdout)
  } catch (error: unknown) {
    throw new Error(`gh ${args[0] ?? ''} returned invalid JSON: ${String(error)}`, { cause: error })
  }
}

/** Run one `gh` text command (already a JSON form); returns stdout. */
export async function ghOutput(ctx: Context, cwd: string, args: readonly string[], signal: AbortSignal | undefined): Promise<string> {
  const run = await runCommand(ctx, ['gh', ...args], cwd, signal)
  if (run.exitCode !== 0 || run.killed) throw ghError(`gh ${args[0] ?? ''} failed (exit ${run.exitCode})`, run)
  return run.stdout
}

/**
 * Parse a git remote URL into `owner/repo`, handling the common shapes:
 * `https://github.com/owner/repo.git`, `git@github.com:owner/repo.git`,
 * `ssh://git@github.com/owner/repo.git`, and `owner/repo`.
 * @returns `owner/repo`, or `undefined` when the remote has no recognizable GitHub form.
 */
export function gitRemoteToRepo(remote: string): string | undefined {
  const value = remote.trim()
  if (value.length === 0) return undefined
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return value
  const match = /(?:github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(value)
  return match?.[1]
}

const DEFAULT_REPO_MEMO = new Map<string, Promise<string | undefined>>()

/**
 * The calling session's default `owner/repo` derived from the git remote of
 * `cwd`. Errors surface as a clear message so short-form reads
 * (`issue://123`) can tell the agent to name the repo explicitly.
 */
export function defaultRepoFromCwd(ctx: Context, cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  const key = cwd
  const cached = DEFAULT_REPO_MEMO.get(key)
  if (cached !== undefined) return cached
  const promise = (async () => {
    const run = await runCommand(ctx, ['git', 'config', '--get', 'remote.origin.url'], cwd, signal)
    if (run.exitCode !== 0) return undefined
    return gitRemoteToRepo(run.stdout)
  })()
  DEFAULT_REPO_MEMO.set(key, promise)
  return promise
}

/** Drop the memoized default-repo cache (tests and repo switches). */
export function resetDefaultRepoMemo(): void {
  DEFAULT_REPO_MEMO.clear()
}
