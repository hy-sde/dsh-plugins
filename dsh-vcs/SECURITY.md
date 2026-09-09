# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-vcs` is a **read-only** VCS surface: it never mutates a
  repository (no commits, no staging, no ref writes). Every verb renders
  existing state through the user-installed `pi-vcs` CLI.
- No command is shell-interpreted: argv is passed verbatim through the
  `ctx.subprocess` seam (bounded stdout/stderr collection, wall-clock
  timeout, SIGTERM→SIGKILL grace).
- The `pi-vcs` binary is resolved config-first (`vcsPath` → `DSH_VCS_PATH` →
  PATH) and feature-detected via `probe()`; when it is unreachable the
  service reports `available: false` and callers degrade to the git service
  (`ctx.git`). All effects stay within the discovery/read slice.
- The `./service` and `./types` subpath entries expose no privileged
  operations; `watch` runs a long-lived JSON-lines companion whose disposer
  terminates the process tree.
