# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-internal-urls` handles only through the harness seams:
  `ctx.fs` for backing-file reads/writes (so the deployment's sandbox and
  observation policy apply to conflict splices — `conflict://` mutations
  forward the write tool's resolved sandbox policy) and the `ctx.subprocess`
  seam for `gh`/`git` children (unconfined, argv-vector spawns with bounded
  stdout/stderr collection; never shell-interpreted).
- `@hy-sde-org/dsh-tool-fs-internal-urls` /
  `@hy-sde-org/dsh-tool-fs-search-internal-urls` are agent-scope shadows that
  register no new capabilities: plain filesystem paths behave exactly like
  the stock tools, and the internal-URL branches only ever read/write through
  the registry (which routes back through `ctx.fs`).
- Trust boundary: `gh` / `git` are invoked from the deployment host with no
  extra confinement beyond the harness subprocess environment scrubbing;
  treat the developer machine as trusted for GitHub-CLI interactions.
