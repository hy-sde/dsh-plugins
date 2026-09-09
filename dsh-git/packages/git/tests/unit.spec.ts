/**
 * Pure-logic ports: diff parsing, hunk selection/validation, topological
 * ordering with cycle rejection, lock-file placement, trivial detection, and
 * message formatting — no subprocesses, no context.
 */

import { describe, expect, it } from 'vitest'
import {
  parseNumstat,
  parseFileDiffs,
  parseFileHunks,
  parseDiffHunks,
  selectHunks,
  extractFileHeader,
  validateHunkSelections,
} from '../src/diff.ts'
import { computeDependencyOrder } from '../src/topo-sort.ts'
import { assignLockFilesToPlan, EXCLUDED_LOCK_FILES } from '../src/lock-files.ts'
import { detectTrivialChange } from '../src/trivial.ts'
import { formatCommitMessage } from '../src/commit-message.ts'
import type { SplitCommitGroup, SplitCommitPlan } from '../src/types.ts'

const SAMPLE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' function keep() {',
  '-  return 1;',
  '+  return 2;',
  ' }',
  '@@ -10,3 +10,4 @@',
  ' const x = 1;',
  '+export const y = 2;',
  ' const z = 3;',
].join('\n')

describe('parseNumstat', () => {
  it('parses tab-separated counts and resolves rename paths', () => {
    const entries = parseNumstat('3\t2\tsrc/a.ts\n0\t0\t{before => after}/file.ts\n2\t1\tplain.txt\n')
    expect(entries).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 2 },
      { path: 'after/file.ts', additions: 0, deletions: 0 },
      { path: 'plain.txt', additions: 2, deletions: 1 },
    ])
  })

  it('handles empty input', () => {
    expect(parseNumstat('')).toEqual([])
  })
})

describe('parseFileDiffs', () => {
  it('splits a multi-file diff into sections with counts', () => {
    const files = parseFileDiffs(SAMPLE_DIFF)
    expect(files).toHaveLength(1)
    expect(files[0]!.filename).toBe('src/a.ts')
    expect(files[0]!.additions).toBe(2)
    expect(files[0]!.deletions).toBe(1)
    expect(files[0]!.isBinary).toBe(false)
  })

  it('flags binary files', () => {
    const binary = [
      'diff --git a/img.png b/img.png',
      'new file mode 100644',
      'index 0000000..1111111',
      'Binary files /dev/null and b/img.png differ',
    ].join('\n')
    const files = parseFileDiffs(binary)
    expect(files[0]!.isBinary).toBe(true)
  })
})

describe('parseFileHunks / parseDiffHunks', () => {
  it('parses hunk headers into line ranges', () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF)
    expect(hunks[0]!.filename).toBe('src/a.ts')
    expect(hunks[0]!.hunks).toHaveLength(2)
    const first = hunks[0]!.hunks[0]!
    expect(first.index).toBe(0)
    expect(first.oldStart).toBe(1)
    expect(first.oldLines).toBe(4)
    expect(first.newStart).toBe(1)
    expect(first.newLines).toBe(4)
    expect(secondOf(hunks[0]!).index).toBe(1)
    expect(hunks[0]!.hunks[0]!.content.startsWith('@@ -1,4 +1,4 @@')).toBe(true)
  })
})

function secondOf(file: { hunks: Array<{ index: number }> }): { index: number } {
  return file.hunks[1]!
}

describe('selectHunks + validateHunkSelections', () => {
  const file = parseFileHunks(parseFileDiffs(SAMPLE_DIFF)[0]!)

  it('selects by 1-based index', () => {
    const selected = selectHunks(file, { type: 'indices', indices: [1] })
    expect(selected).toHaveLength(1)
    expect(selected[0]!.index).toBe(0)
  })

  it('selects by new-file line range', () => {
    const selected = selectHunks(file, { type: 'lines', start: 11, end: 11 })
    expect(selected).toHaveLength(1)
    expect(selected[0]!.index).toBe(1)
  })

  it('validates selections against a raw diff and reports bound errors', () => {
    expect(validateHunkSelections(SAMPLE_DIFF, [{ path: 'src/a.ts', hunks: { type: 'indices', indices: [2] } }])).toEqual([])
    expect(validateHunkSelections(SAMPLE_DIFF, [{ path: 'src/a.ts', hunks: { type: 'indices', indices: [9] } }]))
      .toEqual(['no hunks selected for src/a.ts'])
  })
})

describe('computeDependencyOrder', () => {
  const group = (dependencies: number[], index = 0): SplitCommitGroup => ({
    changes: [{ path: `f${index}`, hunks: { type: 'all' } }],
    type: 'feat',
    scope: null,
    summary: `summary ${index}`,
    details: [],
    issueRefs: [],
    dependencies,
  })

  it('orders independent groups and respects declared dependencies', () => {
    const groups = [group([2]), group([0]), group([])]
    const order = computeDependencyOrder(groups)
    expect(order).toEqual([2, 0, 1])
  })

  it('rejects cycles before anything is written', () => {
    const groups = [group([1]), group([0])]
    const order = computeDependencyOrder(groups)
    expect('error' in order).toBe(true)
    expect((order as { error: string }).error).toContain('Circular')
  })

  it('rejects out-of-range dependency indices', () => {
    const order = computeDependencyOrder([group([5])])
    expect('error' in order).toBe(true)
    expect((order as { error: string }).error).toContain('Invalid dependency index')
  })
})

describe('assignLockFilesToPlan', () => {
  const baseGroup = (path: string): SplitCommitGroup => ({
    changes: [{ path, hunks: { type: 'all' } }],
    type: 'feat',
    scope: null,
    summary: 'x',
    details: [],
    issueRefs: [],
    dependencies: [],
  })

  it('attaches a lock file to the group touching its sibling manifest', () => {
    const plan: SplitCommitPlan = { commits: [baseGroup('packages/a/package.json'), baseGroup('README.md')], warnings: [] }
    assignLockFilesToPlan(plan, ['packages/a/package.json', 'packages/a/pnpm-lock.yaml', 'README.md'])
    expect(plan.commits[0]!.changes).toContainEqual({ path: 'packages/a/pnpm-lock.yaml', hunks: { type: 'all' } })
    expect(plan.commits[1]!.changes).not.toContainEqual({ path: 'packages/a/pnpm-lock.yaml' })
  })

  it('falls back to the last commit when no manifest matches', () => {
    const plan: SplitCommitPlan = { commits: [baseGroup('src/a.ts')], warnings: [] }
    assignLockFilesToPlan(plan, ['src/a.ts', 'Gemfile.lock'])
    expect(plan.commits[0]!.changes).toContainEqual({ path: 'Gemfile.lock', hunks: { type: 'all' } })
  })
})

describe('detectTrivialChange', () => {
  it('classifies whitespace-only diffs as style', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '-  ',
      '+    ',
    ].join('\n')
    const result = detectTrivialChange(diff)
    expect(result).toEqual({ isTrivial: true, type: 'style', summary: 'formatted code' })
  })

  it('classifies import-only diffs as style', () => {
    const diff = [
      '@@ -1 +1 @@',
      "-import { a } from './b'",
      "+import { a, c } from './b'",
    ].join('\n')
    const result = detectTrivialChange(diff)
    expect(result?.type).toBe('style')
  })

  it('returns null for substantive changes', () => {
    expect(detectTrivialChange('@@ -1 +2 @@\n+const value = compute()\n')).toBeNull()
  })
})

describe('formatCommitMessage', () => {
  it('renders header with scope and body bullets', () => {
    const message = formatCommitMessage(
      { type: 'feat', scope: 'git', details: [{ text: ' add commit tool ', userVisible: true }], issueRefs: [] },
      'port agentic commit',
    )
    expect(message).toBe('feat(git): port agentic commit\n\n- add commit tool')
  })

  it('renders header only without details', () => {
    expect(formatCommitMessage({ type: 'fix', scope: null, details: [], issueRefs: [] }, 'fix the bug')).toBe('fix: fix the bug')
  })
})

describe('EXCLUDED_LOCK_FILES', () => {
  it('covers the common lock files', () => {
    for (const name of ['Cargo.lock', 'go.sum', 'pnpm-lock.yaml', 'package-lock.json', 'Gemfile.lock']) {
      expect(EXCLUDED_LOCK_FILES.has(name)).toBe(true)
    }
  })
})

describe('extractFileHeader', () => {
  it('returns everything before the first hunk', () => {
    const header = extractFileHeader(SAMPLE_DIFF)
    expect(header).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(header).not.toContain('@@')
  })
})
