<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-tool-subagent-report`](https://www.npmjs.com/package/@hy-sde-org/dsh-tool-subagent-report)
<!-- MIRROR-NOTE:END -->

# dsh-tool-subagent-report — child-scoped reporting for continuable subagents for DeepSeek Harness

A standalone package for DeepSeek Harness, installable as **one plugin**:
`report` for continuable in-process subagents plus the prompt guidance that
tells each child to use it.

| package | tool | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-tool-subagent-report` | `report` (child-scoped) | yes |

This is a standalone port of the DeepSeek Harness fork's
`@deepseek-ai/dsh-tool-subagent-report` onto its published peer dependencies.
The package builds and tests against the **published** `@deepseek-ai/*`
packages; the fork-only subagent report channel
(`registerContinuableSetup`/`reportFrom` + the keyed open-decisions ledger)
is declared as a local type contract and supplied at runtime by a subagent
service built from the fork or a standalone port carrying the same channel.

**Provenance:** conceptually inspired by
[firstmate](https://github.com/kunchenguid/firstmate) (MIT, © 2026 Kun Chen) —
its parent-status contract with keyed open decisions. No firstmate code is
included.

## Why

Without a return channel, a parent learns what a child found by scraping
its transcript or parsing its final message — if the child is still parked
there at all. This plugin gives every continuable in-process child a real
`report` tool instead: findings, status, summary, evidence, next steps, and
blockers travel through a typed channel (`registerContinuableSetup` /
`reportFrom`) back to the agent that started it, and keyed open decisions
(`needs-decision` / `blocked` with a `decisionKey`) land in a ledger the
parent can answer rather than being buried in child prose. A `tool:report`
prompt section tells each child to deliver a self-contained answer before
finishing, so the parent never has to re-derive context from a raw
transcript.

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- DeepSeek Harness `0.2.0-rc.2` or newer — the package's `@deepseek-ai/*`
  peer range is `^0.2.0-rc.2` (`@deepseek-ai/cordis`, `dsh-agent`,
  `dsh-llm`, `dsh-subagent`, `dsh-system-prompt`, `dsh-tools`);
- **a subagent service with the fork's report channel**: the published
  `@deepseek-ai/dsh-subagent@0.1.2-rc.1` predates
  `registerContinuableSetup`/`reportFrom`, so on a stock published stack
  the row fails at boot with a missing `registerContinuableSetup` service
  method — supply a subagent service built from the DeepSeek Harness fork
  or a standalone port carrying the same channel. This is the documented
  contract, not a misconfiguration.

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh@0.2.0-rc.2 pnpm
dsh --version
```

## The `report` tool

Every continuable in-process child gets:

- a child-scoped `report` tool (`output`, `status`, `summary`, `evidence`,
  `nextSteps`, `blocker`, `decisionKey`), installing a return channel to the
  agent that started it; and
- a `tool:report` prompt section telling the child to report a self-contained
  answer before finishing and to raise keyed `needs-decision`/`blocked`
  questions the parent must answer.

The tool and its guidance are owned by the child scope: roots, one-shot
children, remote providers, and sibling scopes never see them.

## Quick start

### Route A — published npm package (recommended)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-tool-subagent-report
```

The row is a plain host row (`hy-sde-subagent-tool-subagent-report`);
override it per deployment by patching the row by id — for example
`reportDelivery: quiet` for a parked-parent model. Or install the package
as a plain dependency (`npm install @hy-sde-org/dsh-tool-subagent-report`)
and mount its `cordis.patch.yml` row by hand.

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
cd dsh-tool-subagent-report/packages/tool-subagent-report
PACKAGE_TARBALL="$(pnpm pack --silent)"
dsh plugin --profile web add "$PWD/$PACKAGE_TARBALL"
```

`prepack` rebuilds `dist/`, so the tarball is always current.

### Verify

```bash
dsh web --dump-config
```

The composed tree must show the `hy-sde-subagent-tool-subagent-report` row
loading `@hy-sde-org/dsh-tool-subagent-report`. On a stock published stack
the row instead fails at boot with a missing `registerContinuableSetup`
service method — the documented contract (see
[Prerequisites](#prerequisites)).

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-tool-subagent-report
```

## Development

```bash
pnpm install
pnpm -r check
pnpm -r test
pnpm -r build
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish to npm
```

## License and attribution

This package is licensed MIT — the same license as its upstream DeepSeek
Harness packages (MIT License, © 2026 DeepSeek). The `report` tool and its
guidance are ported from the fork's `@deepseek-ai/dsh-tool-subagent-report`
with the port substrate integrated as peer dependencies, not copied source
— see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Provenance is
conceptually inspired by
[firstmate](https://github.com/kunchenguid/firstmate) (MIT, © 2026 Kun
Chen); no firstmate code is included.

## Layout

```
packages/tool-subagent-report/   @hy-sde-org/dsh-tool-subagent-report — the plugin
  cordis.patch.yml               the installable harness bundle (one host row)
  src/index.ts                   the child-scope installer + report tool/guidance
  src/report-contract.ts         the fork-only subagent report channel contract
  tests/                         registration/delivery suite + local seam
```
