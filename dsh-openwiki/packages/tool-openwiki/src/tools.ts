/**
 * OpenWiki lifecycle tools over the standalone deterministic engine.
 *
 * The ported {@link HostSessionManager} is transport-neutral: this surface
 * adapts it to the harness tool registry with raw JSON-Schema parameters (the
 * fork's tool convention), keeping the exact five-tool contract and every
 * model-facing description from openwiki 0.4.
 * @module @hy-sde-org/dsh-tool-openwiki/tools
 */

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  DefineToolOptions,
  ParameterSchemaSpec,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import { HostSessionManager } from '@hy-sde-org/dsh-openwiki'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  BeginRequest,
  SubmitPageRequest,
  SubmitPlanRequest,
} from '@hy-sde-org/dsh-openwiki'

/**
 * `defineTool` passthrough that additionally accepts the fork's `device`
 * device-catalog marker. The published `@deepseek-ai/dsh-tools` 0.1.2-rc.1
 * types predate that option (it landed in the harness's in-repo registry),
 * so the marker rides a widened but fully typed options shape; a consumer
 * registry without the device concept simply ignores it at runtime.
 */
function defineOpenWikiTool<S extends ParameterSchemaSpec, O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O> & { device?: boolean },
) {
  return defineTool<S, O>(options)
}

/** Tool-level configuration (all optional; defaults apply). */
export interface OpenWikiToolConfig {
  /** Stable host identity recorded in run metadata (default `harness`). */
  host?: string
  /** Provenance actor for engine-owned finalizers (default `harness`). */
  producerActor?: string
}

/** Shared single-run adapter kept for the agent session that mounted this row. */
let manager: HostSessionManager | null = null

/** Resolves the shared engine adapter or raises a boot-time diagnostic. */
function requireManager(): HostSessionManager {
  if (manager === null) {
    throw new Error('openwiki tools mounted without an engine adapter (plugin apply did not run).')
  }
  return manager
}

/**
 * Register the five OpenWiki lifecycle tools.
 * @param ctx - the agent-plane plugin context (injects `tools`).
 * @param config - resolved plugin configuration.
 */
export function applyOpenWikiTools(ctx: Context, config: OpenWikiToolConfig = {}): void {
  manager = HostSessionManager.create({
    host: config.host ?? 'harness',
    producerActor: config.producerActor ?? 'harness',
  })

  /* openwiki_begin — start or resume a durable repository run. */
  ctx.tools.register(defineOpenWikiTool({
    name: 'openwiki_begin',
    device: true,
    description:
      'Start or resume OpenWiki repository generation. Returns status=noop for a clean update, otherwise the durable planning/generation run state. An unrecognized `language` fails the call with invalid_input instead of starting a run.',
    parameters: {
      root: { type: 'string', description: 'Absolute path to any directory inside the target Git repository.', required: true },
      mode: { type: 'string', enum: ['init', 'update'], description: 'init generates a fresh wiki; update refreshes an existing one.', required: true },
      language: { type: 'string', description: 'BCP-47 documentation language code, e.g. "ko" (not "Korean"). Omit to keep the existing wiki language.' },
      force: { type: 'boolean', description: 'Bypass update no-op detection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          runId: { type: 'string' },
          mode: { type: 'string' },
          language: { type: 'string' },
          phase: { type: 'string' },
          changedPaths: { type: 'array', items: { type: 'string' } },
          claimIssues: { type: 'array' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [
        { type: 'text', text: renderValue(value) },
      ],
    },
    async execute(args) {
      const input: BeginRequest = {
        root: (args as { root: string }).root,
        mode: (args as { mode: 'init' | 'update' }).mode,
        ...(typeof (args as { language?: string }).language === 'string'
          ? { language: (args as { language: string }).language }
          : {}),
        ...(typeof (args as { force?: boolean }).force === 'boolean'
          ? { force: (args as { force: boolean }).force }
          : {}),
      }
      return projectBegin(await requireManager().begin(input))
    },
  }))

  /* openwiki_submit_plan — validate and durably persist the ordered queue. */
  ctx.tools.register(defineOpenWikiTool({
    name: 'openwiki_submit_plan',
    device: true,
    description:
      'Submit the final canonical page plan. OpenWiki validates it and durably persists the ordered PageJob queue before accepting it.',
    parameters: {
      runId: { type: 'string', description: 'Stable run UUID returned by openwiki_begin.', required: true },
      pages: {
        type: 'array',
        description: 'Ordered proposed page queue.',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            title: { type: 'string', required: true },
            purpose: { type: 'string', required: true },
            seedPaths: { type: 'array', items: { type: 'string' } },
            relatedPages: { type: 'array', items: { type: 'string' } },
            instructions: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      deletePages: { type: 'array', items: { type: 'string' }, description: 'Existing generated pages to delete.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          totalPages: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [
        { type: 'text', text: renderValue(value) },
      ],
    },
    async execute(args) {
      const a = args as SubmitPlanRequest & { runId: string }
      const planned = await requireManager().submitPlan({
        runId: a.runId,
        pages: a.pages.map(p => ({
          path: p.path,
          title: p.title,
          purpose: p.purpose,
          ...(p.seedPaths ? { seedPaths: p.seedPaths } : {}),
          ...(p.relatedPages ? { relatedPages: p.relatedPages } : {}),
          ...(p.instructions ? { instructions: p.instructions } : {}),
        })),
        ...(a.deletePages ? { deletePages: a.deletePages } : {}),
      }) as PlanView
      return { ...planned, text: renderValue(planned) }
    },
  }))

  /* openwiki_next_page — current pending job and its existing Claims. */
  ctx.tools.register(defineOpenWikiTool({
    name: 'openwiki_next_page',
    device: true,
    description:
      'Return the first pending page job and its current Claims, or status=complete when no jobs remain.',
    parameters: {
      runId: { type: 'string', description: 'Stable run UUID returned by openwiki_begin.', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          job: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              path: { type: 'string' },
              title: { type: 'string' },
              purpose: { type: 'string' },
              mode: { type: 'string' },
              existing: { type: 'boolean' },
              existingClaims: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    statement: { type: 'string' },
                    evidence: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { resource: { type: 'string' } },
                      },
                    },
                  },
                },
              },
              instructions: { type: 'array', items: { type: 'string' } },
            },
          },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [
        { type: 'text', text: renderValue(value) },
      ],
    },
    async execute(args) {
      const a = args
      return projectNext(await requireManager().nextPage(a))
    },
  }))

  /* openwiki_submit_page — complete the current job with its Claim set. */
  ctx.tools.register(defineOpenWikiTool({
    name: 'openwiki_submit_page',
    device: true,
    description:
      'Complete the current page job after its Markdown is written by submitting that page\'s complete intended repository-grounded Claim set. Preserve the id, exact statement, and evidence resource values of each unchanged existing Claim; reuse its id for a necessary revision; omit it to retract it; and omit id for a genuinely new Claim. The final page and Claim set must agree.',
    parameters: {
      runId: { type: 'string', description: 'Stable run UUID returned by openwiki_begin.', required: true },
      jobId: { type: 'string', description: 'Current pending job UUID from openwiki_next_page.', required: true },
      claims: {
        type: 'array',
        description: 'Complete material Claim set for the finished page.',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Existing id to preserve/reuse; omit for a genuinely new Claim.' },
            statement: { type: 'string', required: true },
            evidence: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  resource: { type: 'string', required: true },
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          page: { type: 'string', required: true },
          remaining: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [
        { type: 'text', text: renderValue(value) },
      ],
    },
    async execute(args) {
      const a = args as SubmitPageRequest
      const submitted = await requireManager().submitPage({
        runId: a.runId,
        jobId: a.jobId,
        claims: a.claims.map(c => ({
          ...(c.id !== undefined ? { id: c.id } : {}),
          statement: c.statement,
          evidence: c.evidence.map(e => ({ resource: e.resource })),
        })),
      }) as PageView
      return { ...submitted, text: renderValue(submitted) }
    },
  }))

  /* openwiki_finish — strict deterministic finalization of a complete run. */
  ctx.tools.register(defineOpenWikiTool({
    name: 'openwiki_finish',
    device: true,
    description:
      'Finish only after every PageJob is complete. Runs deterministic deletion, validation, indexing, provenance, Claims finalization, and run metadata persistence.',
    parameters: {
      runId: { type: 'string', description: 'Stable run UUID returned by openwiki_begin.', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          sourceChanged: { type: 'boolean' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [
        { type: 'text', text: renderValue(value) },
      ],
    },
    async execute(args) {
      const a = args
      const finished = await requireManager().finish(a) as FinishView
      return { ...finished, text: renderValue(finished) }
    },
  }))
}

/** Renders lifecycle results as stable JSON text and maps errors for output. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '{}'
  return JSON.stringify(value, null, 2)
}

/**
 * Engine results leave `HostSessionManager` as `unknown` (the upstream
 * transport-neutral contract), and their views carry fields beyond the tool's
 * stable output schema. Each executor projects the engine view onto the
 * declared schema shape and folds the full detail into `text`, so the
 * model-readable summary stays complete while the structured fields stay
 * exactly contract-bound.
 */
function projectBegin(raw: unknown): BeginView {
  const view = (raw ?? {}) as Record<string, unknown>
  const summary: Record<string, unknown> = {}
  for (const key of [
    'status', 'runId', 'root', 'mode', 'language', 'languageChanged',
    'phase', 'resumed', 'lastUpdate', 'wikiGoal', 'changedPaths',
    'pageUpdateWindows', 'claimIssues', 'completedPages', 'totalPages',
  ]) {
    if (view[key] !== undefined) summary[key] = view[key]
  }
  const status = typeof view.status === 'string' ? view.status : 'error'
  return {
    status,
    text: renderValue(summary),
    ...(typeof view.runId === 'string' ? { runId: view.runId } : {}),
    ...(typeof view.mode === 'string' ? { mode: view.mode } : {}),
    ...(typeof view.language === 'string' ? { language: view.language } : {}),
    ...(typeof view.phase === 'string' ? { phase: view.phase } : {}),
    ...(Array.isArray(view.changedPaths) ? { changedPaths: view.changedPaths.filter((p): p is string => typeof p === 'string') } : {}),
    ...(Array.isArray(view.claimIssues) ? { claimIssues: view.claimIssues as JsonValue[] } : {}),
  }
}

function projectNext(raw: unknown): NextView {
  const view = (raw ?? {}) as Record<string, unknown>
  if (view.status === 'complete' || typeof view.job !== 'object' || view.job === null) {
    return { status: 'complete', text: renderValue(view) }
  }
  const job = view.job as Record<string, unknown>
  const projected: NextView['job'] = {
    ...(typeof job.id === 'string' ? { id: job.id } : {}),
    ...(typeof job.path === 'string' ? { path: job.path } : {}),
    ...(typeof job.title === 'string' ? { title: job.title } : {}),
    ...(typeof job.purpose === 'string' ? { purpose: job.purpose } : {}),
    ...(typeof job.mode === 'string' ? { mode: job.mode } : {}),
    ...(typeof job.existing === 'boolean' ? { existing: job.existing } : {}),
    ...(Array.isArray(job.instructions) ? { instructions: job.instructions.filter((s): s is string => typeof s === 'string') } : {}),
    ...(Array.isArray(job.existingClaims)
      ? {
        existingClaims: job.existingClaims
          .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
          .map(c => ({
            ...(typeof c.id === 'string' ? { id: c.id } : {}),
            ...(typeof c.statement === 'string' ? { statement: c.statement } : {}),
            ...(Array.isArray(c.evidence)
              ? {
                evidence: c.evidence
                  .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
                  .map(e => ({ ...(typeof e.resource === 'string' ? { resource: e.resource } : {}) })),
              }
              : {}),
          })),
      }
      : {}),
  }
  return { status: 'pending', job: projected, text: renderValue(view) }
}

/**
 * Engine results leave `HostSessionManager` as `unknown` (the upstream
 * transport-neutral contract). These views name the stable JSON shapes the
 * five tools expose; the engines guarantee them (begin/submit_plan next_page/
 * submit_page/finish are upstream's own view builders).
 */
interface BeginView {
  status: string
  text: string
  mode?: string
  language?: string
  runId?: string
  phase?: string
  changedPaths?: string[]
  claimIssues?: JsonValue[]
}

interface PlanView {
  status: string
  text: string
  totalPages: number
}

interface NextView {
  status: string
  text: string
  job?: {
    id?: string
    path?: string
    title?: string
    purpose?: string
    mode?: string
    existing?: boolean
    existingClaims?: Array<{
      id?: string
      statement?: string
      evidence?: Array<{ resource?: string }>
    }>
    instructions?: string[]
  }
}

interface PageView {
  status: string
  text: string
  page: string
  remaining: number
}

interface FinishView {
  status: string
  text: string
  sourceChanged?: boolean
}
