import { describe, expect, test } from 'vitest'
import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive } from '../src/ar/open.ts'
import { DEFAULT_ARCHIVE_LIMITS } from '../src/ar/limits.ts'
import { encodeTar } from '../src/ar/tar.ts'
import { gzipCompress } from '../src/ar/codecs/gzip.ts'
import { fileByteSource } from '../src/ar/source.ts'
import { ArchiveError } from '../src/ar/error.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

// The decompressed tar is about 9 KB, so the 4 KiB ceiling forces the streaming walk.
const LIMITS = { ...DEFAULT_ARCHIVE_LIMITS, maxInMemorySize: 4096 }

describe('file-backed byte source', () => {
  test('path-based tar.gz past maxInMemorySize lists and reads members', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-archive-'))
    try {
      const members = [
        ['first.txt', ENCODER.encode('first\n')],
        ['data/fill.bin', new Uint8Array(6000).fill(0x41)],
        ['data/last.txt', ENCODER.encode('last\n')],
      ] as const
      const target = join(dir, 'stream.tar.gz')
      await writeFile(target, await gzipCompress(await encodeTar(members)))
      const archive = await openArchive(target, { limits: LIMITS })
      expect(archive.listDirectory('').map(entry => entry.name)).toEqual(['data', 'first.txt'])
      expect(DECODER.decode((await archive.readFile('data/last.txt')).bytes)).toBe('last\n')
      expect((await archive.readFile('data/fill.bin')).bytes).toEqual(members[1][1])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reads track a replaced file instead of a stale cached descriptor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-archive-'))
    try {
      const target = join(dir, 'data.bin')
      const before = ENCODER.encode('A'.repeat(4096))
      const after = ENCODER.encode('B'.repeat(4096))
      await writeFile(target, before)
      const source = fileByteSource(target)
      expect(await source.read(0, 4)).toEqual(before.subarray(0, 4))
      await writeFile(target, after)
      expect(await source.read(0, 4)).toEqual(after.subarray(0, 4))
      expect(await source.read(4092, 4096)).toEqual(after.subarray(4092, 4096))
      // Swapping the file via rename changes the inode, so the cached
      // descriptor must be invalidated and reopened.
      const firstIno = (await stat(target)).ino
      const swapped = ENCODER.encode('C'.repeat(2048))
      await writeFile(join(dir, 'data.swapped.bin'), swapped)
      await rename(join(dir, 'data.swapped.bin'), target)
      expect((await stat(target)).ino).not.toBe(firstIno)
      expect(await source.read(0, 4)).toEqual(swapped.subarray(0, 4))
      await expect(source.read(4092, 4096)).rejects.toThrow(ArchiveError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('ranges past the end and missing files fail like whole-file reads did', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-archive-'))
    try {
      const target = join(dir, 'short.bin')
      await writeFile(target, ENCODER.encode('0123456789'))
      const source = fileByteSource(target)
      await expect(source.read(0, 20)).rejects.toThrow(ArchiveError)
      await expect(source.read(8, 12)).rejects.toThrow(ArchiveError)
      await expect(fileByteSource(join(dir, 'absent.bin')).read(0, 1)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('more distinct files than cache slots all read correctly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-archive-'))
    try {
      const sources: (readonly [number, ReturnType<typeof fileByteSource>])[] = []
      for (let index = 0; index < 12; index++) {
        const target = join(dir, `file-${index}.bin`)
        const content = `content-${index}`.padEnd(24, '.')
        await writeFile(target, ENCODER.encode(content))
        sources.push([index, fileByteSource(target)])
      }
      for (const [index, source] of sources) {
        expect(DECODER.decode(await source.read(0, 24))).toBe(`content-${index}`.padEnd(24, '.'))
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
