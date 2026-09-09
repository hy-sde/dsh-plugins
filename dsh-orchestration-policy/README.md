# dsh-orchestration-policy — parallelize-by-default policy for DeepSeek Harness

A standalone public package: **`@hy-sde-org/dsh-orchestration-policy`** — the
parallelize-by-default orchestration policy layer for DeepSeek Harness:
config-driven fan-out rules, the fail-closed task-isolation guard, review-gate
posture resolution, and the `orchestration:policy` system-prompt section
([firstmate](https://github.com/kunchenguid/firstmate) dispatch-profile shape), rendered from the same resolved config that
drives the guards so text and enforcement cannot drift.

Published **standalone** because `@deepseek-ai/dsh-orchestration-policy` is a
fork-only package that was never published to npm; until this standalone
existed, consumers had to copy `src/index.ts` by hand (the standalone `dsh-git`
repo vendors exactly such a local stand-in).

**Provenance:** conceptually inspired by
[firstmate](https://github.com/kunchenguid/firstmate) (MIT, © 2026 Kun Chen) —
its dispatch-profile and precedence concepts. No firstmate code is included.

## Install

```bash
pnpm add @hy-sde-org/dsh-orchestration-policy
# or: npm install @hy-sde-org/dsh-orchestration-policy
```

Node `>=22.19.0` — peers are `@deepseek-ai/cordis` and
`@deepseek-ai/dsh-system-prompt` (both published).

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
