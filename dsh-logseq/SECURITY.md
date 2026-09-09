# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-logseq-graph` and `@hy-sde-org/dsh-tool-logseq` drive the
  installed `logseq` CLI through Node's `child_process.execFile` (`windowsHide`,
  fixed `timeout`/`maxBuffer` caps). No network listener is opened; the only
  outbound surface is the CLI subprocess the user already has on PATH (or
  `cliPath`). Arguments are passed as an argv array, never through a shell
  string, so CLI flags cannot be shell-injected.
- The `logseq` CLI itself performs the graph reads/writes (including any
  Datalog query the model or user supplies); treat prompt-derived query text
  as untrusted and keep the graph scoped to a dedicated `--graph <name>` if
  untrusted sessions share the host.
- Both packages ship an invariant companion (`*/invariant`) that probes the
  CLI at boot; the companion only checks `--version` and refuses to install
  when the binary is missing. It never runs graph operations.
