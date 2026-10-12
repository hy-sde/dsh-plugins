# Third-party notices for dsh-tool-tsfork

This package (`@hy-sde-org/dsh-tool-tsfork`, MIT — see LICENSE) contains **no
third-party source code**. The heavy lifting is done by an external compiler
binary that the deployer builds and parks on the host; it is **not
distributed** with this package. For completeness, the provenance of that
binary:

## tsfork compiler binary (`tsc`, TS 7.1.0-dev)

- **Upstream project:** [can1357/TypeScript](https://github.com/can1357/TypeScript)
  — a Go-native rewrite of TypeScript; binary built from the
  `perf/checker-speedups-v3` branch (see the parked `VERSION` stamp for the
  exact commit and toolchain).
- **Lineage:** a fork of [microsoft/TypeScript](https://github.com/microsoft/TypeScript).
  The original TypeScript implementation is:
  > TypeScript — Copyright (c) Microsoft Corporation. Licensed under the
  > Apache License, Version 2.0 — <https://www.apache.org/licenses/LICENSE-2.0>
- **Fork license:** the Go rewrite and the perf branches carry the upstream
  project's licensing as published in that repository; consult its `LICENSE`
  and notices for the authoritative text. No portion of it is vendored here.
- **What this package contributes:** original MIT-licensed plugin code that
  spawns the binary once per call (`tsc -b`, default output), parses
  diagnostics, and exposes two device tools on the DeepSeek Harness.

## DeepSeek Harness

Developed against the DeepSeek Harness
([fork](https://github.com/hy-sde/deepseek-harness), upstream
`deepseek-ai/deepseek-harness`). The harness remains the property of its own
project; this package is an independent installable plugin.
