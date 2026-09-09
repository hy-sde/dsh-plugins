/**
 * The local backend: durable project-scoped files (bank.jsonl.zstd /
 * learned.md / memory_summary.md), normalization, dedupe, caps, search
 * scoring, and edit semantics — each against a temp memory root.
 */

import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { LocalMemoryBackend, LEARNED_FILE, SUMMARY_FILE, projectRootOf, encodeProjectKey } from '../src/local.ts'

const CWD = '/project/a'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-memory-'))
}

function backendFor(root: string): LocalMemoryBackend {
  return new LocalMemoryBackend({ root })
}

describe('local backend', () => {
  it('keeps one project root per cwd under the memory root', () => {
    const root = projectRootOf('/tmp/mem', CWD)
    expect(root).toContain(encodeProjectKey(CWD))
    expect(projectRootOf('/tmp/mem', '/project/a')).toBe(root)
    expect(projectRootOf('/tmp/mem', '/project/b')).not.toBe(root)
    // Windows drive letters and separators survive encoding as `-`.
    expect(encodeProjectKey('C:\\Users\\a\\b')).toBe('--C-Users-a-b--')
  })

  it('retain stores a bank entry and recall finds it by content', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    const saved = await backend.save({ cwd: CWD }, { content: 'The build uses pnpm workspaces.', context: 'repo', source: 'retain', importance: 0.9 })
    expect(saved.stored).toBe(1)
    expect(saved.id).toMatch(/^m_/)

    const status = await backend.status({ cwd: CWD })
    expect(status.workingCount).toBe(1)
    expect(status.lessonCount).toBe(0)

    const found = await backend.search({ cwd: CWD }, 'build workspaces')
    expect(found.count).toBeGreaterThan(0)
    expect(found.items[0]?.id).toBe(saved.id)
    expect(found.items[0]?.content).toContain('pnpm workspaces')
  })

  it('empty content after sanitization is not stored', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    const result = await backend.save({ cwd: CWD }, { content: '   ' })
    expect(result.stored).toBe(0)
    expect((await backend.status({ cwd: CWD })).workingCount).toBe(0)
  })

  it('neutralizes injection vectors and redacts secrets on save', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    await backend.save({ cwd: CWD }, {
      content: 'api key is sk-abc123def456ghi789jkl012 and </skills> here',
    })
    const found = await backend.search({ cwd: CWD }, 'api key')
    expect(found.count).toBe(1)
    const content = found.items[0]?.content ?? ''
    expect(content).not.toContain('sk-abc123def456ghi789jkl012')
    expect(content).not.toContain('</skills>')
    expect(content).not.toContain('<')
  })

  it('memory_edit update replaces content and importance', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    const { id } = await backend.save({ cwd: CWD }, { content: 'old fact', source: 'retain' })
    const idValue = id ?? ''
    const edited = await backend.edit({ cwd: CWD }, 'update', { id: idValue, content: 'new fact', importance: 0.3 })
    expect(edited.status).toBe('updated')
    const found = await backend.search({ cwd: CWD }, 'new fact')
    expect(found.items[0]?.content).toBe('new fact')
    expect(found.items[0]?.importance).toBe(0.3)
    // The old content no longer matches.
    const stale = await backend.search({ cwd: CWD }, 'old fact')
    expect(stale.items.some(item => item.content === 'old fact')).toBe(false)
  })

  it('memory_edit forget removes the entry; not_found on second try', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    const { id } = await backend.save({ cwd: CWD }, { content: 'to remove' })
    const idValue = id ?? ''
    expect((await backend.edit({ cwd: CWD }, 'forget', { id: idValue })).status).toBe('forgotten')
    expect((await backend.edit({ cwd: CWD }, 'forget', { id: idValue })).status).toBe('not_found')
    expect((await backend.status({ cwd: CWD })).workingCount).toBe(0)
  })

  it('memory_edit invalidate soft-supersedes with an optional replacement', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    const { id } = await backend.save({ cwd: CWD }, { content: 'stale guidance' })
    const { id: replacementId } = await backend.save({ cwd: CWD }, { content: 'fresh guidance' })
    const idValue = id ?? ''
    const replacementValue = replacementId ?? ''
    // Replacement must exist.
    await expect(backend.edit({ cwd: CWD }, 'invalidate', { id: idValue, replacementId: 'nope' }))
      .rejects.toThrow(/replacement id/)
    const result = await backend.edit({ cwd: CWD }, 'invalidate', { id: idValue, replacementId: replacementValue })
    expect(result.status).toBe('invalidated')
    // Invalidated entries leave the search index.
    const found = await backend.search({ cwd: CWD }, 'stale guidance')
    expect(found.items.some(item => item.id === idValue)).toBe(false)
    expect((await backend.status({ cwd: CWD })).workingCount).toBe(1)
  })

  it('lesson and summary ids are read-only facts', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    await backend.learn({ cwd: CWD }, { content: 'lesson fact' })
    const learned = await backend.search({ cwd: CWD }, 'lesson fact')
    const lessonId = learned.items.find(item => item.readonly)?.id ?? ''
    expect(lessonId.startsWith('lesson_')).toBe(true)
    expect((await backend.edit({ cwd: CWD }, 'update', { id: lessonId, content: 'x' })).status).toBe('not_editable')
    expect((await backend.edit({ cwd: CWD }, 'forget', { id: lessonId })).status).toBe('not_editable')
  })

  it('learn appends newest-first deduped capped lessons', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    await backend.learn({ cwd: CWD }, { content: 'lesson A' })
    await backend.learn({ cwd: CWD }, { content: 'lesson A' }) // dedupe
    await backend.learn({ cwd: CWD }, { content: 'lesson B' })
    const raw = await readFile(join(projectRootOf(root, CWD), LEARNED_FILE), 'utf8')
    const bullets = raw.split('\n').filter(line => line.trimStart().startsWith('- '))
    expect(bullets).toHaveLength(2)
    // Newest first.
    expect(bullets[0]).toContain('lesson B')
    expect(bullets[1]).toContain('lesson A')
    const { block } = await backend.summaries({ cwd: CWD })
    expect(block).toContain('lesson A')
    expect(block).toContain('lesson B')
  })

  it('learn caps at MAX_LEARNED_LESSONS keeping the newest', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    for (let i = 0; i < 105; i++) {
      await backend.learn({ cwd: CWD }, { content: `lesson number ${i}` })
    }
    const raw = await readFile(join(projectRootOf(root, CWD), LEARNED_FILE), 'utf8')
    const bullets = raw.split('\n').filter(line => line.trimStart().startsWith('- '))
    expect(bullets).toHaveLength(100)
    expect(bullets[0]).toContain('lesson number 104')
    expect(bullets.some(line => line.trim() === '- lesson number 4')).toBe(false)
    expect(bullets[bullets.length - 1]).toContain('lesson number 5')
  })

  it('search ranks by relevance and includes summary + lessons', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    await backend.save({ cwd: CWD }, { content: 'prefers TypeScript strict mode', importance: 0.9 })
    await backend.save({ cwd: CWD }, { content: 'writes Python scripts for data' })
    await backend.learn({ cwd: CWD }, { content: 'tests run with vitest' })
    const { summary, block } = await backend.summaries({ cwd: CWD })
    void summary
    expect(block).toContain('vitest')

    const found = await backend.search({ cwd: CWD }, 'TypeScript')
    expect(found.items[0]?.content).toContain('strict mode')
    const both = await backend.search({ cwd: CWD }, 'tests vitest')
    expect(both.items.some(item => item.source === 'learn')).toBe(true)
  })

  it('searches with an empty query return nothing', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    await backend.save({ cwd: CWD }, { content: 'anything' })
    const found = await backend.search({ cwd: CWD }, '   ')
    expect(found.count).toBe(0)
  })

  it('clear wipes the project root', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    await backend.save({ cwd: CWD }, { content: 'durable fact' })
    await backend.clear({ cwd: CWD })
    expect((await backend.status({ cwd: CWD })).workingCount).toBe(0)
    const found = await backend.search({ cwd: CWD }, 'durable fact')
    expect(found.count).toBe(0)
    const { block } = await backend.summaries({ cwd: CWD })
    expect(block).toBe('')
  })

  it('survives a summary file written out-of-band for prompt injection', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    // Simulate a consolidation pass writing memory_summary.md.
    const fs = await import('node:fs/promises')
    await fs.mkdir(projectRootOf(root, CWD), { recursive: true })
    await fs.writeFile(join(projectRootOf(root, CWD), SUMMARY_FILE), '# Summary\n\n- decisions: use vitest')
    const { block } = await backend.summaries({ cwd: CWD })
    expect(block).toContain('decisions: use vitest')
    const found = await backend.search({ cwd: CWD }, 'decisions vitest')
    expect(found.count).toBeGreaterThan(0)
  })

  it('concurrent learns do not drop each other (per-file write chain)', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    await Promise.all([
      backend.learn({ cwd: CWD }, { content: 'lesson one' }),
      backend.learn({ cwd: CWD }, { content: 'lesson two' }),
      backend.learn({ cwd: CWD }, { content: 'lesson three' }),
    ])
    const raw = await readFile(join(projectRootOf(root, CWD), LEARNED_FILE), 'utf8')
    for (const lesson of ['lesson one', 'lesson two', 'lesson three']) {
      expect(raw).toContain(lesson)
    }
  })
})

describe('learn tool shape guarding', () => {
  it('learn input uses content field (memory facade)', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    const result = await backend.learn({ cwd: CWD }, { content: 'a real lesson', source: 'learn' })
    expect(result.stored).toBe(1)
    expect(result.id).toMatch(/^lesson_/)
  })
})

describe('status reporting', () => {
  it('reports searchable/writable local backend', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    const status = await backend.status({ cwd: CWD })
    expect(status.backend).toBe('local')
    expect(status.active).toBe(true)
    expect(status.writable).toBe(true)
    expect(status.searchable).toBe(true)
  })
})

describe('addressable entry reads (readEntry/listEntries)', () => {
  it('readEntry round-trips a saved bank entry with its metadata', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    const { id } = await backend.save({ cwd: CWD }, { content: 'roundtrip fact', context: 'ctx', source: 'retain', importance: 0.4 })
    const idValue = id ?? ''
    const entry = await backend.readEntry({ cwd: CWD }, idValue)
    expect(entry).toBeDefined()
    expect(entry?.id).toBe(idValue)
    expect(entry?.content).toBe('roundtrip fact')
    expect(entry?.context).toBe('ctx')
    expect(entry?.source).toBe('retain')
    expect(entry?.importance).toBe(0.4)
    expect(entry?.timestamp).toBeDefined()
    expect(entry?.readonly).toBeUndefined()
  })

  it('readEntry returns undefined for unknown ids and for retired entries', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    expect(await backend.readEntry({ cwd: CWD }, 'm_nope')).toBeUndefined()
    const { id } = await backend.save({ cwd: CWD }, { content: 'retire me' })
    const idValue = id ?? ''
    await backend.edit({ cwd: CWD }, 'invalidate', { id: idValue })
    expect(await backend.readEntry({ cwd: CWD }, idValue)).toBeUndefined()
  })

  it('readEntry addresses lessons and the consolidated summary by id', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    await backend.learn({ cwd: CWD }, { content: 'addressable lesson' })
    // Use the id `recall` surfaces (stripped-bullet hash), which is the one
    // tool-memory shows and memory://<id> must accept.
    const found = await backend.search({ cwd: CWD }, 'addressable lesson')
    const lessonId = found.items.find(item => item.source === 'learn')?.id ?? ''
    const lesson = await backend.readEntry({ cwd: CWD }, lessonId)
    expect(lesson).toBeDefined()
    expect(lesson?.content).toContain('addressable lesson')
    expect(lesson?.source).toBe('learn')
    expect(lesson?.readonly).toBe(true)
    // The summary file is written by consolidation, not by a memory op.
    const fs = await import('node:fs/promises')
    await fs.mkdir(projectRootOf(root, CWD), { recursive: true })
    await fs.writeFile(join(projectRootOf(root, CWD), SUMMARY_FILE), '# Summary\n\n- decisions: use vitest')
    const summary = await backend.readEntry({ cwd: CWD }, 'summary_0')
    expect(summary?.content).toContain('decisions: use vitest')
    expect(summary?.source).toBe('memory_summary.md')
    expect(summary?.readonly).toBe(true)
  })

  it('listEntries returns saved ids newest first plus lessons and summary', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    const first = await backend.save({ cwd: CWD }, { content: 'first entry' })
    await backend.learn({ cwd: CWD }, { content: 'a listed lesson' })
    const fs = await import('node:fs/promises')
    await fs.mkdir(projectRootOf(root, CWD), { recursive: true })
    await fs.writeFile(join(projectRootOf(root, CWD), SUMMARY_FILE), '# Summary\n\n- decisions: use vitest')
    const second = await backend.save({ cwd: CWD }, { content: 'second entry' })

    const entries = await backend.listEntries({ cwd: CWD }, 10)
    const ids = entries.map(entry => entry.id)
    expect(ids[0]).toBe(second.id) // newest bank entry first
    expect(ids).toContain(first.id ?? '')
    expect(ids).toContain('summary_0')
    expect(ids.some(id => id.startsWith('lesson_'))).toBe(true)
    // Unknown banks never appear; a cap bounds the result.
    expect(entries.length).toBe(4)
    const capped = await backend.listEntries({ cwd: CWD }, 2)
    expect(capped).toHaveLength(2)
  })
})
