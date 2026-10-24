import { describe, expect, test } from 'vitest'
import { openArchive } from '../src/ar/open.ts'
import { DEFAULT_ARCHIVE_LIMITS } from '../src/ar/limits.ts'
import { encodeTar } from '../src/ar/tar.ts'
import { gzipCompress } from '../src/ar/codecs/gzip.ts'
import { zstdCompress } from '../src/ar/codecs/zstd.ts'
import type { ByteSource } from '../src/ar/source.ts'
import { ArchiveError } from '../src/ar/error.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

// The decompressed tar is about 9 KB, so the 4 KiB ceiling forces the streaming walk.
const MEMBERS = [
  ['first.txt', ENCODER.encode('first\n')],
  ['data/fill.bin', new Uint8Array(6000).fill(0x41)],
  ['data/last.txt', ENCODER.encode('last\n')],
] as const

const LIMITS = { ...DEFAULT_ARCHIVE_LIMITS, maxInMemorySize: 4096 }

describe('compressed tar past maxInMemorySize', () => {
  test.each([
    ['tar.gz', gzipCompress],
    ['tar.zst', zstdCompress],
  ] as const)('%s lists and reads members in any order', async (format, compress) => {
    const bytes = await compress(await encodeTar(MEMBERS))
    const archive = await openArchive({ bytes, format }, { limits: LIMITS })
    expect(archive.listDirectory('').map(entry => entry.name)).toEqual(['data', 'first.txt'])
    expect(DECODER.decode((await archive.readFile('data/last.txt')).bytes)).toBe('last\n')
    expect((await archive.readFile('data/fill.bin')).bytes).toEqual(MEMBERS[1][1])
    expect(DECODER.decode((await archive.readFile('first.txt')).bytes)).toBe('first\n')
  })

  test('reading every member in archive order decompresses the stream once', async () => {
    const bytes = await gzipCompress(await encodeTar(MEMBERS))
    let passes = 0
    const source: ByteSource = {
      size: bytes.byteLength,
      async read(start, end) {
        if (start === 0) passes++
        return bytes.subarray(start, end)
      },
    }
    const archive = await openArchive({ source, format: 'tar.gz' }, { limits: LIMITS })
    const indexPasses = passes
    for (const [memberPath, content] of MEMBERS) {
      expect((await archive.readFile(memberPath)).bytes).toEqual(content)
    }
    expect(passes - indexPasses).toBe(1)
  })

  test('a streamed member read holds only the member bytes', async () => {
    const bytes = await gzipCompress(await encodeTar(MEMBERS))
    const archive = await openArchive({ bytes, format: 'tar.gz' }, { limits: LIMITS })
    const first = (await archive.readFile('first.txt')).bytes
    expect(DECODER.decode(first)).toBe('first\n')
    expect(first.buffer.byteLength).toBe(first.byteLength)
  })

  test('rejects a stream whose gzip trailer is cut off', async () => {
    const bytes = await gzipCompress(await encodeTar(MEMBERS))
    await expect(
      openArchive({ bytes: bytes.subarray(0, bytes.byteLength - 8), format: 'tar.gz' }, { limits: LIMITS }),
    ).rejects.toThrow(ArchiveError)
  })

  test('a stream that is not a tar fails on the in-memory limit', async () => {
    const bytes = await gzipCompress(ENCODER.encode('log line\n'.repeat(1000)))
    await expect(openArchive({ bytes, format: 'gz' }, { limits: LIMITS })).rejects.toThrow(
      'too large to read in memory',
    )
    await expect(openArchive({ bytes, format: 'gz' }, { limits: LIMITS })).rejects.toThrow('4.0KB limit')
  })

  test('a decompression bomb stops at maxStreamSize', async () => {
    // All zeros sniff as an empty tar, so only the stream ceiling stops the walk.
    const bytes = await gzipCompress(new Uint8Array(64 * 1024))
    await expect(
      openArchive(
        { bytes, format: 'tar.gz' },
        { limits: { ...LIMITS, maxStreamSize: 16 * 1024 } },
      ),
    ).rejects.toThrow('Archive decompresses past the 16.0KB stream limit')
  })
})
