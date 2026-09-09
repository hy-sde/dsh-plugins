import { describe, expect, test } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive } from '../src/ar/open.ts'
import { DEFAULT_ARCHIVE_LIMITS } from '../src/ar/limits.ts'
import { ArchiveReader } from '../src/ar/reader.ts'
import { encodeArchive, isWritableArchiveFormat, writeArchive } from '../src/ar/write.ts'
import { sniffArchiveFormat } from '../src/ar/registry.ts'
import type { ArchiveFormat, WritableArchiveFormat } from '../src/ar/types.ts'

const ENCODER = new TextEncoder()

const MEMBERS: readonly (readonly [string, Uint8Array])[] = [
  ['hello.txt', ENCODER.encode('hello archive\n')],
  ['nested/note.txt', ENCODER.encode('nested note\n')],
  ['empty.txt', new Uint8Array(0)],
]

async function openMemory(bytes: Uint8Array): Promise<ArchiveReader> {
  return openArchive(
    { bytes, format: sniffArchiveFormat(bytes) as ArchiveFormat },
    { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 64 * 1024 * 1024 } },
  )
}

describe('encodeArchive round-trips', () => {
  for (const format of ['zip', 'tar', 'tar.gz', 'asar'] as const satisfies readonly WritableArchiveFormat[]) {
    test(`${format} encodes and decodes identical members`, async () => {
      expect(isWritableArchiveFormat(format)).toBe(true)
      const bytes = await encodeArchive(format, MEMBERS)
      let raw = bytes
      if (format === 'tar.gz') raw = gunzipSync(bytes) // sniff needs the inner tar for format detection
      const reader = await openMemory(raw)
      expect(reader.format).toBe(format === 'tar.gz' ? 'tar' : format)
      expect(reader.getNode('hello.txt')?.isDirectory).toBe(false)
      expect(reader.getNode('nested')?.isDirectory).toBe(true)
      expect(new TextDecoder().decode((await reader.readFile('hello.txt')).bytes)).toBe('hello archive\n')
      expect(new TextDecoder().decode((await reader.readFile('nested/note.txt')).bytes)).toBe('nested note\n')
      expect((await reader.readFile('empty.txt')).bytes.byteLength).toBe(0)
    })
  }
})

describe('writeArchive', () => {
  test('writes a zip to disk that reopens to the same members', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-archive-'))
    const target = join(dir, 'roundtrip.zip')
    await writeArchive(target, 'zip', MEMBERS)
    const reader = await openArchive(target, {
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 64 * 1024 * 1024 },
    })
    expect(new TextDecoder().decode((await reader.readFile('hello.txt')).bytes)).toBe('hello archive\n')
    expect(reader.getNode('nested/note.txt')).not.toBeUndefined()
    expect((await readFile(target)).byteLength).toBeGreaterThan(0)
  })
})

describe('encode output is deterministic and sniffable', () => {
  test('zip output sniffs back as zip with no prepended data', async () => {
    const bytes = await encodeArchive('zip', MEMBERS)
    expect(sniffArchiveFormat(bytes)).toBe('zip')
  })

  test('tar.gz output contains a decompressible inner tar', async () => {
    const bytes = await encodeArchive('tar.gz', MEMBERS)
    const inner = gunzipSync(bytes)
    expect(sniffArchiveFormat(inner)).toBe('tar')
  })
})
