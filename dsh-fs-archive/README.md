# dsh-fs-archive — pure-TS multi-format archive engine for DeepSeek Harness

A standalone public package: **`@hy-sde-org/dsh-fs-archive`** — a pure-TypeScript
multi-format archive engine — zip, tar, tar.gz, rar, 7z, iso, deb, rpm, cpio,
cab, arj, asar — plus the codec layer (gzip, bzip2, ncompress LZW, xz, deflate,
zstd) behind them.

This is the oh-my-pi archive engine (the "read multi-format" surface)
ported out of the Bun runtime into pure TypeScript over Node's
standard library, published **standalone** so any TypeScript project — and
especially official DeepSeek Harness installations — can read archives
without depending on the fork that originally hosted `@deepseek-ai/dsh-fs-archive`.

## Install

```bash
pnpm add @hy-sde-org/dsh-fs-archive
# or: npm install @hy-sde-org/dsh-fs-archive
```

Node `>=22.19.0` (relies on `node:zlib` zstd support). No runtime
dependencies.

## Use

```ts
import {
  openArchive,
  parseArchivePathCandidates,
  sniffArchiveFormat,
  archiveFormatFromPath,
  formatArchiveEntryLines,
} from '@hy-sde-org/dsh-fs-archive'

// Open a file on disk
const reader = await openArchive('bundle.zip', { limits: defaultLimits })

// Or from bytes
const reader = await openArchive({ bytes, format: sniffArchiveFormat(bytes) })

const root = reader.getNode('/')
const lines = formatArchiveEntryLines(reader.listDirectory(root))
const file = await reader.readFile(reader.getNode('/notes/readme.txt'))
```

- `openArchive(source, options)` — open a file path or `{ bytes, format }`
  into an `ArchiveReader`; `getNode` resolves members, `listDirectory` lists,
  `readFile` reads one member's bytes, `indexEntries` enumerates.
- `parseArchivePathCandidates(filePath)` — split `archive.ext:member/path`
  into resolution candidates (longest archive prefix first).
- `sniffArchiveFormat(bytes)` / `archiveFormatFromPath(path)` — format rules.
- `formatArchiveEntryLines(entries)` — one line per member, `name/` for
  directories and `name (size)` for files.
- See `packages/fs-archive/src/index.ts` for the full export surface.

## Development

```bash
pnpm install
pnpm -r check       # strict typecheck (src + tests)
pnpm -r test        # 33 archive-engine tests
pnpm -r build       # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish to npm
```

## Layout

```
packages/fs-archive/   @hy-sde-org/dsh-fs-archive — the engine
  src/ar/                 zip/tar/rar/7z/iso/deb/rpm/cpio/cab/arj/asar + codecs
  tests/                  33 specs + the bundled ar.tar.gz fixture
```

See `packages/fs-archive/README.md` for engine details.
