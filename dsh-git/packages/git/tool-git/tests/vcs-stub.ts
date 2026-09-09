/**
 * Test-only stand-in for the unpublished `@deepseek-ai/dsh-vcs` package.
 *
 * `@deepseek-ai/dsh-vcs` exists only inside the DeepSeek Harness fork and is
 * NOT published to npm, so the standalone cannot import it. This module fakes
 * the narrow service surface that `src/reads.ts` consumes — the same verbs
 * as the fork's `VcsService` (`--version`, `repo-info`, `status`, and the
 * `staged-diff`/`rev-diff`/`worktree-diff` diff verbs) — by shelling out to a
 * test shim binary through `node:child_process`. Production code degrades to
 * `ctx.git` when no `vcs` service is registered; only tests mount this fake.
 */

import { execFile } from 'node:child_process'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ReadRange, VcsService } from '../src/reads.ts'

/** Plugin configuration (mirrors the fork's vcs config surface, narrowed). */
export interface VcsStubConfig {
  /** `pi-vcs`-compatible shim executable path (default `pi-vcs`). */
  vcsPath?: string
  /** Per-command wall-clock budget in ms (default 20000). */
  timeoutMs?: number
}

/** One shim invocation result. */
interface ShimRun {
  stdout: string
  stderr: string
  exitCode: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Test-only fake vcs service (stand-in for the fork's `ctx.vcs`). */
    vcs: FakeVcsService
  }
}

/** The fake `ctx.vcs` service: shells out to a `pi-vcs`-shaped shim. */
export class FakeVcsService extends Service implements VcsService {
  private readonly vcsPath: string
  private readonly timeoutMs: number

  constructor(ctx: Context, config: VcsStubConfig = {}) {
    super(ctx, 'vcs')
    this.vcsPath = config.vcsPath ?? 'pi-vcs'
    this.timeoutMs = config.timeoutMs ?? 20_000
  }

  private run(argv: string[], signal?: AbortSignal): Promise<ShimRun> {
    return new Promise((resolve) => {
      execFile(this.vcsPath, argv, { encoding: 'utf8', timeout: this.timeoutMs, signal }, (error, stdout, stderr) => {
        if (error == null) {
          resolve({ stdout, stderr, exitCode: 0 })
        } else {
          const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
          resolve({ stdout, stderr, exitCode: code })
        }
      })
    })
  }

  async probe(): Promise<{ available: boolean; version?: string; reason?: string }> {
    const run = await this.run(['--version'])
    if (run.exitCode !== 0) return { available: false, reason: run.stderr.trim() || `pi-vcs exited ${run.exitCode}` }
    return { available: true, version: run.stdout.trim().replace(/^pi-vcs\s+/, '') }
  }

  async repoInfo(dir: string): Promise<{ root: string; gitDir: string; branch?: string | null } | null> {
    const run = await this.run(['repo-info', dir])
    if (run.exitCode !== 0 || run.stdout.trim().length === 0) return null
    try {
      return JSON.parse(run.stdout) as { root: string; gitDir: string; branch?: string | null }
    } catch {
      return null
    }
  }

  async changedFiles(dir: string, options: ReadRange = {}, signal?: AbortSignal): Promise<string[]> {
    const text = await this.diff(dir, { ...options }, signal, '--name-only')
    return text.split('\n').filter(line => line.length > 0)
  }

  async numstat(dir: string, options: ReadRange = {}, signal?: AbortSignal): Promise<string> {
    return this.diff(dir, options, signal, '--numstat')
  }

  async status(dir: string, signal?: AbortSignal): Promise<{ staged: number; unstaged: number; untracked: number }> {
    const run = await this.run(['status', dir], signal)
    if (run.exitCode !== 0) throw new Error(`fake vcs status exited ${run.exitCode}: ${run.stderr.trim()}`)
    return JSON.parse(run.stdout) as { staged: number; unstaged: number; untracked: number }
  }

  async branch(dir: string): Promise<string | undefined> {
    const info = await this.repoInfo(dir)
    return info?.branch ?? undefined
  }

  async diff(dir: string, options: ReadRange = {}, signal?: AbortSignal, modeFlag: '' | '--name-only' | '--numstat' = ''): Promise<string> {
    const verb = options.base !== undefined ? 'rev-diff' : options.cached === true ? 'staged-diff' : 'worktree-diff'
    const argv: string[] = [verb, dir]
    if (verb === 'rev-diff') {
      argv.push(options.base ?? '')
      if (options.head !== undefined) argv.push(options.head)
    }
    if (modeFlag.length > 0) argv.push(modeFlag)
    const run = await this.run(argv, signal)
    if (run.exitCode !== 0) throw new Error(`fake vcs ${verb} exited ${run.exitCode}: ${run.stderr.trim()}`)
    return run.stdout
  }
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'vcs'

/**
 * Register the fake `ctx.vcs` service: shells out to the `pi-vcs` shim.
 * @param ctx - the test context.
 * @param config - vcs path / timeout (see {@link VcsStubConfig}).
 */
export function apply(ctx: Context, config: VcsStubConfig = {}): void {
  new FakeVcsService(ctx, config)
}

export default { name, apply }
