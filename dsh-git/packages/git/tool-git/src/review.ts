/**
 * The `review` tool: fan out dedicated reviewer subagents in parallel over a
 * git diff (working tree, staged, or a commit range), collect P0–P3 findings
 * with confidence, and produce a ship/reject verdict.
 *
 * Port of omp's `/review` for the harness. omp's reviewer persona
 * (`prompts/agents/reviewer.md`) is adapted into a plain prompt handed to
 * `ctx.subagents` children with a typed `outputSchema`, so each reviewer
 * returns structured verdict + findings instead of prose; aggregation is local.
 * See LICENSE.
 * @module @hy-sde-org/dsh-tool-git/review
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { parseFileDiffs } from '@hy-sde-org/dsh-git'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { resolveCwd } from './commit.ts'
import { openReads, type ReadSurface } from './reads.ts'
import { headOf, indexTreeOf, recordReviewVerdict } from './push-gate.ts'
import type { GitService } from '@hy-sde-org/dsh-git'

/** Configuration consumed by the review tool. */
export interface ReviewToolConfig {
  /** `ctx.subagents` provider name to run reviewers on (default `spawn`). */
  provider?: string
  /** Default cap on parallel reviewers (default 4). */
  maxReviewers?: number
  /** Char cap on the diff inlined into one reviewer prompt (default 40000). */
  maxReviewerDiffChars?: number
}

const DEFAULT_PROVIDER = 'spawn'
const DEFAULT_MAX_REVIEWERS = 4
const DEFAULT_MAX_REVIEWER_DIFF_CHARS = 40_000

type FindingPriority = 'P0' | 'P1' | 'P2' | 'P3'

interface ReviewerFinding {
  title: string
  body: string
  priority: FindingPriority
  confidence: number
  file_path: string
  line_start: number
  line_end: number
}

interface ReviewFinding extends ReviewerFinding {
  reviewer: string
}

interface SliceResult {
  label: string
  files: string[]
  overall_correctness: 'correct' | 'incorrect'
  explanation: string
  confidence: number
  findings: ReviewerFinding[]
}

export type { SliceResult, ReviewerFinding }

interface ReviewArgs {
  target?: 'worktree' | 'staged' | 'commits'
  range?: string
  focus?: string[]
  maxReviewers?: number
  cwd?: string
}

interface ReviewValue {
  target: 'worktree' | 'staged' | 'commits'
  files: string[]
  diffTruncated: boolean
  findings: ReviewFinding[]
  verdict: 'ship' | 'reject'
  verdictExplanation: string
  confidence: number
  slices: SliceResult[]
  errors: string[]
  warnings: string[]
}

/** Subagent `outputSchema` — the standard JSON-Schema dialect
 * (object-level `required` arrays; per-property must appear in `properties`). */
const REVIEWER_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['overall_correctness', 'explanation', 'confidence', 'findings'],
  properties: {
    overall_correctness: { type: 'string', enum: ['correct', 'incorrect'] },
    explanation: { type: 'string' },
    confidence: { type: 'number' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body', 'priority', 'confidence', 'file_path', 'line_start', 'line_end'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          priority: { type: 'integer', enum: [0, 1, 2, 3] },
          confidence: { type: 'number' },
          file_path: { type: 'string' },
          line_start: { type: 'integer' },
          line_end: { type: 'integer' },
        },
      },
    },
  },
}

const PRIORITY_LABELS: readonly FindingPriority[] = ['P0', 'P1', 'P2', 'P3']

export function toPriority(value: unknown): FindingPriority {
  if (value === 0 || value === '0') return 'P0'
  if (value === 1 || value === '1') return 'P1'
  if (value === 2 || value === '2') return 'P2'
  return 'P3'
}

/** Record a staged review verdict for the push gate (no-op for other targets). */
async function recordStagedVerdict(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
  value: ReviewValue,
): Promise<void> {
  if (value.target !== 'staged') return
  recordReviewVerdict({
    root: await git.root(cwd, signal),
    target: value.target,
    verdict: value.verdict,
    beforeHead: await headOf(git, cwd, signal),
    indexTree: await indexTreeOf(git, cwd, signal),
    at: Date.now(),
  })
}

export function applyReviewTool(ctx: Context, config: ReviewToolConfig = {}): void {
  const provider = config.provider ?? DEFAULT_PROVIDER
  const maxReviewers = config.maxReviewers ?? DEFAULT_MAX_REVIEWERS
  const maxReviewerDiffChars = config.maxReviewerDiffChars ?? DEFAULT_MAX_REVIEWER_DIFF_CHARS

  ctx.tools.register(defineTool({
    name: 'review',
    description:
      'Run a parallel code review over git changes (working tree, staged, or a commit range) with dedicated reviewer '
      + 'subagents. Every finding is ranked P0–P3 with a confidence score; the tool returns all findings sorted by severity '
      + 'and a ship/reject verdict with explanation. Reviewers are read-only (git diff/log/show, read, grep, ast_grep) and '
      + 'never edit files or run builds. Use the focus filter to review only the paths that matter.',
    parameters: {
      target: {
        type: 'string',
        enum: ['worktree', 'staged', 'commits'],
        description: 'What to review: working-tree changes vs HEAD (default, includes staged + unstaged), only staged, or a commit range.',
      },
      range: {
        type: 'string',
        description: 'Commit range like HEAD~3..HEAD when target is commits (both endpoints resolved by git).',
      },
      focus: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subset of paths/prefixes to restrict the review to; other files are skipped.',
      },
      maxReviewers: {
        type: 'integer',
        description: `Cap on parallel reviewers (default ${maxReviewers}); the diff is split into at most this many slices.`,
      },
      cwd: { type: 'string', description: 'Working directory; defaults to the session workspace.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true, enum: ['worktree', 'staged', 'commits'] },
          files: { type: 'array', required: true, items: { type: 'string' } },
          diffTruncated: { type: 'boolean', required: true },
          verdict: { type: 'string', required: true, enum: ['ship', 'reject'] },
          verdictExplanation: { type: 'string', required: true },
          confidence: { type: 'number', required: true },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                body: { type: 'string', required: true },
                priority: { type: 'string', required: true, enum: ['P0', 'P1', 'P2', 'P3'] },
                confidence: { type: 'number', required: true },
                file_path: { type: 'string', required: true },
                line_start: { type: 'integer', required: true },
                line_end: { type: 'integer', required: true },
                reviewer: { type: 'string', required: true },
              },
            },
          },
          slices: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', required: true },
                files: { type: 'array', required: true, items: { type: 'string' } },
                overall_correctness: { type: 'string', required: true, enum: ['correct', 'incorrect'] },
                explanation: { type: 'string', required: true },
                confidence: { type: 'number', required: true },
                findings: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      title: { type: 'string', required: true },
                      body: { type: 'string', required: true },
                      priority: { type: 'string', required: true, enum: ['P0', 'P1', 'P2', 'P3'] },
                      confidence: { type: 'number', required: true },
                      file_path: { type: 'string', required: true },
                      line_start: { type: 'integer', required: true },
                      line_end: { type: 'integer', required: true },
                    },
                  },
                },
              },
            },
          },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value: ReviewValue) => [{
        type: 'text',
        text: renderReview(value),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args: ReviewArgs, exec) {
      const cwd = resolveCwd(exec, args.cwd)
      const reads = await openReads(ctx, cwd, exec.signal)
      if (!(await reads.isRepo())) {
        throw new Error(`review requires a git repository: ${cwd} is not inside a working tree`)
      }
      const parent = exec.agent
      if (!parent) {
        throw new Error('review requires a calling agent (exec.agent was undefined)')
      }
      const subagents = ctx.get('subagents')
      if (subagents === undefined || subagents.getProvider(provider) === undefined) {
        throw new Error(`review needs a subagent provider "${provider}" — load @deepseek-ai/dsh-tool-subagent with that provider first`)
      }

      const target = args.target ?? 'worktree'
      const diffText = await resolveReviewDiff(reads, target, args.range)
      const allFiles = Array.from(new Set(parseFileDiffs(diffText).map(file => file.filename)))

      const focus = (args.focus ?? []).map(prefix => prefix.replace(/\/+$/, ''))
      const files = focus.length > 0
        ? allFiles.filter(file => focus.some(prefix => file === prefix || file.startsWith(`${prefix}/`)))
        : allFiles
      const warnings: string[] = []
      if (focus.length > 0 && files.length === 0) {
        warnings.push(`no changed files matched the focus filter: ${focus.join(', ')}`)
      }

      if (files.length === 0) {
        const value: ReviewValue = {
          target,
          files: [],
          diffTruncated: false,
          findings: [],
          verdict: 'ship',
          verdictExplanation: 'No changed files to review.',
          confidence: 1,
          slices: [],
          errors: [],
          warnings,
        }
        await recordStagedVerdict(ctx.git, cwd, exec.signal, value)
        return value
      }

      // Cap the inline diff handed to any one reviewer up front.
      let anyTruncated = false
      const diffFor = new Map<string, string>()
      for (const file of files) {
        let slice = gitDiffSection(diffText, file)
        if (slice.length > 0 && slice.length > maxReviewerDiffChars) {
          slice = slice.slice(0, maxReviewerDiffChars)
          anyTruncated = true
          warnings.push(`diff section for ${file} truncated to ${maxReviewerDiffChars} chars for the reviewer`)
        }
        if (slice.length > 0) diffFor.set(file, slice)
      }

      const budget = Math.max(1, Math.min(args.maxReviewers ?? maxReviewers, files.length))
      const slices = sliceByWeight(files, diffFor, budget)

      const settled = await Promise.allSettled(
        slices.map((sliceFiles, index) => collectSlice(sliceFiles, index)),
      )

      const slicesResult: SliceResult[] = []
      const errors: string[] = []
      for (const [i, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          if (result.value.kind === 'ok') {
            slicesResult.push(result.value.slice)
          } else {
            errors.push(`reviewer ${i + 1}/${slices.length} failed: ${result.value.error}`)
          }
        } else {
          errors.push(`reviewer ${i + 1}/${slices.length} failed: ${reasonOf(result.reason)}`)
        }
      }

      const findings: ReviewFinding[] = []
      for (const slice of slicesResult) {
        for (const finding of slice.findings) {
          findings.push({ ...finding, reviewer: slice.label })
        }
      }
      findings.sort((a, b) => {
        const pa = PRIORITY_LABELS.indexOf(a.priority)
        const pb = PRIORITY_LABELS.indexOf(b.priority)
        if (pa !== pb) return pa - pb
        return b.confidence - a.confidence
      })

      const incorrect = slicesResult.filter(slice => slice.overall_correctness === 'incorrect')
      // If every reviewer failed, we cannot approve unreviewed changes.
      const noReviewerCompleted = slicesResult.length === 0 && errors.length > 0
      const verdict: 'ship' | 'reject' = incorrect.length > 0 || noReviewerCompleted ? 'reject' : 'ship'
      const confidence = slicesResult.length === 0
        ? 0
        : Math.min(...slicesResult.map(slice => slice.confidence))
      const verdictExplanation = noReviewerCompleted
        ? `No reviewer completed (${errors.length} of ${slices.length} failed); refusing to approve unreviewed changes.`
        : verdict === 'reject'
          ? `${incorrect.length} of ${slicesResult.length} reviewers found blocking problems. `
            + incorrect.map(slice => `[${slice.label}] ${slice.explanation}`).join(' ')
          : 'All reviewers judged the change correct'
            + (slicesResult.length > 0 ? ` (${slicesResult.length} reviewer(s))` : '') + '.'
            + (findings.length > 0 ? ` ${findings.length} non-blocking finding(s) remain.` : '')

      const value: ReviewValue = {
        target,
        files,
        diffTruncated: anyTruncated,
        findings,
        verdict,
        verdictExplanation,
        confidence,
        slices: slicesResult,
        errors,
        warnings,
      }
      await recordStagedVerdict(ctx.git, cwd, exec.signal, value)
      return value

      async function collectSlice(sliceFiles: string[], index: number): Promise<
        { kind: 'ok'; slice: SliceResult } | { kind: 'error'; error: string }
      > {
        const label = `reviewer ${index + 1}/${slices.length}`
        const inline = sliceFiles.map(file => diffFor.get(file) ?? '').filter(Boolean).join('\n')
        const prompt = buildReviewerPrompt(label, sliceFiles, inline)
        // Narrowing from the outer scope does not flow into this closure; the
        // checks were already performed above (parent exists, subagents provides
        // the selected provider), so re-assert them for the type checker.
        if (subagents === undefined || parent === undefined) {
          return { kind: 'error', error: 'subagents or calling agent unavailable' }
        }
        const controller = new AbortController()
        const forwardAbort = (): void => { controller.abort() }
        exec.signal.addEventListener('abort', forwardAbort, { once: true })
        let run: SubagentRun
        try {
          run = await subagents.start(provider, {
            label,
            prompt: [{ type: 'text', text: prompt }] as ContentBlock[],
            parent,
            signal: controller.signal,
            outputSchema: REVIEWER_SCHEMA,
          })
        } catch (error: unknown) {
          exec.signal.removeEventListener('abort', forwardAbort)
          return { kind: 'error', error: `start failed: ${String(error)}` }
        }
        try {
          const result = await run.result
          if (result.stopReason === 'completed' && isSliceStructured(result.structured)) {
            const slice: SliceResult = {
              label,
              files: sliceFiles,
              overall_correctness: result.structured.overall_correctness,
              explanation: result.structured.explanation,
              confidence: result.structured.confidence,
              findings: (result.structured.findings ?? []).map(toReviewerFinding),
            }
            return { kind: 'ok', slice }
          }
          return {
            kind: 'error',
            error: `${result.stopReason}${result.diagnostic !== undefined ? ` (${result.diagnostic})` : ''}`,
          }
        } catch (error: unknown) {
          return { kind: 'error', error: String(error) }
        } finally {
          exec.signal.removeEventListener('abort', forwardAbort)
          try {
            await run.dispose()
          } catch {
            // disposal failures are not reviewer results
          }
        }
      }
    },
  }))
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

export function reasonOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

function isSliceStructured(value: unknown): value is {
  overall_correctness: 'correct' | 'incorrect'
  explanation: string
  confidence: number
  findings?: unknown[]
} {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (record.overall_correctness === 'correct' || record.overall_correctness === 'incorrect')
    && typeof record.explanation === 'string'
    && typeof record.confidence === 'number' && Number.isFinite(record.confidence)
}

function toReviewerFinding(value: unknown): ReviewerFinding {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    title: typeof record.title === 'string' ? record.title : '(untitled finding)',
    body: typeof record.body === 'string' ? record.body : '',
    priority: toPriority(record.priority),
    confidence: typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? record.confidence : 0,
    file_path: typeof record.file_path === 'string' ? record.file_path : '',
    line_start: typeof record.line_start === 'number' && Number.isFinite(record.line_start) ? record.line_start : 0,
    line_end: typeof record.line_end === 'number' && Number.isFinite(record.line_end) ? record.line_end : 0,
  }
}

/** Which diff to review for the given target. */
async function resolveReviewDiff(
  reads: ReadSurface,
  target: 'worktree' | 'staged' | 'commits',
  range: string | undefined,
): Promise<string> {
  if (target === 'staged') return reads.diffText({ cached: true })
  if (target === 'commits') {
    if (range === undefined || range.length === 0) {
      throw new Error('review target "commits" requires a range, e.g. HEAD~3..HEAD')
    }
    const dash = range.indexOf('..')
    if (dash === -1) {
      throw new Error(`review range must be base..head (e.g. HEAD~3..HEAD), got "${range}"`)
    }
    const base = range.slice(0, dash)
    const head = range.slice(dash + 2)
    return reads.diffText({ base, ...(head.length > 0 ? { head } : {}) })
  }
  // worktree: everything vs HEAD (staged + unstaged; untracked files are
  // excluded — reviewers judge tracked changes).
  return reads.diffText({ base: 'HEAD' })
}

/** Split `files` into at most `budget` slices balanced by diff size. */
export function sliceByWeight(files: readonly string[], diffFor: Map<string, string>, budget: number): string[][] {
  if (budget <= 1) return [files.slice()]
  const weight = (file: string): number => diffFor.get(file)?.length ?? 1
  const ordered = files.slice()
  ordered.sort((a, b) => weight(b) - weight(a))
  const slices: string[][] = Array.from({ length: budget }, () => [])
  const load = new Array<number>(budget).fill(0)
  for (const file of ordered) {
    let lightest = 0
    for (let i = 1; i < budget; i++) if ((load[i] ?? 0) < (load[lightest] ?? 0)) lightest = i
    slices[lightest]?.push(file)
    load[lightest] = (load[lightest] ?? 0) + weight(file)
  }
  return slices
}

/** Extract the `diff --git` section for one file from a whole diff text. */
export function gitDiffSection(diffText: string, file: string): string {
  const parts = diffText.split('\ndiff --git ')
  for (let index = 0; index < parts.length; index += 1) {
    const raw = parts[index] ?? ''
    const part = index === 0 ? raw : `diff --git ${raw}`
    if (!part.trim()) continue
    const header = part.split('\n')[0] ?? ''
    if (new RegExp(` b/${escapeRegExp(file)}$`).test(header) || header === `diff --git a/${file} b/${file}`) return part
  }
  return ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The reviewer instruction prompt (adapted from omp reviewer.md). */
export function buildReviewerPrompt(label: string, files: readonly string[], inlineDiff: string): string {
  const parts: string[] = []
  parts.push(`You are ${label}, a code review specialist performing a READ-ONLY review.`)
  parts.push('')
  parts.push('OWNED FILES (review these; other changed files are out of scope):')
  for (const file of files) parts.push(`- ${file}`)
  parts.push('')
  parts.push('Find bugs the author wants fixed before merge.')
  parts.push('')
  parts.push('PROCEDURE')
  parts.push('1. Patch: `git diff` (recomputed) or the inline diff below — never trust it blindly.')
  parts.push('2. Read the FULL context of each modified file with read/lsp before judging (the inline diff omits surrounding code).')
  parts.push('3. Report each issue as a finding (see OUTPUT).')
  parts.push('4. Return the final verdict in the structured result (see OUTPUT).')
  parts.push('')
  parts.push('CRITERIA — report only issues meeting ALL: provable impact (no speculation); actionable (discrete fix); '
    + 'unintentional (not a deliberate design choice); introduced in the patch (do not flag pre-existing bugs); '
    + 'no unstated assumptions; rigorous only to the level present elsewhere in the codebase.')
  parts.push('')
  parts.push('CHECK boundary-crossing values: every patch-introduced type/variant/value crossing a function or module '
    + 'boundary (event, message, command, frame, enum variant, queue item, IPC payload) needs its consuming-side dispatch '
    + 'point to forward it explicitly. A silent-drop/no-op at the consumer is a defect — read the consumer before concluding.')
  parts.push('')
  parts.push('PRIORITY — P0: blocks release/operations, universal impact (data corruption, auth bypass). '
    + 'P1: high, fix next cycle (race under load). P2: medium, fix eventually (edge-case mishandling). '
    + 'P3: info / nice to have (suboptimal but correct).')
  parts.push('')
  parts.push(`INLINE DIFF (may be truncated; recompute with git diff / git diff --cached / git diff <range>):\n\n${inlineDiff}`)
  parts.push('')
  parts.push('RULES: This is READ-ONLY. NEVER edit files, never stage, never commit, never run builds or tests that mutate '
    + 'state — git diff/log/show/status and file reads only.')
  parts.push('')
  parts.push('OUTPUT: Return the structured result with `overall_correctness` ("correct" = no bugs/blockers, ignoring '
    + 'style/docs/nits, or "incorrect") and `explanation` (1-3 sentences). `findings` is an array where each item has '
    + 'title (imperative, ≤80 chars), body (one paragraph: bug, trigger, impact), priority (0=P0 … 3=P3), '
    + 'confidence (0.0-1.0 it is a real bug), file_path, line_start, line_end (≤10-line range overlapping the diff). '
    + 'Never invent findings: every finding must be patch-anchored and evidence-backed. Findings that are not patch-introduced '
    + 'or have no provable impact should not be reported.')
  return parts.join('\n')
}

function renderReview(value: ReviewValue): string {
  const lines: string[] = []
  lines.push(`Review (${value.target}) — ${value.files.length} file(s), verdict: ${value.verdict.toUpperCase()}`
    + ` (confidence ${Math.round(value.confidence * 100)}%)`)
  lines.push(value.verdictExplanation)
  if (value.findings.length > 0) {
    lines.push('')
    lines.push(`Findings (${value.findings.length}, sorted by severity):`)
    for (const finding of value.findings) {
      lines.push(`  [${finding.priority}] (${Math.round(finding.confidence * 100)}%) ${finding.title}`)
      if (finding.body.length > 0) lines.push(`      ${finding.body}`)
      lines.push(`      ${finding.file_path}:${finding.line_start}-${finding.line_end}  (reviewer ${finding.reviewer})`)
    }
  } else {
    lines.push('')
    lines.push('No findings reported.')
  }
  if (value.errors.length > 0) {
    lines.push('')
    lines.push(`Reviewer failures (${value.errors.length}):`)
    for (const error of value.errors) lines.push(`  - ${error}`)
  }
  for (const warning of value.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}
