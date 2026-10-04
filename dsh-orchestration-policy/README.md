<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-orchestration-policy`](https://www.npmjs.com/package/@hy-sde-org/dsh-orchestration-policy)
<!-- MIRROR-NOTE:END -->

# dsh-orchestration-policy — parallelize-by-default policy for DeepSeek Harness

A standalone public package: **`@hy-sde-org/dsh-orchestration-policy`** — the
parallelize-by-default orchestration policy layer for DeepSeek Harness:
config-driven fan-out rules, the fail-closed task-isolation guard, review-gate
posture resolution, and the `orchestration:policy` system-prompt section
([firstmate](https://github.com/kunchenguid/firstmate) dispatch-profile shape), rendered from the same resolved config that
drives the guards so text and enforcement cannot drift.

> **Conceptually inspired by
> [firstmate](https://github.com/kunchenguid/firstmate)** (MIT, © 2026 Kun Chen) —
> its dispatch-profile and precedence concepts. No firstmate code is included.
>
> What changed on the port from the fork (`packages/orchestration/policy`,
> never published to npm):
>
> - `tests/policy.spec.ts` is a faithful port of the fork's unit suite; the
>   standalone adds `tests/wave.e2e.spec.ts`, which exercises wave fan-out and
>   the fail-closed isolation guard over a real temporary git repository.
> - firstmate contributes the dispatch-profile shape and precedence concepts
>   only — the config knobs, the fail-closed `OrchestrationPolicyService`
>   isolation guard, review-gate posture resolution, and the
>   outcomes-not-mechanics reporting rules are the fork's own surface.
> - The `orchestration:policy` prompt section renders from the *same resolved
>   config* that arms the guard, so prompt text and enforcement cannot drift.

## Why

`@deepseek-ai/dsh-orchestration-policy` was a fork-only package that was
never published to npm — until this standalone existed, consumers had to copy
`src/index.ts` by hand (the standalone `dsh-git` repo vendors exactly such a
local stand-in). This package publishes that policy layer so any official
DeepSeek Harness installation can opt into parallelize-by-default with an
ordinary npm install.

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- peers `@deepseek-ai/cordis` `~4.0.4` and `@deepseek-ai/dsh-system-prompt`
  `^0.2.0-rc.2` (both published) — npm resolves them on install.

## Install

```bash
pnpm add @hy-sde-org/dsh-orchestration-policy
# or: npm install @hy-sde-org/dsh-orchestration-policy
```

## Verify

Library contract, not a mounted row — `pnpm -r test` runs the policy unit
tests (`tests/policy.spec.ts`, the faithful port of the fork's unit suite)
and the wave E2E (`tests/wave.e2e.spec.ts`, fan-out + fail-closed guard over
a real temp git repository); see Development. `pnpm pack` runs the normal
`prepack` build and yields a tarball containing `dist/` — the sanity check
that the package is publishable.

No `dsh` routes apply: no bundle row ships, so there is nothing to check
with `dsh web --dump-config` and `dsh plugin add` is not an install path —
the deployment authors the row itself (see Use).

## Uninstall

Remove the `@hy-sde-org/dsh-orchestration-policy` row from the composition
(or set its `enabled` to `false`) — the policy is INERT unless
`enabled: true`, so the isolation guard and the prompt section disarm with
the row — then `pnpm remove @hy-sde-org/dsh-orchestration-policy` from the
host project. No `dsh plugin remove` route applies: no bundle row ships.

## Use

```ts
import { resolvePolicyConfig, resolvePosture, OrchestrationPolicyService } from '@hy-sde-org/dsh-orchestration-policy'

const config = resolvePolicyConfig({ enabled: true, maxFanOut: 3 })
const posture = resolvePosture({ '/trusted': 'fast' }, repoRoot, config.reviewGate.default)
```

Mount next to `@deepseek-ai/dsh-tool-subagent` and the `worktree` tool
(`@hy-sde-org/dsh-tool-git`) when a deployment wants parallelize-by-default:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-git'
- name: '@hy-sde-org/dsh-tool-git'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@hy-sde-org/dsh-orchestration-policy'
  config:
    enabled: true
```

Every knob is optional and the policy is INERT until `enabled: true`.
Malformed configuration is an actionable error at LOAD, never a silent
fallback. See `packages/orchestration-policy/README.md` for the full config
table, guard semantics matrix, and section template.

## Development

```bash
pnpm install
pnpm -r check       # strict typecheck (src + tests)
pnpm -r test        # policy unit tests + wave E2E
pnpm -r build       # tsc -> dist
bash scripts/release-public.sh --check      # pre-publish validation
bash scripts/release-public.sh --publish    # publish to npm
```

## Layout

```
packages/orchestration-policy/   @hy-sde-org/dsh-orchestration-policy
  src/index.ts                   config resolution, guard service, posture
                                 resolution, prompt section, reporting rules
  tests/policy.spec.ts           faithful port of the fork's unit suite
  tests/wave.e2e.spec.ts         wave fan-out + fail-closed guard over a real
                                 temp git repository
```

## License and attribution

This repo is licensed MIT — see [LICENSE](LICENSE) (© 2026 hy-sde). The
policy layer — `resolvePolicyConfig` config resolution with actionable
load-time errors, the fail-closed `OrchestrationPolicyService.assertWorkspace`
isolation guard, `resolvePosture` review-gate posture resolution, the
`orchestration:policy` system-prompt section, and the outcomes-not-mechanics
reporting rules — is derived from the DeepSeek Harness codebase (MIT,
© 2026 DeepSeek), from the fork's `packages/orchestration/policy`; the
provenance is aggregated in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
[firstmate](https://github.com/kunchenguid/firstmate) (MIT, © 2026 Kun Chen)
inspired the dispatch-profile shape and precedence concepts — no firstmate
code is included. This is a separately installable package; the harness
remains the property of its own project.
