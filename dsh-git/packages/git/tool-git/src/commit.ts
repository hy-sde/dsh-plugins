/**
 * The two commit tools over `ctx.git`: `commit` analyzes the staged/working
 * tree and returns ground truth plus a suggested split plan, and
 * `commit_apply` validates and executes a plan the model authors (dependency
 * order, cycle rejection, lock-file placement, hunk staging, atomic commits).
 *
 * Port of omp (oh-my-pi)'s agentic commit flow, re-architected for the harness:
 * omp runs its own hidden LLM session; here the model scripts the plan between
 * the two tool calls, so every decision is visible and reviewable (see
 * LICENSE). The deterministic parts — validation, topo order,
 * lock-file assignment, execution — are direct ports.
 * @module @hy-sde-org/dsh-tool-git/commit
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { openReads } from './reads.ts'
import type { OrchestrationPolicyService } from './orchestration-policy.ts'
import { resolvePosture } from './orchestration-policy.ts'
import { decidePushGate, headOf, indexTreeOf, latestStagedVerdict } from './push-gate.ts'
import {
  formatCommitMessage,
  assignLockFilesToPlan,
  detectTrivialChange,
  computeDependencyOrder,
  validateHunkSelections,
  EXCLUDED_LOCK_FILES,
  withRepoLock,
  vcs,
  conventional,
} from '@hy-sde-org/dsh-git'
import type { CommitType, NumstatEntry, SplitCommitGroup, SplitCommitPlan } from '@hy-sde-org/dsh-git'

/** Commit-type vocabulary for schema + validation (llm-git canonical, 22 types). */
const COMMIT_TYPES: readonly CommitType[] = [...conventional.COMMIT_TYPE_ORDER]

/** Call working directory resolution shared by the git tools. */
/** Read the optional policy service; the gate is active only when the policy is enabled and its gate is on. */
export function reviewGateOf(ctx: Context): import('./orchestration-policy.ts').ResolvedReviewGateConfig | undefined {
  const policy = ctx.get('orchestrationPolicy') as OrchestrationPolicyService | undefined
  if (policy === undefined || !policy.config.enabled) return undefined
  return policy.config.reviewGate.enabled ? policy.config.reviewGate : undefined
}

export function resolveCwd(exec: ToolExecution, cwdArg: string | undefined): string {
  const base = exec.agent?.session.header.cwd
  if (typeof base === 'string' && base.length > 0) {
    return cwdArg === undefined ? base : (cwdArg.startsWith('/') ? cwdArg : joinPath(base, cwdArg))
  }
  return cwdArg ?? process.cwd()
}

function joinPath(base: string, rel: string): string {
  if (rel === '.' || rel === './') return base
  return `${base.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`
}

/** Configuration consumed by the commit tools. */
export interface CommitToolConfig {
  /** Char cap on the diff text included in a `commit` analysis (default 60000). */
  maxDiffChars?: number
}

const DEFAULT_MAX_DIFF_CHARS = 60_000

/** JSON-compatible union (structural twin of dsh-shared's JsonValue) for
 * casting plan skeletons across the tool-output boundary without a new peer dep. */
type JsonCompat = null | boolean | number | string | JsonCompat[] | { [key: string]: JsonCompat }

/* ── commit (analyze) ────────────────────────────────────────────────────── */

interface CommitAnalyzeArgs {
  /** Use only what is already staged; do not stage the rest. */
  stagedOnly?: boolean
  /** Additional user context for the model's plan (branch intent, scope). */
  context?: string
  /** Call working directory. */
  cwd?: string
}

export interface CommitChangeSuggestion {
  path: string
  additions: number
  deletions: number
}

export interface CommitAnalysisValue {
  cwd: string
  branch?: string
  staged: boolean
  files: NumstatEntry[]
  untrackedFiles: string[]
  diff: string
  diffTruncated: boolean
  trivial?: { type: CommitType; summary: string }
  lockFilesPending: string[]
  suggestedPlan: readonly unknown[]
  warnings: string[]
  analysisGuidance: string
}

export function applyCommitTool(ctx: Context, config: CommitToolConfig = {}): void {
  const maxDiffChars = config.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS
  ctx.tools.register(defineTool({
    name: 'commit',
    description:
      'Analyze the current git changes and produce a conventional-commit split proposal. '
      + 'Reads the staged (or auto-staged working) tree, returns per-file add/delete counts, the bounded diff text, '
      + 'lock-file hints, and a suggested plan skeleton. After reading the analysis, author a precise `SplitCommitPlan` '
      + '(types, scopes, summaries, dependencies) and pass it to `commit_apply` to execute. Never edit files here: this '
      + 'tool is read-only and never writes to the repository.',
    parameters: {
      stagedOnly: { type: 'boolean', description: 'Analyze only what is already staged; when false and nothing is staged, stage all changes first (default false).' },
      context: { type: 'string', description: 'Optional user context for planning: intent, headline change, reviewers, issue refs.' },
      cwd: { type: 'string', description: 'Working directory; defaults to the session workspace.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwd: { type: 'string', required: true },
          branch: { type: 'string' },
          staged: { type: 'boolean', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                additions: { type: 'integer', required: true },
                deletions: { type: 'integer', required: true },
              },
            },
          },
          untrackedFiles: { type: 'array', required: true, items: { type: 'string' } },
          diff: { type: 'string', required: true },
          diffTruncated: { type: 'boolean', required: true },
          trivial: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', required: true, enum: [...COMMIT_TYPES] },
              summary: { type: 'string', required: true },
            },
          },
          lockFilesPending: { type: 'array', required: true, items: { type: 'string' } },
          suggestedPlan: {
            type: 'array',
            required: true,
            items: { type: 'json' },
          },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          analysisGuidance: { type: 'string', required: true },
        },
      },
      render: (_args, value: CommitAnalysisValue) => [{
        type: 'text',
        text: renderCommitAnalysis(value),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args: CommitAnalyzeArgs, exec) {
      const cwd = resolveCwd(exec, args.cwd)
      const reads = await openReads(ctx, cwd, exec.signal)
      if (!(await reads.isRepo())) {
        throw new Error(`commit requires a git repository: ${cwd} is not inside a working tree`)
      }
      const warnings: string[] = []
      let stagedFiles = await reads.changedFiles({ cached: true })

      if (stagedFiles.length === 0 && !args.stagedOnly) {
        const status = await reads.status()
        if (status.unstaged > 0 || status.untracked > 0) {
          await ctx.git.addAll(cwd, [], exec.signal)
          warnings.push('nothing was staged; staged all working-tree changes automatically for analysis')
        }
        stagedFiles = await reads.changedFiles({ cached: true })
      }

      if (stagedFiles.length === 0) {
        const status = await reads.status()
        if (status.untracked > 0) {
          warnings.push(`detected ${status.untracked} untracked file(s) not included — rerun without stagedOnly to stage them`)
        }
        return {
          cwd,
          staged: false,
          files: [],
          untrackedFiles: [],
          diff: '',
          diffTruncated: false,
          lockFilesPending: [],
          suggestedPlan: [],
          warnings,
          analysisGuidance: 'No staged changes and nothing was auto-staged. Nothing to commit.',
        } satisfies CommitAnalysisValue
      }

      const numstat = await reads.numstat({ cached: true })
      const branch = (await reads.branch()) ?? undefined

      let diffText = await reads.diffText({ cached: true })
      let diffTruncated = false
      if (diffText.length > maxDiffChars) {
        diffText = diffText.slice(0, maxDiffChars)
        diffTruncated = true
        warnings.push('diff truncated: use read/grep on the listed files for the full picture')
      }

      const trivial = detectTrivialChange(diffText)
      const lockFilesPending = stagedFiles.filter((file) => {
        const parts = file.split('/')
        const basename = parts[parts.length - 1] ?? ''
        return EXCLUDED_LOCK_FILES.has(basename)
      })
      // Lock files are auto-placed by commit_apply; keep them out of the
      // plan skeleton so the model plans only real changes.
      const planSource = stagedFiles.filter((file) => {
        const parts = file.split('/')
        const basename = parts[parts.length - 1] ?? ''
        return !EXCLUDED_LOCK_FILES.has(basename)
      })

      const suggestedPlan = trivial
        ? [{
          changes: planSource.map(path => ({ path, hunks: { type: 'all' as const } })),
          type: trivial.type,
          scope: null,
          summary: trivial.summary,
          details: [],
          issueRefs: [],
          dependencies: [],
          rationale: 'trivial change detected (formatted/imports); single commit',
        }]
        : buildSuggestedGroups(planSource)

      const analysisGuidance = buildAnalysisGuidance(trivial, planSource.length, suggestedPlan.length)

      return {
        cwd,
        ...(branch !== undefined ? { branch } : {}),
        staged: true,
        files: numstat,
        untrackedFiles: [],
        diff: diffText,
        diffTruncated,
        ...(trivial !== null ? { trivial } : {}),
        lockFilesPending,
        suggestedPlan: suggestedPlan as unknown as JsonCompat[],
        warnings,
        analysisGuidance,
      } satisfies CommitAnalysisValue
    },
  }))
}

/** Deterministic per-top-directory grouping skeleton for the model to refine. */
function buildSuggestedGroups(stagedFiles: readonly string[]): SplitCommitGroup[] {
  const byDir = new Map<string, string[]>()
  for (const file of stagedFiles) {
    const slash = file.indexOf('/')
    const dir = slash === -1 ? '(root)' : file.slice(0, slash)
    const list = byDir.get(dir)
    if (list) list.push(file)
    else byDir.set(dir, [file])
  }
  const groups: SplitCommitGroup[] = []
  for (const [dir, files] of byDir) {
    groups.push({
      changes: files.map(path => ({ path, hunks: { type: 'all' } })),
      type: 'chore',
      scope: dir === '(root)' ? null : dir,
      summary: '',
      details: [],
      issueRefs: [],
      dependencies: [],
      rationale: `placeholder group for ${files.length} file(s) under "${dir}" — edit type/scope/summary and add dependencies`,
    })
  }
  return groups
}

function buildAnalysisGuidance(
  trivial: { type: CommitType; summary: string } | null,
  fileCount: number,
  groupCount: number,
): string {
  if (trivial) {
    return `Trivial change (${trivial.type}: ${trivial.summary}) — call commit_apply with the suggested single commit group to commit directly.`
  }
  return 'Author a split plan in `commit_apply`: pick a conventional type per group, write a concise imperative summary, '
    + 'group related files together, and declare explicit `dependencies` indices when ordering matters (e.g. a lock file '
    + 'after its manifest, generated code after the generator). Order is derived topologically; cycles are rejected. '
    + `The suggested skeleton groups ${fileCount} file(s) into ${groupCount} group(s) — refine it, do not copy summaries verbatim.`
}

function renderCommitAnalysis(value: CommitAnalysisValue): string {
  const lines: string[] = []
  lines.push(`commit analysis — ${value.cwd}${value.branch ? ` (branch ${value.branch})` : ''}`)
  if (value.files.length === 0) {
    lines.push('No staged changes to commit.')
    return lines.join('\n')
  }
  lines.push(`Files (${value.files.length} staged):`)
  for (const file of value.files) {
    lines.push(`  ${file.path}  +${file.additions} -${file.deletions}`)
  }
  if (value.lockFilesPending.length > 0) {
    lines.push(`Lock files auto-placed by commit_apply: ${value.lockFilesPending.join(', ')}`)
  }
  if (value.trivial) {
    lines.push(`Trivial: ${value.trivial.type} — ${value.trivial.summary}`)
  }
  if (value.diff.length > 0) {
    lines.push(value.diffTruncated ? 'Diff (truncated):' : 'Diff:')
    lines.push(value.diff)
  }
  for (const warning of value.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}

/* ── commit_apply (execute) ──────────────────────────────────────────────── */

interface LooseCommitGroup {
  changes: Array<{ path: string; hunks?: unknown }>
  type: CommitType
  summary: string
  scope?: string | null
  details?: Array<{ text: string; userVisible?: boolean }>
  issueRefs?: string[]
  dependencies?: number[]
  rationale?: string
}

interface CommitApplyArgs {
  commits?: LooseCommitGroup[]
  dryRun?: boolean
  push?: boolean
  cwd?: string
}

export interface CommitCreated {
  position: number
  hash: string
  message: string
  changes: string[]
}

export interface CommitApplyValue {
  mode: 'single' | 'split'
  created: CommitCreated[]
  messages: string[]
  warnings: string[]
  dryRun: boolean
}

/** Validate a plan's group fields; returns a readable error per problem. */
function validateGroupFields(commits: readonly LooseCommitGroup[]): string[] {
  const errors: string[] = []
  for (const [i, group] of commits.entries()) {
    const label = `group ${i + 1}`
    if (!COMMIT_TYPES.includes(group.type)) {
      errors.push(`${label}: unknown commit type "${group.type}"; use one of ${COMMIT_TYPES.join(', ')}`)
    }
    if (typeof group.summary !== 'string' || group.summary.trim().length === 0) {
      errors.push(`${label}: summary is required and must be non-empty`)
    }
    if (!Array.isArray(group.changes) || group.changes.length === 0) {
      errors.push(`${label}: changes is required and must list at least one path`)
    }
    if (group.scope !== undefined && group.scope !== null && typeof group.scope !== 'string') {
      errors.push(`${label}: scope must be a string or null`)
    }
    if (!Array.isArray(group.dependencies)) {
      errors.push(`${label}: dependencies must be an array of group indices`)
    }
  }
  return errors
}

/**
 * Advisory conventional-commit quality checks (llm-git rules) for a split
 * plan. Never blocks: returns one readable line per issue so the model can
 * refine summaries/types in its next round. `warnings` is mutated for
 * stat-free cross-checks (type/file extension consistency).
 */
function collectConventionalAdvisories(
  commits: readonly SplitCommitGroup[],
  _warnings: string[],
): string[] {
  const lines: string[] = []
  for (const [i, group] of commits.entries()) {
    const label = `group ${i + 1}`
    const commitMessage = {
      type: group.type,
      scope: group.scope ?? null,
      summary: group.summary,
      body: group.details.map(detail => detail.text),
      footers: group.issueRefs.map(ref => `Refs: ${ref}`),
    }
    const report = conventional.validateSummaryQuality(group.summary, group.type)
    for (const issue of report.errors) {
      lines.push(`${label} [${issue.code}] ${issue.message}`)
    }
    // Validate the full message shape too (lengths, trailing period, scope).
    const full = conventional.validateCommitMessage(commitMessage, conventional.DEFAULT_CONVENTIONAL_CONFIG)
    for (const issue of full.errors) {
      if (!lines.includes(`${label} [${issue.code}] ${issue.message}`)) {
        lines.push(`${label} [${issue.code}] ${issue.message}`)
      }
    }
  }
  return lines
}

export function applyCommitApplyTool(ctx: Context, _config: { timeoutMs?: number } = {}): void {
  ctx.tools.register(defineTool({
    name: 'commit_apply',
    description:
      'Execute a validated split-commit plan on the staged changes. Requires the plan produced with `commit`: every staged '
      + 'file must be covered exactly once, lock files are placed automatically, hunk selectors are validated against the '
      + 'real diff, dependencies are resolved topologically (cycles rejected before anything is written), and each commit is '
      + 'created atomically in dependency order. Use `dryRun: true` to preview exact messages before writing anything.',
    parameters: {
      commits: {
        type: 'array',
        description: 'Commit groups of the split plan (see commit_apply contract): each has changes [{path, hunks}], type, scope, summary, details, dependencies.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            changes: {
              type: 'array',
              required: true,
              description: 'Files (and optional hunk selectors) this commit covers; paths must name staged files.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  hunks: {
                    type: 'object',
                    description: 'Which part of the file to commit: all (default), indices (1-based hunk numbers), or lines (new-file line range).',
                    additionalProperties: false,
                    properties: {
                      type: { type: 'string', required: true, enum: ['all', 'indices', 'lines'] },
                      indices: { type: 'array', items: { type: 'integer' } },
                      start: { type: 'integer' },
                      end: { type: 'integer' },
                    },
                  },
                },
              },
            },
            type: { type: 'string', required: true, enum: [...COMMIT_TYPES], description: 'Conventional-commit type.' },
            scope: { type: 'string', description: 'Optional conventional scope.' },
            summary: { type: 'string', required: true, description: 'Imperative summary line, ≤72 chars.' },
            details: {
              type: 'array',
              description: 'Optional body bullet lines.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  text: { type: 'string', required: true },
                  userVisible: { type: 'boolean' },
                },
              },
            },
            issueRefs: { type: 'array', items: { type: 'string' } },
            dependencies: { type: 'array', items: { type: 'integer' }, description: 'Zero-based indices of groups that must commit first.' },
          },
        },
      },
      dryRun: { type: 'boolean', description: 'Validate and print the exact commit messages without writing anything (default false).' },
      push: { type: 'boolean', description: 'Push the current branch to `origin` after committing and record upstream tracking (`git push --set-upstream origin <branch>`), so PR flows can consume it. Requires a named branch: on a detached HEAD it fails with guidance (acquire a named-branch slot with `worktree acquire --branch`). Reruns stay no-follow-tags; force is never implied. Default false.' },
      cwd: { type: 'string', description: 'Working directory; defaults to the session workspace.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true, enum: ['single', 'split'] },
          created: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                position: { type: 'integer', required: true },
                hash: { type: 'string', required: true },
                message: { type: 'string', required: true },
                changes: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          messages: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          dryRun: { type: 'boolean', required: true },
        },
      },
      render: (_args, value: CommitApplyValue) => [{
        type: 'text',
        text: renderCommitApply(value),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args: CommitApplyArgs, exec) {
      const git = ctx.git
      const cwd = resolveCwd(exec, args.cwd)
      if (!(await git.isRepo(cwd, exec.signal))) {
        throw new Error(`commit_apply requires a git repository: ${cwd} is not inside a working tree`)
      }
      // Discovery-based repo identity for the advisory layer and the write
      // lock (VcsError NotARepository taxonomy at the tool boundary).
      vcs.requireGit(cwd)
      if (!Array.isArray(args.commits) || args.commits.length === 0) {
        throw new Error('commit_apply requires a non-empty commits plan (call `commit` first to analyze)')
      }

      // Snapshot the actual staged state; validation and execution trust this,
      // never the plan author's stale view.
      const stagedDiff = await git.diffText(cwd, { cached: true, binary: true }, exec.signal)
      const stagedFiles = await git.diff.changedFiles(cwd, { cached: true, signal: exec.signal })

      const plan: SplitCommitPlan = { commits: args.commits.map(cloneGroup), warnings: [] }
      const warnings = [...plan.warnings]
      if (stagedFiles.length === 0) {
        throw new Error('nothing is staged; run `commit` (adds changes) or `git add` first, or review `commit` with stagedOnly')
      }

      // P2 review gate (fail-closed): before any write, a gated push must carry
      // a current ship verdict for THIS staged range. The identity snapshot
      // happens before staging/committing so an unaffected index still matches.
      const pushGate = reviewGateOf(ctx)
      if (args.push && pushGate !== undefined) {
        const root = await git.root(cwd, exec.signal)
        const posture = resolvePosture(pushGate.posture, root, pushGate.default)
        if (posture === 'review-gated') {
          const gateDecision = decidePushGate({
            posture,
            record: latestStagedVerdict(root),
            beforeHead: await headOf(git, cwd, exec.signal),
            indexTree: await indexTreeOf(git, cwd, exec.signal),
            requireVerdict: pushGate.requireVerdict,
            onUnavailable: pushGate.onUnavailable,
          })
          if (!gateDecision.allowed) {
            throw new Error(`commit_apply --push refused by the review gate: ${gateDecision.reason}`)
          }
          warnings.push(gateDecision.reason)
        }
      }

      assignLockFilesToPlan(plan, stagedFiles)

      // Coverage: every staged file planned exactly once.
      const planned = new Set<string>()
      const duplicates: string[] = []
      for (const group of plan.commits) {
        for (const change of group.changes) {
          if (planned.has(change.path)) duplicates.push(change.path)
          planned.add(change.path)
        }
      }
      const missing = stagedFiles.filter(file => !planned.has(file))
      if (duplicates.length > 0) {
        throw new Error(`Split commit plan assigns files to multiple groups: ${[...new Set(duplicates)].join(', ')}`)
      }
      if (missing.length > 0) {
        throw new Error(`Split commit plan missing staged files: ${missing.join(', ')}`)
      }

      // Hunk selectors must resolve against the real diff.
      const hunkErrors = validateHunkSelections(stagedDiff, plan.commits.flatMap(group => group.changes))
      if (hunkErrors.length > 0) {
        throw new Error(`Invalid hunk selections:\n${hunkErrors.map(error => `- ${error}`).join('\n')}`)
      }

      const fieldErrors = validateGroupFields(plan.commits)
      if (fieldErrors.length > 0) {
        throw new Error(fieldErrors.map(error => `- ${error}`).join('\n'))
      }

      // Advisory conventional-commit quality checks (llm-git rules): never
      // block execution — surface past-tense/limit hints as warnings so the
      // model can refine the plan in the next round.
      const advisory = collectConventionalAdvisories(plan.commits, warnings)
      const advisoryText = advisory.map(item => `- ${item}`)
      if (advisoryText.length > 0) warnings.push(...advisoryText)

      const order = computeDependencyOrder(plan.commits)
      if ('error' in order) {
        throw new Error(`Plan rejected before anything was written: ${order.error}`)
      }

      const messages: string[] = order.map((index) => {
        const group = plan.commits[index]
        if (!group) {
          throw new Error('Plan rejected before anything was written: commit order references an unknown group')
        }
        return formatCommitMessage(
          { type: group.type, scope: group.scope, details: group.details, issueRefs: group.issueRefs },
          normalizeSummary(group.summary),
        )
      })

      if (args.dryRun) {
        return {
          mode: order.length === 1 ? 'single' : 'split',
          created: [],
          messages,
          warnings,
          dryRun: true,
        } satisfies CommitApplyValue
      }
      const created: CommitCreated[] = []
      // Serialize this multi-step mutation against other in-process callers
      // on the same repo (git's O_EXCL lock files have no waiter). Keyed by
      // the primary repo root so worktrees of the same repo share one queue.
      await withRepoLock(cwd, async () => {
        await git.resetIndex(cwd, [], exec.signal)
        try {
          for (let position = 0; position < order.length; position++) {
            const index = order[position]
            const group = index === undefined ? undefined : plan.commits[index]
            if (index === undefined || group === undefined) {
              throw new Error('Plan rejected before anything was written: commit order references an unknown group')
            }
            try {
              await git.stageHunks(cwd, group.changes, { rawDiff: stagedDiff, signal: exec.signal })
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error)
              throw new Error(
                `${position} of ${order.length} commits created so far; failed to stage group ${position + 1}: ${message}. `
                 + 'No changes were lost — remaining changes are unstaged.',
              )
            }
            const message = formatCommitMessage(
              { type: group.type, scope: group.scope, details: group.details, issueRefs: group.issueRefs },
              normalizeSummary(group.summary),
            )
            try {
              await git.commit(cwd, message, { signal: exec.signal })
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error)
              throw new Error(
                `Commit ${position + 1} of ${order.length} failed: ${detail}. `
                 + `${position} of ${order.length} commits created; no changes were lost.`,
              )
            }
            const hash = (await git.log(cwd, { max: 1, signal: exec.signal }))[0]?.hash ?? ''
            created.push({
              position: position + 1,
              hash,
              message,
              changes: group.changes.map(change => change.path),
            })
            await git.resetIndex(cwd, [], exec.signal)
          }
        } catch (error: unknown) {
          // Leave the index empty so the user's worktree changes stay intact and
          // inspectable; nothing was lost, no partial staging is leaked.
          await git.resetIndex(cwd, [], exec.signal).catch(() => undefined)
          throw error
        }

        if (args.push) {
          // A1 semantics: push the named branch to origin and record upstream
          // (`-u`), so a freshly cut `worktree acquire --branch` slot becomes
          // consumable by PR tooling. Detached HEAD has no branch to push, so
          // fail with guidance instead of git's raw "not on a branch" error.
          const currentBranch = await git.branch(cwd, exec.signal)
          if (currentBranch === undefined) {
            throw new Error(
              'commit_apply --push requires a named branch, but HEAD is detached: '
              + 'acquire a named-branch slot with `worktree acquire --branch <name>` '
              + 'or `git switch -c <name>` before pushing',
            )
          }
          await git.push(cwd, {
            signal: exec.signal,
            remote: 'origin',
            branch: currentBranch,
            setUpstream: true,
          })
        }
      }, exec.signal)

      return {
        mode: created.length === 1 ? 'single' : 'split',
        created,
        messages,
        warnings,
        dryRun: false,
      } satisfies CommitApplyValue
    },
  }))
}

/** Deep-clone an input group into the service's own table (schema-validated fields). */
function cloneGroup(group: LooseCommitGroup): SplitCommitGroup {
  return {
    changes: group.changes.map(change => ({
      path: change.path,
      hunks: normalizeHunks(change.hunks),
    })),
    type: group.type,
    scope: group.scope ?? null,
    summary: normalizeSummary(group.summary),
    details: (group.details ?? []).map(detail => ({
      text: detail.text,
      userVisible: detail.userVisible ?? true,
    })),
    issueRefs: group.issueRefs ?? [],
    dependencies: group.dependencies ?? [],
    ...group.rationale !== undefined ? { rationale: group.rationale } : {},
  }
}

function normalizeSummary(summary: string): string {
  return summary.trim().replace(/\s+/g, ' ')
}

function normalizeHunks(hunks: unknown): { type: 'all' } | { type: 'indices'; indices: number[] } | { type: 'lines'; start: number; end: number } {
  if (hunks === undefined || hunks === null) return { type: 'all' }
  const value = hunks as { type?: string; indices?: number[]; start?: number; end?: number }
  if (value.type === 'indices') return { type: 'indices', indices: (value.indices ?? []).map(Math.floor) }
  if (value.type === 'lines') {
    return { type: 'lines', start: Math.floor(value.start ?? 0), end: Math.floor(value.end ?? 0) }
  }
  return { type: 'all' }
}

function renderCommitApply(value: CommitApplyValue): string {
  const lines: string[] = []
  if (value.dryRun) {
    lines.push('Split commit plan (dry run):')
  } else if (value.created.length === 0) {
    lines.push('Nothing committed.')
  } else {
    lines.push(value.mode === 'split' ? `Created ${value.created.length} commits:` : 'Created 1 commit:')
  }
  for (const item of value.messages) lines.push(`  ${item.replace(/\n/g, '\n  ')}`)
  if (!value.dryRun && value.created.length > 0) {
    for (const item of value.created) {
      lines.push(`  [${item.position}/${value.created.length}] ${item.hash.slice(0, 8)} ${item.message.split('\n')[0]}`)
    }
  }
  for (const warning of value.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}
