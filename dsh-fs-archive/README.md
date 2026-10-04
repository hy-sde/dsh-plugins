<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-fs-archive`](https://www.npmjs.com/package/@hy-sde-org/dsh-fs-archive)
<!-- MIRROR-NOTE:END -->

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

Faithful vs. adapted: the port is algorithmically 1:1 — the format engines
and codecs, the `ArchiveLimits` bounds, and the sniff/extension detection
rules are the original oh-my-pi (`pi-utils`) logic. What was adapted is the
runtime shell: `Bun.hash.crc32` became a table-driven CRC-32,
`Bun.CryptoHasher` became `node:crypto` SHA-256, and `Bun.file`/`Bun.write`
became `node:fs`/`node:fs/promises` — so the engine runs on stock Node with
no Bun dependency — and relative imports carry `.ts` extensions, with
`formatBytes`, the small `LRUCache`, and the public `index.ts` surface
replacing upstream package-level re-exports.

## Why

Reading `bundle.zip:dir/file.txt` should not require shelling out to external
tools or a Bun runtime. This engine is the durable core of the harness `read`
tool's multi-format support — `foo.zip` lists an archive's root,
`foo.zip:dir` lists a directory, `foo.zip:dir/file.txt` reads one member as
text — and member reads are bounded by `ArchiveLimits` (entry count, index
size, in-memory size, member size, path bytes, link depth) so
attacker-controlled archives cannot drive unbounded allocation.

## Prerequisites

- Node.js 22.19 or newer (relies on `node:zlib` zstd support) with npm and
  pnpm on `PATH`;
- no runtime dependencies — peers `@deepseek-ai/cordis` `~4.0.4` and
  `@deepseek-ai/dsh-invariants` `^0.2.0-rc.2` are needed only for the
  optional `./invariant` Cordis companion entry.

## Install

```bash
pnpm add @hy-sde-org/dsh-fs-archive
# or: npm install @hy-sde-org/dsh-fs-archive
```

No `dsh` routes apply: no bundle row ships and `dsh plugin add` is not an
install path — this is a plain npm library. (Inside the DeepSeek Harness
fork, the `read` tool consumes the engine directly; there is no mounted
plugin row to verify with `dsh web --dump-config`.)

### From source (validate this checkout or hack on the engine)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @hy-sde-org/dsh-fs-archive build

ARCHIVE_TGZ="$(cd dsh-fs-archive/packages/fs-archive && pnpm pack --pack-destination /tmp | tail -n 1)"
pnpm add "$ARCHIVE_TGZ"
```

`pnpm pack` runs the normal `prepack` build and produces a tarball containing
`dist/`.

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

## License and attribution

This repo is licensed MIT — see [LICENSE](LICENSE) (© 2026 hy-sde). The
archive engine is ported from [oh-my-pi](https://github.com/can1357/oh-my-pi)'s
`pi-utils` (`packages/utils/src/ar`) (MIT License, © Mario Zechner 2025,
© Can Bölük 2025-2026); the upstream provenance is aggregated in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), together with the
DeepSeek Harness (MIT, © 2026 DeepSeek) invariant-companion pattern the
`./invariant` entry follows. This is a separately installable package; the
harness remains the property of its own project.
