/**
 * The child-scoped `report` tool and its usage guidance, installed into every
 * continuable in-process child's unpublished context. Roots, one-shot children,
 * remote providers, and agentless executions never see the registration.
 *
 * Ported from `@deepseek-ai/dsh-tool-subagent-report`
 * (`packages/subagent/tool-subagent-report/src/index.ts`) — MIT, see
 * THIRD-PARTY-NOTICES.md. Conceptually inspired by firstmate
 * (https://github.com/kunchenguid/firstmate), MIT © 2026 Kun Chen, whose
 * parent-status contract drives the keyed open-decisions ledger. The
 * fork-only subagent report channel is declared
 * in {@link module:@hy-sde-org/dsh-tool-subagent-report/report-contract} so
 * this package builds against the published `@deepseek-ai/dsh-subagent`.
 *
 * @module @hy-sde-org/dsh-tool-subagent-report
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { subagentsReport } from './report-contract.ts'
import type { SubagentReportContent, SubagentReportDelivery } from './report-contract.ts'

export const name = 'tool-subagent-report'
// The contribution registers only through childCtx.tools and
// childCtx.systemPrompt, but declaring both services makes Loader ordering fail
// at load instead of at the next child materialization.
export const inject = ['subagents', 'tools', 'systemPrompt']

/** Guidance order after every per-tool section a continuable child can carry. */
/** Config: how accepted reports are scheduled on the parent. */
export interface Config {
  /**
   * Parent scheduling (default `next-step`). `next-step` wakes the parent and
   * enters at its nearest step boundary; `quiet` adds the same context without
   * waking, so a parked parent waits for another waking input.
   */
  reportDelivery?: SubagentReportDelivery
}

export const Config: z<Config> = z.object({
  reportDelivery: z.union(['quiet', 'next-step'] as const).default('next-step'),
})

/**
 * Install `report` and its usage guidance into one continuable child's scope.
 * Both registrations are owned by that scope and are therefore invisible to the
 * child's parent and siblings.
 * @param childCtx - child-scoped context receiving the tool and the guidance.
 * @param ctx - service context used for delivery.
 * @param delivery - resolved deployment scheduling policy.
 * @returns disposer that attempts both child registrations before reporting cleanup failures.
 */
export function installReportTool(
  childCtx: Context,
  ctx: Context,
  delivery: SubagentReportDelivery,
): () => void {
  const disposeSection = childCtx.systemPrompt.section({
    name: 'tool:report',
    order: childCtx.systemPrompt.getSectionOrder('TOOL_REPORT'),
    text: 'Deliver your result with the report tool before you finish: call it once with a self-contained '
      + 'answer. The agent that started you shares your workspace but does not automatically receive your '
      + 'transcript, tool output, or reasoning, so a closing remark such as "done" leaves it nothing it can '
      + 'use. Report earlier as well whenever a partial finding changes what that agent should do next; '
      + 'reporting never ends your turn. When you genuinely need that agent to decide something before you '
      + 'continue, send status "needs-decision" (or "blocked" when you cannot proceed) together with a '
      + 'short, stable `decisionKey` and an actionable `summary`; do not reopen the same key with the same '
      + 'summary, and answer questions only with a later keyed report.',
  })
  let disposeTool: () => void
  try {
    disposeTool = childCtx.tools.register(defineTool({
      name: 'report',
      description:
        'Report selected content to the agent that started you. Call this once before you finish, with a '
        + 'self-contained final result, and earlier for progress or findings that change what that agent does '
        + 'next. That agent shares your workspace but does not automatically receive your transcript, tool '
        + 'output, or reasoning, so finishing your work is not itself a result. Reporting does not end your '
        + 'turn or finish your work, and only your direct parent receives it. A failed call may still have '
        + 'arrived, so do not blindly repeat it. Use `output` alone for free-form notes; add `status` with a '
        + '`decisionKey` + `summary` only when the parent must decide something before you continue '
        + '(`needs-decision` = you keep working meanwhile, `blocked` = you cannot).',
      parameters: {
        output: {
          type: 'string',
          description: 'Actionable content for your parent; summarize conclusions and reference relevant shared paths.',
        },
        status: {
          type: 'string',
          enum: ['done', 'progress', 'needs-decision', 'blocked'],
          description: 'Structured status of this report. `needs-decision` and `blocked` open a keyed decision for your parent.',
        },
        summary: {
          type: 'string',
          description: 'One-line actionable summary. Required together with `decisionKey` for a decision-shaped report.',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional evidence lines backing the summary.',
        },
        nextSteps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional next steps you have planned or that await the parent\'s answer.',
        },
        blocker: {
          type: 'string',
          description: 'Required (and only meaningful) when `status` is `blocked`: what stops you.',
        },
        decisionKey: {
          type: 'string',
          description: 'Stable, short key making this report an open decision; unique within your reports. The parent answers with the same key.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            messageId: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `report accepted by the agent that started you as message ${value.messageId}`,
        }],
      },
      async execute(args, exec) {
        const structured = collectStructured(args)
        const { report } = structured
        if ((report.status === 'needs-decision' || report.status === 'blocked')
          && (report.decisionKey === undefined || report.summary === undefined)) {
          throw new Error(
            'a needs-decision or blocked report must carry both a decisionKey and a summary to be answerable',
          )
        }
        const text = renderReportText(args.output, structured)
        if (text.length === 0) {
          throw new Error('report needs output, summary, or another structured field to say something')
        }
        const content: ContentBlock[] = [{ type: 'text', text }]
        // Scope-local resolution guarantees an Agent. The service still verifies
        // its exact live Activation identity at the authority boundary.
        const messageId = await subagentsReport(ctx).reportFrom(exec.agent as Agent, content, {
          delivery,
          signal: exec.signal,
          ...(structured.hasAny ? { report: structured.report } : {}),
        })
        return { messageId }
      },
    }))
  } catch (error: unknown) {
    try {
      disposeSection()
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        'failed to register the report tool and roll back its prompt guidance',
      )
    }
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of [disposeTool, disposeSection]) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to revoke report tool and prompt registrations')
    }
  }
}

/**
 * Register the continuable-child contribution.
 * @param ctx - context carrying tools, the system prompt, and the subagent service.
 * @param config - deployment scheduling policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Config() applies the schema default at runtime; the schemastery return
  // type keeps the input's optional shape, so assert the resolved one.
  const { reportDelivery } = Config(config) as { reportDelivery: SubagentReportDelivery }
  subagentsReport(ctx).registerContinuableSetup(childCtx =>
    installReportTool(childCtx, ctx, reportDelivery))
}

/** The tool arguments of `report`, as resolved by defineTool's schema. */
interface ReportArgs {
  output?: string
  status?: 'done' | 'progress' | 'needs-decision' | 'blocked'
  summary?: string
  evidence?: string[]
  nextSteps?: string[]
  blocker?: string
  decisionKey?: string
}

/** Extracted structured arm plus whether any structured field was supplied. */
interface StructuredContent {
  readonly hasAny: boolean
  readonly report: SubagentReportContent
}

function collectStructured(args: ReportArgs): StructuredContent {
  const report: SubagentReportContent = {
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.summary !== undefined ? { summary: args.summary } : {}),
    ...(args.evidence !== undefined && args.evidence.length > 0 ? { evidence: args.evidence } : {}),
    ...(args.nextSteps !== undefined && args.nextSteps.length > 0 ? { nextSteps: args.nextSteps } : {}),
    ...(args.blocker !== undefined ? { blocker: args.blocker } : {}),
    ...(args.decisionKey !== undefined ? { decisionKey: args.decisionKey } : {}),
  }
  const hasAny = Object.keys(report).length > 0
  return { hasAny, report }
}

const REPORT_STATUS_LABELS: Record<NonNullable<SubagentReportContent['status']>, string> = {
  done: 'DONE',
  progress: 'PROGRESS',
  'needs-decision': 'NEEDS DECISION',
  blocked: 'BLOCKED',
}

/**
 * Canonical parent-facing text for one report. A plain `output`-only report is
 * passed through verbatim (back-compat); structured fields render as a compact
 * status block, with `output` (when also supplied) folded in as a final note.
 */
function renderReportText(output: string | undefined, structured: StructuredContent): string {
  const { report } = structured
  if (!structured.hasAny) return output ?? ''
  const parts: string[] = []
  if (report.status !== undefined) {
    let line = `[${REPORT_STATUS_LABELS[report.status]}]`
    if (report.summary !== undefined) line += ` ${report.summary}`
    parts.push(line)
  } else if (report.summary !== undefined) {
    parts.push(report.summary)
  }
  if (report.evidence !== undefined && report.evidence.length > 0) {
    parts.push(`Evidence:\n${report.evidence.map(item => `- ${item}`).join('\n')}`)
  }
  if (report.nextSteps !== undefined && report.nextSteps.length > 0) {
    parts.push(`Next steps:\n${report.nextSteps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`)
  }
  if (report.blocker !== undefined) parts.push(`Blocker: ${report.blocker}`)
  if (output !== undefined && output.length > 0) parts.push(`Note: ${output}`)
  return parts.join('\n\n')
}
