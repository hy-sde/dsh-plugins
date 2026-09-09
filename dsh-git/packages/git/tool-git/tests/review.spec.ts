/**
 * The `review` tool: pure helper coverage (slicing, prompt shape, priority
 * mapping) plus an end-to-end execute with a fabricated subagent provider
 * returning canned reviewer verdicts, exercising slice fan-out and verdict
 * aggregation without real agents.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
import toolGitPackage from '@hy-sde-org/dsh-tool-git'
import {
  toPriority,
  sliceByWeight,
  gitDiffSection,
  buildReviewerPrompt,
} from '../src/review.ts'

let dir: string
let ctx: Context
let counter = 0

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

const agent = { session: { header: { id: 's1', cwd: '' } } } as never

async function call(name: string, args: unknown): Promise<{ value: unknown }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`rev-${++counter}`),
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
function fakeSubagents(): { getProvider: () => unknown; start: () => Promise<unknown> } {
  return {
    getProvider: () => ({ provider: 'spawn' }),
    start: () => {
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
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Git)
  await ctx.plugin(toolGitPackage)
  ctx.provide('subagents', fakeSubagents() as never)
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await ctx.fiber.dispose()
})

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

  it('builds a reviewer prompt with the owned files and inline diff', () => {
    const prompt = buildReviewerPrompt('reviewer 1/1', ['src/a.ts'], 'diff')
    expect(prompt).toContain('reviewer 1/1')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('READ-ONLY')
    expect(prompt).toContain('P0')
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
