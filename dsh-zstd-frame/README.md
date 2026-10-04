<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-zstd-frame`](https://www.npmjs.com/package/@hy-sde-org/dsh-zstd-frame)
<!-- MIRROR-NOTE:END -->

# dsh-zstd-frame — Zstandard frame primitives for DeepSeek Harness

A standalone public package: **`@hy-sde-org/dsh-zstd-frame`** — append-only,
checksummed **Zstandard frame** primitives shared by the DeepSeek Harness
session persistence backend (`session.jsonl.zstd`) and the project memory
bank (`bank.jsonl.zstd`): the structural scan, the one-shot compress /
decompress API, torn-frame recovery, and the interchangeable multi-frame
decoders.

## Why

Published **standalone** so any official DeepSeek Harness installation and any
TypeScript project can read and write the same frame layout without depending
on the fork that originally hosted `@deepseek-ai/dsh-zstd-frame` (which the
`dsh-memory` repo had to vendor by hand before this standalone existed). The
frame layout is the same as that fork's `@deepseek-ai/dsh-zstd-frame` — one
frame format across `session.jsonl.zstd` and `bank.jsonl.zstd`.

## Prerequisites

- Node `>=22.19.0` — backed entirely by `node:zlib` zstd support (no native
  module).

## Install

```bash
pnpm add @hy-sde-org/dsh-zstd-frame
# or: npm install @hy-sde-org/dsh-zstd-frame
```

### From source

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install

ZSTD_TGZ="$(cd dsh-zstd-frame/packages/zstd-frame && pnpm pack --silent --pack-destination /tmp)"
npm install --save-dev "$ZSTD_TGZ"   # or: pnpm add "$ZSTD_TGZ"
```

This is a library: it ships no bundle row, and there is no `dsh plugin` route —
depend on it from npm, or install the packed tarball as a file dependency.

### Verify

```bash
node --input-type=module -e '
import { compressZstdFrame, scanZstdFrames, decompressZstdFrame } from "@hy-sde-org/dsh-zstd-frame";
const buf = await compressZstdFrame("hello dsh\n");
const { frames } = scanZstdFrames(buf);
const text = Buffer.from(await decompressZstdFrame(buf.subarray(frames[0].start, frames[0].end))).toString();
if (frames.length !== 1 || text !== "hello dsh\n") throw new Error("round-trip failed");
console.log("round-trip ok:", JSON.stringify(text));
'
```

`compressZstdFrame` → `scanZstdFrames` → `decompressZstdFrame`: one checksum-validated
frame scanned out of the buffer, plaintext back — the round trip the Use section below
exercises.

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

## License and attribution

This package is licensed MIT. The Zstandard frame primitives are derived
from the DeepSeek Harness codebase (MIT License, © 2026 DeepSeek); the
upstream copyright holders are recorded in LICENSE next to this package's
own notice, and the upstream notice text is reproduced in full in
THIRD-PARTY-NOTICES.md.

This package is a separate installable library; the harness remains the
property of its own project.

