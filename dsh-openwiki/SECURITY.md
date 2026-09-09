# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-openwiki` (the engine) accesses repository content through
  the `WikiFs` seam only: `ls`/`readRaw`/`write`/`edit`/`delete` under the
  target Git repository root, with root containment enforced at the seam
  (paths are normalized to virtual POSIX `/openwiki/...` and cannot escape the
  repo). `git rev-parse --show-toplevel` resolution is capped with a timeout;
  the only external process the engine spawns is `git`, never a shell.
- `@hy-sde-org/dsh-tool-openwiki` registers the five lifecycle tools with the
  host `ctx.tools` registry; it opens no network listener and contacts no
  remote service. Generated wiki content is ordinary Markdown and JSON
  sidecars written into the target repository.
- Claims carry repository evidence URIs (`repo://path#L#-L#` or file paths)
  resolved through the WikiFs seam — evidence cannot point outside the
  repository root.
