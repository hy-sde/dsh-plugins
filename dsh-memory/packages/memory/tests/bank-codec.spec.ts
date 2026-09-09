/**
 * The bank codec: default zstd framing matches the session container, legacy
 * plaintext banks read transparently and migrate on first write, edit rewrites
 * honor the configured encoding, and session provenance round-trips through
 * save/search.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  compressZstdFrame, decompressZstdFrame, scanZstdFrames,
} from '../src/zstd-frame/index.ts'
import { LocalMemoryBackend, BANK_FILE, LEGACY_BANK_FILE, isZstdData, projectRootOf } from '../src/local.ts'

const CWD = '/project/a'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-memory-codec-'))
}

function backendFor(root: string, compression?: 'zstd' | 'none'): LocalMemoryBackend {
  return new LocalMemoryBackend({ root, ...compression !== undefined ? { compression } : {} })
}

async function bankBytes(root: string): Promise<Buffer> {
  return readFile(join(projectRootOf(root, CWD), BANK_FILE))
}

describe('bank codec', () => {
  it('writes the default bank as checksummed zstd frames', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    await backend.save({ cwd: CWD }, { content: 'row one', source: 'retain' })
    await backend.save({ cwd: CWD }, { content: 'row two', source: 'retain' })

    const bytes = await bankBytes(root)
    expect(isZstdData(bytes)).toBe(true)
    const { frames } = scanZstdFrames(bytes)
    expect(frames.length).toBe(2)
    const decoded = Buffer.concat(await Promise.all(
      frames.map(frame => decompressZstdFrame(bytes.subarray(frame.start, frame.end))),
    ))
    expect(decoded.toString()).toContain('"row one"')
    expect(decoded.toString()).toContain('"row two"')

    // A fresh backend still reads rows out of the framed bank.
    const status = await backendFor(root).status({ cwd: CWD })
    expect(status.workingCount).toBe(2)
  })

  it('reads a legacy plaintext bank and migrates it on first write', async () => {
    const root = await tempRoot()
    const project = projectRootOf(root, CWD)
    await (await import('node:fs')).promises.mkdir(project, { recursive: true })
    const legacyLine = JSON.stringify({
      id: 'm_legacy', content: 'legacy row', source: 'retain', importance: 0.7,
      createdAt: 1, updatedAt: 1, active: true,
    })
    await writeFile(join(project, LEGACY_BANK_FILE), `${legacyLine}\n`, 'utf8')

    // Read path is encoding-agnostic: the plaintext row is visible.
    const before = await backendFor(root).search({ cwd: CWD }, 'legacy row')
    expect(before.count).toBeGreaterThan(0)
    expect(before.items[0]?.content).toContain('legacy row')

    // A write migrates the whole file to frames while preserving the old row.
    const backend = backendFor(root)
    await backend.save({ cwd: CWD }, { content: 'new framed row', source: 'retain' })
    const bytes = await bankBytes(root)
    expect(isZstdData(bytes)).toBe(true)
    const migrated = await backendFor(root).search({ cwd: CWD }, 'legacy row')
    expect(migrated.count).toBeGreaterThan(0)
    // The pre-rename plaintext file is gone after migration (no double sources).
    await expect((await import('node:fs')).promises.stat(join(project, LEGACY_BANK_FILE))).rejects.toThrow()
  })

  it('reads a legacy plaintext bank even before any write happens', async () => {
    const root = await tempRoot()
    const project = projectRootOf(root, CWD)
    await (await import('node:fs')).promises.mkdir(project, { recursive: true })
    await writeFile(join(project, LEGACY_BANK_FILE), `${JSON.stringify({
      id: 'm_only', content: 'the only row', source: 'retain', importance: 0.7,
      createdAt: 1, updatedAt: 1, active: true,
    })}\n`, 'utf8')
    const found = await backendFor(root).search({ cwd: CWD }, 'only row')
    expect(found.items[0]?.content).toContain('the only row')
    // Still no canonical bank file yet — nothing has written since the rename.
    await expect(bankBytes(root)).rejects.toThrow()
  })

  it('honors compression: none with the plaintext line-append format', async () => {
    const root = await tempRoot()
    const backend = backendFor(root, 'none')
    await backend.save({ cwd: CWD }, { content: 'plain row', source: 'retain' })
    const bytes = await bankBytes(root)
    expect(isZstdData(bytes)).toBe(false)
    expect(bytes.toString('utf8')).toContain('"plain row"')
    // And reads still work.
    expect((await backend.search({ cwd: CWD }, 'plain row')).count).toBe(1)
  })

  it('edit rewrites the bank under the configured framing', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    const saved = await backend.save({ cwd: CWD }, { content: 'editable row', source: 'retain' })
    expect(saved.id).toBeDefined()
    await backend.edit({ cwd: CWD }, 'update', { id: saved.id!, content: 'edited row' })
    const bytes = await bankBytes(root)
    expect(isZstdData(bytes)).toBe(true)
    const seen = await backend.search({ cwd: CWD }, 'edited row')
    expect(seen.items[0]?.content).toContain('edited row')
  })

  it('round-trips session provenance through save and search', async () => {
    const root = await tempRoot()
    const backend = backendFor(root)
    await backend.save({ cwd: CWD }, { content: 'decision: vitest', sessionId: 'session-abc' })
    const found = await backend.search({ cwd: CWD }, 'decision')
    expect(found.items[0]?.sessionId).toBe('session-abc')
    // learned.md stays plaintext and human-readable even under zstd banks.
    await backend.learn({ cwd: CWD }, { content: 'a lesson' })
  })

  it('recovers a plaintext-fallback read for a structurally corrupt frame bank', async () => {
    const root = await tempRoot()
    const project = projectRootOf(root, CWD)
    const fs = await import('node:fs')
    await fs.promises.mkdir(project, { recursive: true })
    // 4-byte zstd magic + garbage → read falls back to text, self-heals to zero rows.
    await writeFile(join(project, BANK_FILE), Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('{"garbage"')]))
    const status = await backendFor(root).status({ cwd: CWD })
    expect(status.workingCount).toBe(0)
  })

  it('keeps the legacy codec round-trip intact through the shared zstd package', async () => {
    const frame = await compressZstdFrame('{"type":"session","version":0,"id":"x","createdAt":1}\n')
    expect(frame.readUInt32LE(0)).toBe(0xFD2FB528)
    expect((await decompressZstdFrame(frame)).toString()).toContain('"id":"x"')
  })

  it('lesson provenance survives across backend instances', async () => {
    const root = await tempRoot()
    await backendFor(root).save({ cwd: CWD }, { content: 'provenance row', source: 'retain', sessionId: 'session-1' })
    const other = await backendFor(root).search({ cwd: CWD }, 'provenance')
    expect(other.items[0]?.sessionId).toBe('session-1')
  })
})
