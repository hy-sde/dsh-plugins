/**
 * The `ctx.git` service: a thin, read-through-write wrapper around the `git`
 * CLI via the `ctx.subprocess` seam, plus the diff-parsing primitives and the
 * split-commit execution verbs (hunk staging, dependency-ordered commit, lock
 * files). Host-plane — the service holds no durable state and shells out per
 * call, so one instance serves every session; the model-facing tools live in
 * `@hy-sde-org/dsh-tool-git` and resolve this host instance.
 *
 * Port of the omp (oh-my-pi) git layer, reduced to what the commit + review
 * workflows need: `git` CLI execution, diff capture/parsing, status, hunk
 * staging, commit/push. See LICENSE.
 * @module @hy-sde-org/dsh-git/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  parseFileDiffs,
  parseFileHunks,
  parseNumstat,
  selectHunks,
  extractFileHeader,
} from './diff.ts'
import type {
  FileChange,
  FileDiff,
  GitLogEntry,
  GitStatusSummary,
  NumstatEntry,
} from './types.ts'
import { joinPatches } from './vcs.ts'

/** Plugin configuration for the git service. */
export interface Config {
  /** `git` executable name (default `git`; resolved through the subprocess seam). */
  gitPath?: string
  /** Per-command wall-clock budget in ms (default 120000). */
  timeoutMs?: number
  /** In-memory cap on one collected stdout (default 8 MiB). */
  maxStdoutBytes?: number
  /** Retained stderr tail bytes (default 64 KiB). */
  maxStderrBytes?: number
  /** SIGTERM→SIGKILL grace in ms (default 5000). */
  graceMs?: number
}

/** The `diff` namespace surface of `ctx.git` (read shapes, mirrors omp). */
export interface GitDiffNamespace {
  changedFiles(cwd: string, options?: { cached?: boolean; files?: readonly string[]; signal?: AbortSignal }): Promise<string[]>
  numstat(cwd: string, options?: { cached?: boolean; signal?: AbortSignal }): Promise<NumstatEntry[]>
  has(cwd: string, options?: { cached?: boolean; files?: readonly string[]; signal?: AbortSignal }): Promise<boolean>
}

/** A failed `git` invocation: exit status plus stderr retained for the agent. */
export class GitCommandError extends Error {
  readonly exitCode: number | null
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

interface DiffOptions {
  cached?: boolean
  binary?: boolean
  nameOnly?: boolean
  numstat?: boolean
  /** Base revision (e.g. `HEAD~3`); with `head` forms a range. */
  base?: string
  head?: string
  files?: readonly string[]
}

/** Options accepted by the helpers that require a clean exit (checked/text). */
interface UncheckedRunOptions {
  cwd: string
  signal?: AbortSignal | undefined
  stdin?: string | undefined
}

/** Default per-command timeout. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Default stdout collection cap. */
export const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_GRACE_MS = 5_000

/** The `ctx.git` service. */
export class GitService extends Service {
  private readonly gitPath: string
  private readonly timeoutMs: number
  private readonly maxStdoutBytes: number
  private readonly maxStderrBytes: number
  private readonly graceMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'git')
    this.gitPath = config.gitPath ?? 'git'
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxStdoutBytes = config.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
    this.maxStderrBytes = config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
    this.graceMs = config.graceMs ?? DEFAULT_GRACE_MS
  }

  /* ── low-level runner ──────────────────────────────────────────────────── */

  private subprocess(): SubprocessRuntime {
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error('git service requires the subprocess seam: load @deepseek-ai/dsh-subprocess-local')
    }
    return subprocess
  }

  /**
   * Run one `git` command against `cwd`. A non-zero exit code is returned as
   * data on the run (callers decide whether it is an error); only a launch
   * failure, a signal kill, or a timeout throws {@link GitCommandError}.
   * @param argv - git arguments (never shell-interpreted).
   * @param options - cwd (required), abort signal, stdin text, timeout override.
   * @returns exit code, stdout, stderr; throws {@link GitCommandError} only for launch/timeout/signal failures.
   */
  async run(
    argv: readonly string[],
    options: { cwd: string; signal?: AbortSignal | undefined; stdin?: string | undefined; timeoutMs?: number },
  ): Promise<CommandRun> {
    const { cwd, signal, stdin } = options
    if (signal?.aborted) {
      throw new GitCommandError('git command was aborted before it could start', { exitCode: null, stderr: '' })
    }
    const limit = options.timeoutMs ?? this.timeoutMs
    const controller = new AbortController()
    const timerState: { timedOut: boolean } = { timedOut: false }
    const timer = setTimeout(() => {
      timerState.timedOut = true
      controller.abort()
    }, limit)
    const forward = (): void => { controller.abort() }
    if (signal !== undefined) {
      signal.addEventListener('abort', forward, { once: true })
    }
    let handle: SubprocessHandle
    try {
      handle = this.subprocess().spawn({
        argv: [this.gitPath, ...argv],
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
        throw new GitCommandError('git command was aborted before completion', { exitCode: null, stderr: '', cause: error })
      }
      if (timerState.timedOut) {
        throw new GitCommandError(`git ${argv[0] ?? ''} timed out after ${limit}ms`, { exitCode: null, stderr: '', cause: error })
      }
      throw new GitCommandError(`git ${argv[0] ?? ''} could not start (launch failed)`, {
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
      if (timerState.timedOut) {
        throw new GitCommandError(`git ${argv[0] ?? ''} timed out after ${limit}ms`, { exitCode: null, stderr: '', cause: error })
      }
      throw new GitCommandError(`git ${argv[0] ?? ''} could not start (launch failed)`, {
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
      throw new GitCommandError(`git ${argv[0] ?? ''} produced no collected output streams`, {
        exitCode: null,
        stderr: '',
      })
    }
    if (timerState.timedOut) {
      throw new GitCommandError(`git ${argv[0] ?? ''} timed out after ${limit}ms`, { exitCode: null, stderr: stderr.text })
    }
    if (outcome.signal !== null) {
      throw new GitCommandError(`git ${argv[0] ?? ''} was killed by signal ${outcome.signal}`, {
        exitCode: outcome.exitCode,
        stderr: stderr.text,
      })
    }
    if (outcome.exitCode === null) {
      throw new GitCommandError(`git ${argv[0] ?? ''} exited without a code`, { exitCode: null, stderr: stderr.text })
    }
    return { stdout: stdout.text, exitCode: outcome.exitCode, killed: false, stderr: stderr.text }
  }

  /** Run a command and require exit 0, throwing a readable {@link GitCommandError}. */
  private async checked(argv: readonly string[], options: UncheckedRunOptions): Promise<CommandRun> {
    const run = await this.run(argv, options)
    if (run.exitCode !== 0) {
      const stderr = run.stderr.trim()
      const label = `git ${argv[0] ?? ''} failed (exit ${run.exitCode})`
      throw new GitCommandError(stderr.length > 0 ? `${label}: ${stderr}` : label, {
        exitCode: run.exitCode,
        stderr: run.stderr,
      })
    }
    return run
  }

  /** Run a command requiring exit 0 and return its stdout text. */
  private async text(argv: readonly string[], options: UncheckedRunOptions): Promise<string> {
    return (await this.checked(argv, options)).stdout
  }

  /* ── repository state ──────────────────────────────────────────────────── */

  /**
   * True when `cwd` is inside a git working tree.
   * @param cwd - working directory to probe.
   * @param signal - optional abort.
   * @returns whether `cwd` is a git working tree (never throws).
   */
  async isRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const run = await this.run(['rev-parse', '--is-inside-work-tree'], { cwd, signal })
      return run.exitCode === 0 && run.stdout.trim() === 'true'
    } catch {
      return false
    }
  }

  /**
   * The repository root (`git rev-parse --show-toplevel`).
   * @param cwd - working directory inside the repository.
   * @param signal - optional abort.
   * @returns the absolute repository root.
   */
  async root(cwd: string, signal?: AbortSignal): Promise<string> {
    return (await this.text(['rev-parse', '--show-toplevel'], { cwd, signal })).trim()
  }

  /**
   * The current branch name, or undefined when detached.
   * @param cwd - working directory inside the repository.
   * @param signal - optional abort.
   * @returns the branch name, or undefined on a detached HEAD.
   */
  async branch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    const value = (await this.text(['branch', '--show-current'], { cwd, signal })).trim()
    return value.length > 0 ? value : undefined
  }

  /**
   * Plain status summary: staged/unstaged/untracked counts.
   * @param cwd - working directory inside the repository.
   * @param signal - optional abort.
   * @returns counts of staged, unstaged and untracked entries.
   */
  async status(cwd: string, signal?: AbortSignal): Promise<GitStatusSummary> {
    const output = await this.text(['status', '--porcelain'], { cwd, signal })
    let staged = 0
    let unstaged = 0
    let untracked = 0
    for (const line of output.split('\n')) {
      if (!line) continue
      const x = line[0]
      const y = line[1]
      if (x === '?' && y === '?') {
        untracked += 1
        continue
      }
      if (x && x !== ' ' && x !== '?') staged += 1
      if (y && y !== ' ') unstaged += 1
    }
    return { staged, unstaged, untracked }
  }

  /**
   * True when the index differs from HEAD (something is staged).
   * @param cwd - working directory inside the repository.
   * @param signal - optional abort.
   * @returns whether there is anything staged.
   */
  async hasStaged(cwd: string, signal?: AbortSignal): Promise<boolean> {
    const run = await this.run(['diff', '--cached', '--quiet'], { cwd, signal })
    return run.exitCode !== 0
  }

  /* ── diff ──────────────────────────────────────────────────────────────── */

  /**
   * Whole raw diff text; non-zero exit is an error unless `allowFailure`.
   * @param cwd - working directory inside the repository.
   * @param options - cached vs worktree, pathspec files, binary, name-only, numstat, allowFailure.
   * @param signal - optional abort.
   * @returns the diff text.
   */
  async diffText(cwd: string, options: DiffOptions & { allowFailure?: boolean } = {}, signal?: AbortSignal): Promise<string> {
    const args = this.buildDiffArgs(options)
    if (options.allowFailure) {
      return (await this.run(args, { cwd, signal })).stdout
    }
    return this.text(args, { cwd, signal })
  }

  /** Diff namespace (mirrors omp's `diff.*`) for the derived read shapes. */
  readonly diff: GitDiffNamespace = {
    changedFiles: (cwd: string, options: { cached?: boolean; files?: readonly string[]; signal?: AbortSignal } = {}): Promise<string[]> =>
      this.diffText(cwd, { ...options, nameOnly: true }, options.signal).then(splitLines),
    numstat: (cwd: string, options: { cached?: boolean; signal?: AbortSignal } = {}): Promise<NumstatEntry[]> =>
      this.diffText(cwd, { ...options, numstat: true }, options.signal).then(parseNumstat),
    has: async (cwd: string, options: { cached?: boolean; files?: readonly string[]; signal?: AbortSignal } = {}): Promise<boolean> => {
      const args = ['diff']
      if (options.cached) args.push('--cached')
      args.push('--quiet')
      if (options.files?.length) args.push('--', ...options.files)
      const run = await this.run(args, { cwd, signal: options.signal })
      return run.exitCode !== 0
    },
  }

  /**
   * Parsed file diff sections for `pathSpec` (defaults to the whole cached diff).
   * @param cwd - working directory inside the repository.
   * @param options - cached vs worktree and pathspec filter.
   * @returns one parsed section per changed file.
   */
  async fileDiffs(
    cwd: string,
    options: { cached?: boolean; files?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<FileDiff[]> {
    const diffText = await this.diffText(cwd, {
      cached: options.cached ?? true,
      ...(options.files !== undefined ? { files: options.files } : {}),
    }, options.signal)
    return parseFileDiffs(diffText)
  }

  /**
   * Selectively stage whole files or hunks from a diff that is already in the
   * index (the `--cached` view). Direct port of omp `stage.hunks`: rebuilds a
   * patch from the recorded diff and applies it to the index.
   * @param cwd - working directory inside the repository.
   * @param selections - file/hunk selections to stage.
   * @param options - the raw cached diff to slice from (defaults to `git diff --cached`).
   */
  async stageHunks(
    cwd: string,
    selections: readonly FileChange[],
    options: { rawDiff?: string; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (selections.length === 0) return
    const rawDiff = options.rawDiff ?? (await this.diffText(cwd, { cached: true }, options.signal))
    const fileDiffMap = new Map(parseFileDiffs(rawDiff).map(entry => [entry.filename, entry]))
    const patchParts: string[] = []

    for (const selection of selections) {
      const fileDiff = fileDiffMap.get(selection.path)
      if (!fileDiff) throw new Error(`No diff found for ${selection.path}`)
      if (fileDiff.isBinary) {
        if (selection.hunks.type !== 'all') {
          throw new Error(`Cannot select hunks for binary file ${selection.path}`)
        }
        patchParts.push(fileDiff.content)
        continue
      }
      if (selection.hunks.type === 'all') {
        patchParts.push(fileDiff.content)
        continue
      }
      const fileHunks = parseFileHunks(fileDiff)
      const selected = selectHunks(fileHunks, selection.hunks)
      if (selected.length === 0) throw new Error(`No hunks selected for ${selection.path}`)
      const header = extractFileHeader(fileDiff.content)
      patchParts.push([header, ...selected.map(h => h.content)].join('\n'))
    }

    const patchText = patchJoin(patchParts)
    if (!patchText.trim()) return
    await this.applyPatchText(cwd, patchText, { cached: true, signal: options.signal })
  }

  /**
   * Apply a patch string (to the index with `cached: true`, as split staging needs).
   * @param cwd - working directory inside the repository.
   * @param patchText - unified diff text piped to `git apply`.
   * @param options - cached vs worktree, reverse direction, abort signal.
   */
  async applyPatchText(
    cwd: string,
    patchText: string,
    options: { cached?: boolean; reverse?: boolean; signal?: AbortSignal | undefined } = {},
  ): Promise<void> {
    if (!patchText.trim()) return
    const args = ['apply']
    if (options.cached) args.push('--cached')
    if (options.reverse) args.push('--reverse')
    // `--binary` is only for patches that embed binary content. Passing it for
    // a text patch whose header carries `index <old>..<new>` makes git apply
    // find both blobs and stage the WHOLE new blob instead of honoring hunk
    // granularity — which would silently defeat partial-hunk staging.
    if (/^(?:diff --git .*\n)?Binary files /m.test(patchText) || /^GIT binary patch/m.test(patchText)) {
      args.push('--binary')
    }
    args.push('-')
    await this.checked(args, { cwd, signal: options.signal, stdin: patchText })
  }

  /* ── staging ───────────────────────────────────────────────────────────── */

  /**
   * Stage files; empty list stages everything (`git add -A`).
   * @param cwd - working directory inside the repository.
   * @param files - paths to stage; empty stages everything.
   * @param signal - optional abort.
   */
  async addAll(cwd: string, files: readonly string[] = [], signal?: AbortSignal): Promise<void> {
    const args = files.length === 0 ? ['add', '-A'] : ['add', '--', ...files]
    await this.checked(args, { cwd, signal })
  }

  /**
   * Unstage files; empty list unstages everything (`git reset`).
   * @param cwd - working directory inside the repository.
   * @param files - paths to unstage; empty unstages everything.
   * @param signal - optional abort.
   */
  async resetIndex(cwd: string, files: readonly string[] = [], signal?: AbortSignal): Promise<void> {
    const args = files.length === 0 ? ['reset'] : ['reset', '--', ...files]
    await this.checked(args, { cwd, signal })
  }

  /* ── commit / push ─────────────────────────────────────────────────────── */

  /**
   * Create a commit from `message` (passed via stdin).
   * @param cwd - working directory inside the repository.
   * @param message - commit message (subject/body).
   * @param options - allow-empty and abort signal.
   * @returns the underlying command run.
   */
  async commit(cwd: string, message: string, options: { signal?: AbortSignal; allowEmpty?: boolean } = {}): Promise<CommandRun> {
    const args = ['commit', '-F', '-']
    if (options.allowEmpty) args.push('--allow-empty')
    return this.checked(args, { cwd, signal: options.signal, stdin: message })
  }

  /**
   * Push the current branch (or an explicit branch to `remote`), keeping
   * `--no-follow-tags` so only the branch moves. `setUpstream` records
   * `remote`/`branch` tracking, which a freshly cut named-branch worktree
   * needs before any PR flow can consume it; without it, a branch with no
   * existing upstream fails like any plain `git push` does.
   * @param cwd - working directory inside the repository.
   * @param options - remote, branch, upstream-recording, force-with-lease, abort signal.
   */
  async push(cwd: string, options: {
    signal?: AbortSignal
    forceWithLease?: boolean
    remote?: string
    branch?: string
    setUpstream?: boolean
  } = {}): Promise<void> {
    const args = ['push', '--no-follow-tags']
    if (options.forceWithLease) args.push('--force-with-lease')
    if (options.setUpstream) args.push('--set-upstream')
    if (options.remote !== undefined) args.push(options.remote)
    if (options.branch !== undefined) args.push(options.branch)
    await this.checked(args, { cwd, signal: options.signal })
  }

  /* ── log ───────────────────────────────────────────────────────────────── */

  /**
   * Recent commits (default 20), parseable fields only.
   * @param cwd - working directory inside the repository.
   * @param options - max count, abort signal.
   * @returns newest-first commit entries with hash/author/date/subject.
   */
  async log(cwd: string, options: { max?: number; signal?: AbortSignal; color?: 'never' } = {}): Promise<GitLogEntry[]> {
    const max = options.max ?? 20
    const output = await this.text(
      ['log', `--max-count=${max}`, '--pretty=format:%H%x09%h%x09%an%x09%ae%x09%aI%x09%s'],
      { cwd, signal: options.signal },
    )
    const entries: GitLogEntry[] = []
    for (const line of output.split('\n')) {
      if (!line) continue
      const [hash, shortHash, authorName, authorEmail, date, ...subjectParts] = line.split('\t')
      if (hash === undefined || shortHash === undefined) continue
      entries.push({
        hash,
        shortHash,
        authorName: authorName ?? '',
        authorEmail: authorEmail ?? '',
        date: date ?? '',
        subject: subjectParts.join('\t'),
      })
    }
    return entries
  }

  private buildDiffArgs(options: DiffOptions): string[] {
    const args = ['diff']
    if (options.binary) args.push('--binary')
    if (options.cached) args.push('--cached')
    if (options.nameOnly) args.push('--name-only')
    if (options.numstat) args.push('--numstat')
    if (options.base) {
      args.push(options.base)
      if (options.head) args.push(options.head)
    }
    if (options.files?.length) args.push('--', ...options.files)
    return args
  }
}

function splitLines(text: string): string[] {
  const lines: string[] = []
  for (const line of text.split('\n')) {
    if (line.length > 0) lines.push(line)
  }
  return lines
}

/**
 * Join patch parts the way `git apply` expects. Delegates to the pi-vcs
 * contract `vcs.joinPatches`: parts are concatenated verbatim with a final
 * newline added only when absent — trailing newlines are never collapsed,
 * so a `GIT binary patch` terminator survives byte-exact (#8899).
 */
function patchJoin(parts: readonly string[]): string {
  return joinPatches(parts)
}
