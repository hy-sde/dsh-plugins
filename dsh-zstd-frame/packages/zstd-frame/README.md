# @hy-sde-org/dsh-zstd-frame

Zstandard frame primitives shared by the DeepSeek Harness session
persistence backend (`session.jsonl.zstd`) and the project memory bank
(`bank.jsonl.zstd`). Both store append-only, checksummed, per-batch zstd
frames; this package owns the structural scan, the one-shot compress /
decompress API with checksum, torn-frame recovery, and the interchangeable
multi-frame decoders, so consumers never reimplement frame layout or
Node-private decoder lifecycle.

Published standalone as `@hy-sde-org/dsh-zstd-frame`; it mirrors
`@deepseek-ai/dsh-zstd-frame` in the [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness).

Backed entirely by `node:zlib` — no native module, works in-process.

## API

```ts
import {
  compressZstdFrame,
  decompressZstdFrame,
  decompressZstdFrameSync,
  decompressZstdPrefix,
  scanZstdFrames,
  createZstdFrameDecoder,
} from '@hy-sde-org/dsh-zstd-frame'
```

- `scanZstdFrames(buffer, maxFrames?)` → `{ frames: ZstdFrameRange[], tornStart? }` —
  locate complete frames without decompressing their blocks; EOF inside the
  final frame returns its start for repair.
- `compressZstdFrame(input)` — one independently decodable, checksummed frame.
- `decompressZstdFrame(input, maxOutput?)` / `decompressZstdFrameSync(...)` —
  one-frame decompression with optional plaintext bound.
- `decompressZstdPrefix(input)` — recover available plaintext from a
  structurally incomplete final frame.
- `createZstdFrameDecoder()` — `NodePrivateZstdFrameDecoder` when the running
  Node shape is compatible, else `PublicZstdFrameDecoder`; both implement the
  common `ZstdFrameDecoder` interface (`decode(source, frames)` generator +
  `close()`).

## Known Limitations and Deferred Work

- The private-handle decoder (`NodePrivateZstdFrameDecoder`) depends on the
  private `zlib._handle.writeSync` shape, which the public Node API does not
  document; the decoder feature-probes at load and falls back to the
  one-shot-based `PublicZstdFrameDecoder` when the shape is incompatible, so
  correctness never depends on private internals.
- No streaming incremental compressor; frames are written whole per batch.
- Only *checksummed* frames are produced by `compressZstdFrame`
  (`ZSTD_c_checksumFlag`), and `decompressZstdPrefix` deliberately suppresses
  final-frame/checksum completion — callers must establish the torn boundary
  themselves before using it.

The optional `./invariant` entry registers the package into a Cordis host's
`ctx.invariants` service (no-op) and needs `@deepseek-ai/cordis` +
`@deepseek-ai/dsh-invariants` peers only when you use that entry.

## License

MIT. Derived from the DeepSeek Harness codebase; see
`THIRD-PARTY-NOTICES.md` for provenance.
