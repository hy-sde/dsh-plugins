import { describe, expect, it } from 'vitest'
import {
  analyzeSessions,
  bashCommands,
  type SessionEventLike,
  type SessionLike,
} from '../src/insights/analyze.ts'
import { formatToolFrequency } from '../src/presentation.ts'
import { parseSessionInsightsArgs, parseSinceMs } from '../src/input.ts'
import { parseLogText, projectKey } from '../src/cli.ts'

function event(
  seq: number,
  time: number,
  type: string,
  data: Record<string, unknown>,
): SessionEventLike {
  return { seq, time, type, data }
}

function callEvent(
  seq: number,
  time: number,
  callId: string,
  name: string,
  args = '{}',
): SessionEventLike {
  return event(seq, time, 'tool/call', { turn: 1, step: 1, callId, name, arguments: args })
}

function resultEvent(
  seq: number,
  time: number,
  callId: string,
  error?: { name: string; code: string },
): SessionEventLike {
  return event(seq, time, 'tool/result', {
    turn: 1,
    step: 1,
    message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', content: [] }] },
    ...(error !== undefined ? { error } : {}),
  })
}

function session(
  id: string,
  createdAt: number,
  events: SessionEventLike[],
  inheritedEventCount?: number,
): SessionLike {
  return {
    id,
    createdAt,
    ...(inheritedEventCount !== undefined ? { inheritedEventCount } : {}),
    events,
  }
}

describe('analyzeSessions', () => {
  it('reports zeroes for an empty input', () => {
    const report = analyzeSessions({ workspace: '/w', sessions: [], sessionReadFailures: 0 })
    expect(report.toolCalls).toBe(0)
    expect(report.toolResults).toBe(0)
    expect(report.distinctTools).toBe(0)
    expect(report.rows).toEqual([])
    expect(report.callsStart).toBeNull()
    expect(report.callsEnd).toBeNull()
  })

  it('counts calls by tool across sessions and sorts highest → lowest, ties alphabetically', () => {
    const sessions = [
      session('s1', 1, [
        callEvent(0, 1000, 'c1', 'bash'),
        callEvent(1, 2000, 'c2', 'bash'),
        callEvent(2, 3000, 'c3', 'read'),
      ]),
      session('s2', 2, [
        callEvent(0, 1500, 'c4', 'bash'),
        callEvent(1, 2500, 'c5', 'edit'),
      ]),
    ]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 0 })
    expect(report.toolCalls).toBe(5)
    expect(report.distinctTools).toBe(3)
    expect(report.rows.map(row => [row.tool, row.calls])).toEqual([
      ['bash', 3],
      ['edit', 1],
      ['read', 1],
    ])
  })

  it('assigns a normalized category to every row', () => {
    const sessions = [
      session('s1', 1, [
        callEvent(0, 1000, 'c1', 'Grep'),
        callEvent(1, 2000, 'c2', 'NotebookEdit'),
        callEvent(2, 3000, 'c3', 'todo_write'),
        callEvent(3, 4000, 'c4', 'glob'),
        callEvent(4, 5000, 'c5', 'spawn_agent'),
        callEvent(5, 6000, 'c6', 'mcp__zen_subagents__spawn_subagent'),
        callEvent(6, 7000, 'c7', 'warp_engine'),
      ]),
    ]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 0 })
    expect(Object.fromEntries(report.rows.map(row => [row.tool, row.category]))).toEqual({
      Grep: 'Grep',
      NotebookEdit: 'Write',
      'mcp__zen_subagents__spawn_subagent': 'Task',
      glob: 'Glob',
      spawn_agent: 'Task',
      todo_write: 'Tool',
      warp_engine: 'Other',
    })
  })

  it('attributes result errors to the tool through callId and buckets unmatched results', () => {
    const sessions = [
      session('s1', 1, [
        callEvent(0, 1000, 'c1', 'bash'),
        resultEvent(1, 1100, 'c1', { name: 'ToolTimeoutError', code: 'TIMEOUT' }),
        resultEvent(2, 1200, 'c2', { name: 'ToolNotFoundError', code: 'UNKNOWN' }),
      ]),
    ]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 0 })
    expect(report.toolResults).toBe(2)
    const bash = report.rows.find(row => row.tool === 'bash')!
    expect(bash.errors).toBe(1)
    const unknown = report.rows.find(row => row.tool === '(unknown)')!
    expect(unknown.errors).toBe(1)
    expect(unknown.calls).toBe(0)
  })

  it('counts isError content without an error field as an error', () => {
    const sessions = [
      session('s1', 1, [
        callEvent(0, 1000, 'c1', 'bash'),
        event(1, 1100, 'tool/result', {
          turn: 1,
          step: 1,
          message: {
            source: { kind: 'tool', callId: 'c1' },
            content: [{ type: 'tool-result', isError: true, content: [] }],
          },
        }),
      ]),
    ]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 0 })
    expect(report.rows.find(row => row.tool === 'bash')!.errors).toBe(1)
  })

  it('skips inherited seeded events so parents are not double-counted', () => {
    const sessions = [
      session('child', 1, [
        callEvent(0, 1000, 'c-parent-1', 'bash'),
        callEvent(1, 1100, 'c-parent-2', 'read'),
        callEvent(2, 2000, 'c-child', 'edit'),
      ], 2),
    ]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 0 })
    expect(report.inheritedToolCallsSkipped).toBe(2)
    expect(report.toolCalls).toBe(1)
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]!.tool).toBe('edit')
  })

  it('tracks distinct sessions per tool and the call-time window', () => {
    const sessions = [
      session('s1', 1, [callEvent(0, 5000, 'c1', 'bash'), callEvent(1, 1000, 'c2', 'edit')]),
      session('s2', 2, [callEvent(0, 9000, 'c3', 'bash')]),
    ]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 0 })
    expect(report.rows.find(row => row.tool === 'bash')!.sessions).toBe(2)
    expect(report.callsStart).toBe(1000)
    expect(report.callsEnd).toBe(9000)
  })

  it('reports session read failures without dropping counted sessions', () => {
    const sessions = [session('s1', 1, [callEvent(0, 1000, 'c1', 'bash')])]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 2 })
    expect(report.sessionsAnalyzed).toBe(1)
    expect(report.sessionReadFailures).toBe(2)
  })

  it('dedupes compaction re-logged results by callId', () => {
    const sessions = [
      session('s1', 1, [
        callEvent(0, 1000, 'c1', 'bash'),
        resultEvent(1, 1100, 'c1', { name: 'ToolTimeoutError', code: 'TIMEOUT' }),
        event(2, 1200, 'compaction/prune', {}),
        resultEvent(3, 1300, 'c1', { name: 'ToolTimeoutError', code: 'TIMEOUT' }),
      ]),
    ]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 0 })
    expect(report.toolResults).toBe(1)
    expect(report.rows.find(row => row.tool === 'bash')!.errors).toBe(1)
  })
})

describe('formatToolFrequency', () => {
  it('renders the sorted table with percentages and insight lines', () => {
    const sessions = [
      session('s1', 1, [
        callEvent(0, 1000, 'c1', 'bash'),
        callEvent(1, 2000, 'c2', 'bash'),
        callEvent(2, 3000, 'c3', 'read'),
        resultEvent(3, 3100, 'c3', { name: 'ToolTimeoutError', code: 'TIMEOUT' }),
      ]),
    ]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 1 })
    const text = formatToolFrequency(report)
    expect(text).toContain('Tool call frequency for /w')
    expect(text).toContain('sessions analyzed: 1 (1 unreadable)')
    expect(text).toContain('| 1 | bash | — | Bash | 2 | 66.7%')
    expect(text).toContain('| 2 | read | — | Read | 1 | 33.3%')
    expect(text).toContain('read shows the most errors (1 of 1 results)')
  })

  it('respects the top cap and announces omitted rows', () => {
    const sessions = [session('s1', 1, [
      callEvent(0, 1, 'c1', 'bash'),
      callEvent(1, 2, 'c2', 'edit'),
      callEvent(2, 3, 'c3', 'read'),
    ])]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 0 })
    const text = formatToolFrequency(report, { top: 1 })
    expect(text).toContain('| 1 | bash | — | Bash |')
    expect(text).not.toContain('| edit |')
    expect(text).toContain('... and 2 more tools')
  })

  it('renders a friendly message when no calls exist', () => {
    const report = analyzeSessions({ workspace: '/w', sessions: [session('s1', 1, [])], sessionReadFailures: 0 })
    expect(formatToolFrequency(report)).toContain('No tool calls found')
  })
})

describe('parseSessionInsightsArgs', () => {
  it('accepts a minimal action and parses optional fields', () => {
    expect(parseSessionInsightsArgs({ action: 'tool-frequency' })).toEqual({ action: 'tool-frequency' })
    const parsed = parseSessionInsightsArgs({
      action: 'tool-frequency',
      workspace: '/w',
      limit: 10,
      top: 5,
      since: '2026-09-01T00:00:00Z',
    })
    expect(parsed.limit).toBe(10)
    expect(parsed.top).toBe(5)
    expect(parsed.sinceMs).toBe(Date.parse('2026-09-01T00:00:00Z'))
  })

  it('rejects unknown actions, non-positive ints, and bad timestamps', () => {
    expect(() => parseSessionInsightsArgs({ action: 'nope' })).toThrow(/action must be one of/)
    expect(() => parseSessionInsightsArgs({ action: 'tool-frequency', limit: 0 })).toThrow(/limit must be a positive integer/)
    expect(() => parseSessionInsightsArgs({ action: 'tool-frequency', top: 1.5 })).toThrow(/top must be a positive integer/)
    expect(() => parseThroughSince()).toThrow(/parseable ISO-8601/)
  })
})

function parseThroughSince(): unknown {
  return parseSessionInsightsArgs({ action: 'tool-frequency', since: 'not-a-date' })
}

describe('cli helpers', () => {
  it('encodes a workspace path like the persistence backend projectKey', () => {
    expect(projectKey('/Users/hui/Documents/workspace')).toBe('--Users-hui-Documents-workspace--')
    expect(projectKey('/Users/hui/Documents/github/deepseek-harness')).toBe('--Users-hui-Documents-github-deepseek-harness--')
  })

  it('parses a JSONL artifact into header facts and tool events', () => {
    const text = [
      JSON.stringify({ type: 'session', version: 0, id: 'session-abc', createdAt: 123, seedLength: 1 }),
      JSON.stringify({ type: 'tool/call', seq: 0, time: 100, data: { callId: 'c0', name: 'bash' } }),
      JSON.stringify({ type: 'tool/call', seq: 1, time: 200, data: { callId: 'c1', name: 'read' } }),
      JSON.stringify({ type: 'tool/result', seq: 2, time: 300, data: { callId: 'c0', error: { name: 'x', code: 'y' } } }),
      JSON.stringify({ type: 'text-chunks', seq: 3, time: 400, data: {}, sourceEventSeqs: [1, 2] }),
      '',
    ].join('\n')
    const parsed = parseLogText(text, '/tmp/session-abc', 'session.jsonl.zstd')
    expect(parsed.id).toBe('session-abc')
    expect(parsed.createdAt).toBe(123)
    expect(parsed.inheritedEventCount).toBe(1)
    // This package keeps EVERY typed event (health/recent-edits need
    // user/assistant/compaction rows too), not just tool events.
    expect(parsed.events).toHaveLength(4)
    expect(parsed.events[0]!.type).toBe('tool/call')
    expect(parsed.events[3]!.type).toBe('text-chunks')
  })

  it('rejects an artifact without a session header', () => {
    expect(() => parseLogText('{"type":"tool/call","seq":0,"time":1,"data":{}}\n', '/tmp/x', 'f')).toThrow(/no session header/)
  })
})

describe('parseSinceMs', () => {
  it('parses ISO timestamps and rejects garbage', () => {
    expect(parseSinceMs('2026-09-01')).toBe(Date.parse('2026-09-01'))
    expect(() => parseSinceMs('yesterday')).toThrow()
  })
})

describe('bashCommands', () => {
  it('extracts the command from a JSON arguments field', () => {
    expect(bashCommands('{"command":"ls -la /tmp","description":"list"}')).toEqual(['ls'])
    expect(bashCommands('{"command":"rg -n foo src/","description":"search"}')).toEqual(['rg'])
  })

  it('splits compound commands on ; && || and newlines', () => {
    expect(bashCommands('{"command":"ls -la; rg foo && git status || echo nope\\ncat x"}')).toEqual([
      'ls',
      'rg',
      'git',
      'echo',
      'cat',
    ])
  })

  it('strips leading env assignments and wrapper words', () => {
    expect(bashCommands('{"command":"FOO=1 BAR=x ls -la"}')).toEqual(['ls'])
    expect(bashCommands('{"command":"sudo rg foo"}')).toEqual(['rg'])
  })

  it('takes the basename of a path-qualified command', () => {
    expect(bashCommands('{"command":"/usr/bin/env node x.js"}')).toEqual(['node'])
  })

  it('falls back to a raw non-JSON arguments string', () => {
    expect(bashCommands('ls -la')).toEqual(['ls'])
    expect(bashCommands(undefined)).toEqual([])
    expect(bashCommands('   ')).toEqual([])
  })

  it('does not split inside quotes', () => {
    expect(bashCommands('{"command":"node -e \\"if (x) { y(); z(); }\\""}')).toEqual(['node'])
    expect(bashCommands("{\"command\":\"rg 'a;b' && ls\"}")).toEqual(['rg', 'ls'])
  })

  it('keeps a heredoc body with its opening command', () => {
    expect(bashCommands('{"command":"node <<\'EOF\'\\nconst a = 1;\\nif (a) console.log(a);\\nEOF"}')).toEqual(['node'])
    expect(bashCommands('{"command":"cat <<EOF\\nhello\\nEOF; ls"}')).toEqual(['cat', 'ls'])
  })

  it('does not treat 2>&1 redirections as separators', () => {
    expect(bashCommands('{"command":"pnpm exec tsc -b --force 2>&1 | tail -20"}')).toEqual(['pnpm', 'tail'])
  })
})

describe('command granularity in analyzeSessions', () => {
  it('splits a bash row into one row per command', () => {
    const sessions: SessionLike[] = [{
      id: 's1',
      createdAt: 1,
      cwd: '/w',
      events: [
        callEvent(0, 100, 'c0', 'bash', '{"command":"ls -la"}'),
        callEvent(1, 200, 'c1', 'bash', '{"command":"rg foo && git status"}'),
        callEvent(2, 300, 'c2', 'read', '{}'),
        resultEvent(3, 400, 'c0', { name: 'E', code: '1' }),
      ],
    }]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 0 })
    const rows = report.rows.map(row => ({ tool: row.tool, command: row.command, calls: row.calls, errors: row.errors }))
    // Equal call counts tie-break alphabetically by tool then command.
    expect(rows).toEqual([
      { tool: 'bash', command: 'git', calls: 1, errors: 0 },
      { tool: 'bash', command: 'ls', calls: 1, errors: 1 },
      { tool: 'bash', command: 'rg', calls: 1, errors: 0 },
      { tool: 'read', command: undefined, calls: 1, errors: 0 },
    ])
    // Error of a multi-command call is attributed to its FIRST command.
    const ls = report.rows.find(row => row.tool === 'bash' && row.command === 'ls')
    const rg = report.rows.find(row => row.tool === 'bash' && row.command === 'rg')
    expect(ls?.errors).toBe(1)
    expect(rg?.errors).toBe(0)
    expect(report.distinctTools).toBe(2)
    expect(report.toolCalls).toBe(3)
  })

  it('renders the Command column with — for non-bash rows', () => {
    const sessions: SessionLike[] = [{
      id: 's1',
      createdAt: 1,
      cwd: '/w',
      events: [
        callEvent(0, 100, 'c0', 'bash', '{"command":"ls -la"}'),
        callEvent(1, 200, 'c1', 'read', '{}'),
      ],
    }]
    const report = analyzeSessions({ workspace: '/w', sessions, sessionReadFailures: 0 })
    const text = formatToolFrequency(report)
    expect(text).toContain('| Rank | Tool | Command | Category |')
    expect(text).toContain('| bash | ls | Bash |')
    expect(text).toContain('| read | — | Read |')
  })
})
