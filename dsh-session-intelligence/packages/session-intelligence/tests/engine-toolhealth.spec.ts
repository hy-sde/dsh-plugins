import { describe, expect, it } from 'vitest'
import { computeToolHealth, isFailure } from '../src/engine/index.ts'
import type { ToolCallRow } from '../src/engine/types.ts'

function call(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    toolName: 'bash',
    category: 'Bash',
    inputJson: '{}',
    resultContent: '',
    messageOrdinal: 0,
    callIndex: 0,
    eventStatus: '',
    ...overrides,
  }
}

describe('isFailure', () => {
  it('honors explicit event status first', () => {
    expect(isFailure(call({ eventStatus: 'errored' }))).toBe(true)
    expect(isFailure(call({ eventStatus: 'cancelled' }))).toBe(true)
    expect(isFailure(call({ eventStatus: 'completed' }))).toBe(false)
    expect(isFailure(call({ eventStatus: '' }))).toBe(false)
  })

  it('detects bash failures by content heuristics', () => {
    expect(isFailure(call({ resultContent: 'bash: rg: command not found' }))).toBe(true)
    expect(isFailure(call({ resultContent: 'cp: Permission denied' }))).toBe(true)
    expect(isFailure(call({ resultContent: 'Traceback (most recent call last):\n  File "x.py"' }))).toBe(true)
    expect(isFailure(call({ resultContent: 'goroutine 23 [running]:\nsyscall.Syscall' }))).toBe(true)
    expect(isFailure(call({ resultContent: '  at packageA.Thing (x.js:1:1)\n  at packageB.Thing (y.js:2:2)\n  at packageC.Thing (z.js:3:3)' }))).toBe(true)
  })

  it('requires an error companion to elevate a non-zero exit code', () => {
    expect(isFailure(call({ resultContent: 'exit status 1' }))).toBe(false)
    expect(isFailure(call({ resultContent: 'exit status 1\nNo such file or directory' }))).toBe(true)
    expect(isFailure(call({ resultContent: 'fatal: not a git repository\n exit code 2' }))).toBe(true)
    expect(isFailure(call({ resultContent: 'panic: nil pointer dereference\n exit code 2' }))).toBe(true)
  })

  it('detects edit/write failures only by FAILED content', () => {
    expect(isFailure(call({ category: 'Edit', toolName: 'edit', resultContent: 'patch FAILED at hunk 3' }))).toBe(true)
    expect(isFailure(call({ category: 'Write', toolName: 'write', resultContent: 'write FAILED' }))).toBe(true)
    expect(isFailure(call({ category: 'Edit', resultContent: 'patched cleanly' }))).toBe(false)
    expect(isFailure(call({ category: 'Read', resultContent: 'exit status 1' }))).toBe(false)
  })
})

describe('computeToolHealth', () => {
  it('counts failures and the longest consecutive streak', () => {
    const health = computeToolHealth([
      call({ resultContent: 'command not found' }),
      call({ resultContent: 'command not found' }),
      call({ resultContent: 'ok' }),
      call({ resultContent: 'Permission denied' }),
    ])
    expect(health.failureSignalCount).toBe(3)
    expect(health.consecutiveFailureMax).toBe(2)
  })

  it('counts retries for >=3 identical consecutive calls', () => {
    const json = '{"cmd":"pnpm t"}'
    const health = computeToolHealth([
      call({ inputJson: json, resultContent: 'error x' }),
      call({ inputJson: json, resultContent: 'error x' }),
      call({ inputJson: json, resultContent: 'error x' }),
      call({ inputJson: json, resultContent: 'error x' }),
      call({ inputJson: '{"cmd":"pnpm t2"}', resultContent: 'ok' }),
    ])
    expect(health.retryCount).toBe(3)
  })

  it('does not count retries for differing arguments or short runs', () => {
    const health = computeToolHealth([
      call({ inputJson: '{"cmd":"a"}', resultContent: 'x' }),
      call({ inputJson: '{"cmd":"b"}', resultContent: 'x' }),
      call({ inputJson: '{"cmd":"a"}', resultContent: 'x' }),
    ])
    expect(health.retryCount).toBe(0)
  })

  it('counts one churn event per file with 3+ edits in a 10-ordinal span', () => {
    const health = computeToolHealth([
      call({ category: 'Edit', inputJson: '{"file_path":"src/a.ts"}', messageOrdinal: 1 }),
      call({ category: 'Edit', inputJson: '{"file_path":"src/a.ts"}', messageOrdinal: 2 }),
      call({ category: 'Edit', inputJson: '{"file_path":"src/a.ts"}', messageOrdinal: 3 }),
      call({ category: 'Edit', inputJson: '{"file_path":"src/b.ts"}', messageOrdinal: 1 }),
      call({ category: 'Edit', inputJson: '{"file_path":"src/b.ts"}', messageOrdinal: 2 }),
      call({ category: 'Edit', inputJson: '{"file_path":"src/b.ts"}', messageOrdinal: 3 }),
      // Two edits only: no churn.
      call({ category: 'Write', inputJson: '{"file_path":"src/c.ts"}', messageOrdinal: 1 }),
      call({ category: 'Write', inputJson: '{"file_path":"src/c.ts"}', messageOrdinal: 2 }),
      // Outside the 10-ordinal window.
      call({ category: 'Edit', inputJson: '{"file_path":"src/d.ts"}', messageOrdinal: 1 }),
      call({ category: 'Edit', inputJson: '{"file_path":"src/d.ts"}', messageOrdinal: 20 }),
      call({ category: 'Edit', inputJson: '{"file_path":"src/d.ts"}', messageOrdinal: 21 }),
    ])
    expect(health.editChurnCount).toBe(2)
  })

  it('skips non-edit/write calls and files without a path', () => {
    const health = computeToolHealth([
      call({ category: 'Bash', inputJson: '{"file_path":"src/a.ts"}' }),
      call({ category: 'Edit', inputJson: '{"path":"src/a.ts"}' }),
    ])
    expect(health.editChurnCount).toBe(0)
  })
})
