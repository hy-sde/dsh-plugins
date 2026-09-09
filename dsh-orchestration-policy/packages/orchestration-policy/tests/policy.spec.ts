/**
 * Unit tests for the orchestration policy: config resolution (defaults, invalid
 * input as actionable errors), the fail-closed isolation guard (allowed /
 * rejected / degraded-warning / disabled no-op), and the rendered prompt section
 * (driven by the same config the guards use).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import policyPackage, {
  DEFAULT_POLICY_CONFIG,
  OrchestrationPolicyError,
  OrchestrationPolicyService,
  buildOrchestrationPromptSection,
  buildReportingRules,
  resolvePolicyConfig,
  resolvePosture,
} from '../src/index.ts'

describe('resolvePolicyConfig', () => {
  it('defaults to disabled with the documented knobs', () => {
    expect(resolvePolicyConfig()).toEqual(DEFAULT_POLICY_CONFIG)
    expect(DEFAULT_POLICY_CONFIG).toMatchObject({
      enabled: false,
      defaultMode: 'parallel',
      maxFanOut: 3,
      isolation: 'required',
      enforceWorkspace: true,
      announcePlan: true,
    })
    expect(DEFAULT_POLICY_CONFIG.serializeReasons).toHaveLength(4)
  })

  it('resolves partial config over the defaults', () => {
    const resolved = resolvePolicyConfig({ enabled: true, maxFanOut: 3, isolation: 'suggested' })
    expect(resolved).toMatchObject({ enabled: true, maxFanOut: 3, isolation: 'suggested', defaultMode: 'parallel' })
  })

  it('rejects malformed maxFanOut with an actionable message', () => {
    expect(() => resolvePolicyConfig({ maxFanOut: 0 })).toThrow(/maxFanOut.*positive integer/)
    expect(() => resolvePolicyConfig({ maxFanOut: 1.5 })).toThrow(/maxFanOut.*positive integer/)
  })

  it('rejects an unknown isolation mode', () => {
    expect(() => resolvePolicyConfig({ isolation: 'nonsense' as never })).toThrow(/'required' or 'suggested'/)
  })

  it('rejects an unknown serialize reason (never silently ignores)', () => {
    expect(() => resolvePolicyConfig({ serializeReasons: ['same-file-edit', 'mood' as never] }))
      .toThrow(/unknown serialize reason.*mood/)
  })
})

describe('OrchestrationPolicyService.assertWorkspace', () => {
  async function withService(
    config: Parameters<typeof resolvePolicyConfig>[0],
    run: (service: OrchestrationPolicyService, ctx: Context) => Promise<void>,
  ): Promise<void> {
    const ctx = new Context()
    try {
      const service = new OrchestrationPolicyService(ctx, config)
      await run(service, ctx)
    } finally {
      await ctx.fiber.dispose()
    }
  }

  it('is a no-op when disabled (default)', async () => {
    await withService({}, async (service) => {
      expect(service.assertWorkspace(undefined, true)).toBeUndefined()
    })
  })

  it('rejects a workspace-less start when enabled + required + capable provider (fail-closed)', async () => {
    await withService({ enabled: true }, async (service) => {
      expect(() => service.assertWorkspace(undefined, true)).toThrow(OrchestrationPolicyError)
      expect(() => service.assertWorkspace(undefined, true)).toThrow(/worktree acquire.*workspace/)
    })
  })

  it('allows a start carrying an isolated workspace', async () => {
    await withService({ enabled: true }, async (service) => {
      expect(service.assertWorkspace('/pool/repo-x/1', true)).toBeUndefined()
    })
  })

  it('degrades to a REPORTED warning (never silent) when the provider cannot isolate', async () => {
    await withService({ enabled: true }, async (service) => {
      const warning = service.assertWorkspace(undefined, false)
      expect(warning).toMatch(/cannot honor `workspace`/)
      expect(warning).toMatch(/in-process provider/)
    })
  })

  it('relaxes when isolation is suggested or enforcement is off', async () => {
    await withService({ enabled: true, isolation: 'suggested' }, async (service) => {
      expect(service.assertWorkspace(undefined, true)).toBeUndefined()
    })
    await withService({ enabled: true, enforceWorkspace: false }, async (service) => {
      expect(service.assertWorkspace(undefined, true)).toBeUndefined()
    })
  })
})

describe('buildOrchestrationPromptSection', () => {
  it('renders an empty section when disabled', () => {
    const section = buildOrchestrationPromptSection(resolvePolicyConfig())
    expect(section.name).toBe('orchestration:policy')
    expect(section.order).toBe(129)
    expect(section.text).toBe('')
  })

  it('renders the fan-out procedure from config when enabled', () => {
    const section = buildOrchestrationPromptSection(resolvePolicyConfig({ enabled: true, maxFanOut: 3 }))
    const text = section.text
    expect(text).toContain('# Orchestration policy (parallelize-by-default)')
    expect(text).toContain('up to 3 per wave')
    expect(text).toContain('worktree acquire --branch')
    expect(text).toContain('`workspace` set to a `worktree acquire` path')
    expect(text).toContain('fail-closed')
    expect(text).toContain('same-file-edit')
    expect(text).toContain('Announce the plan once')
  })

  it('renders the relaxed isolation + serial default wording when configured', () => {
    const serial = buildOrchestrationPromptSection(resolvePolicyConfig({ enabled: true, defaultMode: 'serial' }))
    expect(serial.text).toContain('Run work serially unless')
    const suggested = buildOrchestrationPromptSection(resolvePolicyConfig({ enabled: true, isolation: 'suggested' }))
    expect(suggested.text).toContain('guard does not enforce it')
  })

  it('omits the announce paragraph when announcePlan is off', () => {
    const section = buildOrchestrationPromptSection(resolvePolicyConfig({ enabled: true, announcePlan: false }))
    expect(section.text).not.toContain('Announce the plan once')
  })
})

describe('plugin mount', () => {
  it('registers the service and the prompt section through the plugin', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(policyPackage, { enabled: true, maxFanOut: 2 })
      const service = ctx.get('orchestrationPolicy') as OrchestrationPolicyService | undefined
      expect(service).toBeDefined()
      expect(service!.config.maxFanOut).toBe(2)
      // The assembled prompt carries the rendered policy text.
      const assembly = await ctx.systemPrompt.assemble()
      const policySection = assembly.sections.find(section => section.name === 'orchestration:policy')
      expect(policySection?.text).toContain('up to 2 per wave')
      // The guard is live through the mounted service.
      expect(() => service!.assertWorkspace(undefined, true)).toThrow(OrchestrationPolicyError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('malformed config fails at load, not at first start', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      let failure: unknown
      try {
        await ctx.plugin(policyPackage, { maxFanOut: -1 })
      } catch (error: unknown) {
        failure = error
      }
      expect(String(failure)).toContain('maxFanOut')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('reviewGate config resolution', () => {
  it('defaults the gate active under the sad posture when the policy is enabled', () => {
    const resolved = resolvePolicyConfig({ enabled: true })
    expect(resolved.reviewGate).toEqual({
      enabled: true,
      default: 'review-gated',
      posture: {},
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(resolved.scoutPolicy.knowledgeOnly).toHaveLength(5)
  })

  it('resolves a partial reviewGate + scoutPolicy over the defaults', () => {
    const resolved = resolvePolicyConfig({
      enabled: true,
      reviewGate: { default: 'fast', posture: { '/trusted': 'fast', '/gated': 'review-gated', '*': 'review-gated' }, onUnavailable: 'warn' },
      scoutPolicy: { knowledgeOnly: ['diagnose', 'audit'] },
    })
    expect(resolved.reviewGate.enabled).toBe(true)
    expect(resolved.reviewGate.default).toBe('fast')
    expect(resolved.reviewGate.onUnavailable).toBe('warn')
    expect(resolved.reviewGate.requireVerdict).toBe('ship')
    expect(resolved.scoutPolicy.knowledgeOnly).toEqual(['diagnose', 'audit'])
  })

  it('rejects malformed reviewGate config with actionable messages', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ reviewGate: { enabled: 'yes' } }, 'reviewGate.enabled'],
      [{ reviewGate: { default: 'strict' } }, 'reviewGate.default'],
      [{ reviewGate: { posture: { '/x': 'sometimes' } } }, 'posture for "/x"'],
      [{ reviewGate: { requireVerdict: 'approve' } }, 'reviewGate.requireVerdict'],
      [{ reviewGate: { onUnavailable: 'ignore' } }, 'reviewGate.onUnavailable'],
      [{ reviewGate: 'on' }, 'reviewGate'],
      [{ scoutPolicy: { knowledgeOnly: 'investigate' } }, 'knowledgeOnly'],
    ]
    for (const [config, needle] of cases) {
      let failure: unknown
      try {
        resolvePolicyConfig(config)
      } catch (error: unknown) {
        failure = error
      }
      expect(String(failure), JSON.stringify(config)).toContain(needle)
    }
  })
})

describe('resolvePosture', () => {
  it('picks the most specific matching prefix, then *, then the default', () => {
    const posture = { '/a': 'fast', '/a/b': 'review-gated', '*': 'review-gated' } as const
    expect(resolvePosture(posture, '/a/b/c', 'review-gated')).toBe('review-gated')
    expect(resolvePosture(posture, '/a/x', 'review-gated')).toBe('fast')
    expect(resolvePosture(posture, '/z', 'review-gated')).toBe('review-gated')
    expect(resolvePosture({}, '/z', 'fast')).toBe('fast')
    expect(resolvePosture({ '*': 'fast' }, '/z', 'review-gated')).toBe('fast')
  })
})

describe('P2 prompt rendering', () => {
  it('renders the quality-gate rule and scout guidance when the policy is enabled', () => {
    const section = buildOrchestrationPromptSection(resolvePolicyConfig({
      enabled: true,
      scoutPolicy: { knowledgeOnly: ['audit'] },
    }))
    expect(section.text).toContain('Quality gate')
    expect(section.text).toContain('review --target staged')
    expect(section.text).toContain('commit_apply --push')
    expect(section.text).toContain('explicit `fast` posture')
    expect(section.text).toContain('Knowledge-only intents (audit)')
  })

  it('omits the gate rule when reviewGate.enabled is false (scout guidance stays)', () => {
    const section = buildOrchestrationPromptSection(resolvePolicyConfig({
      enabled: true,
      reviewGate: { enabled: false },
    }))
    expect(section.text).not.toContain('Quality gate')
    expect(section.text).toContain('Knowledge-only intents')
  })

  it('renders every serialize reason with its description', () => {
    const section = buildOrchestrationPromptSection(resolvePolicyConfig({ enabled: true }))
    expect(section.text).toContain('same-file-edit: two chunks edit the same file')
    expect(section.text).toContain('incompatible-concurrency: both rework the same subsystem in conflicting ways')
  })
})

describe('P3 reporting', () => {
  it("buildReportingRules is empty under verbose mode (today's behavior)", () => {
    expect(buildReportingRules({ mode: 'verbose', includePerTask: 'summary', forbiddenTerms: ['x'] })).toEqual([])
  })

  it('renders the contract: ONE block per wave, needs-you taxonomy, forbidden terms, summary per-task', () => {
    const rules = buildReportingRules({
      mode: 'outcomes',
      includePerTask: 'summary',
      forbiddenTerms: ['subagent', 'workspace'],
    })
    expect(rules[0]).toContain('ONE block')
    expect(rules[0]).toContain('after each wave')
    expect(rules[1]).toContain('a decision, a blocker, a credential need, or a review-ready result')
    expect(rules[2]).toContain('one line per task')
    expect(rules[3]).toContain('subagent, workspace')
    expect(rules[3]).toContain("don't dump")
  })

  it('switches per-task detail to detail blocks', () => {
    const rules = buildReportingRules({
      mode: 'outcomes',
      includePerTask: 'detail',
      forbiddenTerms: [],
    })
    expect(rules[2]).toContain('detail block per task')
    expect(rules[3]).toContain('none by configuration')
  })

  it('renders the reporting block from config (outcomes default) with default forbidden terms', () => {
    const section = buildOrchestrationPromptSection(resolvePolicyConfig({ enabled: true }))
    expect(section.text).toContain('6. Report OUTCOMES, not mechanics')
    expect(section.text).toContain('subagent, workspace, lease, worktree, pool, continuation, provider')
    expect(section.text).toContain('one line per task in the wave summary')
  })

  it('omits only the reporting block under reporting.mode verbose', () => {
    const section = buildOrchestrationPromptSection(resolvePolicyConfig({
      enabled: true,
      reporting: { mode: 'verbose' },
    }))
    expect(section.text).not.toContain('Report OUTCOMES')
    expect(section.text).toContain('Quality gate')
    expect(section.text).toContain('Knowledge-only intents')
  })

  it('renumbers the reporting block when the gate is disabled', () => {
    const section = buildOrchestrationPromptSection(resolvePolicyConfig({
      enabled: true,
      reviewGate: { enabled: false },
    }))
    expect(section.text).toContain('5. Report OUTCOMES, not mechanics')
    expect(section.text).not.toContain('6. Report')
  })

  it('rejects malformed reporting config at load', () => {
    expect(() => resolvePolicyConfig({ enabled: true, reporting: 'on' as never })).toThrow(/reporting.*must be an object/)
    expect(() => resolvePolicyConfig({ enabled: true, reporting: { mode: 'chatty' as never } })).toThrow(/reporting\.mode/)
    expect(() => resolvePolicyConfig({ enabled: true, reporting: { includePerTask: 'full' as never } })).toThrow(/includePerTask/)
    expect(() => resolvePolicyConfig({ enabled: true, reporting: { forbiddenTerms: [42 as never] } })).toThrow(/forbiddenTerms/)
  })

  it('uses configured forbidden terms verbatim and defaults when absent', () => {
    expect(resolvePolicyConfig({ enabled: true }).reporting.forbiddenTerms).toEqual([
      'subagent', 'workspace', 'lease', 'worktree', 'pool', 'continuation', 'provider',
    ])
    const custom = resolvePolicyConfig({ enabled: true, reporting: { forbiddenTerms: ['qemu'] } })
    expect(custom.reporting.forbiddenTerms).toEqual(['qemu'])
    const section = buildOrchestrationPromptSection(custom)
    expect(section.text).toContain('qemu')
  })
})
