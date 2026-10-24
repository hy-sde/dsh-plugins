import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { Readable, type Transform } from 'node:stream'
import { formatBytes } from '../format.ts'
import { LRUCache } from '../lru.ts'
import { ArchiveError } from './error.ts'

/**
 * A byte window into an archive — file-backed (lazy, ranged reads) or
 * in-memory. Format readers index through this so ZIP/ASAR/RAR payloads are
 * only read when a member is actually extracted.
 */
export interface ByteSource {
  readonly size: number
  read(start: number, end: number): Promise<Uint8Array>
}

/** Filesystem-backed byte-window handle. */
interface FileByteHandle {
  readonly size: number
  readRange(start: number, end: number): Promise<Uint8Array>
}

/** A shared descriptor: refcounted so eviction never closes a handle mid-read. */
interface SharedFileHandle {
  handle: FileHandle
  refs: number
  /** Set when evicted while reads are outstanding; closed by the last release. */
  evicted: boolean
}

/**
 * Open descriptors reused across ranged reads: streamed decompression issues
 * one ranged read per chunk, and a whole-file re-read per range turns that
 * into quadratic disk I/O. The cache bounds the process to a few open
 * descriptors; identity is revalidated on borrow so a replaced file is never
 * read through a stale handle (node:fs replacement for Bun.file slices).
 */
const FILE_HANDLES = new LRUCache<string, Promise<SharedFileHandle>>({
  max: 8,
  dispose: (promise) => {
    void promise.then(
      (shared) => {
        shared.evicted = true
        if (shared.refs === 0) void shared.handle.close().catch(() => {})
      },
      () => {},
    )
  },
})

/** Borrow (opening if needed) the descriptor for `filePath`; call `release()` exactly once. */
async function borrowFileHandle(filePath: string): Promise<{ handle: FileHandle; release: () => void }> {
  let pending = FILE_HANDLES.get(filePath)
  if (!pending) {
    pending = fs.open(filePath, 'r').then(handle => ({ handle, refs: 0, evicted: false }))
    FILE_HANDLES.set(filePath, pending)
    pending.catch(() => {
      if (FILE_HANDLES.peek(filePath) === pending) FILE_HANDLES.delete(filePath)
    })
  }
  const shared = await pending
  shared.refs++
  let released = false
  return {
    handle: shared.handle,
    release() {
      if (released) return
      released = true
      shared.refs--
      if (shared.evicted && shared.refs === 0) void shared.handle.close().catch(() => {})
    },
  }
}

/** Read exactly `length` bytes at `start`; a short read means truncation. */
async function readPositional(handle: FileHandle, start: number, length: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(length)
  const { bytesRead } = await handle.read(buffer, 0, length, start)
  if (bytesRead < length) {
    throw new ArchiveError('Invalid archive: truncated data')
  }
  return buffer
}

/** Ranged read through a reused descriptor, revalidated against the path's identity. */
async function readRangeValidated(filePath: string, start: number, end: number, attempt: number): Promise<Uint8Array> {
  const length = end - start
  const leased = await borrowFileHandle(filePath)
  try {
    // Revalidate the descriptor against the path so a replaced file is not
    // read through a stale handle.
    const [handleStat, pathStat] = await Promise.all([
      leased.handle.stat(),
      fs.stat(filePath).catch(() => null),
    ])
    if (!pathStat || handleStat.ino !== pathStat.ino || handleStat.dev !== pathStat.dev || handleStat.size !== pathStat.size) {
      if (FILE_HANDLES.peek(filePath)) FILE_HANDLES.delete(filePath)
      if (!pathStat) {
        // Removed while open: fail the way a full re-read would.
        await fs.access(filePath)
        throw new ArchiveError('Invalid archive: truncated data')
      }
      if (attempt >= 2) {
        throw new ArchiveError('Invalid archive: truncated data')
      }
      return await readRangeValidated(filePath, start, end, attempt + 1)
    }
    return await readPositional(leased.handle, start, length)
  } finally {
    leased.release()
  }
}

/** Open a file handle kept for lazy ranged reads (node:fs replacement for Bun.file). */
function openFileHandle(filePath: string): FileByteHandle {
  return {
    get size(): number {
      // Stat lazily so opening never performs I/O. A missing file reports an
      // oversized/absent archive, surfacing as a read-time error.
      try {
        return statSync(filePath).size
      } catch {
        return -1
      }
    },
    async readRange(start, end) {
      return readRangeValidated(filePath, start, end, 0)
    },
  }
}

/** Reject a nonsensical `[start, end)` range before any read. */
export function assertValidRange(start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new ArchiveError('Invalid archive range')
  }
}

/** Read an exact in-memory range, throwing (not clamping) when it runs past the buffer. */
export function readMemoryRange(buffer: Uint8Array, start: number, end: number): Uint8Array {
  assertValidRange(start, end)
  if (end > buffer.byteLength) {
    throw new ArchiveError('Invalid archive: truncated data')
  }
  return buffer.subarray(start, end)
}

/** Wrap borrowed bytes as a {@link ByteSource}. */
export function memoryByteSource(buffer: Uint8Array): ByteSource {
  return {
    size: buffer.byteLength,
    async read(start, end) {
      return readMemoryRange(buffer, start, end)
    },
  }
}

/** Lazily read ranges of a file on disk as a {@link ByteSource}. */
export function fileByteSource(filePath: string): ByteSource {
  const handle = openFileHandle(filePath)
  return {
    get size(): number {
      const size = handle.size
      if (!Number.isSafeInteger(size)) {
        throw new ArchiveError('Archive is too large to read safely')
      }
      return size
    },
    async read(start, end) {
      assertValidRange(start, end)
      const bytes = await handle.readRange(start, end)
      if (bytes.byteLength !== end - start) {
        throw new ArchiveError('Invalid archive: truncated data')
      }
      return bytes
    },
  }
}

/** Materialize an entire {@link ByteSource}; use only under a limits check. */
export async function readAllBytes(source: ByteSource): Promise<Uint8Array> {
  return source.read(0, source.size)
}

/** Chunk size for streamed decompression, on both the compressed and the decompressed side. */
export const STREAM_CHUNK_SIZE = 1024 * 1024

async function* readChunks(source: ByteSource): AsyncGenerator<Uint8Array> {
  for (let start = 0; start < source.size; start += STREAM_CHUNK_SIZE) {
    yield await source.read(start, Math.min(source.size, start + STREAM_CHUNK_SIZE))
  }
}

/**
 * Decompress a {@link ByteSource} through `decoder` chunk by chunk, so neither
 * the compressed nor the decompressed stream is ever held whole. Output past
 * `maxOutput` bytes fails, so a decompression bomb cannot run without bound.
 */
export async function* decodeByteSource(source: ByteSource, decoder: Transform, maxOutput: number): AsyncGenerator<Uint8Array> {
  const input = Readable.from(readChunks(source))
  input.once('error', error => decoder.destroy(error))
  let output = 0
  try {
    for await (const chunk of input.pipe(decoder)) {
      output += chunk.byteLength
      if (output > maxOutput) {
        throw new ArchiveError(`Archive decompresses past the ${formatBytes(maxOutput)} stream limit`)
      }
      yield chunk
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError(error instanceof Error ? error.message : String(error))
  } finally {
    input.destroy()
  }
}

/** Options for {@link httpByteSource}. */
export interface HttpByteSourceOptions {
  /** Extra request headers (e.g. authorization). */
  headers?: Record<string, string>
  /** Fetch implementation seam for tests; defaults to global `fetch`. */
  fetch?: typeof fetch
  /**
	 * When the server ignores `Range` (responds 200), the body is buffered in
	 * memory instead, capped to this many bytes. Default 256 MiB.
	 */
  maxFallbackBytes?: number
}

const HTTP_FALLBACK_CAP = 256 * 1024 * 1024

/**
 * A {@link ByteSource} over HTTP(S) range requests, so remote archives can be
 * indexed and read member-by-member without downloading the whole file.
 * Probes with `Range: bytes=0-0`; servers without range support fall back to
 * one bounded full download. Wrap with {@link cachingByteSource} to coalesce
 * the many small header reads format parsers issue.
 */
export async function httpByteSource(url: string | URL, options: HttpByteSourceOptions = {}): Promise<ByteSource> {
  const doFetch = options.fetch ?? fetch
  const headers = { ...options.headers, range: 'bytes=0-0' }
  const probe = await doFetch(url, { headers })
  if (probe.status === 200) {
    // No range support: buffer the whole body once, bounded.
    const cap = options.maxFallbackBytes ?? HTTP_FALLBACK_CAP
    const declared = Number(probe.headers.get('content-length') ?? 0)
    if (declared > cap) {
      throw new ArchiveError(
        `Remote archive is too large to buffer without range support (${declared} > ${cap} bytes)`,
      )
    }
    const bytes = new Uint8Array(await probe.arrayBuffer())
    if (bytes.byteLength > cap) {
      throw new ArchiveError(`Remote archive is too large to buffer without range support (> ${cap} bytes)`)
    }
    return memoryByteSource(bytes)
  }
  if (probe.status !== 206) {
    await probe.body?.cancel()
    throw new ArchiveError(`Remote archive request failed (HTTP ${probe.status})`)
  }
  await probe.body?.cancel()
  // `Content-Range: bytes 0-0/12345` carries the total size.
  const contentRange = probe.headers.get('content-range')
  const total = contentRange ? Number(/\/(\d+)$/.exec(contentRange)?.[1]) : Number.NaN
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ArchiveError('Remote archive did not report a valid size in Content-Range')
  }
  return {
    size: total,
    async read(start, end) {
      assertValidRange(start, end)
      if (start === end) return new Uint8Array(0)
      const response = await doFetch(url, {
        headers: { ...options.headers, range: `bytes=${start}-${end - 1}` },
      })
      if (response.status !== 206) {
        await response.body?.cancel()
        throw new ArchiveError(`Remote archive range request failed (HTTP ${response.status})`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength !== end - start) {
        throw new ArchiveError('Invalid archive: truncated data')
      }
      return bytes
    },
  }
}

/** Options for {@link cachingByteSource}. */
export interface CachingByteSourceOptions {
  /** Cache block size in bytes. Default 256 KiB. */
  blockSize?: number
  /** Max cached blocks. Default 64 (16 MiB at the default block size). */
  maxBlocks?: number
}

/**
 * Wrap a high-latency {@link ByteSource} (HTTP, network filesystems) with an
 * aligned-block LRU cache. Small header reads coalesce into shared block
 * fetches (concurrent readers of one block share a single in-flight request);
 * reads spanning more than two blocks bypass the cache to avoid copying large
 * member payloads through it.
 */
export function cachingByteSource(source: ByteSource, options: CachingByteSourceOptions = {}): ByteSource {
  const blockSize = options.blockSize ?? 256 * 1024
  const blocks = new LRUCache<number, Promise<Uint8Array>>({ max: options.maxBlocks ?? 64 })
  const readBlock = (index: number): Promise<Uint8Array> => {
    const cached = blocks.get(index)
    if (cached) return cached
    const start = index * blockSize
    const pending = source.read(start, Math.min(start + blockSize, source.size))
    blocks.set(index, pending)
    pending.catch(() => blocks.delete(index))
    return pending
  }
  return {
    size: source.size,
    async read(start, end) {
      assertValidRange(start, end)
      if (end > source.size) {
        throw new ArchiveError('Invalid archive: truncated data')
      }
      if (start === end) return new Uint8Array(0)
      const firstBlock = Math.floor(start / blockSize)
      const lastBlock = Math.floor((end - 1) / blockSize)
      if (lastBlock - firstBlock > 1) return source.read(start, end)
      const out = new Uint8Array(end - start)
      for (let index = firstBlock; index <= lastBlock; index++) {
        const block = await readBlock(index)
        const blockStart = index * blockSize
        const from = Math.max(start, blockStart)
        const to = Math.min(end, blockStart + block.byteLength)
        if (to < Math.min(end, blockStart + blockSize)) {
          throw new ArchiveError('Invalid archive: truncated data')
        }
        out.set(block.subarray(from - blockStart, to - blockStart), from - start)
      }
      return out
    },
  }
}
