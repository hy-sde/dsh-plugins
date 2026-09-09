# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-zstd-frame` is a pure computation library over `node:zlib`.
  Decompression callers can bound output with the `maxOutput` parameter
  (`maxOutputLength`); the structural scan rejects corrupt frame layout
  without executing any payload code.
- The `./invariant` entry only registers a no-op invariant with the host's
  `ctx.invariants` service; it performs no I/O on its own.
