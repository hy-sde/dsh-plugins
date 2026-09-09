# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-orchestration-policy` is a policy layer: config
  resolution, a fail-closed isolation guard, posture resolution, and rendered
  system-prompt text. It performs no I/O of its own.
- Malformed configuration is an actionable error at LOAD, never a silent
  fallback — `resolvePolicyConfig` rejects unknown serialize reasons, invalid
  isolation modes, and non-positive `maxFanOut` rather than guessing.
- The review gate is fail-closed: under `review-gated` posture a push is
  refused without a current `ship` verdict, and a `reject` verdict always
  blocks even under `onUnavailable: warn`. Per-repository posture is
  host-owned config only — a repo-writable posture file would be an injection
  surface and is not supported.
- The task-isolation guard is fail-closed under `isolation: required`: a
  start without an isolated `workspace` is rejected, while a provider that
  cannot honor `workspace` degrades to a REPORTED warning, never a silent
  ignore.
