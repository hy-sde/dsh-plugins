# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-tool-codebase-memory` drives the installed
  `codebase-memory-mcp` CLI through Node's `child_process.execFile`
  (`windowsHide`, fixed `timeout`/`maxBuffer` caps). No network listener is
  opened; the only outbound surface is the CLI subprocess the user already has
  on PATH (or `cliPath`). Arguments are passed as an argv array (plus a temp
  `--args-file` holding JSON), never through a shell string, so tool
  arguments cannot be shell-injected.
- The `codebase-memory-mcp` CLI itself performs graph reads/writes (including
  any Cypher query the model or user supplies); treat prompt-derived query
  text as untrusted and keep the graph scoped to indexing only repositories
  the host already trusts.
- The package ships an invariant companion (`invariant`) that probes the CLI
  at boot; the companion only checks `--version` and refuses to install when
  the binary is missing. It never runs graph operations.
- Indexing (`codebase_index_repository`) is an explicit, potentially
  long-running and resource-intensive action exposed to the model; prefer
  `codebase_search_graph`/`codebase_query_graph` on already-indexed projects,
  and use `codebase_delete_project` only for superseded indexes.
