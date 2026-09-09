/**
 * Public re-export of the vendored Zstandard frame primitives so sibling
 * packages (e.g. `@hy-sde-org/dsh-tool-memory`) can decode framed banks
 * without depending on a separate codec package. Backed entirely by
 * `node:zlib` — no native module.
 * @module @hy-sde-org/dsh-memory/frame-codec
 */

export {
  compressZstdFrame,
  decompressZstdFrame,
  decompressZstdFrameSync,
  decompressZstdPrefix,
  scanZstdFrames,
  createZstdFrameDecoder,
  type ZstdFrameRange,
  type ZstdFrameScan,
  type ZstdFrameDecoder,
  NodePrivateZstdFrameDecoder,
  PublicZstdFrameDecoder,
} from './zstd-frame/index.ts'
