# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms of the MIT License. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## oh-my-pi (omp²)

- **Project**: https://github.com/stencil-hq/omp (MIT License)
- **Copyright**: Copyright (c) 2025-2026 Can Bölük and contributors
- **Derived modules**:
  - `src/pdf.rs` — `crates/tools/src/read/pdf.rs` from the omp² Rust rewrite
    (page rasterization via `hayro`, bounded input/page/pixel/output), with
    `omp_core::Str` replaced by `&'static str`.
  - `src/sqlite.rs` — `crates/tools/src/read/sqlite.rs` from the omp² Rust
    rewrite (read-only SQLite querying with the `:tbl[:col]?where=&limit=`
    and `?q=` target syntax), with the nightly-only `xutf` width calls
    replaced by `unicode-width` so the crate builds on stable.

## crates.io ecosystem

- `hayro` (pure-Rust PDF rasterizer), `rusqlite`, `bytes`, `serde_json`,
  `unicode-width`, `parking_lot`, `thiserror`, `tempfile` (dev) — each under
  its own license; `rusqlite` uses `sqlite3` (public domain) bundled.

## DeepSeek Harness

- **Project**: https://github.com/deepseek-ai/deepseek-harness (MIT License)
- **Copyright**: Copyright (c) 2026 DeepSeek
- **Derived**: the harness `read` tool integration in
  `packages/fs/tool-fs/src/read-native.ts` lives in the hy-sde fork; this
  repo carries only the sidecar crate and its pinned `docs/cli-contract.md`.

License text (identical for all listed projects):

```
MIT License

Copyright (c) 2026 hy-sde

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
