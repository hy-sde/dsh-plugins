import { describe, expect, it } from 'vitest'
import { collectRecentEdits, resolveFilePath } from '../src/recentedits.ts'
import type { HealthSessionLike } from '../src/adapter/dsh.ts'

function toolCall(seq: number, time: number, callId: string, name: string, args: string) {
  return { seq, time, type: 'tool/call', data: { callId, name, arguments: args } }
}

function userMessage(seq: number, time: number, text: string) {
  return { seq, time, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: {} } }
}

function assistantMessage(seq: number, time: number, text: string) {
  return {
    seq, time, type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }], source: {} } },
  }
}

describe('resolveFilePath', () => {
  it('tries file_path then path then filePath then file', () => {
    expect(resolveFilePath('{"file_path":"src/a.ts"}')).toBe('src/a.ts')
    expect(resolveFilePath('{"path":"src/b.ts"}')).toBe('src/b.ts')
    expect(resolveFilePath('{"filePath":"src/c.ts"}')).toBe('src/c.ts')
    expect(resolveFilePath('{"file":"src/d.ts"}')).toBe('src/d.ts')
  })

  it('prefers file_path over the fallbacks', () => {
    expect(resolveFilePath('{"file_path":"a.ts","file":"b.ts"}')).toBe('a.ts')
  })

  it('returns "" for invalid JSON, non-objects, and no path key', () => {
    expect(resolveFilePath('')).toBe('')
    expect(resolveFilePath('not json')).toBe('')
    expect(resolveFilePath('["src/a.ts"]')).toBe('')
    expect(resolveFilePath('{"cmd":"rg foo"}')).toBe('')
    expect(resolveFilePath('{"file_path":42}')).toBe('')
  })
})

describe('collectRecentEdits', () => {
  it('groups per path, newest edit first, with inlined occurrences', () => {
    const eventsA = [
      userMessage(0, 1_000, 'task a'),
      assistantMessage(1, 2_000, 'working'),
      toolCall(2, 3_000, 'c1', 'edit', '{"file_path":"src/a.ts"}'),
      toolCall(3, 4_000, 'c2', 'write', '{"file_path":"src/b.ts"}'),
      assistantMessage(4, 5_000, 'again'),
      toolCall(5, 6_000, 'c3', 'edit', '{"file_path":"src/a.ts"}'),
    ]
    const eventsB = [
      userMessage(0, 10_000, 'task b'),
      assistantMessage(1, 11_000, 'working'),
      toolCall(2, 12_000, 'c4', 'write', '{"file_path":"src/a.ts"}'),
    ]
    const files = collectRecentEdits([
      { id: 'sess-a', createdAt: 1_000, events: eventsA },
      { id: 'sess-b', createdAt: 10_000, events: eventsB },
    ] satisfies readonly HealthSessionLike[])

    expect(files.map(f => f.filePath)).toEqual(['src/a.ts', 'src/b.ts'])
    const a = files[0]!
    expect(a.editCount).toBe(3)
    expect(a.lastEditedAt).toBe(12_000)
    expect(a.lastSessionId).toBe('sess-b')
    expect(a.edits.map(e => e.timestamp)).toEqual([12_000, 6_000, 3_000])
  })

  it('applies the per-file inline cap', () => {
    const events = [
      userMessage(0, 1_000, 't'),
      assistantMessage(1, 2_000, 'w'),
      toolCall(2, 3_000, 'c1', 'edit', '{"file_path":"a.ts"}'),
      toolCall(3, 4_000, 'c2', 'edit', '{"file_path":"a.ts"}'),
      toolCall(4, 5_000, 'c3', 'edit', '{"file_path":"a.ts"}'),
    ]
    const files = collectRecentEdits([{ id: 's', createdAt: 1, events }], { perFile: 2 })
    expect(files[0]!.edits).toHaveLength(2)
    expect(files[0]!.editCount).toBe(3)
  })

  it('filters by case-insensitive path substring', () => {
    const events = [
      userMessage(0, 1_000, 't'),
      assistantMessage(1, 2_000, 'w'),
      toolCall(2, 3_000, 'c1', 'edit', '{"file_path":"src/engine/types.ts"}'),
      toolCall(3, 4_000, 'c2', 'write', '{"file_path":"docs/README.md"}'),
    ]
    const files = collectRecentEdits([{ id: 's', createdAt: 1, events }], { path: 'ENGINE' })
    expect(files.map(f => f.filePath)).toEqual(['src/engine/types.ts'])
  })

  it('ignores non Edit/Write calls, unparseable paths, and inherited events', () => {
    const events = [
      userMessage(0, 1_000, 't'),
      assistantMessage(1, 2_000, 'w'),
      toolCall(2, 3_000, 'c1', 'bash', '{"file_path":"ignored.ts"}'),
      toolCall(3, 4_000, 'c2', 'edit', '{"cmd":"no path"}'),
      toolCall(4, 5_000, 'c3', 'write', '{"file_path":"real.ts"}'),
    ]
    const files = collectRecentEdits([
      { id: 's', createdAt: 1, inheritedEventCount: 3, events },
    ])
    expect(files.map(f => f.filePath)).toEqual(['real.ts'])
  })
})
