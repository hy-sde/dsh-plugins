# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `ast_edit` writes files only through the harness filesystem contract
  (`ctx.fs`), which enforces the deployment's sandbox/observation policy when
  mounted; in preview mode (`apply: false`) it touches nothing.
- The packaged ast-grep engine is a native binary that ships inside the
  `@ast-grep/cli` npm dependency. All model input travels as separate argv
  elements — there is no shell layer — so a hostile pattern stays inert.
- The engine reads the deployment's per-project `sgconfig.yml` when present;
  treat workspace files as a trust boundary when running agents on
  untrusted repositories.
- The plugin spawns processes through the harness `ctx.subprocess` seam, so
  the deployment's subprocess policy (timeouts, cancellation, process-tree
  termination) applies to every engine run.
