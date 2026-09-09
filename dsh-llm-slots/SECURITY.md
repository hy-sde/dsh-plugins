# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `@hy-sde-org/dsh-llm-slots` is an event-bus listener: it delays model calls
  in a host-wide FIFO budget and performs no I/O of its own. A call waiting
  for a slot observes its caller's AbortSignal, so cancellation during
  admission surfaces as an AbortError instead of leaking a slot.
- The `./invariant` entry registers package-owned admission-accounting checks
  with the host's `ctx.invariants` service; it performs no I/O on its own.
