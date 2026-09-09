import { describe, expect, it } from 'vitest'
import {
  analyzeHeuristics,
  countFrustrationMarkers,
  isFrustrationMarker,
} from '../src/engine/heuristics.ts'
import type { HeuristicMessage, HeuristicInput, ToolCallRow } from '../src/engine/types.ts'

/** Build one message with defaults matching the Go test fixtures. */
function msg(
  role: string,
  content: string,
  opts: { isSystem?: boolean; ordinal?: number; timestamp?: string } = {},
): HeuristicMessage {
  return {
    role,
    content,
    isSystem: opts.isSystem ?? false,
    ordinal: opts.ordinal ?? 0,
    timestamp: opts.timestamp ?? '',
  }
}

/** Build one tool row with inert defaults. */
function tool(partial: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    toolName: 'Tool',
    category: 'Other',
    inputJson: '{}',
    resultContent: '',
    messageOrdinal: 0,
    callIndex: 0,
    eventStatus: '',
    ...partial,
  }
}

function input(messages: HeuristicMessage[], toolRows: ToolCallRow[] = []): HeuristicInput {
  return { messages, toolRows }
}

describe('analyzeHeuristics — prompt quality', () => {
  it('ignores short control prompts', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'yes'),
      msg('user', 'continue'),
    ]))
    expect(got).toEqual({
      shortPromptCount: 0,
      unstructuredStart: false,
      missingSuccessCriteriaCount: 0,
      missingVerificationCount: 0,
      duplicatePromptCount: 0,
      noCodeContextCount: 0,
      runawayToolLoopCount: 0,
    })
  })

  it('counts only the first substantive short start prompt', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'fix bug'),
      msg('user', 'add tests'),
    ]))
    expect(got.shortPromptCount).toBe(1)
    expect(got.unstructuredStart).toBe(true)
    expect(got.missingSuccessCriteriaCount).toBe(1)
    expect(got.missingVerificationCount).toBe(0) // "add tests" supplies verification language
    expect(got.noCodeContextCount).toBe(1)
  })

  it('treats a structured first prompt as structured with criteria and context', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Fix internal/signals/score.go\n\n- Must preserve existing grades\n- Run go test ./internal/signals\nExpected result: tests pass'),
    ]))
    expect(got).toEqual({
      shortPromptCount: 0,
      unstructuredStart: false,
      missingSuccessCriteriaCount: 0,
      missingVerificationCount: 0,
      duplicatePromptCount: 0,
      noCodeContextCount: 0,
      runawayToolLoopCount: 0,
    })
  })

  it('flags a code task that lacks verification language (action + object)', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Implement the backend scorer in the codebase. Success means the score changes only for repeated prompts.'),
    ]))
    expect(got.missingSuccessCriteriaCount).toBe(0) // "Success" present
    expect(got.missingVerificationCount).toBe(1)
    expect(got.noCodeContextCount).toBe(1)
  })

  it('does not penalize a non-code conversation', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'What are useful ways to think about technical debt in a planning meeting?'),
    ]))
    expect(got).toEqual({
      shortPromptCount: 0,
      unstructuredStart: false,
      missingSuccessCriteriaCount: 0,
      missingVerificationCount: 0,
      duplicatePromptCount: 0,
      noCodeContextCount: 0,
      runawayToolLoopCount: 0,
    })
  })
})

describe('analyzeHeuristics — code task shape detection', () => {
  it('detects code tasks through file ref + code action', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Fix the parser in internal/parser.go.'),
    ]))
    expect(got.missingSuccessCriteriaCount).toBe(1)
    expect(got.noCodeContextCount).toBe(0) // file ref is prompt context
  })

  it('detects code tasks through failing-test / stack-trace phrases', () => {
    const viaPhrase = analyzeHeuristics(input([
      msg('user', 'The log shows a stack trace from the daemon.'),
    ]))
    expect(viaPhrase.missingSuccessCriteriaCount).toBe(1)
    const viaFailure = analyzeHeuristics(input([
      msg('user', 'Fix the failing test case in the suite.'),
    ]))
    expect(viaFailure.missingSuccessCriteriaCount).toBe(1)
  })
})

describe('analyzeHeuristics — unstructured start', () => {
  it('is unstructured when no file ref, constraints, or spec structure exist', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'fix bug'),
    ]))
    expect(got.unstructuredStart).toBe(true)
  })

  it('is structured when the prompt carries a bullet list', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Fix the parser function.\n\n- Read the file first\n- Keep changes small'),
    ]))
    expect(got.unstructuredStart).toBe(false)
  })

  it('is structured when the prompt carries a heading', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Fix the parser function.\n\n# Steps\nRead the file, then edit it.'),
    ]))
    expect(got.unstructuredStart).toBe(false)
  })

  it('is structured when the prompt states acceptance criteria', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Implement the retry logic in the app. Acceptance criteria: no duplicate calls.'),
    ]))
    expect(got.unstructuredStart).toBe(false)
  })
})

describe('analyzeHeuristics — success criteria and verification', () => {
  it('reports both missing when the prompt gives neither', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Fix the backend scorer in the codebase.'),
    ]))
    expect(got.missingSuccessCriteriaCount).toBe(1)
    expect(got.missingVerificationCount).toBe(1)
  })

  it('reports neither missing when criteria and verification appear at least once', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Fix the backend scorer in the codebase. Expected result: it works. Run the tests to check.'),
    ]))
    expect(got.missingSuccessCriteriaCount).toBe(0)
    expect(got.missingVerificationCount).toBe(0)
  })
})

describe('analyzeHeuristics — code context', () => {
  const codeTask = msg('user', 'Fix the backend test failure in the codebase.')

  it('reports missing context when neither prompt nor tool activity supplies it', () => {
    expect(analyzeHeuristics(input([codeTask])).noCodeContextCount).toBe(1)
  })

  it('treats a file reference as context', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Fix the backend test failure in internal/signals/score.go.'),
    ]))
    expect(got.noCodeContextCount).toBe(0)
  })

  it('treats Read/Grep/Glob category tool activity as context', () => {
    expect(analyzeHeuristics(input([codeTask], [tool({ category: 'Grep', toolName: 'Grep' })])).noCodeContextCount).toBe(0)
    expect(analyzeHeuristics(input([codeTask], [tool({ category: 'Glob', toolName: 'Glob' })])).noCodeContextCount).toBe(0)
    expect(analyzeHeuristics(input([codeTask], [tool({
      category: 'Read', toolName: 'Read', inputJson: '{"file_path":"a.go"}',
    })])).noCodeContextCount).toBe(0)
  })

  it('treats context commands as context', () => {
    expect(analyzeHeuristics(input([codeTask], [tool({
      category: 'Bash', toolName: 'Bash', inputJson: '{"command":"go test ./internal/signals"}',
    })])).noCodeContextCount).toBe(0)
    expect(analyzeHeuristics(input([codeTask], [tool({
      category: 'Bash', toolName: 'Bash', inputJson: '{"command":"rg TODO src/"}',
    })])).noCodeContextCount).toBe(0)
    expect(analyzeHeuristics(input([codeTask], [tool({
      category: 'Bash', toolName: 'Bash', inputJson: '{"command":"git status"}',
    })])).noCodeContextCount).toBe(0)
  })

  it('does not treat an unrelated command as context', () => {
    expect(analyzeHeuristics(input([codeTask], [tool({
      category: 'Bash', toolName: 'Bash', inputJson: '{"command":"python script.py --run"}',
    })])).noCodeContextCount).toBe(1)
  })
})

describe('analyzeHeuristics — short prompt counting', () => {
  it('counts a first substantive short prompt and a short steering prompt after a stale assistant', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Please fix the parser bug in internal/parser.go.', { timestamp: '2026-05-27T10:00:00Z' }),
      msg('assistant', 'I changed the parser.', { timestamp: '2026-05-27T10:05:00Z' }),
      msg('user', 'add tests', { timestamp: '2026-05-27T10:06:00Z' }),
      msg('assistant', 'Done.', { timestamp: '2026-05-27T10:10:00Z' }),
      msg('user', 'fix docs', { timestamp: '2026-05-27T11:00:01Z' }),
    ]))
    expect(got.shortPromptCount).toBe(1)
  })

  it('does not count a short steering prompt that follows a recent assistant', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Please fix the parser bug in internal/parser.go.', { timestamp: '2026-05-27T10:00:00Z' }),
      msg('assistant', 'I changed the parser.', { timestamp: '2026-05-27T10:05:00Z' }),
      msg('user', 'add tests', { timestamp: '2026-05-27T10:06:00Z' }),
    ]))
    expect(got.shortPromptCount).toBe(0)
  })

  it('counts a short first prompt plus a later stale short steering prompt', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'fix bug', { timestamp: '2026-05-27T10:00:00Z' }),
      msg('assistant', 'Working on it.', { timestamp: '2026-05-27T10:00:30Z' }),
      msg('user', 'add tests', { timestamp: '2026-05-27T11:00:01Z' }),
    ]))
    // "add tests" is the first user after the assistant and follows a stale
    // assistant (>30 min), so it counts as a second short start.
    expect(got.shortPromptCount).toBe(2)
  })
})

describe('analyzeHeuristics — duplicate prompts', () => {
  const longA = 'Please fix the failing tests in the backend scorer and keep the changes small.'
  const assistant = msg('assistant', "I'll inspect the scorer.")

  it('counts an exact normalized repeat', () => {
    const got = analyzeHeuristics(input([
      msg('user', longA),
      assistant,
      msg('user', longA),
    ]))
    expect(got.duplicatePromptCount).toBe(1)
  })

  it('counts a high-jaccard near repeat and ignores control prompts', () => {
    const got = analyzeHeuristics(input([
      msg('user', longA),
      assistant,
      msg('user', 'Please fix failing backend scorer tests and keep the changes small.'),
      msg('user', 'yes'),
    ]))
    expect(got.duplicatePromptCount).toBe(1)
  })

  it('does not count low-jaccard prompts', () => {
    const got = analyzeHeuristics(input([
      msg('user', 'Implement authentication with hashed passwords and session tokens.'),
      assistant,
      msg('user', 'Document the cold start latency regression in the metrics dashboard.'),
    ]))
    expect(got.duplicatePromptCount).toBe(0)
  })
})

describe('analyzeHeuristics — runaway tool loop', () => {
  const failingBash = (command: string): ToolCallRow => tool({
    category: 'Bash',
    toolName: 'Bash',
    inputJson: JSON.stringify({ command }),
    eventStatus: 'errored',
    resultContent: 'exit status 1\nFAIL',
  })
  const okBash = (command: string): ToolCallRow => tool({
    category: 'Bash',
    toolName: 'Bash',
    inputJson: JSON.stringify({ command }),
    resultContent: 'PASS',
  })

  it('stays silent under 12 calls', () => {
    const calls = Array.from({ length: 10 }, () => failingBash('npm test'))
    expect(analyzeHeuristics(input([], calls)).runawayToolLoopCount).toBe(0)
  })

  it('flags a repeated failing exact tool run', () => {
    const calls = Array.from({ length: 12 }, () => failingBash('npm test'))
    expect(analyzeHeuristics(input([], calls)).runawayToolLoopCount).toBe(1)
  })

  it('does not flag repeated successful calls', () => {
    const calls = Array.from({ length: 12 }, () => okBash('npm test'))
    expect(analyzeHeuristics(input([], calls)).runawayToolLoopCount).toBe(0)
  })

  it('does not flag ordinary varied calls', () => {
    const calls: ToolCallRow[] = [
      tool({ category: 'Read', toolName: 'Read', inputJson: '{"file_path":"a.go"}' }),
      tool({ category: 'Grep', toolName: 'Grep', inputJson: '{"pattern":"x"}' }),
      tool({ category: 'Edit', toolName: 'Edit', inputJson: '{"file_path":"a.go"}' }),
      okBash('go test ./...'),
      tool({ category: 'Read', toolName: 'Read', inputJson: '{"file_path":"b.go"}' }),
      tool({ category: 'Edit', toolName: 'Edit', inputJson: '{"file_path":"b.go"}' }),
      tool({ category: 'Glob', toolName: 'Glob', inputJson: '{"pattern":"*.go"}' }),
      okBash('go test ./internal/db'),
      tool({ category: 'Read', toolName: 'Read', inputJson: '{"file_path":"c.go"}' }),
      tool({ category: 'Edit', toolName: 'Edit', inputJson: '{"file_path":"c.go"}' }),
      tool({ category: 'Grep', toolName: 'Grep', inputJson: '{"pattern":"z"}' }),
      okBash('go test ./internal/signals'),
    ]
    expect(analyzeHeuristics(input([], calls)).runawayToolLoopCount).toBe(0)
  })

  it('flags a window with six failures', () => {
    const calls = Array.from({ length: 13 }, (_, i) => okBash(`npm run step-${String.fromCharCode(97 + i)}`))
    for (const index of [1, 3, 5, 7, 9, 11]) {
      calls[index] = failingBash(`npm run step-${String.fromCharCode(97 + index)}`)
    }
    expect(analyzeHeuristics(input([], calls)).runawayToolLoopCount).toBe(1)
  })

  it('requires three failures for a dominant command class', () => {
    const calls = Array.from({ length: 12 }, (_, i) => okBash(`npm run step-${String.fromCharCode(97 + i)}`))
    calls[2] = failingBash('npm run step-c')
    calls[5] = failingBash('npm run step-f')
    // Dominant class (12/12) with only 2 failures is benign.
    expect(analyzeHeuristics(input([], calls)).runawayToolLoopCount).toBe(0)
    // A third failure tips it into runaway.
    calls[9] = failingBash('npm run step-j')
    expect(analyzeHeuristics(input([], calls)).runawayToolLoopCount).toBe(1)
  })
})

describe('isFrustrationMarker', () => {
  it('flags repeated punctuation', () => {
    expect(isFrustrationMarker('WHY WONT THIS WORK???!!!')).toBe(true)
  })

  it('flags hostile phrases', () => {
    expect(isFrustrationMarker('this is broken after the retry')).toBe(true)
  })

  it('flags an all-caps word ratio of 0.4 or more', () => {
    expect(isFrustrationMarker('THIS TOOL KEEPS FAILING TODAY')).toBe(true)
  })

  it('ignores short text', () => {
    expect(isFrustrationMarker('NO')).toBe(false)
  })

  it('strips fenced code before judging tone', () => {
    expect(isFrustrationMarker('```text\nFUCK\n```\nPlease handle the log.')).toBe(false)
  })

  it('ignores polite focused requests', () => {
    expect(isFrustrationMarker('Please run the focused test again.')).toBe(false)
  })
})

describe('countFrustrationMarkers', () => {
  it('counts user frustration markers and skips system/assistant messages', () => {
    const got = countFrustrationMarkers([
      msg('user', 'WHY WONT THIS WORK???!!!'),
      msg('user', 'this is broken after the retry'),
      msg('assistant', 'I will inspect it.'),
      msg('user', 'Please run the focused test again.'),
      msg('user', '```text\nFUCK\n```\nPlease handle the log.'),
      msg('system', 'THIS IS BROKEN fucking', { isSystem: true }),
    ])
    expect(got).toBe(2)
  })
})
