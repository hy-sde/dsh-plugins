# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-session-intelligence` is a port of agentsview's
  `internal/signals` engine (MIT — see [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)). It
  reads session logs from the harness sessions directory and derives health
  signals (outcome classification, grades, tool-health, context-pressure) in
  process — it opens no network listener and contacts no remote service.
- The engine is read-only with respect to sessions: it never rewrites a
  session log, and it reports classifications/derived signals only.
- If a session log is corrupted or oversized, the engine degrades to
  `unknown`/`errored` with a clear reason rather than throwing into the
  caller — treat derived signals as diagnostics, not ground truth.
