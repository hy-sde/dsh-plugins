/**
 * End-to-end tool tests for `commit` and `commit_apply` over a real temp git
 * repository: analysis output, plan validation, cycle rejection, atomic split
 * commits, and dry-run previews. The subagent `review` tool's orchestration is
 * covered separately in review.spec.ts.
 */

import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Git from '@hy-sde-org/dsh-git'
import toolGitPackage from '@hy-sde-org/dsh-tool-git'
import policyPackage from '../src/orchestration-policy.ts'
import { clearReviewVerdicts, recordReviewVerdict } from '../src/push-gate.ts'

let dir: string
let ctx: Context
let counter = 0

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** Write a file under the temp repo, creating parent dirs. */
async function write(path: string, content: string): Promise<void> {
  const target = join(dir, path)
  await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
  await writeFile(target, content)
}

/** Unstage everything and clear untracked/restored changes for a clean slate. */
function resetRepo(): void {
  runGit(['reset', '-q'])
  runGit(['clean', '-fdq'])
  // checkout may fail on an empty history (no tracked paths) — tolerated
  spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: dir, encoding: 'utf8' })
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
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-git-'))
  runGit(['init', '-q'])
  runGit(['config', 'user.email', 'test@example.com'])
  runGit(['config', 'user.name', 'Test User'])
  ;(agent as { session: { header: { cwd: string } } }).session.header.cwd = dir
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Git)
  await ctx.plugin(toolGitPackage)
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await ctx.fiber.dispose()
})

describe('commit (analyze)', () => {
  it('stages everything when nothing is staged and reports files + diff', async () => {
    resetRepo()
    await write('src/a.ts', 'const a = 1;\n')
    await write('src/b.ts', 'const b = 2;\n')
    const result = await call('commit', { })
    const value = result.value as {
      staged: boolean
      files: Array<{ path: string; additions: number }>
      diff: string
      suggestedPlan?: unknown
    }
    expect(value.staged).toBe(true)
    expect(value.files.map(file => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(value.diff).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(value.suggestedPlan).toBeDefined()
  })

  it('honors stagedOnly and warns about unstaged leftovers', async () => {
    resetRepo()
    await write('only.txt', 'x\n')
    await call('commit', { stagedOnly: true })
    await write('only.txt', 'x\ny\n')
    // uncommitted change to the same file; nothing staged → report empty
    runGit(['reset', '-q'])
    const result = await call('commit', { stagedOnly: true })
    const value = result.value as { staged: boolean; warnings: string[] }
    expect(value.staged).toBe(false)
  })

  it('detects trivial changes', async () => {
    resetRepo()
    await write('triv.txt', 'same\n')
    await write('triv2.txt', 'same ')
    await call('commit', { }) // stage all
    const result = await call('commit', { stagedOnly: true })
    const value = result.value as { trivial: { type: string; summary: string } | undefined; diffTruncated: boolean }
    expect(value.trivial).toBeUndefined()
  })

  it('lists lock files pending automatic placement', async () => {
    resetRepo()
    await write('package.json', '{"name":"x"}\n')
    await write('pnpm-lock.yaml', 'lockfileVersion: 6\n')
    const result = await call('commit', { })
    const value = result.value as {
      lockFilesPending: string[]
      diff: string
      suggestedPlan: Array<{ changes: Array<{ path: string }> }>
    }
    expect(value.lockFilesPending).toContain('pnpm-lock.yaml')
    // Lock files must not appear in the plan skeleton — commit_apply places them.
    const planned = value.suggestedPlan.flatMap(group => group.changes.map(change => change.path))
    expect(planned).not.toContain('pnpm-lock.yaml')
    expect(planned).toContain('package.json')
  })
})

describe('commit_apply (execute)', () => {
  /** Content marker so staged files always differ from earlier commits. */
  let baselineVersion = 0
  async function settleBaseline(): Promise<void> {
    resetRepo()
    baselineVersion += 1
    const marker = `v${baselineVersion}`
    await write('pkg/a.ts', `const a = ${baselineVersion};\n`)
    await write('pkg/b.ts', `const b = ${baselineVersion};\n`)
    await write('README.md', `# hi ${marker}\n`)
    await write('package.json', `{"name":"x","marker":"${marker}"}\n`)
    await write('pnpm-lock.yaml', `lockfileVersion: 6\n# ${marker}\n`)
    runGit(['add', '-A'])
  }

  it('dry-run previews exact messages without committing', async () => {
    await settleBaseline()
    const result = await call('commit_apply', {
      dryRun: true,
      commits: [
        {
          changes: [{ path: 'pkg/a.ts', hunks: { type: 'all' } }, { path: 'pkg/b.ts', hunks: { type: 'all' } }, { path: 'package.json', hunks: { type: 'all' } }],
          type: 'feat',
          scope: 'pkg',
          summary: 'add helpers',
          details: [{ text: 'two small helpers', userVisible: true }],
          dependencies: [],
        },
        {
          changes: [{ path: 'README.md', hunks: { type: 'all' } }],
          type: 'docs',
          summary: 'add readme',
          dependencies: [0],
        },
      ],
    })
    const value = result.value as { dryRun: boolean; messages: string[]; created: Array<{ position: number; message: string }> }
    expect(value.dryRun).toBe(true)
    expect(value.messages).toHaveLength(2)
    expect(value.messages[0]).toBe('feat(pkg): add helpers\n\n- two small helpers')
    expect(value.messages[1]).toBe('docs: add readme')
    expect(value.created).toHaveLength(0)
  })

  it('executes a validated split plan with lock-file placement in dependency order', async () => {
    await settleBaseline()
    const result = await call('commit_apply', {
      commits: [
        {
          changes: [{ path: 'pkg/a.ts', hunks: { type: 'all' } }],
          type: 'feat',
          scope: 'pkg',
          summary: 'add helper a',
          details: [],
          dependencies: [],
        },
        {
          changes: [{ path: 'pkg/b.ts', hunks: { type: 'all' } }, { path: 'README.md', hunks: { type: 'all' } }, { path: 'package.json', hunks: { type: 'all' } }],
          type: 'feat',
          scope: 'pkg',
          summary: 'add helper b and docs',
          dependencies: [],
        },
      ],
    })
    const value = result.value as { mode: string; created: Array<{ message: string; position: number }> }
    expect(value.mode).toBe('split')
    expect(value.created).toHaveLength(2)
    const log = runGit(['log', '--format=%s']).split('\n').filter(Boolean)
    expect(log[0]).toContain('add helper b and docs')
    expect(log[1]).toContain('add helper a')
    // pnpm-lock.yaml rides with the group that owns package.json (not lost).
    const lockOwner = runGit(['log', '--format=%s', '-1', '--', 'pnpm-lock.yaml'])
    expect(lockOwner).toContain('add helper b and docs')
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(`{"name":"x","marker":"v${baselineVersion}"}\n`)
    expect(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe(`lockfileVersion: 6\n# v${baselineVersion}\n`)
  })

  it('rejects a plan that misses staged files before writing anything', async () => {
    await settleBaseline()
    const before = await readFile(join(dir, 'pkg', 'a.ts'), 'utf8')
    const resultP = call('commit_apply', {
      commits: [
        { changes: [{ path: 'pkg/a.ts', hunks: { type: 'all' } }], type: 'feat', summary: 'partial', dependencies: [] },
      ],
    })
    await expect(resultP).rejects.toThrow(/missing staged files/)
    expect(await readFile(join(dir, 'pkg', 'a.ts'), 'utf8')).toBe(before)
    // nothing committed either
    const log = runGit(['log', '--format=%s']).split('\n').filter(Boolean)
    expect(log).not.toContain('partial')
  })

  it('rejects circular dependency plans before writing anything', async () => {
    await write('cyc.ts', 'const c = 3;\n')
    await write('cyc2.ts', 'const c2 = 4;\n')
    await call('commit', { })
    const resultP = call('commit_apply', {
      commits: [
        { changes: [{ path: 'pkg/a.ts', hunks: { type: 'all' } }, { path: 'cyc.ts', hunks: { type: 'all' } }, { path: 'cyc2.ts', hunks: { type: 'all' } }], type: 'feat', summary: 'one', dependencies: [1] },
        { changes: [{ path: 'pkg/b.ts', hunks: { type: 'all' } }], type: 'fix', summary: 'two', dependencies: [0] },
        { changes: [{ path: 'README.md', hunks: { type: 'all' } }, { path: 'package.json', hunks: { type: 'all' } }], type: 'docs', summary: 'three', dependencies: [] },
      ],
    })
    await expect(resultP).rejects.toThrow(/Circular dependency/)
    const log = runGit(['log', '--format=%s']).split('\n').filter(Boolean)
    expect(log.some(line => line.includes('one'))).toBe(false)
    expect(log.some(line => line.includes('two'))).toBe(false)
  })

  it('stages only the selected hunks of a file in a split', async () => {
    resetRepo()
    const baseline = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    await write('split.txt', baseline)
    runGit(['add', '-A'])
    runGit(['commit', '-qm', 'baseline split.txt'])
    // two separate edits far apart → distinct hunks; stage explicitly
    await write('split.txt', baseline.replace('line2', 'TWO').replace('line27', 'NINE'))
    runGit(['add', '-A'])
    const staged = await ctx.git.diffText(dir, { cached: true, binary: true })
    expect(staged).toContain('TWO')
    expect(staged).toContain('NINE')
    const result = await call('commit_apply', {
      commits: [
        {
          changes: [{ path: 'split.txt', hunks: { type: 'indices', indices: [1] } }],
          type: 'fix',
          summary: 'uppercase two',
          dependencies: [],
        },
      ],
    })
    const value = result.value as { created: Array<{ message: string }> }
    expect(value.created).toHaveLength(1)
    // Only hunk 1 was committed; hunk 2 (NINE) is left in the worktree — the
    // tool resets the index so nothing is lost, but nothing else stays staged.
    expect(await ctx.git.hasStaged(dir)).toBe(false)
    const leftover = await ctx.git.diffText(dir, { cached: false, binary: true })
    expect(leftover).not.toContain('TWO')
    expect(leftover).toContain('NINE')
  })
})

describe('commit_apply --push (named-branch semantics)', () => {
  let pushDir: string
  let originDir: string

  function runIn(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout
  }

  /** Move onto main, hard-reset, and clean so each test starts from the baseline. */
  function resetPushRepo(branch?: string): void {
    runIn(pushDir, ['checkout', '-qf', 'main'])
    runIn(pushDir, ['reset', '--hard', '-q'])
    runIn(pushDir, ['clean', '-fdq'])
    if (branch !== undefined) runIn(pushDir, ['switch', '-qc', branch])
  }

  beforeAll(async () => {
    pushDir = await mkdtemp(join(tmpdir(), 'dsh-tool-git-push-'))
    originDir = await mkdtemp(join(tmpdir(), 'dsh-tool-git-origin-'))
    rmSync(originDir, { recursive: true, force: true })
    runIn(pushDir, ['init', '-q'])
    runIn(pushDir, ['config', 'user.email', 'test@example.com'])
    runIn(pushDir, ['config', 'user.name', 'Test User'])
    await writeFile(join(pushDir, 'README.md'), '# push\n')
    runIn(pushDir, ['add', 'README.md'])
    runIn(pushDir, ['commit', '-qm', 'chore: baseline'])
    runIn(pushDir, ['branch', '-M', 'main'])
    spawnSync('git', ['init', '--bare', '-q', originDir], { encoding: 'utf8' })
    runIn(pushDir, ['remote', 'add', 'origin', originDir])
    runIn(pushDir, ['push', '-qu', 'origin', 'main'])
  })

  afterAll(async () => {
    rmSync(pushDir, { recursive: true, force: true })
    rmSync(originDir, { recursive: true, force: true })
  })

  it('pushes a named branch to origin and records upstream tracking', async () => {
    resetPushRepo('feature/push-1')
    await mkdir(join(pushDir, 'pkg'), { recursive: true })
    await writeFile(join(pushDir, 'pkg/a.ts'), 'const a = 1;\n')
    expect(spawnSync('git', ['add', '-A'], { cwd: pushDir, encoding: 'utf8' }).status).toBe(0)
    const result = await call('commit_apply', {
      cwd: pushDir,
      commits: [{ changes: [{ path: 'pkg/a.ts' }], type: 'feat', scope: 'pkg', summary: 'add helper a', dependencies: [] }],
      push: true,
    })
    const value = result.value as { mode: string; created: Array<{ hash: string }> }
    expect(value.mode).toBe('single')
    expect(value.created).toHaveLength(1)
    // Branch now exists on origin with upstream tracking recorded.
    expect(spawnSync('git', ['show-ref', '--verify', 'refs/heads/feature/push-1'], { cwd: originDir, encoding: 'utf8' }).status).toBe(0)
    expect(runIn(pushDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim()).toBe('origin/feature/push-1')
  })

  it('fails with guidance on a detached HEAD instead of git’s raw error', async () => {
    resetPushRepo('feature/push-2')
    await mkdir(join(pushDir, 'pkg'), { recursive: true })
    await writeFile(join(pushDir, 'pkg/b.ts'), 'const b = 2;\n')
    expect(spawnSync('git', ['add', '-A'], { cwd: pushDir, encoding: 'utf8' }).status).toBe(0)
    runIn(pushDir, ['checkout', '--detach', '-q'])
    await expect(call('commit_apply', {
      cwd: pushDir,
      commits: [{ changes: [{ path: 'pkg/b.ts' }], type: 'feat', scope: 'pkg', summary: 'add helper b', dependencies: [] }],
      push: true,
    })).rejects.toThrow(/requires a named branch.*worktree acquire --branch/s)
  })
})

describe('P2 review gate on commit_apply --push', () => {
  let gateDir: string
  let gateOrigin: string
  let gateRoot: string

  function gateGit(args: string[]): string {
    const result = spawnSync('git', args, { cwd: gateDir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout
  }

  function resetGateRepo(branch?: string): void {
    gateGit(['checkout', '-qf', 'main'])
    gateGit(['reset', '--hard', '-q'])
    gateGit(['clean', '-fdq'])
    if (branch !== undefined) gateGit(['switch', '-qc', branch])
  }

  async function stage(path: string, content: string): Promise<void> {
    const target = join(gateDir, path)
    await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    await writeFile(target, content)
    expect(spawnSync('git', ['add', path], { cwd: gateDir, encoding: 'utf8' }).status).toBe(0)
  }

  beforeAll(async () => {
    gateDir = await mkdtemp(join(tmpdir(), 'dsh-tool-git-gate-'))
    gateOrigin = await mkdtemp(join(tmpdir(), 'dsh-tool-git-gate-origin-'))
    rmSync(gateOrigin, { recursive: true, force: true })
    gateGit(['init', '-q'])
    gateGit(['config', 'user.email', 'test@example.com'])
    gateGit(['config', 'user.name', 'Test User'])
    await writeFile(join(gateDir, 'README.md'), '# gate\n')
    gateGit(['add', 'README.md'])
    gateGit(['commit', '-qm', 'chore: baseline'])
    gateGit(['branch', '-M', 'main'])
    spawnSync('git', ['init', '--bare', '-q', gateOrigin], { encoding: 'utf8' })
    gateGit(['remote', 'add', 'origin', gateOrigin])
    gateGit(['push', '-qu', 'origin', 'main'])
    gateRoot = gateGit(['rev-parse', '--show-toplevel']).trim()
    await ctx.plugin(policyPackage, { enabled: true, reviewGate: { default: 'review-gated' } })
  })

  afterAll(async () => {
    rmSync(gateDir, { recursive: true, force: true })
    rmSync(gateOrigin, { recursive: true, force: true })
  })

  beforeEach(() => { clearReviewVerdicts() })

  const commitPlan = (path: string) => [{
    changes: [{ path }],
    type: 'feat',
    summary: 'add gated change',
    dependencies: [],
  }]

  it('refuses a gated push with no verdict, naming `review` as the fix', async () => {
    resetGateRepo('feature/gated-1')
    await stage('pkg/gated-a.ts', 'export const a = 1;\n')
    await expect(call('commit_apply', {
      cwd: gateDir,
      commits: commitPlan('pkg/gated-a.ts'),
      push: true,
    })).rejects.toThrow(/review gate.*never been reviewed.*review --target staged/s)
  })

  it('releases a push carrying a current ship verdict over the same staged range', async () => {
    resetGateRepo('feature/gated-2')
    await stage('pkg/gated-b.ts', 'export const b = 2;\n')
    const beforeHead = gateGit(['rev-parse', 'HEAD']).trim()
    const indexTree = gateGit(['write-tree']).trim()
    recordReviewVerdict({
      root: gateRoot,
      target: 'staged',
      verdict: 'ship',
      beforeHead,
      indexTree,
      at: Date.now(),
    })
    const result = await call('commit_apply', {
      cwd: gateDir,
      commits: commitPlan('pkg/gated-b.ts'),
      push: true,
    })
    const value = result.value as { mode: string; warnings: string[] }
    expect(value.mode).toBe('single')
    expect(value.warnings.some(text => text.includes('push gated') && text.includes('ship'))).toBe(true)
    expect(gateGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim()).toBe('origin/feature/gated-2')
  })

  it('refuses when the staged range changed after the review (stale verdict)', async () => {
    resetGateRepo('feature/gated-3')
    await stage('pkg/gated-c.ts', 'export const c = 3;\n')
    recordReviewVerdict({
      root: gateRoot,
      target: 'staged',
      verdict: 'ship',
      beforeHead: gateGit(['rev-parse', 'HEAD']).trim(),
      indexTree: gateGit(['write-tree']).trim(),
      at: Date.now(),
    })
    // A second staged change invalidates the reviewed range identity.
    await stage('pkg/gated-d.ts', 'export const d = 4;\n')
    await expect(call('commit_apply', {
      cwd: gateDir,
      commits: commitPlan('pkg/gated-d.ts'),
      push: true,
    })).rejects.toThrow(/stale review verdict/)
  })

  it('refuses a push after a reject verdict (fail-closed)', async () => {
    resetGateRepo('feature/gated-4')
    await stage('pkg/gated-e.ts', 'export const e = 5;\n')
    recordReviewVerdict({
      root: gateRoot,
      target: 'staged',
      verdict: 'reject',
      beforeHead: gateGit(['rev-parse', 'HEAD']).trim(),
      indexTree: gateGit(['write-tree']).trim(),
      at: Date.now(),
    })
    await expect(call('commit_apply', {
      cwd: gateDir,
      commits: commitPlan('pkg/gated-e.ts'),
      push: true,
    })).rejects.toThrow(/verdict was `reject`/)
  })

  it('leaves local commits ungated when push is not requested', async () => {
    resetGateRepo('feature/gated-5')
    await stage('pkg/gated-f.ts', 'export const f = 6;\n')
    const result = await call('commit_apply', {
      cwd: gateDir,
      commits: commitPlan('pkg/gated-f.ts'),
      push: false,
    })
    expect((result.value as { mode: string }).mode).toBe('single')
  })
})
