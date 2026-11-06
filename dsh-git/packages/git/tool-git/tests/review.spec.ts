/** Review slice budgeting, artifact retrieval, and verdict aggregation. */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Git from '@hy-sde-org/dsh-git'
import toolGitPackage from '@hy-sde-org/dsh-tool-git'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import {
  toPriority,
  sliceByWeight,
  gitDiffSection,
} from '../src/review.ts'

let dir: string
let ctx: Context
let counter = 0
let spillRoot: string
const maxReviewerDiffChars = 40_000
type ActivationOptions = Parameters<Context['subagents']['startActivation']>[0]
let reviewerPrompts: string[] = []

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

const agent = { session: { header: { id: 's1', cwd: '' } } } as never

async function call(name: string, args: unknown): Promise<{ value: unknown }> {
  const result = await ctx.tools.execute({
    calls: [{ type: 'tool-call' as const, id: ToolCallId(`rev-${++counter}`), name, arguments: JSON.stringify(args)}],
    signal: new AbortController().signal,
    agent,
  }).then(b => b.results[0]!.result)
  if (result.isError) {
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    throw new Error(text || 'tool failed')
  }
  return result
}

/** A fabricated `ctx.subagents` service whose `start` returns canned runs. */
interface CannedReviewer {
  overall_correctness: 'correct' | 'incorrect'
  explanation: string
  confidence: number
  findings?: unknown[]
}

let cannedRuns: CannedReviewer[] = []
let erroringStart = false
let fakeIndex = 0
function fakeSubagents(): {
  getProvider: () => unknown
  startActivation: (options: ActivationOptions) => Promise<unknown>
} {
  return {
    getProvider: () => ({ provider: 'spawn' }),
    startActivation: (options) => {
      reviewerPrompts.push(options.request.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n'))
      if (erroringStart) {
        return Promise.resolve({
          result: Promise.resolve({ stopReason: 'error', diagnostic: 'model transport failed', output: [] }),
          dispose: () => Promise.resolve(),
        })
      }
      const canned = cannedRuns[fakeIndex] ?? { overall_correctness: 'correct', explanation: 'no runs left', confidence: 1, findings: [] }
      fakeIndex += 1
      return Promise.resolve({
        result: Promise.resolve({ stopReason: 'completed', structured: canned, output: [] }),
        dispose: () => Promise.resolve(),
      })
    },
  }
}

function resetFake(): void {
  cannedRuns = []
  erroringStart = false
  fakeIndex = 0
  reviewerPrompts = []
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-review-'))
  runGit(['init', '-q'])
  runGit(['config', 'user.email', 'test@example.com'])
  runGit(['config', 'user.name', 'Test User'])
  ;(agent as { session: { header: { cwd: string } } }).session.header.cwd = dir
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Git)
  spillRoot = `${dir}-spill`
  await ctx.plugin(LocalSpillStore, { root: spillRoot, cleanupPeriodDays: 0 })
  await ctx.plugin(toolGitPackage, { maxReviewerDiffChars })
  ctx.provide('subagents', fakeSubagents() as never)
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await ctx.fiber.dispose()
  rmSync(spillRoot, { recursive: true, force: true })
})

afterEach(() => { vi.restoreAllMocks() })

async function seedChanges(): Promise<void> {
  runGit(['reset', '-q'])
  runGit(['clean', '-fdq'])
  // checkout may fail on an empty history (no tracked paths) — tolerated
  spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: dir, encoding: 'utf8' })
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src/a.ts'), 'const a = 1;\n')
  await writeFile(join(dir, 'src/b.ts'), 'const b = 2;\n')
  await writeFile(join(dir, 'README.md'), '# project\n')
  runGit(['add', '-A'])
}

describe('pure helpers', () => {
  it('maps numeric priorities to P labels', () => {
    expect(toPriority(0)).toBe('P0')
    expect(toPriority(3)).toBe('P3')
    expect(toPriority(2)).toBe('P2')
    expect(toPriority('anything')).toBe('P3')
  })

  it('slices files by diff size into at most budget balanced groups', () => {
    const map = new Map<string, string>()
    map.set('big.ts', 'x'.repeat(1000))
    map.set('mid1.ts', 'x'.repeat(100))
    map.set('mid2.ts', 'x'.repeat(100))
    map.set('mid3.ts', 'x'.repeat(100))
    map.set('small.ts', 'x'.repeat(10))
    const slices = sliceByWeight(['big.ts', 'mid1.ts', 'mid2.ts', 'mid3.ts', 'small.ts'], map, 3)
    expect(slices.length).toBe(3)
    expect(slices.flat().sort()).toEqual(['big.ts', 'mid1.ts', 'mid2.ts', 'mid3.ts', 'small.ts'].sort())
  })

  it('extracts a file section from a whole diff', () => {
    const diff = gitSectionPair()
    const section = gitDiffSection(diff, 'src/a.ts')
    expect(section).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(section).not.toContain('src/b.ts')
  })
})

describe('review tool with fabricated reviewers', () => {
  it('returns a ship verdict with ranked findings when all reviewers pass', async () => {
    await seedChanges()
    resetFake()
    cannedRuns = [
      {
        overall_correctness: 'correct',
        explanation: 'looks good',
        confidence: 0.9,
        findings: [
          { title: 'minor nit', body: 'suboptimal but correct', priority: 3, confidence: 0.6, file_path: 'src/a.ts', line_start: 1, line_end: 1 },
          { title: 'handle null response', body: 'potential edge case', priority: 2, confidence: 0.7, file_path: 'src/b.ts', line_start: 3, line_end: 5 },
        ],
      },
    ]
    const result = await call('review', { target: 'staged' })
    const value = result.value as { verdict: string; findings: Array<{ priority: string }>; errors: string[]; files: string[] }
    expect(value.verdict).toBe('ship')
    expect(value.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']))
    // sorted by severity: P2 before P3
    expect(value.findings.map(finding => finding.priority)).toEqual(['P2', 'P3'])
    expect(value.errors).toEqual([])
  })

  it('rejects when any reviewer reports incorrect', async () => {
    await seedChanges()
    resetFake()
    cannedRuns = [
      { overall_correctness: 'correct', explanation: 'fine', confidence: 0.9, findings: [] },
      { overall_correctness: 'incorrect', explanation: 'data corruption in b', confidence: 0.95, findings: [
        { title: 'auth bypass', body: 'P0 scenario', priority: 0, confidence: 0.95, file_path: 'src/b.ts', line_start: 1, line_end: 4 },
      ] },
    ]
    const result = await call('review', { target: 'staged', maxReviewers: 2 })
    const value = result.value as { verdict: string; findings: Array<{ priority: string }>; confidence: number | null }
    expect(value.verdict).toBe('reject')
    expect(value.findings[0]!.priority).toBe('P0')
    // Overall confidence is the minimum across reviewers.
    expect(value.confidence).toBeLessThan(1)
  })

  it.each([26_000, 50_000])('keeps complete scoped diffs retrievable when reviewer input exceeds the cap (%i chars per file)', async (chars) => {
    await seedChanges()
    resetFake()
    for (const name of ['a', 'b']) {
      await writeFile(join(dir, `src/${name}.ts`), `export const ${name} = "${name.repeat(chars)}";\n`)
    }
    runGit(['add', 'src'])
    const sections = Git.parseFileDiffs(runGit(['diff', '--cached', '--', 'src']))
    const expected = sections.map(section => section.content).join('\n')
    expect(expected.length).toBeGreaterThan(maxReviewerDiffChars)
    if (chars < maxReviewerDiffChars) {
      expect(sections.every(section => section.content.length <= maxReviewerDiffChars)).toBe(true)
    }
    const save = vi.spyOn(ctx.spillStore, 'saveText')
    const result = await call('review', { target: 'staged', focus: ['src'], maxReviewers: 1 })
    expect(result.value).toMatchObject({ verdict: 'ship', errors: [], diffTruncated: false })
    expect(save).toHaveBeenCalledTimes(1)
    const ref = await save.mock.results[0]!.value
    const captured = await readFile(ref.locator, 'utf8')
    expect(captured).toBe(expected)
    const prompt = reviewerPrompts[0]!
    expect(prompt.length).toBeLessThan(maxReviewerDiffChars)
    expect(prompt).toContain(ref.locator)
    const ranges = [...prompt.matchAll(/^- (src\/[ab]\.ts): lines (\d+)-(\d+)$/gm)]
    expect(ranges.map(range => range[1])).toEqual(sections.map(section => section.filename))
    const lines = captured.split('\n')
    for (const [index, range] of ranges.entries()) {
      expect(lines.slice(Number(range[2]) - 1, Number(range[3])).join('\n')).toBe(sections[index]!.content)
    }
  })

  it('does not start a reviewer with incomplete input when artifact storage fails', async () => {
    await seedChanges()
    resetFake()
    await writeFile(join(dir, 'src/a.ts'), `export const a = "${'a'.repeat(maxReviewerDiffChars)}";\n`)
    runGit(['add', 'src/a.ts'])
    vi.spyOn(ctx.spillStore, 'saveText').mockRejectedValue(new Error('spill storage unavailable'))
    const result = await call('review', { target: 'staged', focus: ['src/a.ts'], maxReviewers: 1 })
    expect(result.value).toMatchObject({
      verdict: 'reject',
      slices: [],
      errors: [expect.stringContaining('spill storage unavailable')],
    })
    expect(reviewerPrompts).toEqual([])
  })

  it('reports reviewer failures as errors without crashing', async () => {
    await seedChanges()
    erroringStart = true
    try {
      const result = await call('review', { target: 'staged' })
      const value = result.value as { errors: string[]; slices: unknown[]; verdict: string }
      expect(value.errors.length).toBeGreaterThan(0)
      expect(value.errors[0]).toContain('model transport failed')
      expect(value.slices).toHaveLength(0)
      // No reviewer completed: refusing to approve unreviewed changes.
      expect(value.verdict).toBe('reject')
    } finally {
      erroringStart = false
    }
  })
})

function gitSectionPair(): string {
  return [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-const a = 1;',
    '+const a = 2;',
    'diff --git a/src/b.ts b/src/b.ts',
    'index 3333333..4444444 100644',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1 +1 @@',
    '-const b = 2;',
    '+const b = 3;',
  ].join('\n')
}
