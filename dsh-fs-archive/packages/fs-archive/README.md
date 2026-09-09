# @hy-sde-org/dsh-fs-archive

A pure-TS multi-format archive engine — zip, tar, tar.gz, rar, 7z, iso, deb, rpm, cpio, cab, arj, asar — plus the codec layer (gzip, bzip2, ncompress LZW, xz, deflate, zstd) behind them. Ported from [@oh-my-pi/pi-utils](https://github.com/can1357/oh-my-pi/tree/main/packages/utils/src/ar).

This is the durable core of the harness `read` tool's multi-format support: `foo.zip` lists an archive's root, `foo.zip:dir` lists a directory, and `foo.zip:dir/file.txt` reads one member as text. Published standalone as `@hy-sde-org/dsh-fs-archive`; it mirrors `@deepseek-ai/dsh-fs-archive` in the [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness).

Format detection sniffs content signatures (`sniffArchiveFormat`) and falls back to extension inference (`archiveFormatFromPath`); member reads are bounded by `ArchiveLimits` (entry count, index size, in-memory size, member size, path bytes, link depth) so attacker-controlled archives cannot drive unbounded allocation.

## Port differences

- No `Bun` runtime: `Bun.hash.crc32` is table-driven CRC-32, `Bun.CryptoHasher` is `node:crypto` SHA-256, and `Bun.file` / `Bun.write` are `node:fs` / `node:fs/promises` equivalents.
- All relative imports carry the `.ts` extension (repo `rewriteRelativeImportExtensions`).
- `formatBytes`, the small `LRUCache`, and the public `index.ts` surface replace the upstream package-level re-exports; tests load fixtures from one bundled `tar.gz` (the same layout upstream uses to keep checkout state quiet).
- The optional `./invariant` companion registers the package into a Cordis host's `ctx.invariants` service (no-op); it needs `@deepseek-ai/cordis` + `@deepseek-ai/dsh-invariants` peers only when you use that entry.

Otherwise the port is algorithmically 1:1 with the original source. Keep the two sources in sync when the fork backports upstream archive-engine fixes.

## Known Limitations and Deferred Work

- The harness `read` tool member reads go through `ctx.fs.readBytes` with a bounded `readMaxArchiveBytes` (default 256 MiB): the archive file is loaded into memory for indexing. No streaming/local `fileByteSource` path is wired into the tool yet, so very large archives stay beyond the cap even though the engine itself supports lazy source reads.
- The harness `read` tool serves member text and listings only; archive *writing* is not exposed through the tool (members are immutable there), though this package's `writeArchive` API supports zip/tar/tar.gz/asar writing for programmatic use.
- Detection needs either content sniffing or an archive extension on the path; a member named with a supported archive extension inside a container is interpreted by longest-prefix rules from `parseArchivePathCandidates`.

Package API:

```ts
import {
  openArchive,
  parseArchivePathCandidates,
  sniffArchiveFormat,
  formatArchiveEntryLines,
} from '@hy-sde-org/dsh-fs-archive'
```

- `openArchive(source, options)` — open a file path or `{ bytes, format }` into an `ArchiveReader`; `getNode` resolves members, `listDirectory` lists, `readFile` reads one member's bytes, `indexEntries` enumerates.
- `parseArchivePathCandidates(filePath)` — split `archive.ext:member/path` into resolution candidates (longest archive prefix first).
- `sniffArchiveFormat(bytes)` / `archiveFormatFromPath(path)` — format rules.
- `formatArchiveEntryLines(entries)` — one line per member, `name/` for directories and `name (size)` for files.
- See `src/index.ts` for the full export surface.

## License

Port of MIT-licensed code. Original copyright: `Copyright (c) 2025-2026 Can Bölük` and contributors. Derived files carry header attribution; see the inline file headers and `THIRD-PARTY-NOTICES.md`.
