# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `dsh-omp-native` is a **read-only** sidecar: it never writes to disk beyond
  its own stdout, opens SQLite with `SQLITE_OPEN_READ_ONLY` plus progress
  interrupts and WAL, and enforces the same ceilings as the omp² `read` tool
  (20 MiB in, 2000 pages, 1.5M pixels/page, 8 MiB out).
- PDF rendering runs arbitrary document structure through `hayro`; the
  bounded page/pixel ceilings are what keep hostile documents from exhausting
  memory.
- The harness integration gates every invocation by file extension + magic
  bytes; this crate itself has no network surface.
