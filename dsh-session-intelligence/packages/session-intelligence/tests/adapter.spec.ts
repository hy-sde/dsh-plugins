import { describe, expect, it } from 'vitest'
import { analyzeSession } from '../src/adapter/dsh.ts'
import type { HealthSessionEventLike, HealthSessionLike } from '../src/adapter/dsh.ts'

function event(seq: number, time: number, type: string, data: unknown): HealthSessionEventLike {
  return { seq, time, type, data }
}

function session(events: HealthSessionEventLike[], id = 'sess-1', createdAt = 1000): HealthSessionLike {
  return { id, createdAt, events }
}

describe('analyzeSession (DSH adapter)', () => {
  it('reduces a small session into outcome, tool health, and score', () => {
    const events = [
      event(0, 1_000, 'user/message', {
        role: 'user', id: 'u1',
        content: [{ type: 'text', text: 'implement foo' }], source: { kind: 'user' },
      }),
      event(1, 2_000, 'assistant/message', {
        message: {
          role: 'assistant', id: 'a1',
          content: [{ type: 'text', text: 'done' }, { type: 'tool-call', id: 'tc1', name: 'bash', arguments: '{"cmd":"pnpm test"}' }],
          source: { kind: 'assistant' },
        },
        usage: { inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 2_000 },
        turn: 1, step: 1,
      }),
      event(2, 2_100, 'tool/call', { callId: 'c1', name: 'bash', arguments: '{"cmd":"pnpm test"}', turn: 1, step: 1 }),
      event(3, 2_200, 'tool/result', {
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{
            type: 'tool-result', toolCallId: 'c1',
            content: [{ type: 'text', text: 'exit status 1\nfatal: oops' }],
            isError: true,
          }],
          role: 'user', id: 'r1',
        },
        error: { name: 'ToolError', code: 'FAILED' },
        turn: 1, step: 1,
      }),
    ]
    const signals = analyzeSession(session(events))

    expect(signals.messageCount).toBe(2)
    expect(signals.outcome).toEqual({ outcome: 'completed', confidence: 'medium', isRecent: false })
    expect(signals.toolHealth).toEqual({
      failureSignalCount: 1, retryCount: 0, editChurnCount: 0, consecutiveFailureMax: 1,
    })
    expect(signals.finalFailureStreak).toBe(1)
    expect(signals.hasContextData).toBe(true)
    expect(signals.peakContextTokens).toBe(3_000)
    expect(signals.compactionCount).toBe(0)
    expect(signals.score.score).toBe(97)
    expect(signals.score.grade).toBe('A')
    expect(signals.score.penalties).toEqual({ tool_failure_signals: 3 })
  })

  it('counts explicit compactions and mid-task tool overlap', () => {
    const events = [
      event(0, 1_000, 'user/message', { role: 'user', id: 'u1', content: [{ type: 'text', text: 'fix the parser bug' }], source: {} }),
      event(1, 2_000, 'assistant/message', { message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'let me look' }], source: {} }, usage: { inputTokens: 50_000, outputTokens: 100, cacheReadTokens: 20_000 }, turn: 1, step: 1 }),
      event(2, 2_500, 'tool/call', { callId: 'c1', name: 'bash', arguments: '{"cmd":"rg foo src"}', turn: 1, step: 1 }),
      event(3, 2_600, 'tool/result', { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }], role: 'user', id: 'r1' }, turn: 1, step: 1 }),
      event(4, 3_000, 'tool/call', { callId: 'c2', name: 'edit', arguments: '{"file_path":"src/parser.ts"}', turn: 1, step: 2 }),
      event(5, 3_100, 'tool/result', { message: { source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'patched' }] }], role: 'user', id: 'r2' }, turn: 1, step: 2 }),
      event(6, 4_000, 'compaction/end', { compactionId: 'cc1', turn: 1 }),
      event(7, 4_100, 'compaction/summary', { compactionId: 'cc1', provider: 'x', model: 'claude-sonnet-4-5', summary: [{ type: 'text', text: 'summary' }], usage: { inputTokens: 30_000, outputTokens: 50, cacheReadTokens: 20_000 }, turn: 1 }),
      event(8, 5_000, 'assistant/message', { message: { role: 'assistant', id: 'a2', content: [{ type: 'text', text: 'ok continuing' }], source: {} }, usage: { inputTokens: 25_000, outputTokens: 40, cacheReadTokens: 10_000 }, turn: 2, step: 1 }),
      event(9, 5_100, 'tool/call', { callId: 'c3', name: 'bash', arguments: '{"cmd":"rg foo src"}', turn: 2, step: 1 }),
      event(10, 5_200, 'tool/result', { message: { source: { kind: 'tool', callId: 'c3' }, content: [{ type: 'tool-result', toolCallId: 'c3', content: [{ type: 'text', text: 'ok' }] }], role: 'user', id: 'r3' }, turn: 2, step: 1 }),
      event(11, 5_300, 'tool/call', { callId: 'c4', name: 'edit', arguments: '{"file_path":"src/parser.ts"}', turn: 2, step: 2 }),
      event(12, 5_400, 'tool/result', { message: { source: { kind: 'tool', callId: 'c4' }, content: [{ type: 'tool-result', toolCallId: 'c4', content: [{ type: 'text', text: 'patched again' }] }], role: 'user', id: 'r4' }, turn: 2, step: 2 }),
    ]
    const signals = analyzeSession(session(events))

    expect(signals.messageCount).toBe(3)
    expect(signals.explicitCompactionBoundaries).toEqual([2])
    expect(signals.compactionCount).toBe(1)
    expect(signals.midTaskCompactionCount).toBe(1)
    expect(signals.model).toBe('claude-sonnet-4-5')
    expect(signals.pressureMax).not.toBeNull()
    expect(signals.toolHealth.failureSignalCount).toBe(0)
    expect(signals.score.basis).toContain('context_pressure')
  })

  it('skips inherited (seeded) events', () => {
    const events = [
      event(0, 500, 'user/message', { role: 'user', id: 'u0', content: [{ type: 'text', text: 'parent message' }], source: {} }),
      event(5, 1_000, 'user/message', { role: 'user', id: 'u1', content: [{ type: 'text', text: 'my real task: fix the parser bug' }], source: {} }),
      event(6, 2_000, 'assistant/message', { message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'working' }], source: {} }, usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0 }, turn: 1, step: 1 }),
    ]
    const signals = analyzeSession({
      id: 'sess-inherit',
      createdAt: 1_000,
      inheritedEventCount: 2,
      events,
    })
    expect(signals.messageCount).toBe(2)
    expect(signals.outcome.outcome).toBe('completed')
  })
})
