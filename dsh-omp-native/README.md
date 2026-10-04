<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
<!-- MIRROR-NOTE:END -->

# dsh-omp-native — native PDF and SQLite sidecar for DeepSeek Harness

English | [中文](README.zh.md)

Standalone native sidecar extracted from the
[oh-my-pi](https://github.com/stencil-hq/omp) Rust rewrite (omp², MIT). It gives
the DeepSeek Harness two bounded, read-only capabilities that were previously
"Rust-dependent" in the omp backlog — now delivered as one small, statically
linked binary the harness calls over a pinned JSON CLI contract:

- **`pdf`** — page rasterization to PNG via the pure-Rust [hayro]
  (https://crates.io/crates/hayro) renderer, with the same input/page/pixel/
  output bounds the omp2 `read` tool enforces (20 MiB in, 2000 pages,
  1.5M pixels, 8 MiB out).
- **`sqlite`** — read-only querying of SQLite databases with the full oh-my-pi
  table/column target syntax (`db.sqlite`, `db.sqlite:users`,
  `db.sqlite:users?where=...&limit=...`, raw `?q=SELECT ...`), built on
  `rusqlite` with `SQLITE_OPEN_READ_ONLY` + progress interrupts and WAL support.

| Identity | Value |
| --- | --- |
| Package | `dsh-omp-native` — a Rust crate (version `0.1.2-rc.1`), not an npm package |
| Plugin id | none — no Cordis row; the harness finds the binary via `DSH_OMP_NATIVE_PATH` or the default `target/release/dsh-omp-native` probe |
| Seam | the pinned JSON CLI contract ([docs/cli-contract.md](docs/cli-contract.md)), consumed by the hy-sde fork's `read` tool (`packages/fs/tool-fs/src/read-native.ts`) |

> **Based on [oh-my-pi](https://github.com/stencil-hq/omp) (omp²)** — `src/pdf.rs`
> and `src/sqlite.rs` are ported from the omp² `crates/tools/src/read/` modules
> (MIT, © 2025-2026 Can Bölük and contributors). See
> [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Why

PDF rasterization and SQLite querying were "Rust-dependent" items in the omp
backlog: the harness had no way to get them without adopting Rust into its own
build. This sidecar delivers both as one small, statically linked binary over
a pinned JSON CLI contract — bounded, read-only, and versioned independently
of the harness checkout.

The harness consumer is `packages/fs/tool-fs/src/read-native.ts` in the
[hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness): the
`read` tool routes `.pdf`/`.sqlite` files to this binary when present, sniffing
the magic bytes first, and falls back to the regular read otherwise. Published
here **standalone** so the sidecar builds and versions independently of the
harness checkout.

## Prerequisites

- Rust stable with edition 2024 support — install via
  [rustup](https://rustup.rs); the crate is `edition = "2024"` and builds on
  the stable channel (no nightly feature is used);
- `cargo` on `PATH` (comes with rustup);
- the consumer: the hy-sde fork's `read` tool (`tool-fs`), which probes the
  binary — nothing else is required; there is no npm/Node dependency.

## Layout

```text
dsh-omp-native/
  Cargo.toml            standalone crate (edition 2024, stable channel)
  src/main.rs           JSON contract entry
  src/pdf.rs            ported from omp2 crates/tools/src/read/pdf.rs
  src/sqlite.rs         ported from omp2 crates/tools/src/read/sqlite.rs (+ own tests)
  docs/cli-contract.md  pinned external contract
  fixtures/            sample.sqlite + sample.pdf used by the tool-fs spec
```

## Build

```sh
cargo build --release          # stable channel is sufficient (no nightly)
cargo test --release           # sqlite module unit tests
```

Then either export `DSH_OMP_NATIVE_PATH=/abs/path/to/dsh-omp-native` at
harness-runtime, or leave the binary at
`target/release/dsh-omp-native` (the default probe in the fork's
`read-native.ts`).

### Uninstall / teardown

Unwiring is env-level: remove the `DSH_OMP_NATIVE_PATH` export from the
harness environment (or delete `target/release/dsh-omp-native`, the default
probe location). The `read` tool then falls back to the regular read for
`.pdf`/`.sqlite` files — absence is always safe. `cargo clean` (or deleting
`target/`) removes the build artifacts and the binary.

## Provenance

- `src/pdf.rs` — omp² `crates/tools/src/read/pdf.rs` (MIT), `omp_core::Str`
  replaced by `&'static str`.
- `src/sqlite.rs` — omp² `crates/tools/src/read/sqlite.rs` (MIT), `xutf` width
  calls replaced by `unicode-width` so the crate builds on stable (omp²'s own
  workspace pins nightly for its `xutf`).
- Any further capability harvested from omp² should keep the same pattern:
  bounded read-only surface, own subcommand, JSON contract, magic-byte gating
  in the consumer.

## License and attribution

This crate is licensed MIT — see [LICENSE](LICENSE) (© 2026 hy-sde). The
`pdf` and `sqlite` modules are ported from the oh-my-pi Rust rewrite
([omp²](https://github.com/stencil-hq/omp), MIT License, © 2025-2026 Can Bölük
and contributors); the upstream provenance is aggregated in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), which also records the
crates.io ecosystem dependencies (`hayro`, `rusqlite` with bundled
public-domain `sqlite3`, `unicode-width`, and the rest) under their own
licenses. This is a separately built sidecar; the harness remains the
property of its own project.
