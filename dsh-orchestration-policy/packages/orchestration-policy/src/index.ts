/**
 * Parallelize-by-default orchestration policy (P1 of the firstmate port).
 *
 * The policy layer is three parts, matching `firstmate-policy-scope.md` §1:
 * 1. **Policy text** — the `orchestration:policy` system-prompt section,
 *    rendered from the same config that drives the guards, so text and
 *    enforcement can't drift.
 * 2. **Config knobs** — the plugin's `cordis.yml` config row (schema-defaulted
 *    below; every knob is optional). The whole policy is INERT unless
 *    `enabled: true`: default OFF keeps today's model-discretion behavior
 *    byte-stable until a deployment opts in.
 * 3. **Seam guard** — the optional `ctx.orchestrationPolicy` service. Absent
 *    service = no guard (tool-subagent checks it with `ctx.get`, not inject,
 *    so mounting this plugin is the ONLY thing that arms enforcement). A
 *    task child started without an isolated `workspace` under
 *    `isolation: required` is rejected with an actionable fix message
 *    (fail-closed); a provider that cannot honor `workspace` degrades to a
 *    REPORTED warning, never a silent ignore.
 *
 * Precedence is fixed (firstmate precedence): explicit captain instruction in
 * the moment > configured rule > configured default > built-in default.
 * Malformed configuration is an actionable error, never a silent fallback.
 * @module @hy-sde-org/dsh-orchestration-policy
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** The ONLY accepted reasons to serialize instead of fanning out. */
export const SERIALIZE_REASONS = [
  'same-file-edit',
  'semantic-dependency',
  'shared-mutable-state',
  'incompatible-concurrency',
] as const

export type SerializeReason = typeof SERIALIZE_REASONS[number]

/** Plugin configuration (all optional; defaults in {@link DEFAULT_POLICY_CONFIG}). */
export interface OrchestrationPolicyConfig {
  /** Master switch. The guard and prompt text are inert until true (default false). */
  enabled?: boolean
  /** Default posture for work that decomposes (default `parallel`). */
  defaultMode?: 'parallel' | 'serial'
  /** Ceiling on one fan-out wave; beyond it the remainder is a follow-up wave (default 3). */
  maxFanOut?: number
  /** `required` = fail-closed isolation; `suggested` = prompt-only (default `required`). */
  isolation?: 'required' | 'suggested'
  /** Whether the seam guard enforces isolation when `isolation: required` (default true). */
  enforceWorkspace?: boolean
  /** Accepted serialize reasons; anything else is rejected at load (default: all four). */
  serializeReasons?: SerializeReason[]
  /** Show the captain one plan summary before a wave is dispatched (default true). */
  announcePlan?: boolean
  /** Same-quality gate on `commit_apply --push` (active whenever the policy is enabled; see {@link ReviewGateConfig}). */
  reviewGate?: ReviewGateConfig
  /** Scout classification rule set (prompt-rendered guidance in P2; enforcement stays at the push boundary). */
  scoutPolicy?: ScoutPolicyConfig
  /** P3 outcomes-not-mechanics reporting contract (prompt-rendered; default `outcomes`). */
  reporting?: ReportingConfig
}

/** Push-posture values recognized by the review gate. */
export type PushPosture = 'review-gated' | 'fast'

/** The P2 same-quality gate: no unreviewed change leaves the repo under a gated posture. */
export interface ReviewGateConfig {
  /** Gate active whenever the policy is enabled; explicitly `false` exits it (default: active). */
  enabled?: boolean
  /** Standing posture for repositories without an explicit entry (default `review-gated`). */
  default?: PushPosture
  /**
   * Explicit standing posture per repository-root prefix (`*` = global default;
   * most-specific = longest matching prefix wins). Host-owned config only — a
   * repo-writable posture file is an injection surface.
   */
  posture?: Record<string, PushPosture>
  /** Only this verdict releases a push (default `ship`; today the only accepted value). */
  requireVerdict?: 'ship'
  /**
   * Behavior when there is no current `ship` verdict: `block` (default,
   * fail-closed refusal) or `warn` (degrade with a loud warning). A `reject`
   * verdict always blocks in both modes.
   */
  onUnavailable?: 'block' | 'warn'
}

/** Scout classification: which intents are knowledge-only (never PR-shaped). */
export interface ScoutPolicyConfig {
  /** Intent labels whose output is a scout (prompt-rendered guidance; default the five firstmate labels). */
  knowledgeOnly?: string[]
}

/** P3 outcomes-not-mechanics reporting (prompt contract; rendered from the same config). */
export interface ReportingConfig {
  /** `outcomes` = the captain sees what happened, not how (default); `verbose` = today's behavior, for debugging. */
  mode?: 'outcomes' | 'verbose'
  /** Per-task detail in the one-block wave summary: `summary` (one line per task, default) or `detail`. */
  includePerTask?: 'summary' | 'detail'
  /** Mechanics vocabulary to translate or omit in captain-facing text (default the seven firstmate terms). */
  forbiddenTerms?: string[]
}

/** Fully-resolved reporting config (every knob present). */
export interface ResolvedReportingConfig {
  mode: 'outcomes' | 'verbose'
  includePerTask: 'summary' | 'detail'
  forbiddenTerms: string[]
}

/** The seven firstmate mechanics terms that never appear in captain-facing prose by default. */
export const DEFAULT_FORBIDDEN_TERMS = [
  'subagent',
  'workspace',
  'lease',
  'worktree',
  'pool',
  'continuation',
  'provider',
] as const

/** Fully-resolved review-gate config (every knob present). */
export interface ResolvedReviewGateConfig {
  enabled: boolean
  default: PushPosture
  posture: Record<string, PushPosture>
  requireVerdict: 'ship'
  onUnavailable: 'block' | 'warn'
}

export const DEFAULT_KNOWLEDGE_ONLY = ['investigate', 'diagnose', 'plan', 'audit', 'reproduce'] as const

/** Fully-resolved config (every knob present). */
export interface ResolvedPolicyConfig {
  enabled: boolean
  defaultMode: 'parallel' | 'serial'
  maxFanOut: number
  isolation: 'required' | 'suggested'
  enforceWorkspace: boolean
  serializeReasons: SerializeReason[]
  announcePlan: boolean
  reviewGate: ResolvedReviewGateConfig
  scoutPolicy: { knowledgeOnly: readonly string[] }
  reporting: ResolvedReportingConfig
}

export const DEFAULT_POLICY_CONFIG: ResolvedPolicyConfig = {
  enabled: false,
  defaultMode: 'parallel',
  maxFanOut: 3,
  isolation: 'required',
  enforceWorkspace: true,
  serializeReasons: [...SERIALIZE_REASONS],
  announcePlan: true,
  reviewGate: {
    enabled: true,
    default: 'review-gated',
    posture: {},
    requireVerdict: 'ship',
    onUnavailable: 'block',
  },
  scoutPolicy: { knowledgeOnly: [...DEFAULT_KNOWLEDGE_ONLY] },
  reporting: {
    mode: 'outcomes',
    includePerTask: 'summary',
    forbiddenTerms: [...DEFAULT_FORBIDDEN_TERMS],
  },
}

/** The SCHEMA-DEFAULT review gate, shared by resolution and the service. */
function defaultReviewGate(): ResolvedReviewGateConfig {
  return {
    enabled: true,
    default: 'review-gated',
    posture: {},
    requireVerdict: 'ship',
    onUnavailable: 'block',
  }
}

/** Validate + resolve partial config; malformed input throws an actionable error. */
export function resolvePolicyConfig(config: OrchestrationPolicyConfig = {}): ResolvedPolicyConfig {
  if (config.maxFanOut !== undefined && (!Number.isInteger(config.maxFanOut) || config.maxFanOut < 1)) {
    throw new Error(
      `orchestration-policy: \`maxFanOut\` must be a positive integer (got ${JSON.stringify(config.maxFanOut)})`,
    )
  }
  const ISOLATION_MODES = ['required', 'suggested'] as const
  if (config.isolation !== undefined && !ISOLATION_MODES.includes(config.isolation)) {
    throw new Error(
      `orchestration-policy: \`isolation\` must be 'required' or 'suggested' (got ${JSON.stringify(config.isolation)})`,
    )
  }
  if (config.serializeReasons !== undefined) {
    const unknown = config.serializeReasons.filter(reason => !SERIALIZE_REASONS.includes(reason))
    if (unknown.length > 0) {
      throw new Error(
        `orchestration-policy: unknown serialize reason(s) ${JSON.stringify(unknown)} — accept only `
        + SERIALIZE_REASONS.join(', '),
      )
    }
  }
  let reviewGate = defaultReviewGate()
  if (config.reviewGate !== undefined) {
    const gate = config.reviewGate as ReviewGateConfig | null | undefined
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
      throw new Error(`orchestration-policy: \`reviewGate.requireVerdict\` must be 'ship' (got ${JSON.stringify(gate.requireVerdict)})`)
    }
    if (gate.onUnavailable !== undefined && !GATE_UNAVAILABLE_MODES.includes(gate.onUnavailable)) {
      throw new Error(
        `orchestration-policy: \`reviewGate.onUnavailable\` must be 'block' or 'warn' (got ${JSON.stringify(gate.onUnavailable)})`,
      )
    }
    const posture = { ...gate.posture }
    const postureConfig = gate.posture as Record<string, PushPosture> | null | undefined
    if (postureConfig !== undefined) {
      if (postureConfig === null || typeof postureConfig !== 'object' || Array.isArray(postureConfig)) {
        throw new Error('orchestration-policy: `reviewGate.posture` must be a record of repository prefix \u2192 posture')
      }
      for (const [key, value] of Object.entries(postureConfig)) {
        if (!PUSH_POSTURES.includes(value)) {
          throw new Error(
            `orchestration-policy: posture for ${JSON.stringify(key)} must be 'review-gated' or 'fast' (got ${JSON.stringify(value)})`,
          )
        }
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
  let reporting = defaultReporting()
  if (config.reporting !== undefined) {
    const rep = config.reporting as ReportingConfig | null | undefined
    if (rep === null || typeof rep !== 'object' || Array.isArray(rep)) {
      throw new Error('orchestration-policy: `reporting` must be an object')
    }
    if (rep.mode !== undefined && !REPORTING_MODES.includes(rep.mode)) {
      throw new Error(`orchestration-policy: \`reporting.mode\` must be 'outcomes' or 'verbose' (got ${JSON.stringify(rep.mode)})`)
    }
    if (rep.includePerTask !== undefined && !REPORTING_PER_TASK.includes(rep.includePerTask)) {
      throw new Error(
        `orchestration-policy: \`reporting.includePerTask\` must be 'summary' or 'detail' (got ${JSON.stringify(rep.includePerTask)})`,
      )
    }
    if (rep.forbiddenTerms !== undefined) {
      if (!Array.isArray(rep.forbiddenTerms) || rep.forbiddenTerms.some(term => typeof term !== 'string' || term.length === 0)) {
        throw new Error('orchestration-policy: `reporting.forbiddenTerms` must be an array of non-empty strings')
      }
    }
    reporting = {
      mode: rep.mode ?? 'outcomes',
      includePerTask: rep.includePerTask ?? 'summary',
      forbiddenTerms: rep.forbiddenTerms ?? [...DEFAULT_FORBIDDEN_TERMS],
    }
  }
  let knowledgeOnly: readonly string[] = DEFAULT_KNOWLEDGE_ONLY
  if (config.scoutPolicy !== undefined) {
    const scout = config.scoutPolicy as ScoutPolicyConfig | null | undefined
    if (scout === null || typeof scout !== 'object' || Array.isArray(scout)) {
      throw new Error('orchestration-policy: `scoutPolicy` must be an object')
    }
    if (scout.knowledgeOnly !== undefined) {
      if (!Array.isArray(scout.knowledgeOnly) || scout.knowledgeOnly.some(item => typeof item !== 'string')) {
        throw new Error('orchestration-policy: `scoutPolicy.knowledgeOnly` must be an array of intent labels')
      }
      knowledgeOnly = scout.knowledgeOnly
    }
  }
  return {
    ...DEFAULT_POLICY_CONFIG,
    ...config,
    reviewGate,
    scoutPolicy: { knowledgeOnly },
    reporting,
  }
}

/** The SCHEMA-DEFAULT reporting config, shared by resolution and the service. */
function defaultReporting(): ResolvedReportingConfig {
  return {
    mode: 'outcomes',
    includePerTask: 'summary',
    forbiddenTerms: [...DEFAULT_FORBIDDEN_TERMS],
  }
}

const REPORTING_MODES = ['outcomes', 'verbose'] as const
const REPORTING_PER_TASK = ['summary', 'detail'] as const

const PUSH_POSTURES = ['review-gated', 'fast'] as const
const GATE_UNAVAILABLE_MODES = ['block', 'warn'] as const

/**
 * Resolve one repository's standing push posture.
 * @param posture - the configured posture map (`*` = global default; empty = all).
 * @param repoRoot - absolute repository root (`git rev-parse --show-toplevel`).
 * @param defaultPosture - the configured default for unlisted repositories.
 * @returns the most-specific matching posture: longest matching key prefix wins,
 *          then `*`, then `defaultPosture`.
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

/** A policy rejection: the fail-closed start that violates `isolation: required`. */
export class OrchestrationPolicyError extends Error {
  override readonly name = 'OrchestrationPolicyError' as const
}

/** The optional seam service tool-subagent reads via `ctx.get('orchestrationPolicy')`. */
export class OrchestrationPolicyService extends Service {
  public readonly config: ResolvedPolicyConfig

  constructor(ctx: Context, config: OrchestrationPolicyConfig = {}) {
    super(ctx, 'orchestrationPolicy')
    this.config = resolvePolicyConfig(config)
  }

  /**
   * Fail-closed isolation check for one delegation start.
   * @param workspace - the start's requested `workspace` (undefined = none).
   * @param providerCanIsolate - whether the provider honors `workspace`.
   * @returns a warning string when the provider cannot isolate (REPORTED, not
   *          silent — callers must surface it), `undefined` when allowed.
   * @throws {@link OrchestrationPolicyError} when the start violates the policy.
   */
  assertWorkspace(workspace: string | undefined, providerCanIsolate: boolean): string | undefined {
    if (!this.config.enabled) return undefined
    if (this.config.isolation !== 'required' || !this.config.enforceWorkspace) return undefined
    if (workspace !== undefined) return undefined
    if (!providerCanIsolate) {
      return 'orchestration-policy: task isolation is required but this subagent provider cannot honor `workspace` — configure an in-process provider or set `isolation: suggested`'
    }
    throw new OrchestrationPolicyError(
      'orchestration-policy requires task isolation: pass the isolated working-copy `path` from `worktree acquire` as the `workspace` argument (or set `isolation: suggested` / `enabled: false` to relax)',
    )
  }
}

const SECTION_NAME = 'orchestration:policy'
const SECTION_ORDER = 129

function reasonText(reasons: readonly SerializeReason[]): string {
  const lines = [
    '- same-file-edit: two chunks edit the same file',
    '- semantic-dependency: one change is an input to the next',
    '- shared-mutable-state: lockfiles, migrations, generated code, credentials',
    '- incompatible-concurrency: both rework the same subsystem in conflicting ways',
  ]
  const kept = reasons.map(reason => lines.find(line => line.startsWith(`- ${reason}:`)) ?? `- ${reason}`)
  return kept.join('\n')
}

/**
 * Build the orchestration policy prompt section from resolved config.
 * @param config - resolved policy configuration.
 * @returns the {@link PromptSection} to register (empty text when disabled).
 */
/**
 * The P3 reporting contract as prompt rules. Empty under `mode: 'verbose'`
 * (today's behavior); otherwise one block: one summary per wave, the
 * needs-you taxonomy, the per-task detail knob, and the forbidden mechanics
 * vocabulary.
 */
export function buildReportingRules(config: ResolvedReportingConfig): string[] {
  if (config.mode !== 'outcomes') return []
  const perTask = config.includePerTask === 'detail'
    ? 'Per-task detail: include a short detail block per task when something needs the captain\u2019s eye.'
    : 'Per-task detail: one line per task in the wave summary (detail stays available on request).'
  const terms = config.forbiddenTerms.length > 0 ? config.forbiddenTerms.join(', ') : 'none by configuration'
  return [
    'Report OUTCOMES, not mechanics: after each wave, give the captain ONE block \u2014 what was decided, what shipped, what is blocked, and what needs the captain.',
    'Every "needs you" item is one of: a decision, a blocker, a credential need, or a review-ready result \u2014 never a child transcript.',
    perTask,
    `Translate or omit mechanics vocabulary in captain-facing text: ${terms}. When the captain asks for details, give them (escrow, don't dump).`,
  ]
}

export function buildOrchestrationPromptSection(config: ResolvedPolicyConfig = DEFAULT_POLICY_CONFIG): PromptSection {
  if (!config.enabled) return { name: SECTION_NAME, order: SECTION_ORDER, text: '' }
  const mode = config.defaultMode === 'parallel'
    ? 'Fan out independent chunks as isolated task children; today\'s serial behavior is the exception.'
    : 'Run work serially unless a chunk is clearly independent — parallel is opt-in.'
  const reasons = reasonText(config.serializeReasons)
  const isolation = config.isolation === 'required'
    ? 'One task = one isolated working copy. A task child MUST be started with `workspace` set to a `worktree acquire` path — the guard rejects a start without one (this is fail-closed, not a preference).'
    : 'Prefer one task = one isolated working copy (`worktree acquire` + `workspace`), but the guard does not enforce it.'
  const plan = config.announcePlan
    ? 'Announce the plan once before dispatch: N isolated tasks, what each owns, expected overlap (rare), who merges. One summary — never per-child chatter in the captain-facing thread.'
    : ''
  const rules: string[] = [
    '1. Classify before doing: independent chunks (different files/subsystems, no shared mutable state, no ordering) or one unit of work.',
    `2. Serialize ONLY for a true dependency — the accepted reasons are:\n${reasons}`,
    '   Same-file edits ALONE are not a reason to serialize: split by intent and merge; a shared-file edit with conflicting intent is `incompatible-concurrency`.',
    `3. Fan out: per chunk \`worktree acquire --branch <task>\` then \`subagent { workspace: <lease path> }\` — parallel, up to ${config.maxFanOut} per wave; beyond that announce the rest as a follow-up wave.`,
    isolation,
    '4. Steer with `send_message` at the nearest step boundary; `interrupt_agent` cancels; `list_agents` shows the fleet. Collect every child before merging; release each lease after its child settles — never `force` a release without the captain\'s explicit word.',
  ]
  const post: string[] = []
  let number = 5
  if (config.reviewGate.enabled) {
    post.push(
      `${number}. Quality gate: under the \`review-gated\` posture (the default for any repository without an explicit \`fast\` entry), a push is REFUSED until \`review --target staged\` returns \`ship\` for the CURRENT staged range — run \`review\` after staging, before \`commit_apply --push\`. Any change after the review makes the verdict stale and a re-review is required; a \`reject\` verdict always blocks (even under \`onUnavailable: warn\`). Only an explicit \`fast\` posture skips the gate — never infer trust.`,
    )
    number += 1
  }
  const reporting = buildReportingRules(config.reporting)
  if (reporting.length > 0) {
    post.push(`${number}. ${reporting[0]}`)
    post.push(...reporting.slice(1))
  }
  post.push(
    `Knowledge-only intents (${config.scoutPolicy.knowledgeOnly.join(', ')}) produce investigation notes, not PR-shaped changes.`,
  )
  const text = [
    '# Orchestration policy (parallelize-by-default)',
    `Goal: same quality, more velocity, less captain cognitive load. ${mode}`,
    '',
    ...rules,
    ...post,
    plan,
  ].filter(Boolean).join('\n')
  return { name: SECTION_NAME, order: SECTION_ORDER, text }
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'orchestration-policy'

/** Services consumed by this plugin (systemPrompt from the host bundle). */
export const inject = ['systemPrompt']

/**
 * Mount the policy: register the service and the prompt section.
 * @param ctx - agent-plane plugin context (injects `systemPrompt`).
 * @param config - plugin configuration (see {@link OrchestrationPolicyConfig}).
 */
export function apply(ctx: Context, config: OrchestrationPolicyConfig = {}): void {
  // Resolve eagerly so malformed config fails at LOAD, not at first start.
  const resolved = resolvePolicyConfig(config)
  new OrchestrationPolicyService(ctx, config)
  ctx.systemPrompt.section(buildOrchestrationPromptSection(resolved))
}

export default { name, inject, apply }
