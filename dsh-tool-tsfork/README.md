<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-tool-tsfork`](https://www.npmjs.com/package/@hy-sde-org/dsh-tool-tsfork)
<!-- MIRROR-NOTE:END -->

# dsh-tool-tsfork — Go-native TypeScript compiler devices for DeepSeek Harness

A standalone package, installable as **one plugin** (two device tools) for the
DeepSeek Harness: model-facing devices over a **parked Go-native TypeScript
compiler** — the [can1357/TypeScript](https://github.com/can1357/TypeScript)
perf fork (`perf/checker-speedups-v3`, TS `7.1.0-dev`). `tsfork_status`
reports the binary, version banner and build stamp; `tsfork_check` runs
one-shot `-b` project-graph checks with parsed diagnostics, wall time, and a
GOMAXPROCS cap. The compiler binary is built once and parked on the host; the
plugin only speaks the harness device seam — zero upstream harness changes.

| Identity | Value |
| --- | --- |
| Package | `@hy-sde-org/dsh-tool-tsfork` |
| Plugin id | `hy-sde-tsfork` |
| Devices | `tsfork_status` · `tsfork_check` (device-catalog tools via `dyn`) |

> **Based on [can1357/TypeScript](https://github.com/can1357/TypeScript)**
> (`perf/checker-speedups-v3`, a Go rewrite of
> [microsoft/TypeScript](https://github.com/microsoft/TypeScript), Apache-2.0
> lineage): no compiler code is ported or modified — this package is original
> plugin code that spawns the binary once per call over a stable CLI contract
> (`tsc -b`, JSON-free default output). Adapted, not ported: the harness
> device seam (`device: true` tools via `ctx.tools` + `ctx.systemPrompt`)
> exists so a deployment can expose a fast compiler without touching the
> repo's pinned toolchain. See
> [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Why

The type gate on a large workspace is the stock `tsc -b` over the whole
solution graph — on the fork harness's 337-project host graph that was
**54.25s cold** (91.6s CPU, 4.6GB peak), and every agent that wants a
typecheck pays it serially. The Go compiler checks the same graph
byte-identically (project listings, 14/14 planted errors, deterministic
output) in **7.05s cold / ~0.6s warm** — 7.7× less wall time, 3.4× less CPU.
But nothing in a harness exposes it: gates run through `pnpm` scripts pinned
to `typescript@6.0.3`, and a plugin cannot replace a repo's own toolchain —
nor should it, because oxlint `typeAware` and the typert generator need the
JS API that TS 7 (a Go binary) does not ship. What agents need is a *device*
pointing at a parked binary: loadable per deployment, unloadable by toggling
one row, structured output, no PATH tricks, no upstream changes — while the
pinned toolchain stays exactly as pinned.

## Prerequisites

- Node.js **22.19 or newer** (the package's `engines` floor) with pnpm on `PATH`;
- a DeepSeek Harness installation with the device catalog (the package's peer
  baseline is `@deepseek-ai/cordis ~4.0.5-alpha.1`,
  `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-system-prompt`
  `^0.2.1-alpha.2`; registries without the device concept simply present the
  tools eagerly);
- a tsfork compiler binary parked on the host (default `~/.dsh/tsfork/tsc`)
  with a `VERSION` stamp beside it — build it once from a checkout of the
  fork:

  ```bash
  git clone https://github.com/can1357/TypeScript.ts.git typescript.ts   # or your fork
  cd typescript.ts && git checkout perf/checker-speedups-v3
  go build -o ~/.dsh/tsfork/tsc ./cmd/tsc        # inside the tsc/ dir of the checkout
  printf 'source: can1357/TypeScript perf/checker-speedups-v3 @ <commit>\n' > ~/.dsh/tsfork/VERSION
  ```

  (the Go tree ships its generated files — no generate step; Go 1.27+)

## Quick start

### Route A — published npm package (recommended)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-tool-tsfork
```

> Publishing after the Shape-A trial — until then use Route B.

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins/dsh-tool-tsfork/packages/tool-tsfork
pnpm install
PACKAGE_TARBALL="$(pnpm pack | tail -n 1)"
dsh plugin --profile web add "$PWD/$PACKAGE_TARBALL"
cd ../../../..
```

Deployment variant used for the trial (no `dsh` CLI on PATH, hand-managed
profile): link the built package into the profile with an absolute `file:`
path — `pnpm add file:<abs-path-to-package>` in the profile dir, then add
`@hy-sde-org/dsh-tool-tsfork` to `dsh.profile.bundles`. The package's own
`dsh.bundle.patch` mounts the `hy-sde-tsfork` row.

### Verify the composed configuration

```bash
dsh web --dump-config
```

### Run

Start the harness (`dsh web`) and ask the agent to check or probe a graph.
The model-facing calls (device catalog — `dyn search tsfork`):

- `tsfork_status` (no arguments) — resolved binary, `Version 7.1.0-dev`
  banner, build stamp from `<binaryDir>/VERSION`, 20s health probe.
- `tsfork_check` — `tsc -b <project>`; returns `exitCode`, `wallMs`,
  `errorCount`/`warningCount`, parsed `diagnostics` (`file:line:col TSxxxx`),
  an `outputTail`, and a reproducible `command`. `dry: true` prepends
  `--dry` (list the projects a build would run, without building). Pass
  `cwd` (and `project`) explicitly outside the deployment's default checkout.

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-tool-tsfork
```

## What the bundle does

The plugin's `cordis.patch.yml` mounts **one plain agent-plane row**
(`hy-sde-tsfork`) that consumes the deployment's host services — `tools` and
`systemPrompt` (the stock agent bundle provides both). No service, realm, or
filesystem seam of its own: each call spawns the parked compiler once, so
concurrent agent lanes are isolated by construction and the only shared-box
knob is GOMAXPROCS. It also registers the `tsfork:tools` prompt section,
which documents the buildinfo gotcha and the adoption boundary to every
session that mounts the device.

## Engine behavior

- **One-shot spawn, stdin closed.** Every call is `spawn(binary, argv)` with
  `stdio: ['ignore', 'pipe', 'pipe']` — the compiler never reads stdin, and
  a held-open pipe is the classic CLI-wrapper hang.
- **Flag order.** The Go parser requires `-b`/`--build` to precede the
  project path; post-project flags (`--dry`, …) are accepted after it. A
  bare `tsc <tsconfig>` (no `-b`) fails with TS5112 — the plugin always
  sends `-b` first.
- **Timeout semantics.** SIGTERM at `timeoutMs`, SIGKILL 5s later — the
  escalation is scheduled *by* the timeout, never at spawn. A timed-out run
  resolves with `timedOut: true` and the partial output instead of rejecting.
- **Output caps.** stdout/stderr are captured up to `maxOutputBytes` per
  side (default 4 MiB, flagged `outputTruncated`); diagnostics are capped at
  500 with exact counts kept beyond the cap (`diagnosticsTruncated`).
- **`.tsbuildinfo` is compiler-version-tagged.** Alternating `tsfork_check`
  with the repo's stock `tsc -b` invalidates the other side's incremental
  caches — runs go cold. The prompt section warns agents; pick a primary
  and accept the other side paying one cold run.
- **Adoption boundary.** tsfork does not replace the pinned `typescript@6.0.3`
  toolchain: oxlint `typeAware` and typert need the JS API (TS 7's npm
  package is a launcher shim with no `lib/typescript.js`). Promotion, if the
  trial proves out, is a `pnpm` override of the gate binary — not this
  plugin.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `binary` | `~/.dsh/tsfork/tsc` | Compiler binary (expandable `~`), must be executable |
| `defaultProject` | — | `-b` project used when a call omits `project` |
| `defaultCwd` | — | Working directory used when a call omits `cwd` |
| `timeoutMs` | `900000` | Per-call process timeout |
| `gomaxprocs` | — | `GOMAXPROCS` written to the child env (lane-friendly parallelism cap) |
| `maxOutputBytes` | `4000000` | Cap on captured stdout/stderr bytes per side |

```yaml
- id: hy-sde-tsfork
  config:
    binary: ~/.dsh/tsfork/tsc
    defaultProject: tsconfig.host.json
    defaultCwd: /path/to/your/checkout
    timeoutMs: 900000
    gomaxprocs: 4
```

## Errors

| Code | Meaning |
| --- | --- |
| `binary_missing` | No file at the resolved `binary` path |
| `binary_not_executable` | The file exists but lacks the execute bit |
| `project_missing` | No tsconfig at the resolved project path (nor `tsconfig.json` inside a directory) |
| `spawn_failed` | The OS refused the spawn (ENOENT, EACCES) — message carries the errno |
| `timeout` / `timedOut: true` | The run exceeded `timeoutMs`; partial output is returned, not discarded |

Compiler diagnostics themselves are not errors of the plugin — a failing
check is a valid result (`ok: false`, `exitCode` 1/2, parsed diagnostics).

## Privacy and security notes

- **No network.** The plugin spawns a local binary; it sends nothing
  off-host and holds no credentials.
- **No shell layer.** Every input (project, extra args) is its own argv
  element — a hostile string stays inert. `project` must resolve to an
  existing tsconfig (or directory containing one) or the call is rejected.
- **Environment.** The child inherits the host env with at most one
  override (`GOMAXPROCS`); no secrets are added or redacted by the plugin.

## Compatibility

- Node.js ≥ 22.19.0.
- DeepSeek Harness peer range: `@deepseek-ai/cordis ~4.0.5-alpha.1`,
  `@deepseek-ai/dsh-tools ^0.2.1-alpha.2`,
  `@deepseek-ai/dsh-system-prompt ^0.2.1-alpha.2`.
- Seam contract: `device: true` tool registration (`tsfork_status`,
  `tsfork_check`) + a `systemPrompt` section; registries without the device
  concept present the same tools eagerly.

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck (tsc --noEmit)
pnpm -r test       # unit tests + real-binary integration suite (skips without ~/.dsh/tsfork/tsc)
pnpm -r build      # tsc -> dist
```

The integration suite runs the REAL parked compiler against a real temp
fixture project — no engine mocks; it skips cleanly on hosts without the
binary.

## Layout

```
packages/tool-tsfork/   @hy-sde-org/dsh-tool-tsfork — the plugin (both devices)
  cordis.patch.yml      the installable harness bundle (row hy-sde-tsfork)
  src/core.ts           the engine: binary/project resolution, spawn, parse, stamp
  src/tools.ts          the tsfork_status / tsfork_check device bodies
  src/prompt.ts         the tsfork:tools system-prompt section
```

## License and attribution

This package is licensed MIT — see [LICENSE](LICENSE). It contains no
compiler source: the tsfork binary is built by the deployer from
[can1357/TypeScript](https://github.com/can1357/TypeScript)
(`perf/checker-speedups-v3`), a Go rewrite of
[microsoft/TypeScript](https://github.com/microsoft/TypeScript) (Apache
License 2.0, © Microsoft and upstream contributors; fork changes © the fork
authors). Provenance and the full attribution live in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The harness remains the
property of its own project.
