/**
 * Local test seam standing in for the fork-only subagent report channel.
 *
 * The published `@deepseek-ai/dsh-subagent@0.1.2-rc.1` predates the DeepSeek
 * Harness fork's report channel (`registerContinuableSetup`, `reportFrom`,
 * the `subagent-report`/`subagent-settled` message sources, and the keyed
 * open-decisions ledger). Rather than weaken any assertion, this suite mounts
 * a faithful local seam that implements exactly the fork contract declared in
 * `src/report-contract.ts` over the REAL published agent stack
 * (agent-loop, agents registry, sessions, tools, system prompt, LLM runtime),
 * so every child materialization, inbox ordering, and wake is produced by the
 * published machinery and only the report channel is faked.
 *
 * @module @hy-sde-org/dsh-tool-subagent-report/tests/report-subagent-seam
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { applyChildComposition } from '@deepseek-ai/dsh-subagent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { OpenDecision, SubagentReportContent } from '../src/report-contract.ts'
import { normalizeDecisionKey } from '../src/report-contract.ts'
import { SubagentActivationSetupRegistry } from './activation-setup-registry.ts'
import { SubagentError } from './error.ts'

/** Durable attribution of one child-chosen report delivered to its direct parent. */
export interface SubagentReportMessageSource {
  readonly kind: 'subagent-report'
  /** `relay` context form: the child selected the content; the parent sees it. */
  readonly form: 'relay'
  /** Session id of the reporting child. */
  readonly senderSessionId: SessionId
}

/** Durable attribution of the runtime's own settlement account for a child. */
export interface SubagentSettledMessageSource {
  readonly kind: 'subagent-settled'
  readonly form: 'notice'
  /** One-line account of how the child ended. */
  readonly summary: string
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'subagent-report': SubagentReportMessageSource
    'subagent-settled': SubagentSettledMessageSource
  }
}

/** One child's live residency record. */
interface Activation {
  readonly childId: SessionId
  readonly parentId: SessionId
  readonly handle: AgentHandle
  disposing: Promise<void> | undefined
}

/** The delegation request shape the suite drives. */
export interface SeamContinuableRequest {
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly toolFilter?: { readonly allow?: string[]; readonly deny?: string[] }
}

/** The `startContinuable` spec shape the suite drives. */
export interface SeamContinuableStartSpec {
  readonly provider: string
  readonly label: string
  readonly request: SeamContinuableRequest
  readonly signal: AbortSignal
}

/**
 * The report-channel service: children are real published Agents; only this
 * manager's contracts are local.
 */
class SubagentReportSeam {
  private readonly setups = new SubagentActivationSetupRegistry()
  private readonly activations = new Map<SessionId, Activation>()
  private readonly decisions = new Map<string, OpenDecision>()
  private readonly closingScopes = new Map<SessionId, Set<SessionId>>()
  private drained = false
  private counter = 0

  constructor(private readonly ctx: Context) {
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const activation = this.activations.get(agent.id)
      if (activation === undefined || activation.disposing !== undefined) return
      if (agent.inbox.hasPending) return
      const hasLiveDescendants = [...this.activations.values()]
        .some(other => other.parentId === agent.id && other.disposing === undefined)
      if (hasLiveDescendants) return
      void this.settle(activation)
    })
  }

  /** Install one scoped contribution, tied to this manager's own lifetime. */
  registerContinuableSetup(contribution: (childCtx: Context) => () => void): () => void {
    return this.registerContinuableSetupWith(this.ctx, contribution)
  }

  /**
   * Install one scoped contribution tied to an explicit owner fiber: disposing
   * that fiber revokes the registration and its live child installations
   * immediately. The fork's traced service binds the caller's fiber implicitly;
   * the standalone seam has no tracing channel, so callers supply the owner.
   */
  registerContinuableSetupWith(
    owner: Context,
    contribution: (childCtx: Context) => () => void,
  ): () => void {
    const remove = owner.effect(
      () => this.setups.register(contribution),
      'subagents.registerContinuableSetup()',
    )
    return () => { void remove() }
  }

  /** Establish one durable continuable child with real published materialization. */
  async startContinuable(spec: SeamContinuableStartSpec): Promise<{ childId: SessionId; messageId: MessageId }> {
    spec.signal.throwIfAborted()
    const parent = spec.request.parent
    this.assertAdmitting(parent)
    const childId = SessionId(`seam-child-${++this.counter}`)
    const handle = await this.ctx.agents.create({
      sessionId: childId,
      meta: { parentSession: parent.id, origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: (agentCtx) => {
        applyChildComposition(agentCtx, parent, {
          ...(spec.request.toolFilter !== undefined ? { toolFilter: spec.request.toolFilter } : {}),
        })
        return this.setups.apply(agentCtx)
      },
    })
    const child = handle.agent
    this.activations.set(childId, { childId, parentId: parent.id, handle, disposing: undefined })
    spec.signal.throwIfAborted()
    const message = createUserMessage({
      content: spec.request.prompt,
      source: { kind: 'user' },
    })
    child.followup(message)
    return { childId, messageId: message.id }
  }

  /**
   * Deliver explicitly selected content from one resident continuable child
   * to its durable direct parent, framed and scheduled per the fork contract.
   */
  async reportFrom(
    child: Agent,
    content: ContentBlock[],
    options: { signal: AbortSignal; delivery: 'quiet' | 'next-step'; report?: SubagentReportContent },
  ): Promise<MessageId> {
    options.signal.throwIfAborted()
    this.assertAdmitting(child)
    const activation = this.activations.get(child.id)
    if (activation === undefined || activation.handle.agent !== child) {
      throw new SubagentError(
        `agent "${child.id}" is not a live continuable subagent and cannot report`,
        'UNAUTHORIZED',
      )
    }
    const parent = this.ctx.agents.get(activation.parentId)
    if (parent === undefined) {
      throw new SubagentError('direct parent is not live; report was not delivered', 'PARENT_UNAVAILABLE')
    }
    const message = createUserMessage({
      content: [
        { type: 'text', text: `Background subagent ${activation.childId} reported:` },
        ...content,
      ],
      source: {
        kind: 'subagent-report',
        form: 'relay',
        senderSessionId: activation.childId,
      },
    })
    const decision = decisionShape(options.report)
    if (decision !== undefined) this.recordDecision(parent, activation.childId, decision)
    if (options.delivery === 'next-step') this.sendWaking(parent, message)
    else this.sendQuiet(parent, message)
    return message.id
  }

  /** The parent's currently open keyed decisions, in open order. */
  listOpenDecisions(parent: Agent): OpenDecision[] {
    const prefix = `${parent.id}\u0000`
    return [...this.decisions.entries()]
      .filter(([id]) => id.startsWith(prefix))
      .map(([, decision]) => decision)
  }

  /** Close one open record for the exact child and key. */
  resolveOpenDecision(parent: Agent, childId: string, key: string): boolean {
    const id = `${parent.id}\u0000${childId}\u0000${normalizeDecisionKey(key)}`
    return this.decisions.delete(id)
  }

  /** Close admission below exact live roots and stop their strict descendants. */
  async drainContinuableDescendants(parents: readonly Agent[]): Promise<void> {
    const roots = parents.filter(parent => this.ctx.agents.get(parent.id) === parent)
    for (const root of roots) {
      let members = this.closingScopes.get(root.id)
      if (members === undefined) {
        members = new Set()
        this.closingScopes.set(root.id, members)
      }
      members.add(root.id)
    }
    const targets = [...this.activations.values()].filter(activation =>
      roots.some(root => activation.childId !== root.id && this.lineage(activation.childId).includes(root.id)))
    await Promise.all(targets.map(activation => this.settle(activation)))
  }

  /**
   * Compatibility implementation of the published `sendMessage` direction —
   * unused by this suite but part of the service surface the control package
   * types against.
   */
  async sendMessage(
    _sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: { signal: AbortSignal },
  ): Promise<MessageId> {
    options.signal.throwIfAborted()
    const activation = this.activations.get(targetId)
    const target = activation !== undefined ? activation.handle.agent : this.ctx.agents.get(targetId)
    if (target === undefined) {
      throw new SubagentError(`subagent "${targetId}" is not live`, 'UNAUTHORIZED')
    }
    const message = createUserMessage({ content, source: { kind: 'user' } })
    target.followup(message)
    return message.id
  }

  /** Reject every report/new-child operation once the lineage began closing. */
  private assertAdmitting(agent: Agent): void {
    const closing = this.closingTeardownFor(agent)
    if (closing !== undefined) {
      throw new SubagentError(
        closing === 'manager'
          ? 'continuable subagents are draining; the operation was not admitted'
          : `continuable subagents below parent "${closing}" are draining; the operation was not admitted`,
        'DRAINING',
      )
    }
  }

  /** Resolve the closing teardown that owns one agent's lineage, if any. */
  private closingTeardownFor(agent: Agent): SessionId | 'manager' | undefined {
    if (this.drained) return 'manager'
    const lineage = this.lineage(agent.id)
    for (const [rootId, members] of this.closingScopes) {
      if (members.has(agent.id) || lineage.includes(rootId)) return rootId
    }
    return undefined
  }

  /** The exact ancestry of one agent id through durable parentSession metadata. */
  private lineage(id: SessionId): SessionId[] {
    const chain: SessionId[] = [id]
    let current = id
    const seen = new Set<SessionId>([id])
    while (true) {
      const agent = this.ctx.agents.get(current)
      const parent = agent?.session.header.parentSession
      if (parent === undefined || seen.has(parent)) break
      chain.push(parent)
      seen.add(parent)
      current = parent
    }
    return chain
  }

  /** Record or refresh one open decision for the parent. */
  private recordDecision(
    parent: Agent,
    childId: SessionId,
    decision: { key: string; status: 'needs-decision' | 'blocked'; summary: string },
  ): void {
    const open: OpenDecision = {
      childId: childId.toString(),
      key: decision.key,
      label: 'subagent',
      status: decision.status,
      summary: decision.summary,
      openedAt: Date.now(),
    }
    this.decisions.set(`${parent.id}\u0000${childId}\u0000${decision.key}`, open)
  }

  /** Waking delivery: the parked/running parent reaches its nearest step boundary. */
  private sendWaking(parent: Agent, message: ReturnType<typeof createUserMessage>): void {
    try {
      parent.steer(message)
    } catch (error: unknown) {
      throw new SubagentError('direct parent is not live; report was not delivered', 'PARENT_UNAVAILABLE', { cause: error })
    }
  }

  /** Quiet delivery: context only, no wake. */
  private sendQuiet(parent: Agent, message: ReturnType<typeof createUserMessage>): void {
    try {
      parent.inject(message)
    } catch (error: unknown) {
      throw new SubagentError('direct parent is not live; report was not delivered', 'PARENT_UNAVAILABLE', { cause: error })
    }
  }

  /** Notify the direct parent that the child produced everything it is going to. */
  private notifySettlement(activation: Activation): void {
    const parent = this.ctx.agents.get(activation.parentId)
    if (parent === undefined) return
    const summary = `Background subagent ${activation.childId} finished and will do no further work unless you send it more.`
    const message = createUserMessage({
      content: [
        { type: 'text', text: summary },
        { type: 'text', text: 'It left no closing message.' },
      ],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary,
        senderSessionId: activation.childId,
      },
    })
    try {
      parent.inject(message)
    } catch {
      // A parent that is no longer live is not an error; the child's own
      // Session remains the durable record.
    }
  }

  /** Release one activation: settle notice, then dispose the real handle. */
  private settle(activation: Activation): Promise<void> {
    if (activation.disposing !== undefined) return activation.disposing
    this.notifySettlement(activation)
    activation.disposing = (async () => {
      this.activations.delete(activation.childId)
      await activation.handle.dispose()
    })()
    return activation.disposing
  }
}

/** The seam plugin: provides `ctx.subagents` with the fork report contract. */
export const name = 'subagent-report-seam'
export const inject = ['agents']

export function apply(ctx: Context): void {
  const seam = new SubagentReportSeam(ctx)
  ctx.provide('subagents', seam)
}

/** Extract the coalescible decision shape, mirroring the fork's helper. */
function decisionShape(
  report: SubagentReportContent | undefined,
): { key: string; status: 'needs-decision' | 'blocked'; summary: string } | undefined {
  if (report === undefined) return undefined
  if (report.status !== 'needs-decision' && report.status !== 'blocked') return undefined
  if (typeof report.decisionKey !== 'string') return undefined
  const key = normalizeDecisionKey(report.decisionKey)
  if (key.length === 0 || typeof report.summary !== 'string' || report.summary.trim().length === 0) {
    return undefined
  }
  return { key, status: report.status, summary: report.summary.trim() }
}
