import { describe, expect, it } from 'vitest'
import { analyzeSession } from '../src/adapter/dsh.ts'
import type { HealthSessionLike } from '../src/adapter/dsh.ts'
import { parseRecentEditsArgs, parseSessionHealthArgs, parseSinceMs } from '../src/input.ts'
import { formatRecentEdits, formatRecentHealth, formatSessionHealth } from '../src/presentation.ts'
import { parseLogText, projectKey, sessionsDirForCwd } from '../src/cli.ts'

describe('parseSessionHealthArgs', () => {
  it('accepts both actions and parses optional fields', () => {
    expect(parseSessionHealthArgs({ action: 'recent' })).toEqual({ action: 'recent' })
    expect(parseSessionHealthArgs({
      action: 'session', sessionId: 'abc', limit: 5, since: '2026-09-01T00:00:00Z',
    })).toEqual({
      action: 'session', sessionId: 'abc', limit: 5, since: '2026-09-01T00:00:00Z',
      sinceMs: Date.parse('2026-09-01T00:00:00Z'),
    })
  })

  it('rejects unknown actions, a missing sessionId, and bad values', () => {
    expect(() => parseSessionHealthArgs({ action: 'nope' })).toThrow(/action must be one of/)
    expect(() => parseSessionHealthArgs({ action: 'session' })).toThrow(/requires a sessionId/)
    expect(() => parseSessionHealthArgs({ action: 'recent', limit: 0 })).toThrow(/positive integer/)
    expect(() => parseSessionHealthArgs({ action: 'recent', since: 'garbage' })).toThrow(/ISO-8601/)
    expect(() => parseSessionHealthArgs(null)).toThrow(/must be an object/)
  })

  it('parses since with Date semantics', () => {
    expect(parseSinceMs('2026-01-02T03:04:05Z')).toBe(Date.parse('2026-01-02T03:04:05Z'))
  })

  it('validates session_recent_edits arguments', () => {
    expect(parseRecentEditsArgs({ path: 'src' })).toEqual({ path: 'src' })
    expect(parseRecentEditsArgs({ limit: 10, perFile: 2 })).toEqual({ limit: 10, perFile: 2 })
    expect(parseRecentEditsArgs({ since: '2026-09-01T00:00:00Z' }).sinceMs).toBe(Date.parse('2026-09-01T00:00:00Z'))
    expect(() => parseRecentEditsArgs({ limit: 0 })).toThrow(/positive integer/)
    expect(() => parseRecentEditsArgs(null)).toThrow(/must be an object/)
  })
})

describe('presentation', () => {
  const signals = analyzeSession({
    id: 'sess-1',
    createdAt: 1_000,
    events: [
      { seq: 0, time: 1_000, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'implement foo' }], source: {} } },
      { seq: 1, time: 2_000, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], source: {} }, usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0 }, turn: 1, step: 1 } },
    ],
  } satisfies HealthSessionLike)

  it('renders a single-session report with outcome and grade', () => {
    const text = formatSessionHealth(signals)
    expect(text).toContain('Session health for sess-1')
    expect(text).toContain('Outcome: completed (medium confidence)')
    expect(text).toContain('Health: A (100/100)')
    expect(text).toContain('Tool health: 0 failures')
  })

  it('renders a recent-health table sorted newest first', () => {
    const older = { ...signals, sessionId: 'old', startedAt: 1_000 }
    const newer = { ...signals, sessionId: 'new', startedAt: 2_000 }
    const text = formatRecentHealth([older, newer])
    expect(text).toContain('Session health across 2 session(s)')
    expect(text).toContain('| new |')
    expect(text.indexOf('| new |')).toBeLessThan(text.indexOf('| old |'))
  })

  it('notes skipped unreadable sessions', () => {
    const text = formatRecentHealth([], { unreadable: 3 })
    expect(text).toContain('(3 unreadable session(s) skipped)')
  })

  it('renders the recent-edits feed with path detail', () => {
    const files = [
      {
        filePath: 'src/engine/types.ts',
        editCount: 4,
        lastEditedAt: 2_000,
        lastSessionId: 'sess-abcdef123456',
        edits: [
          { sessionId: 'sess-abcdef123456', timestamp: 2_000, messageOrdinal: 3, callIndex: 1, toolName: 'edit', category: 'Edit' as const, filePath: 'src/engine/types.ts' },
          { sessionId: 'sess-abc', timestamp: 1_000, messageOrdinal: 1, callIndex: 0, toolName: 'write', category: 'Write' as const, filePath: 'src/engine/types.ts' },
        ],
      },
    ]
    const text = formatRecentEdits(files, { path: 'engine' })
    expect(text).toContain('Recent edits across 1 file(s) (files matching "engine")')
    expect(text).toContain('| src/engine/types.ts |')
    expect(text).toContain('Per-file recent edits (newest first):')
    expect(text).toContain('— Edit (edit) in sess-abcdef12…')
  })
})

describe('cli helpers', () => {
  it('encodes a workspace path like the persistence backend projectKey', () => {
    expect(projectKey('/Users/hui/Documents/workspace')).toBe('--Users-hui-Documents-workspace--')
  })

  it('resolves the sessions dir under DSH_HOME', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '/tmp/dsh-home'
    try {
      expect(sessionsDirForCwd('/Users/hui/Documents/workspace'))
        .toBe('/tmp/dsh-home/sessions/--Users-hui-Documents-workspace--')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('parses a JSONL artifact into header facts and typed events', () => {
    const text = [
      JSON.stringify({ type: 'session', id: 's1', createdAt: 42, seedLength: 3 }),
      JSON.stringify({ seq: 3, time: 100, type: 'user/message', data: { role: 'user' } }),
      JSON.stringify({ seq: 4, time: 200, type: 'compaction/end', data: { compactionId: 'c' } }),
    ].join('\n')
    const parsed = parseLogText(text, '/tmp/s1', 'session.jsonl.zstd')
    expect(parsed.id).toBe('s1')
    expect(parsed.createdAt).toBe(42)
    expect(parsed.inheritedEventCount).toBe(3)
    expect(parsed.events.map(e => e.type)).toEqual(['user/message', 'compaction/end'])
  })
})
