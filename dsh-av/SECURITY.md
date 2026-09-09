# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-av` wraps the external Automic Vault `av` CLI strictly
  read-only through the `ctx.subprocess` seam: scan/doctor/detectors/
  hardeners/list, each with bounded stdout/stderr collection, a wall-clock
  timeout, SIGTERM→SIGKILL grace, and argv that is never shell-interpreted.
  The value-releasing and system-mutating verbs (`av inject` / `av proxy` /
  `av save` / `av harden`) are deliberately NOT part of the service surface —
  they stay human-in-the-loop in a terminal the user controls.
- The `av` executable is resolved from config → `DSH_AV_PATH` → PATH. An
  attacker-controlled executable on PATH could impersonate `av`, so prefer
  an absolute `avPath` when the host environment is untrusted.
- `@hy-sde-org/dsh-tool-av` never returns a Secret Value: `av_list` returns
  names only, and scan/doctor/catalog outputs carry paths, configs, and
  advice. Hardening is reported and proposed (`av harden <tool>` as a
  human-run command), never auto-approved or executed by the agent.
- No local listener or network service is opened; every call is one bounded
  subprocess per read-only query.
