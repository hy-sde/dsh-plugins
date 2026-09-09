# dsh-zstd-frame — Zstandard frame primitives for DeepSeek Harness

A standalone public package: **`@hy-sde-org/dsh-zstd-frame`** — append-only,
checksummed **Zstandard frame** primitives shared by the DeepSeek Harness
session persistence backend (`session.jsonl.zstd`) and the project memory
bank (`bank.jsonl.zstd`): the structural scan, the one-shot compress /
decompress API, torn-frame recovery, and the interchangeable multi-frame
decoders.

Published **standalone** so any official DeepSeek Harness installation and any
TypeScript project can read and write the same frame layout without depending
on the fork that originally hosted `@deepseek-ai/dsh-zstd-frame` (which the
`dsh-memory` repo had to vendor by hand before this standalone existed).

## Install

```bash
pnpm add @hy-sde-org/dsh-zstd-frame
# or: npm install @hy-sde-org/dsh-zstd-frame
```

Node `>=22.19.0` — backed entirely by `node:zlib` zstd support (no native
module).

## Use

```ts
import {
  compressZstdFrame,
  decompressZstdFrame,
  decompressZstdFrameSync,
  decompressZstdPrefix,
  scanZstdFrames,
  createZstdFrameDecoder,
} from '@hy-sde-org/dsh-zstd-frame'

const encoded = Buffer.concat([
  await compressZstdFrame('{"type":"session",...}\n'),
  await compressZstdFrame('{"type":"turn/start",...}\n'),
])
const { frames, tornStart } = scanZstdFrames(encoded)
const plaintext = await Promise.all(
  frames.map(f => decompressZstdFrame(encoded.subarray(f.start, f.end))),
)
```

- `scanZstdFrames(buffer)` — locate complete frames without decompressing
  their blocks; EOF inside the final frame returns its start (`tornStart`).
- `compressZstdFrame` / `decompressZstdFrame` / `decompressZstdFrameSync` —
  one-shot, checksum-validated (optional `maxOutput` bound).
- `decompressZstdPrefix(input)` — recover plaintext from a structurally
  incomplete final frame (`ZSTD_e_flush`).
- `createZstdFrameDecoder()` — select `NodePrivateZstdFrameDecoder` (fast,
  private Node handle) or `PublicZstdFrameDecoder` fallback; both yield one
  plaintext per frame through the common `ZstdFrameDecoder` interface.

## Development

```bash
pnpm install
pnpm -r check       # strict typecheck (src + tests)
pnpm -r test        # frame-primitive tests
pnpm -r build       # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish to npm
```

## Layout

```
packages/zstd-frame/   @hy-sde-org/dsh-zstd-frame — the frame primitives
  src/index.ts                     public scan / compress / decompress API
  src/zstd-private-decoder.ts      private-handle multi-frame decoder
  src/zstd-public-decoder.ts       one-shot-API multi-frame decoder fallback
  src/invariant.ts                 optional Cordis ./invariant companion
```
