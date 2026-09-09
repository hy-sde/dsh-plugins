# @hy-sde-org/dsh-av

The host-plane, **read-only** Automic Vault (`av`) CLI wrapper for DeepSeek
Harness: `ctx.av` resolves the `av` executable (config → `DSH_AV_PATH` →
PATH), probes it with `av --version`, and parses the JSON surfaces
`av scan --json`, `av doctor [tool] --json`, `av detectors --json`,
`av hardeners --json`, plus `av list` (secret **names only**). The
model-facing tools in `@hy-sde-org/dsh-tool-av` resolve this exact service.
Ported standalone from the fork-only `@deepseek-ai/dsh-av` — no upstream
harness changes required.

## Executed commands

| Method | CLI invocation | Purpose |
|---|---|---|
| `probe` | `av --version` | reachability + version, never throws |
| `scan` | `av scan --json [detectors…]` | audit the Mac for credential exposures and hazards |
| `doctor` | `av doctor [tool] --json` | verify installed hardening |
| `detectors` | `av detectors --json` | detector catalog (feed `scan` filters) |
| `hardeners` | `av hardeners --json` | hardener catalog with hardened/applicable status |
| `list` | `av list` | saved secret names only |

All commands run through `ctx.subprocess` with bounded stdout/stderr
collection, a wall-clock timeout, and SIGTERM→SIGKILL grace. A non-zero exit
is returned as data on the run; only launch failure, signal kill, or timeout
throws `AvCommandError`.

## Security boundary

Never invoked from this service: `av inject` / `av proxy` / `av save` /
`av harden`. No stored Secret Value ever reaches model context or an argv
here — the value-touching verbs stay human-in-the-loop in a terminal the
user controls. `list` is a hard limit to secret **names**.

## Configuration

| config | env fallback | default | meaning |
|---|---|---|---|
| `avPath` | `DSH_AV_PATH` | `av` (PATH) | executable name or absolute path |
| `timeoutMs` | — | `120000` | per-command wall-clock budget |
| `maxStdoutBytes` | — | `8 MiB` | in-memory cap on collected stdout |
| `maxStderrBytes` | — | `64 KiB` | retained stderr tail |
| `graceMs` | — | `5000` | SIGTERM→SIGKILL grace |

## Install

Service row ships as `cordis.patch.yml` (stock `insert` form); `dsh plugin
add @hy-sde-org/dsh-av @hy-sde-org/dsh-tool-av` inserts it into the profile's
base composition. The tool row mounts at the agent plane from the ready-made
preset in `examples/agent-preset/`.

```bash
pnpm --filter @hy-sde-org/dsh-av test    # fake-av-CLI service tests
pnpm --filter @hy-sde-org/dsh-av build   # tsc -> dist
```
