# @hy-sde-org/dsh-tool-subagent-report

The child-scoped `report` tool for continuable in-process subagents on
DeepSeek Harness: it installs a child-scoped `report` tool plus the prompt
guidance that tells the child to use it. The tool and its guidance exist only
inside continuable children — roots, one-shot subagents, remote providers, and
sibling scopes never see them. Accepted reports reach the parent as ordinary
parent messages, framed as `Background subagent <child-id> reported:`.

## Requirements

The package is a thin presentation layer over the subagent service's
**report channel**. The published `@deepseek-ai/dsh-subagent@0.1.2-rc.1`
predates that channel, so the host service must be built from the DeepSeek
Harness fork (or a standalone port carrying `registerContinuableSetup`,
`reportFrom`, and the keyed open-decisions ledger):

- `@deepseek-ai/cordis` `^4.0.2`
- `@deepseek-ai/dsh-agent` `^0.1.2-rc.1`
- `@deepseek-ai/dsh-llm` `^0.1.2-rc.1`
- `@deepseek-ai/dsh-subagent` `^0.1.2-rc.1`
- `@deepseek-ai/dsh-system-prompt` `^0.1.2-rc.1`
- `@deepseek-ai/dsh-tools` `^0.1.2-rc.1`

## Install

```bash
dsh plugin --profile web add @hy-sde-org/dsh-tool-subagent-report
```

The plugin's `cordis.patch.yml` exporter mounts one host row
(`hy-sde-subagent-tool-subagent-report`); `dsh plugin add` reconciles the
profile's bundle list after installation. You can also depend on the package
directly: `npm install @hy-sde-org/dsh-tool-subagent-report`.

## What the row does

- `hy-sde-subagent-tool-subagent-report` — `@hy-sde-org/dsh-tool-subagent-report`,
  registering the child-scoped `report` tool and `tool:report` prompt section
  into every continuable child's unpublished creation context. Default
  delivery is `next-step` (wakes the parent to its nearest step boundary);
  override per deployment with `config.reportDelivery: quiet`.

## Config

| field | values | default |
|---|---|---|
| `reportDelivery` | `quiet` \| `next-step` | `next-step` |

`quiet` adds the framed context without waking a parked parent; `next-step`
wakes it (decision-shaped reports deliver content quietly and coalesce the
wake).

## Development

```bash
pnpm install
pnpm -r check      # strict typecheck (tsc --noEmit)
pnpm -r test       # child-scope registration + delivery suite
pnpm -r build      # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
```

The test suite runs against the published agent-loop stack plus a local seam
implementing the fork report channel; every assertion from the upstream fork
spec is preserved.
