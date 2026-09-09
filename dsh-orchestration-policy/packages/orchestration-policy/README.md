# @hy-sde-org/dsh-orchestration-policy

Parallelize-by-default orchestration policy for DeepSeek Harness:
config-driven fan-out rules, a fail-closed task-isolation guard, review-gate
posture resolution, and the rendered `orchestration:policy` system-prompt
section ([firstmate](https://github.com/kunchenguid/firstmate) dispatch-profile shape).

Published standalone as `@hy-sde-org/dsh-orchestration-policy`; it mirrors
`@deepseek-ai/dsh-orchestration-policy` in the
[hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness),
which was never published to npm.

## Summary

When a request decomposes into independent chunks, the agent fans them out as
isolated task children (`worktree acquire --branch` → `subagent { workspace }`)
up to a configured ceiling, and serializes only for a true dependency. The
policy has five parts:

1. **Policy text** — the `orchestration:policy` system-prompt section, rendered
   from the *same config* that arms the guard, so text and enforcement cannot
   drift.
2. **Config knobs** — every knob optional, defaults below. The whole policy is
   **inert unless `enabled: true`**: default OFF keeps today's
   model-discretion behavior byte-stable until a deployment opts in.
3. **Seam guard** — the optional `ctx.orchestrationPolicy` service.
   `tool-subagent` reads it with `ctx.get` (never `inject`), so mounting this
   plugin is the *only* thing that arms enforcement. Under
   `isolation: required` a task child started without an isolated `workspace`
   is **rejected** with an actionable fix message (fail-closed); a provider
   that cannot honor `workspace` degrades to a reported warning, never a
   silent ignore.
4. **Same-quality gate (P2)** — when the policy is enabled, the review gate is
   active too (opt out with `reviewGate.enabled: false`). Under the default
   `review-gated` posture a `commit_apply --push` is **refused until
   `review --target staged` returns `ship` for the exact current staged range**
   (identity = pre-commit HEAD + index tree); `reject` verdicts always block.
   Only an explicit `fast` posture entry skips the gate — never infer trust.
5. **Outcomes-not-mechanics reporting (P3)** — captain-facing prose follows an
   outcome contract (one block per wave; every "needs you" is a decision,
   blocker, credential need, or review-ready result; mechanics vocabulary
   translated or omitted; detail available on request).

## Install

```bash
pnpm add @hy-sde-org/dsh-orchestration-policy
```

Peers: `@deepseek-ai/cordis` `^4.0.2` and `@deepseek-ai/dsh-system-prompt`
`^0.1.2-rc.1` (both published).

Mount next to `@deepseek-ai/dsh-tool-subagent` and the `worktree` tool
(`@hy-sde-org/dsh-tool-git`) in a composition whose deployment wants
parallelize-by-default:

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

## Configuration knobs (all optional)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch: guard and prompt text are inert until `true`. |
| `defaultMode` | `parallel` | Posture for decomposable work: `parallel` (default) or `serial`. |
| `maxFanOut` | `3` | Ceiling on one fan-out wave; beyond it the remainder is a follow-up wave. |
| `isolation` | `required` | `required` = fail-closed isolation; `suggested` = prompt-only. |
| `enforceWorkspace` | `true` | Whether the seam guard enforces isolation when `isolation: required`. |
| `serializeReasons` | all four | Accepted reasons to serialize: `same-file-edit`, `semantic-dependency`, `shared-mutable-state`, `incompatible-concurrency`. |
| `announcePlan` | `true` | Show the captain one plan summary before a wave is dispatched. |
| `reviewGate.enabled` | `active` | The gate is active whenever the policy is enabled; `false` exits it. |
| `reviewGate.default` | `review-gated` | Standing posture for repositories without an explicit entry. |
| `reviewGate.posture` | `{}` | Explicit standing posture per repository-root prefix (`*` = global; longest matching prefix wins). Host-owned config — never repo files. |
| `reviewGate.requireVerdict` | `ship` | The only verdict that releases a push today. |
| `reviewGate.onUnavailable` | `block` | No current `ship` verdict: `block` (fail-closed refusal) or `warn` (loud degrade). A `reject` verdict always blocks in both modes. |
| `scoutPolicy.knowledgeOnly` | the five labels | Intent labels whose output is scout, not PR-shaped (prompt-rendered guidance). |
| `reporting.mode` | `outcomes` | Captain-facing prose follows the outcome contract; `verbose` = today's behavior (debugging). |
| `reporting.includePerTask` | `summary` | Per-task detail in the one-block wave summary: `summary` (one line per task) or `detail` (blocks). |
| `reporting.forbiddenTerms` | the seven terms | Mechanics vocabulary to translate or omit in captain-facing text (default: subagent, workspace, lease, worktree, pool, continuation, provider). |

**Precedence is fixed** ([firstmate](https://github.com/kunchenguid/firstmate) precedence): explicit captain instruction
in the moment > configured rule > configured default > built-in default.
**Malformed configuration fails at LOAD** with an actionable message — never
silently ignored or selected around.

## API

```ts
import {
  resolvePolicyConfig,
  resolvePosture,
  OrchestrationPolicyService,
  OrchestrationPolicyError,
  buildOrchestrationPromptSection,
  buildReportingRules,
  DEFAULT_POLICY_CONFIG,
  SERIALIZE_REASONS,
} from '@hy-sde-org/dsh-orchestration-policy'
```

- `resolvePolicyConfig(config?)` — validate + resolve partial config; throws
  actionable errors on malformed input (never a silent fallback).
- `resolvePosture(posture, repoRoot, defaultPosture)` — most-specific matching
  prefix wins, then `*`, then the default (`review-gated`).
- `OrchestrationPolicyService` — the optional `ctx.orchestrationPolicy`
  service; `assertWorkspace(workspace, providerCanIsolate)` returns a
  warning string when the provider cannot isolate, `undefined` when allowed,
  and throws `OrchestrationPolicyError` when the start violates
  `isolation: required`.
- `buildOrchestrationPromptSection(config)` / `buildReportingRules(config)` —
  the rendered `orchestration:policy` section and P3 reporting rules.
- `name` / `inject` / `apply` — the Cordis plugin surface (default export is
  `{ name, inject, apply }`).

## Guard semantics matrix

| Policy state | Provider can isolate | `workspace` given | Result |
|---|---|---|---|
| not mounted / `enabled: false` | any | any | no-op (today's behavior) |
| `required` + `enforceWorkspace` | yes | no | **throws** `OrchestrationPolicyError` (fix: `worktree acquire` → pass `path`) |
| `required` + `enforceWorkspace` | no | no | **warning string returned** (caller surfaces it in tool output) |
| `required` + `enforceWorkspace` | any | yes | allowed |
| `suggested` or `enforceWorkspace: false` | any | any | no-op (prompt-only guidance) |

The guard sits at the model-facing `tool-subagent` seam (both one-shot and
continuable starts). SDK/ACP/API paths do not go through the tool and never
see the guard.

## Known Limitations and Deferred Work

- **Only the isolation guard is fail-closed.** Classification, fan-out ceiling,
  announce-plan, and steering are prompt-level guidance — there is no
  scheduler daemon.
- **Incapable providers warn, they do not fail.** An out-of-process backend
  degrades to a reported warning; for hard failure, enforce at the
  composition level (`isolation: required` with an in-process provider).
- **Verdicts are in-process.** A host restart clears them, so a gated
  deployment must re-review after a restart before the gate releases a push.
- **Posture is host-owned config.** Per-repository `fast` opt-outs live in the
  policy config row; a repo-writable posture file is an injection surface.
- **Reporting is policy text only.** The outcome contract shapes the
  captain-facing final message; there is no render seam. If debriefs drift,
  tighten `forbiddenTerms` / `includePerTask`.

## License

MIT. Derived from the DeepSeek Harness codebase; see
`THIRD-PARTY-NOTICES.md` for provenance.
