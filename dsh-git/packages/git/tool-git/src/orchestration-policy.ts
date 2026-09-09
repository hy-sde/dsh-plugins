/**
 * Minimal local stand-in for the unpublished `@deepseek-ai/dsh-orchestration-policy`
 * package.
 *
 * The real package exists only inside the DeepSeek Harness fork and is NOT
 * published to npm (404), so the standalone cannot declare it. This module
 * carries the narrow surface this plugin consumes — the `orchestrationPolicy`
 * service shape (`config.enabled` / `config.reviewGate`), `resolvePosture`,
 * and the review-gate config types — with behavior ported from the fork. A
 * host that installs the real package still provides the same service shape,
 * and the tool resolves it opportunistically via `ctx.get('orchestrationPolicy')`.
 * @module @hy-sde-org/dsh-tool-git/orchestration-policy
 */

import { Service, type Context } from '@deepseek-ai/cordis'

/** Push-posture values recognized by the review gate. */
export type PushPosture = 'review-gated' | 'fast'

/** The P2 same-quality gate: no unreviewed change leaves the repo under a gated posture. */
export interface ReviewGateConfig {
  /** Gate active whenever the policy is enabled; explicitly `false` exits it (default: active). */
  enabled?: boolean
  /** Standing posture for repositories without an explicit entry (default `review-gated`). */
  default?: PushPosture
  /** Explicit standing posture per repository-root prefix (`*` = global default; longest prefix wins). */
  posture?: Record<string, PushPosture>
  /** Only this verdict releases a push (default `ship`). */
  requireVerdict?: 'ship'
  /** `block` (fail-closed, default) or `warn` (loud degrade) when no current `ship` verdict exists. */
  onUnavailable?: 'block' | 'warn'
}

/** Fully-resolved review-gate config (every knob present). */
export interface ResolvedReviewGateConfig {
  enabled: boolean
  default: PushPosture
  posture: Record<string, PushPosture>
  requireVerdict: 'ship'
  onUnavailable: 'block' | 'warn'
}

/** Policy config accepted by the service plugin (narrowed surface). */
export interface OrchestrationPolicyConfig {
  /** Master switch (default false). */
  enabled?: boolean
  /** Same-quality gate on `commit_apply --push` (see {@link ReviewGateConfig}). */
  reviewGate?: ReviewGateConfig
}

/** Resolved policy config: everything this plugin reads, with defaults filled. */
export interface ResolvedPolicyConfig extends OrchestrationPolicyConfig {
  enabled: boolean
  reviewGate: ResolvedReviewGateConfig
}

const PUSH_POSTURES = ['review-gated', 'fast'] as const
const GATE_UNAVAILABLE_MODES = ['block', 'warn'] as const

/** The schema-default review gate (mirrors the fork's `defaultReviewGate`). */
function defaultReviewGate(): ResolvedReviewGateConfig {
  return {
    enabled: true,
    default: 'review-gated',
    posture: {},
    requireVerdict: 'ship',
    onUnavailable: 'block',
  }
}

/** Resolve policy config: fill defaults and validate the review-gate knobs. */
export function resolvePolicyConfig(config: OrchestrationPolicyConfig = {}): ResolvedPolicyConfig {
  let reviewGate = defaultReviewGate()
  if (config.reviewGate !== undefined) {
    const gate = config.reviewGate
    if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) {
      throw new Error('orchestration-policy: `reviewGate` must be an object')
    }
    if (gate.enabled !== undefined && typeof gate.enabled !== 'boolean') {
      throw new Error(`orchestration-policy: \`reviewGate.enabled\` must be a boolean (got ${JSON.stringify(gate.enabled)})`)
    }
    if (gate.default !== undefined && !PUSH_POSTURES.includes(gate.default)) {
      throw new Error(
        `orchestration-policy: \`reviewGate.default\` must be 'review-gated' or 'fast' (got ${JSON.stringify(gate.default)})`,
      )
    }
    const requireVerdict: unknown = gate.requireVerdict
    if (requireVerdict !== undefined && requireVerdict !== 'ship') {
      throw new Error(
        `orchestration-policy: \`reviewGate.requireVerdict\` must be 'ship' (got ${JSON.stringify(gate.requireVerdict)})`,
      )
    }
    if (gate.onUnavailable !== undefined && !GATE_UNAVAILABLE_MODES.includes(gate.onUnavailable)) {
      throw new Error(
        `orchestration-policy: \`reviewGate.onUnavailable\` must be 'block' or 'warn' (got ${JSON.stringify(gate.onUnavailable)})`,
      )
    }
    const posture = { ...gate.posture }
    for (const [key, value] of Object.entries(posture)) {
      if (!PUSH_POSTURES.includes(value)) {
        throw new Error(
          `orchestration-policy: posture for ${JSON.stringify(key)} must be 'review-gated' or 'fast' (got ${JSON.stringify(value)})`,
        )
      }
    }
    reviewGate = {
      enabled: gate.enabled ?? true,
      default: gate.default ?? 'review-gated',
      posture,
      requireVerdict: gate.requireVerdict ?? 'ship',
      onUnavailable: gate.onUnavailable ?? 'block',
    }
  }
  return { enabled: config.enabled ?? false, reviewGate }
}

/**
 * Resolve one repository's standing push posture.
 * @param posture - the configured posture map (`*` = global default).
 * @param repoRoot - absolute repository root (`git rev-parse --show-toplevel`).
 * @param defaultPosture - the configured default for unlisted repositories.
 * @returns the most-specific matching posture: longest matching key prefix wins,
 * then `*`, then `defaultPosture`.
 */
export function resolvePosture(
  posture: Readonly<Record<string, PushPosture>>,
  repoRoot: string,
  defaultPosture: PushPosture,
): PushPosture {
  let best: string | undefined
  for (const key of Object.keys(posture)) {
    if (key === '*') continue
    if (repoRoot.startsWith(key) && (best === undefined || key.length > best.length)) best = key
  }
  if (best !== undefined) return posture[best] as PushPosture
  return posture['*'] ?? defaultPosture
}

/** The optional seam service this plugin reads via `ctx.get('orchestrationPolicy')`. */
export class OrchestrationPolicyService extends Service {
  public readonly config: ResolvedPolicyConfig

  constructor(ctx: Context, config: OrchestrationPolicyConfig = {}) {
    super(ctx, 'orchestrationPolicy')
    this.config = resolvePolicyConfig(config)
  }
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'orchestration-policy'

/**
 * Register the `orchestrationPolicy` service (resolves eagerly so malformed
 * config fails at load, not at first start). No prompt section: the real
 * package registers one, but this stand-in only covers the gate surface.
 * @param ctx - the host or test context.
 * @param config - policy configuration (see {@link OrchestrationPolicyConfig}).
 */
export function apply(ctx: Context, config: OrchestrationPolicyConfig = {}): void {
  new OrchestrationPolicyService(ctx, config)
}

export default { name, apply }
