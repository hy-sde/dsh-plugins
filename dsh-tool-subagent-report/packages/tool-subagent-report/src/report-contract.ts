/**
 * The fork-only subagent report channel contract, declared locally so this
 * package typechecks and builds against the PUBLISHED
 * `@deepseek-ai/dsh-subagent` (0.1.2-rc.1). That published version predates
 * the DeepSeek Harness fork's report channel — `registerContinuableSetup`,
 * `reportFrom`, the `subagent-report` message source, and the keyed
 * open-decisions ledger are fork-side extensions — so the package declares
 * exactly the surface it consumes here and reads it back off `ctx.subagents`
 * at runtime. A host built from the fork (or a standalone port carrying the
 * same channel) provides the implementation; this package only formats and
 * validates the report.
 *
 * Ported from `@deepseek-ai/dsh-subagent` types (`continuation.ts`,
 * `types.ts`) — MIT, see THIRD-PARTY-NOTICES.md.
 *
 * @module @hy-sde-org/dsh-tool-subagent-report/report-contract
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'

/** Report status vocabulary; `needs-decision`/`blocked` open a keyed record. */
export type DecisionStatus = 'done' | 'progress' | 'needs-decision' | 'blocked'

/**
 * A child-reported decision that still awaits the parent's answer.
 * @see SubagentReportService.listOpenDecisions
 */
export interface OpenDecision {
  /** Durable session id of the reporting child. */
  readonly childId: string
  /** Stable, normalized decision key (unique within one child). */
  readonly key: string
  /** One-line label naming the decision (currently the child's label). */
  readonly label: string
  /** `needs-decision` = waiting while staying productive; `blocked` = cannot proceed. */
  readonly status: 'needs-decision' | 'blocked'
  /** Actionable summary of what the parent must decide. */
  readonly summary: string
  /** Epoch milliseconds when the decision was opened (or last re-opened). */
  readonly openedAt: number
  /** Set when wedge supervision raised the record rather than the child. */
  readonly wedge?: true
}

/**
 * The structured arm of one child report, delivered alongside the free-text
 * content. `status` without a `decisionKey` is advisory only; a key turns the
 * report into a durable open-decision record.
 */
export interface SubagentReportContent {
  /** Structured report status (advisory when no `decisionKey`). */
  readonly status?: DecisionStatus
  /** One-line actionable summary shown to the parent. */
  readonly summary?: string
  /** Optional evidence lines backing the summary. */
  readonly evidence?: readonly string[]
  /** Optional next steps the child has planned or awaits. */
  readonly nextSteps?: readonly string[]
  /** Required (and only meaningful) when `status` is `blocked`. */
  readonly blocker?: string
  /** Stable key making this report an open decision. */
  readonly decisionKey?: string
}

/**
 * Parent scheduling for one accepted report. `quiet` adds the framed context
 * without waking a parked parent; `next-step` wakes the parent to its nearest
 * step boundary (decision-shaped reports deliver their content quietly and
 * coalesce the wake).
 */
export type SubagentReportDelivery = 'quiet' | 'next-step'

/** Options for one child-to-parent report delivery. */
export interface SubagentReportOptions {
  /** Caller cancellation; owns the operation only until inbox acceptance. */
  readonly signal: AbortSignal
  /** Resolved deployment scheduling policy. */
  readonly delivery: SubagentReportDelivery
  /** The structured arm when the report carried one. */
  readonly report?: SubagentReportContent
}

/**
 * The fork-only subagent report surface consumed by this package. A host
 * implementing `ctx.subagents` (fork build or ported standalone service)
 * supplies it; this service also owns sender authorization, parent
 * resolution, send acceptance, and the durable open-decisions ledger.
 */
export interface SubagentReportService {
  /**
   * Install one scoped contribution into every future continuable child's
   * unpublished creation context.
   * @param contribution - synchronous child-scope installer; returns its disposer.
   * @returns an idempotent registration undo.
   */
  registerContinuableSetup(contribution: (childCtx: Context) => () => void): () => void
  /**
   * Local seam binding: like {@link registerContinuableSetup}, but ties the
   * registration's lifetime to the calling fiber through an explicit owner
   * context. A traced fork service does this implicitly via caller tracing; a
   * standalone seam has no tracing channel, so the binder supplies it.
   * @param owner - the context (fiber) that owns this registration.
   * @param contribution - synchronous child-scope installer.
   * @returns an idempotent registration undo tied to the owner's lifetime.
   */
  registerContinuableSetupWith(
    owner: Context,
    contribution: (childCtx: Context) => () => void,
  ): () => void
  /**
   * Deliver selected content from one exact live continuable child to its
   * durable direct parent.
   * @param child - exact live reporting child; this is the authority credential.
   * @param content - selected model-facing content.
   * @param options - scheduling policy and pre-acceptance cancellation.
   * @returns the stable identity of the message accepted by the parent.
   */
  reportFrom(
    child: Agent,
    content: ContentBlock[],
    options: SubagentReportOptions,
  ): Promise<MessageId>
  /** The parent's currently open keyed decisions, in open order. */
  listOpenDecisions(parent: Agent): OpenDecision[]
  /**
   * Close one open record for the exact child.
   * @returns whether a record was closed.
   */
  resolveOpenDecision(parent: Agent, childId: string, key: string): boolean
}

/**
 * Resolve the report-channel service off a context typed by the published
 * `@deepseek-ai/dsh-subagent`. The cast documents the fork-only extension
 * point: the same surface name, verified by the host at the authority
 * boundary. The returned facade binds registration lifetime to `ctx` so a
 * plugin mounting the tool and then disposing revokes every resident
 * installation immediately (the fork's traced-service equivalent).
 * @param ctx - context carrying the subagent service.
 * @returns the report channel implementation.
 */
export function subagentsReport(ctx: Context): SubagentReportService {
  // Read the channel back off `ctx.subagents` without depending on the
  // published dsh-subagent Context augmentation (which lacks the channel);
  // the intersection documents the fork-only extension point.
  const service = (ctx as Context & { readonly subagents: SubagentReportService }).subagents
  return {
    registerContinuableSetup: (contribution) => service.registerContinuableSetupWith(ctx, contribution),
    registerContinuableSetupWith: (owner, contribution) => service.registerContinuableSetupWith(owner, contribution),
    reportFrom: (child, content, options) => service.reportFrom(child, content, options),
    listOpenDecisions: (parent) => service.listOpenDecisions(parent),
    resolveOpenDecision: (parent, childId, key) => service.resolveOpenDecision(parent, childId, key),
  }
}

/**
 * Normalize a caller-supplied decision key: trim and collapse whitespace.
 * Mirrors the host's normalization so a parent answering with the same key
 * always matches.
 * @param key - the raw decision key.
 * @returns the normalized key.
 */
export function normalizeDecisionKey(key: string): string {
  return key.trim().replace(/\s+/g, ' ')
}
