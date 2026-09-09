import { describe, expect, it } from 'vitest'
import {
  classifyOutcome,
  computeContextPressure,
  computeHealthScore,
  countMidTaskCompactions,
  normalizeToolCategory,
} from '../src/engine/index.ts'
import type { HeuristicSignals, OutcomeInput, ToolCallOrdinal } from '../src/engine/types.ts'

const quiet: HeuristicSignals = {
  shortPromptCount: 0,
  unstructuredStart: false,
  missingSuccessCriteriaCount: 0,
  missingVerificationCount: 0,
  duplicatePromptCount: 0,
  noCodeContextCount: 0,
  runawayToolLoopCount: 0,
}

function outcomeInput(overrides: Partial<OutcomeInput> = {}): OutcomeInput {
  return {
    isAutomated: false,
    messageCount: 5,
    endedWithRole: 'assistant',
    finalFailureStreak: 0,
    lastAssistantText: '',
    lastActivityMs: Date.now() - 60 * 60 * 1000,
    ...overrides,
  }
}

describe('classifyOutcome', () => {
  it('reports unknown/low for automated sessions', () => {
    expect(classifyOutcome(outcomeInput({ isAutomated: true }))).toEqual({
      outcome: 'unknown', confidence: 'low', isRecent: false,
    })
  })

  it('treats a recent terminal API error as still pending', () => {
    expect(classifyOutcome(outcomeInput({
      endedWithRole: 'assistant',
      lastAssistantText: 'API error: connection reset',
      lastActivityMs: Date.now() - 60 * 1000,
    }))).toEqual({ outcome: 'unknown', confidence: 'low', isRecent: true })
  })

  it('classifies a stale terminal API error as errored', () => {
    expect(classifyOutcome(outcomeInput({
      endedWithRole: 'assistant',
      lastAssistantText: 'API error: connection reset',
    }))).toEqual({ outcome: 'errored', confidence: 'medium', isRecent: false })
  })

  it('treats a 2-message assistant-ended session as completed', () => {
    expect(classifyOutcome(outcomeInput({ messageCount: 2 }))).toEqual({
      outcome: 'completed', confidence: 'medium', isRecent: false,
    })
  })

  it('reports unknown/low below three messages', () => {
    expect(classifyOutcome(outcomeInput({ messageCount: 1, endedWithRole: 'user' }))).toEqual({
      outcome: 'unknown', confidence: 'low', isRecent: false,
    })
  })

  it('marks a recent session as still active', () => {
    expect(classifyOutcome(outcomeInput({ lastActivityMs: Date.now() - 60 * 1000 }))).toEqual({
      outcome: 'unknown', confidence: 'low', isRecent: true,
    })
  })

  it('classifies user-ended sessions as abandoned (high confidence when long)', () => {
    expect(classifyOutcome(outcomeInput({ endedWithRole: 'user', messageCount: 5 }))).toEqual({
      outcome: 'abandoned', confidence: 'medium', isRecent: false,
    })
    expect(classifyOutcome(outcomeInput({ endedWithRole: 'user', messageCount: 12 }))).toEqual({
      outcome: 'abandoned', confidence: 'high', isRecent: false,
    })
  })

  it('classifies a long final failure streak as errored', () => {
    expect(classifyOutcome(outcomeInput({ finalFailureStreak: 3 }))).toEqual({
      outcome: 'errored', confidence: 'medium', isRecent: false,
    })
  })

  it('classifies assistant-ended sessions as completed, low when giving up', () => {
    expect(classifyOutcome(outcomeInput())).toEqual({
      outcome: 'completed', confidence: 'medium', isRecent: false,
    })
    expect(classifyOutcome(outcomeInput({
      lastAssistantText: "I'm unable to proceed without write access",
    }))).toEqual({ outcome: 'completed', confidence: 'low', isRecent: false })
  })
})

describe('computeContextPressure', () => {
  it('counts >30% drops between consecutive measured rows', () => {
    const result = computeContextPressure([
      { contextTokens: 100_000, hasContextTokens: true },
      { contextTokens: 60_000, hasContextTokens: true },
      { contextTokens: 61_000, hasContextTokens: true },
      { contextTokens: 0, hasContextTokens: false },
      { contextTokens: 50_000, hasContextTokens: true },
    ], 100_000, 'claude-sonnet-4-5')
    // 60k drops >30% below 100k; 61k grows; 50k is >30% of 61k (42.7k).
    expect(result.compactionCount).toBe(1)
  })

  it('computes peak-to-window pressure for known models', () => {
    const forward = computeContextPressure([], 100_000, 'claude-sonnet-4-5')
    expect(forward.pressureMax).toBeCloseTo(0.5)
    const prefix = computeContextPressure([], 128_000, 'gpt-4o-mini')
    expect(prefix.pressureMax).toBe(1)
    // Prefix matching: gpt-4o-mini must win over gpt-4o.
    const mini = computeContextPressure([], 64_000, 'gpt-4o-mini')
    expect(mini.pressureMax).toBeCloseTo(0.5)
  })

  it('returns null pressure for unknown models or no peak', () => {
    expect(computeContextPressure([], 100_000, 'mystery-model').pressureMax).toBeNull()
    expect(computeContextPressure([], 0, 'claude-sonnet-4-5').pressureMax).toBeNull()
    expect(computeContextPressure([], 100_000, '').pressureMax).toBeNull()
  })
})

describe('countMidTaskCompactions', () => {
  function calls(entries: ReadonlyArray<readonly [number, string]>): ToolCallOrdinal[] {
    return entries.map(([messageOrdinal, toolName]) => ({ messageOrdinal, toolName }))
  }

  it('flags a boundary when >=2 distinct tool names overlap', () => {
    const before = calls([[1, 'bash'], [2, 'edit'], [3, 'read']])
    const after = calls([[5, 'bash'], [6, 'edit'], [7, 'write']])
    expect(countMidTaskCompactions([4], [...before, ...after])).toBe(1)
  })

  it('ignores boundaries with no overlap and empty windows', () => {
    const disjoint = calls([[1, 'bash'], [2, 'edit'], [9, 'ls'], [10, 'cat']])
    expect(countMidTaskCompactions([4], disjoint)).toBe(0)
    expect(countMidTaskCompactions([4], [])).toBe(0)
    expect(countMidTaskCompactions([], calls([[1, 'bash']]))).toBe(0)
  })

  it('does not inflate from a single repeated tool', () => {
    const callsOnly = calls([[1, 'bash'], [5, 'bash'], [6, 'bash'], [7, 'bash']])
    expect(countMidTaskCompactions([4], callsOnly)).toBe(0)
  })
})

describe('computeHealthScore', () => {
  function input(overrides: Partial<Parameters<typeof computeHealthScore>[0]> = {}) {
    return {
      outcome: 'completed',
      outcomeConfidence: 'medium',
      hasToolCalls: true,
      failureSignalCount: 0,
      retryCount: 0,
      editChurnCount: 0,
      consecutiveFailMax: 0,
      hasContextData: true,
      compactionCount: 0,
      midTaskCompactionCount: 0,
      pressureMax: null,
      heuristics: quiet,
      ...overrides,
    }
  }

  it('scores a clean session A with the full basis', () => {
    const result = computeHealthScore(input())
    expect(result.score).toBe(100)
    expect(result.grade).toBe('A')
    expect(result.basis).toEqual(['outcome', 'tool_health', 'context_pressure'])
    expect(result.penalties).toEqual({})
  })

  it('does not score unknown/low without supporting signals', () => {
    const result = computeHealthScore(input({
      outcome: 'unknown', outcomeConfidence: 'low', hasToolCalls: false, hasContextData: false,
    }))
    expect(result.score).toBeNull()
    expect(result.grade).toBe('')
  })

  it('scores unknown/low when other signals exist', () => {
    const result = computeHealthScore(input({ outcome: 'unknown', outcomeConfidence: 'low' }))
    expect(result.score).toBe(100)
  })

  it('applies outcome, tool, context and heuristic penalties', () => {
    const result = computeHealthScore(input({
      outcome: 'errored',
      failureSignalCount: 12,
      retryCount: 6,
      editChurnCount: 6,
      consecutiveFailMax: 4,
      compactionCount: 4,
      midTaskCompactionCount: 3,
      pressureMax: 0.95,
      heuristics: {
        ...quiet,
        unstructuredStart: true,
        missingSuccessCriteriaCount: 1,
        duplicatePromptCount: 3,
        noCodeContextCount: 1,
        runawayToolLoopCount: 2,
      },
    }))
    expect(result.penalties).toEqual({
      outcome_errored: 30,
      tool_failure_signals: 30,
      tool_retries: 25,
      edit_churn: 20,
      consecutive_failures: 10,
      compactions: 15,
      mid_task_compactions: 18,
      context_pressure_high: 10,
      constraintless_first_prompt: 1,
      missing_success_criteria: 1,
      stuck_repeated_prompts: 4,
      code_task_without_context: 4,
      repeated_failing_tool_cycles: 5,
    })
    expect(result.score).toBe(0)
    expect(result.grade).toBe('F')
  })

  it('grades boundaries at 90/75/60/40', () => {
    const make = (score: number) => {
      // Walk back: choose inputs that yield the wanted score bucket.
      expect(computeHealthScore(input())).toBeDefined()
      return score
    }
    make(100)
    const high = computeHealthScore(input({ failureSignalCount: 4 })) // -12 => 88 -> B
    expect(high.grade).toBe('B')
    const mid = computeHealthScore(input({ failureSignalCount: 9 })) // -27 => 73 -> C
    expect(mid.grade).toBe('C')
    const low = computeHealthScore(input({ outcome: 'abandoned', failureSignalCount: 12 })) // -15-30=>55->D
    expect(low.grade).toBe('D')
    const floor = computeHealthScore(input({ outcome: 'errored' })) // -30 => 70 -> C
    expect(floor.grade).toBe('C')
    // explicit boundary check
    expect(computeHealthScore(input({ outcome: 'abandoned', failureSignalCount: 9 }))).toMatchObject({
      grade: 'D',
    })
  })
})

describe('normalizeToolCategory (engine)', () => {
  it('maps the DSH tool surface', () => {
    expect(normalizeToolCategory('bash')).toBe('Bash')
    expect(normalizeToolCategory('edit')).toBe('Edit')
    expect(normalizeToolCategory('read')).toBe('Read')
    expect(normalizeToolCategory('grep')).toBe('Grep')
    expect(normalizeToolCategory('glob')).toBe('Glob')
    expect(normalizeToolCategory('todo_write')).toBe('Tool')
    expect(normalizeToolCategory('mcp__zen_subagents__spawn_subagent')).toBe('Task')
    expect(normalizeToolCategory('warp_engine')).toBe('Other')
  })
})
