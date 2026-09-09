# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- The `report` tool is registered ONLY into continuable in-process child
  scopes (`ctx.subagents.registerContinuableSetup`); roots, one-shot children,
  remote providers, and agentless executions never see the registration.
- The tool validates every model-authored report before delivery: a
  `needs-decision`/`blocked` report must carry both a `decisionKey` and a
  `summary`, and an empty report is rejected outright.
- Delivery goes through the host subagent service's own authorization
  boundary (`reportFrom`), which verifies the exact live sender identity and
  rejects forged, root, orphaned, and draining senders with typed errors.
- The package never touches the filesystem, never spawns processes, and
  carries no network surface of its own.
