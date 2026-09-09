# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-fs-archive` is a pure computation library: opening an
  archive does not execute any member code, and all reads are bounded by
  `ArchiveLimits` (entry count, index size, in-memory size, member size, path
  bytes, link depth) so attacker-controlled archives cannot drive unbounded
  allocation. Member decompression runs under Node's built-in codecs only.
- The `read` tool integration in the harness adds a `readMaxArchiveBytes` cap
  (default 256 MiB); this package itself exposes the bounded `openArchive`
  surface and never writes to the filesystem.
- The `./invariant` entry only registers a no-op invariant with the host's
  `ctx.invariants` service; it performs no I/O on its own.
