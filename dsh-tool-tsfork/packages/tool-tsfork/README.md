# @hy-sde-org/dsh-tool-tsfork

Model-facing **tsfork devices** for DeepSeek Harness: `tsfork_status` and
`tsfork_check`, driving a parked **Go-native TypeScript compiler** (the
[can1357/TypeScript](https://github.com/can1357/TypeScript) perf fork,
`perf/checker-speedups-v3`, TS `7.1.0-dev`) as one-shot `-b` project-graph
checks with parsed diagnostics, wall time, and a GOMAXPROCS cap.

Decision-experiment numbers behind this plugin (2026-10-11, on the fork
harness's own 337-project host graph, noEmit):

| run | stock typescript@6.0.3 | tsfork Go 7.1.0-dev |
|---|---|---|
| cold `tsc -b tsconfig.host.json` | 54.25s wall / 91.6s user | 7.05s wall / 27.0s user (**7.7×**) |
| warm | 0.65s | 0.56s |

Graph listings (`--dry`) and error output are **byte-identical** (14/14 planted
errors, deterministic). CPU work is 3.4× less — the cache-insensitive floor.

## Devices

- **`tsfork_status`** (zero params) — resolved binary, `--version` probe, build
  stamp (`<binaryDir>/VERSION`).
- **`tsfork_check`** — `tsc -b <project>` (or `-p` fixture checks via `args`),
  returning `exitCode`, `wallMs`, `errorCount`/`warningCount`, parsed
  `diagnostics` (`file:line:col TSxxxx`), an `outputTail`, and a reproducible
  `command`. `dry: true` prepends `--dry` (cheap graph-coverage probe).

The plugin registers a `tsfork:tools` system-prompt section documenting the
buildinfo gotcha and the adoption boundary (below).

## Install (fleet flow)

```sh
# 1. park a compiler binary (or point `binary` at your own):
#    inside a checkout of the fork's tsc/ dir: go build -o ~/.dsh/tsfork/tsc ./cmd/tsc
#    (the tree ships generated files; no generate step needed)

# 2. wire into the profile (absolute file: path — the anchorPathSpec only
#    rewrites ./ ../ file: link: specs):
cd ~/.dsh/profiles/web
pnpm add file:/Users/hui/Documents/github/dsh-plugins/dsh-tool-tsfork/packages/tool-tsfork

# 3. add '@hy-sde-org/dsh-tool-tsfork' to dsh.profile.bundles in package.json
#    (the package's own cordis.patch.yml mounts row `hy-sde-tsfork`)
```

Per-deployment config rides the row (`binary`, `defaultProject`, `defaultCwd`,
`timeoutMs`, `gomaxprocs`, `maxOutputBytes`) — patch `hy-sde-tsfork` by id.

## Gotchas

- **`.tsbuildinfo` is compiler-version-tagged** — alternating `tsfork_check`
  with the repo's stock `tsc -b` invalidates the other side's incremental
  caches; runs go cold. The prompt section warns agents.
- **GOMAXPROCS** defaults to 4 (row config) to avoid oversubscribing a shared
  box across concurrent lanes; override per call.
- **Adoption boundary:** tsfork does NOT replace the pinned toolchain —
  oxlint `typeAware` and the typert generator need the JS API
  (`typescript@6.0.3`; TS 7's npm package is a launcher shim with no
  `lib/typescript.js`). Promotion path (if the trial proves out) is a
  `pnpm` override of the gate binary, not this plugin.

## Development

```sh
pnpm install && pnpm build && pnpm check && pnpm test
```

Integration tests auto-skip when `~/.dsh/tsfork/tsc` is absent.

## License

MIT
