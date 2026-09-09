# dsh-tool-subagent-report — child-scoped reporting for continuable subagents

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

## Install

```bash
dsh plugin --profile web add @hy-sde-org/dsh-tool-subagent-report
```

or `npm install @hy-sde-org/dsh-tool-subagent-report` and mount the package's
`cordis.patch.yml` row (`hy-sde-subagent-tool-subagent-report`).

## Development

```bash
pnpm install
pnpm -r check
pnpm -r test
pnpm -r build
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish to npm
```

## Layout

```
packages/tool-subagent-report/   @hy-sde-org/dsh-tool-subagent-report — the plugin
  cordis.patch.yml               the installable harness bundle (one host row)
  src/index.ts                   the child-scope installer + report tool/guidance
  src/report-contract.ts         the fork-only subagent report channel contract
  tests/                         registration/delivery suite + local seam
```
