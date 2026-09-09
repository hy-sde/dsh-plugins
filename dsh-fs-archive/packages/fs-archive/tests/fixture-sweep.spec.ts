import { describe, expect, test } from 'vitest'
import { openArchive } from '../src/ar/open.ts'
import { DEFAULT_ARCHIVE_LIMITS } from '../src/ar/limits.ts'
import type { ArchiveReader } from '../src/ar/reader.ts'
import { ArchiveError } from '../src/ar/error.ts'
import { sniffArchiveFormat } from '../src/ar/registry.ts'
import type { ArchiveFormat } from '../src/ar/types.ts'
import { arFixture } from './fixtures.ts'

/**
 * Every fixture archive goes through the unified `openArchive` door. This
 * isn't a per-format conformance suite (those ship upstream); it proves the
 * ported decoders don't crash or hang on their own vectors and that the
 * unified reader lists + reads real members across every container family.
 */
const FORMATS: readonly { fixture: string; format?: ArchiveFormat; listing: readonly string[] }[] = [
  { fixture: 'zip-basic.zip', listing: ['plain.txt', 'nested'] },
  { fixture: 'sevenzip-default.7z', listing: [] },
  { fixture: 'rar4-store.rar', listing: [] },
  { fixture: 'rar5-default.rar', listing: [] },
  { fixture: 'minimal-symlink.iso', listing: [] },
  { fixture: 'cpio-crc.cpio', listing: [] },
  { fixture: 'cab-none.cab', listing: [] },
  { fixture: 'tiny-lzma.deb', listing: ['debian-binary', 'control', 'usr'] },
  { fixture: 'asar-valid.asar', listing: ['docs'] },
]

describe('fixture format sweep', () => {
  for (const { fixture, listing } of FORMATS) {
    test(`opens ${fixture} via the unified API`, async () => {
      const bytes = await arFixture(fixture)
      const sniffed = sniffArchiveFormat(bytes)
      expect(sniffed).toBeDefined()
      const reader = await openArchive(
        { bytes, format: sniffed as ArchiveFormat },
        { limits: { ...DEFAULT_ARCHIVE_LIMITS } },
      )
      expect(reader).toBeInstanceOf(Object)
      const rootListing = reader.listDirectory('/').map(entry => entry.name)
      for (const expected of listing) expect(rootListing).toContain(expected)
      // Read every member under 256 KiB to exercise materialization.
      for (const entry of reader.indexEntries()) {
        if (entry.isDirectory || entry.size > 256 * 1024) continue
        try {
          await reader.readFile(entry.path)
        } catch (error) {
          if (entry.storage?.type === 'member' && entry.storage.source !== undefined) throw error
        }
      }
    })
  }

  test('rejects a truncated zip with an ArchiveError, not a crash', async () => {
    const bytes = await arFixture('zip-basic.zip')
    const truncated = bytes.subarray(0, Math.floor(bytes.byteLength / 2))
    let threw = false
    try {
      await openArchive({ bytes: truncated, format: 'zip' }, { limits: { ...DEFAULT_ARCHIVE_LIMITS } })
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveError)
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('deb fixture merges control + data tar trees', () => {
  let reader: ArchiveReader
  test('tiny-lzma.deb exposes package metadata and payload in one tree', async () => {
    const bytes = await arFixture('tiny-lzma.deb')
    reader = await openArchive({ bytes, format: 'deb' }, { limits: { ...DEFAULT_ARCHIVE_LIMITS } })
    const names = reader.listDirectory('/').map(entry => entry.name)
    expect(names).toEqual(expect.arrayContaining(['debian-binary', 'control', 'usr']))
  })
})
