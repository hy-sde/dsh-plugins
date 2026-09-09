# CLI contract: dsh-omp-native

This file pins the sidecar's externally observable behavior — the cross-package
compatibility surface between the binary and every consumer (currently
`packages/fs/tool-fs/src/read-native.ts`). Changing anything below requires a
version bump for the whole crate and a note in the release notes.

## Invocation grammar

```text
dsh-omp-native pdf     <input.pdf> <page>   → PNG page raster, JSON on stdout
dsh-omp-native sqlite  <target>             → table/query text, JSON on stdout
dsh-omp-native --help | -h                  → usage
```

- `<page>` is one-based; `1` is the default consumer choice.
- `<target>` for `sqlite` embeds the database path **and** the selector/query in
  the oh-my-pi path syntax, e.g. `data.sqlite`, `data.sqlite:users`,
  `data.sqlite:users:2`, `data.sqlite:users?where=age>30&limit=4&order=age:desc`,
  `data.sqlite?q=SELECT ...`. The extension boundary is `.sqlite3`/`.sqlite`/
  `.db3`/`.db`, followed by `:` or `?` (or end of path).
- No flags, no environment-variable inputs, no stdin contract.

## Output contract

One JSON document on stdout; nothing else on stdout.

- Success: `{"ok": {...}}`, exit `0`.
- Failure: `{"error": {"kind", "message", "detail"}}` with a non-zero exit —
  `1` for runtime errors (unreadable input, invalid PDF, rasterization failure,
  query failure), `2` for usage errors (wrong arity, bad page number).
  `detail` carries machine-readable error context when it exists (`max_bytes`,
  `pages`/`max_pages`, `page`/`total_pages`, ...).
- `pdf` success payload:
  `{ "media_type": "image/png", "page", "total_pages", "width", "height", "data_base64" }`.
- `sqlite` success payload: `{ "text": "..." }` — the deterministic table
  rendering with pagination hints, exactly as the omp tools produce.

## Bounds (identical to the omp2 source of truth)

| Bound | `pdf` | `sqlite` |
| --- | --- | --- |
| Input size | ≤ 20 MiB | opened read-only |
| Pages / limits | ≤ 2000 pages; ≤ 1,500,000 px; ≤ 1568 px edge; ≤ 8 MiB PNG | ≤ 1000 raw rows; ≤ 500 query limit; ≤ 50000 row-count probe |
| Mutability | none | read-only (`SQLITE_OPEN_READ_ONLY` + `query_only`), WAL handled |

## Exit codes

- `0`: success (JSON `ok` payload the ONLY stdout).
- `1`: runtime error (JSON `error` payload on stdout).
- `2`: usage error (JSON `error` payload on stdout).
- `125`: reserved (unused).

## Stderr

Diagnostics and the `usage:` line on arity errors go to stderr only; stdout
carries exclusively the JSON contract.

## Platform

Release build via `cargo build --release` in `native/dsh-omp-native/`; the
binary is statically self-contained for the host (bundled SQLite, pure-Rust
hayro PDF renderer). macOS/Windows/Linux artifacts live under
`target/release/dsh-omp-native[.exe]`. Consumers locate it via
`DSH_OMP_NATIVE_PATH` or the repo-relative default
`native/dsh-omp-native/target/release/dsh-omp-native`.
