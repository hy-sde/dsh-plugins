/**
 * Read-preference routing for the git tools (see LICENSE): when a
 * `pi-vcs`-backed `ctx.vcs` service is registered and its probe is clean, the
 * commit/review READ surfaces resolve through it and mutations stay on
 * `ctx.git`. These tests mount a fake `pi-vcs` shim next to a real temp git
 * repo and assert both that the vcs verbs are the ones actually served and
 * that the git mutation paths (addAll) still work.
 */

import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Git from '@hy-sde-org/dsh-git'
import VcsPlugin from './vcs-stub.ts'
import toolGitPackage from '@hy-sde-org/dsh-tool-git'
import { openReads } from '../src/reads.ts'

let dir: string
let shimDir: string
let ctx: Context
let counter = 0
/** Every argv the fake pi-vcs received, in order. */
const callLog: string[][] = []

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

async function write(path: string, content: string): Promise<void> {
  const target = join(dir, path)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
  await writeFile(target, content)
}

const agent = { session: { header: { id: 's1', cwd: '' } } } as never

async function call(name: string, args: unknown): Promise<{ value: unknown }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++counter}`),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) {
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    throw new Error(text || 'tool failed')
  }
  return result
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-git-vcs-'))
  shimDir = await mkdtemp(join(tmpdir(), 'dsh-pi-vcs-shim-'))
  runGit(['init', '-q'])
  runGit(['config', 'user.email', 'test@example.com'])
  runGit(['config', 'user.name', 'Test User'])
  ;(agent as { session: { header: { cwd: string } } }).session.header.cwd = dir
  await write('base.txt', 'v1\n')

  // The shim proxies reads through the REAL git CLI so byte output stays
  // faithful, and logs every invocation so the test can assert the routing.
  const logPath = join(shimDir, 'calls.log')
  const shim = [
    '#!/bin/bash',
    `echo "[$*]" >> '${logPath}'`,
    'case "$1" in',
    '  --version) echo "pi-vcs 0.1.0"; exit 0 ;;',
    '  repo-info) printf \'{"root":"%s","gitDir":"%s","branch":"main"}\n\' "$2" "$2/.git"; exit 0 ;;',
    '  status)',
    '    py="$2"',
    '    git -C "$py" status --porcelain > "$py/.dsh-status.txt" || true',
    '    st=0; un=0; ut=0',
    '    while IFS= read -r line; do',
    '      [ -z "$line" ] && continue',
    '      x="${line:0:1}"; y="${line:1:1}"',
    '      if [ "$x" = "?" ] && [ "$y" = "?" ]; then ut=$((ut+1)); else',
    '        if [ "$x" != " " ]; then st=$((st+1)); fi',
    '        if [ "$y" != " " ]; then un=$((un+1)); fi',
    '      fi',
    '    done < "$py/.dsh-status.txt"',
    '    rm -f "$py/.dsh-status.txt"',
    '    printf \'{"staged":%s,"unstaged":%s,"untracked":%s}\n\' "$st" "$un" "$ut"',
    '    exit 0',
    '    ;;',
    '  staged-diff)',
    '    if [ "$3" = "--name-only" ]; then git -C "$2" diff --cached --name-only; exit 0; fi',
    '    if [ "$3" = "--numstat" ]; then git -C "$2" diff --cached --numstat; exit 0; fi',
    '    git -C "$2" diff --cached; exit 0',
    '    ;;',
    '  rev-diff) shift 2; git -C "$1" diff "$@"; exit 0 ;;',
    '  worktree-diff) shift 2; git -C "$1" diff; exit 0 ;;',
    '  *) echo "unknown command" >&2; exit 2 ;;',
    'esac',
    '',
  ].join('\n')
  const shimPath = join(shimDir, 'pi-vcs')
  await writeFile(shimPath, shim)
  await chmod(shimPath, 0o755)

  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Git)
  await ctx.plugin(VcsPlugin, { vcsPath: shimPath, timeoutMs: 20000 })
  await ctx.plugin(toolGitPackage)
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(shimDir, { recursive: true, force: true })
  await ctx.fiber.dispose()
})

describe('read-preference routing (G7)', () => {
  it('opens a vcs-backed read facade when the probe is clean', async () => {
    const probe = await ctx.vcs.probe()
    expect(probe.available).toBe(true)
    const reads = await openReads(ctx, dir, undefined)
    expect(reads.backend).toBe('vcs')
    await expect(reads.isRepo()).resolves.toBe(true)
    await expect(reads.branch()).resolves.toBe('main')
  })

  it('falls back to ctx.git when no vcs service is registered', async () => {
    const bare = new Context()
    await bare.plugin(Git)
    const reads = await openReads(bare, dir, undefined)
    expect(reads.backend).toBe('git')
    await bare.fiber.dispose()
  })

  it('routes commit analysis reads through pi-vcs and mutations through git', async () => {
    const logFile = join(shimDir, 'calls.log')
    await rm(logFile, { force: true })
    callLog.length = 0
    runGit(['add', '-A'])
    runGit(['commit', '-q', '-m', 'base'])
    await write('base.txt', 'v2\nv3\n')
    // ensure nothing is staged so the tool auto-stages via ctx.git first
    runGit(['reset', '-q'])
    const result = await call('commit', {})
    const value = result.value as { staged: boolean; files: Array<{ path: string }>; diff: string }
    expect(value.staged).toBe(true)
    expect(value.files.map(file => file.path)).toEqual(['base.txt'])
    expect(value.diff).toContain('+v2')
    // Reads must have gone through the vcs verbs; the auto-stage mutation
    // (git add) is a git call, not a pi-vcs call.
    const logged = await import('node:fs/promises').then(fs => fs.readFile(logFile, 'utf8'))
    callLog.length = 0
    for (const line of logged.split('\n')) {
      const m = line.match(/^\[([^\]]*)\]$/)
      if (m) callLog.push((m[1] ?? '').split(' '))
    }
    const verbs = callLog.map(argv => argv[0])
    expect(verbs).toContain('status')
    expect(verbs).toContain('staged-diff')
    expect(verbs).not.toContain('unknown')
  })
})
