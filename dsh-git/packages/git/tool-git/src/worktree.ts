/**
 * The `worktree` tool: a model-facing pool of isolated git worktrees with
 * durable leases (firstmate/treehouse port). One tool, five actions
 * mirroring the treehouse CLI verb surface — `acquire`
 * (cut or reuse a slot and take a lease), `release` (conditional on the exact
 * lease id; parks the slot, refuses dirty unless `force`), `list` (live pool
 * status), `prune` (dry-run removal of idle slots; `yes` executes), and
 * `destroy` (dry-run unless `yes`, with explicit `includeLeased` /
 * `includeUnlanded` overrides for the irreversible cases).
 *
 * The engine — `@hy-sde-org/dsh-git/worktree` — holds every safety
 * invariant; this module is the thin model-facing surface: argument mapping,
 * render, and typed error surfacing (`[CODE]` prefixes on `WorktreeError`).
 * @module @hy-sde-org/dsh-tool-git/worktree
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  acquireWorktree,
  releaseWorktree,
  listWorktrees,
  pruneWorktrees,
  destroyWorktree,
  WorktreeError,
} from '@hy-sde-org/dsh-git/worktree'
import type {
  WorktreeLease,
  WorktreeStatus,
  WorktreePruneResult,
  WorktreeReleaseResult,
  WorktreeDestroyResult,
} from '@hy-sde-org/dsh-git/worktree'
import { resolveCwd } from './commit.ts'

/** Configuration consumed by the worktree tool (pool settings). */
export interface WorktreeToolConfig {
  /** Pool root directory (default `~/.treehouse`). */
  worktreeRoot?: string
  /** Default branch to cut worktrees from (default: inferred from origin HEAD / current branch). */
  worktreeBaseBranch?: string
  /** Fetch origin before acquire (default true; skipped when the repo has no origin). */
  worktreeFetchBeforeAcquire?: boolean
  /** Max ms to wait for the cross-process pool-state lock (default 30000). */
  worktreeLockWaitMs?: number
  /** Cap on total pooled slots per repository (default 0 = unlimited; reuse still allowed at the cap). */
  worktreeMaxSlots?: number
}

type WorktreeAction = 'acquire' | 'release' | 'list' | 'prune' | 'destroy'

/** Tool arguments. Only the fields relevant to the chosen action are used. */
interface WorktreeArgs {
  action: WorktreeAction
  cwd?: string
  /** acquire: cut HEAD at a new named branch (supports commit_apply --push on the branch). */
  branch?: string
  /** acquire: cut from this branch instead of the configured/inferred default. */
  base?: string
  /** acquire: lease holder label (default `dsh`). */
  holder?: string
  /** acquire: skip the origin fetch. */
  noFetch?: boolean
  /** release: the leased worktree path (from the acquire result). */
  path?: string
  /** release: the exact lease id from the acquire result. */
  leaseId?: string
  /** release: discard uncommitted changes instead of refusing. */
  force?: boolean
  /** destroy: pool-relative slot name (or `path`). */
  name?: string
  /** prune/destroy: execute instead of previewing. */
  yes?: boolean
  /** destroy: permit destroying a slot that is still leased. */
  includeLeased?: boolean
  /** destroy: permit discarding dirty/unmerged work (irreversible). */
  includeUnlanded?: boolean
  /** prune: sweep every pool under the configured root, not just this repo's. */
  all?: boolean
}

export interface WorktreeToolValue {
  action: WorktreeAction
  cwd: string
  lease?: WorktreeLease
  released?: WorktreeReleaseResult
  worktrees?: WorktreeStatus[]
  prune?: WorktreePruneResult
  destroyed?: WorktreeDestroyResult
  warnings: string[]
}

const ACTIONS: readonly WorktreeAction[] = ['acquire', 'release', 'list', 'prune', 'destroy']

function engineSettings(config: WorktreeToolConfig): {
  root?: string
  baseBranch?: string
  fetchBeforeAcquire?: boolean
  lockWaitMs?: number
  maxSlots?: number
} {
  return {
    ...config.worktreeRoot !== undefined ? { root: config.worktreeRoot } : {},
    ...config.worktreeBaseBranch !== undefined ? { baseBranch: config.worktreeBaseBranch } : {},
    ...config.worktreeFetchBeforeAcquire !== undefined ? { fetchBeforeAcquire: config.worktreeFetchBeforeAcquire } : {},
    ...config.worktreeLockWaitMs !== undefined ? { lockWaitMs: config.worktreeLockWaitMs } : {},
    ...config.worktreeMaxSlots !== undefined ? { maxSlots: config.worktreeMaxSlots } : {},
  }
}

/**
 * Register the `worktree` tool.
 * @param ctx - agent-plane context (injects `tools`, `git`).
 * @param config - pool settings (root, base branch, fetch behavior).
 */
export function applyWorktreeTool(ctx: Context, config: WorktreeToolConfig = {}): void {
  ctx.tools.register(defineTool({
    name: 'worktree',
    description:
      'Manage isolated per-task git worktrees in a persistent pool with durable leases (firstmate/treehouse model). '
      + '`acquire` cuts a fresh slot (`--branch` for a named-branch HEAD — the path for commit_apply --push and PRs) '
      + 'or reuses a provably-idle one, returning `path` + `leaseId`; `release` returns the slot (refuses dirty unless `force`) '
      + 'and is conditional on the exact lease id; `list` shows live pool status; `prune` removes only idle slots (dry-run '
      + 'without `yes`); `destroy` removes one slot (dry-run without `yes`, refuses leased/dirty unless the explicit flag). '
      + 'Work at `lease.path` — it is a normal git worktree of the same repository; finish with release before shipping.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...ACTIONS],
        description: 'acquire | release | list | prune | destroy.',
      },
      cwd: { type: 'string', description: 'Working directory; defaults to the session workspace.' },
      branch: { type: 'string', description: 'acquire only: cut HEAD at a new named branch (for commit_apply --push / PR flows).' },
      base: { type: 'string', description: 'acquire only: cut from this branch instead of the configured/inferred default.' },
      holder: { type: 'string', description: 'acquire only: lease holder label (default `dsh`).' },
      noFetch: { type: 'boolean', description: 'acquire only: skip the origin fetch.' },
      path: { type: 'string', description: 'release/destroy: the worktree path from the acquire result.' },
      leaseId: { type: 'string', description: 'release only: the exact lease id from the acquire result.' },
      force: { type: 'boolean', description: 'release only: discard uncommitted changes instead of refusing (git clean -fdqx).' },
      name: { type: 'string', description: 'destroy only: pool-relative slot name (alternative to path).' },
      yes: { type: 'boolean', description: 'prune/destroy only: execute instead of dry-running.' },
      includeLeased: { type: 'boolean', description: 'destroy only: allow destroying a slot that is still leased.' },
      includeUnlanded: { type: 'boolean', description: 'destroy only: allow discarding dirty/unmerged work (irreversible).' },
      all: { type: 'boolean', description: 'prune only: sweep every pool under the configured root.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: [...ACTIONS] },
          cwd: { type: 'string', required: true },
          lease: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              leaseId: { type: 'string', required: true },
              leaseHolder: { type: 'string', required: true },
              leasedAt: { type: 'string', required: true },
              baseBranch: { type: 'string', required: true },
              branch: { type: 'string' },
            },
          },
          released: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              released: { type: 'boolean', required: true },
            },
          },
          worktrees: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['leased', 'idle', 'damaged'] },
                leased: { type: 'boolean', required: true },
                leaseId: { type: 'string' },
                leaseHolder: { type: 'string' },
                leasedAt: { type: 'string' },
                baseBranch: { type: 'string', required: true },
                branch: { type: 'string' },
                dirty: { type: 'boolean', required: true },
                merged: { type: 'boolean', required: true },
                exists: { type: 'boolean', required: true },
              },
            },
          },
          prune: {
            type: 'object',
            additionalProperties: false,
            properties: {
              candidates: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    path: { type: 'string', required: true },
                    reason: { type: 'string', required: true },
                  },
                },
              },
              skipped: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    path: { type: 'string', required: true },
                    reason: { type: 'string', required: true },
                  },
                },
              },
              removed: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          destroyed: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              removed: { type: 'boolean', required: true },
            },
          },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value: WorktreeToolValue) => [{
        type: 'text',
        text: renderWorktreeValue(value),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args: WorktreeArgs, exec: ToolExecution) {
      const cwd = resolveCwd(exec, args.cwd)
      const settings = engineSettings(config)
      const signal = exec.signal
      const warnings: string[] = []
      try {
        switch (args.action) {
          case 'acquire': {
            const lease = await acquireWorktree(ctx.git, cwd, settings, {
              ...args.branch !== undefined ? { branch: args.branch } : {},
              ...args.base !== undefined ? { base: args.base } : {},
              ...args.holder !== undefined ? { holder: args.holder } : {},
              ...args.noFetch === true ? { noFetch: true } : {},
              signal,
            })
            return { action: 'acquire', cwd, lease, warnings } satisfies WorktreeToolValue
          }
          case 'release': {
            const path = args.path
            const leaseId = args.leaseId
            if (path === undefined || leaseId === undefined) {
              throw new Error('worktree release requires path and leaseId (both from the acquire result)')
            }
            const released = await releaseWorktree(ctx.git, cwd, { path, leaseId }, {
              ...args.force === true ? { force: true } : {},
              settings,
              signal,
            })
            return { action: 'release', cwd, released, warnings } satisfies WorktreeToolValue
          }
          case 'list': {
            const worktrees = await listWorktrees(ctx.git, cwd, { settings, signal })
            return { action: 'list', cwd, worktrees, warnings } satisfies WorktreeToolValue
          }
          case 'prune': {
            const prune = await pruneWorktrees(ctx.git, cwd, {
              ...args.yes === true ? { yes: true } : {},
              ...args.all === true ? { all: true } : {},
              settings,
              signal,
            })
            return { action: 'prune', cwd, prune, warnings } satisfies WorktreeToolValue
          }
          case 'destroy': {
            if (args.path === undefined && args.name === undefined) {
              throw new Error('worktree destroy requires path or name')
            }
            const destroyed = await destroyWorktree(ctx.git, cwd, {
              ...args.path !== undefined ? { path: args.path } : {},
              ...args.name !== undefined ? { name: args.name } : {},
              ...args.yes === true ? { yes: true } : {},
              ...args.includeLeased === true ? { includeLeased: true } : {},
              ...args.includeUnlanded === true ? { includeUnlanded: true } : {},
              settings,
              signal,
            })
            return { action: 'destroy', cwd, destroyed, warnings } satisfies WorktreeToolValue
          }
        }
      } catch (error: unknown) {
        if (error instanceof WorktreeError) {
          throw new Error(`worktree ${args.action} failed [${error.code}]: ${error.message}`)
        }
        throw error
      }
    },
  }))
}

function renderWorktreeValue(value: WorktreeToolValue): string {
  switch (value.action) {
    case 'acquire': {
      const lease = value.lease
      if (lease === undefined) return 'Acquire: no result.'
      const lines = [
        'Worktree lease acquired:',
        `  path: ${lease.path}`,
        `  leaseId: ${lease.leaseId}`,
        `  holder: ${lease.leaseHolder}`,
        `  base: ${lease.baseBranch}`,
        `  head: ${lease.branch ?? 'detached'}`,
      ]
      if (value.warnings.length > 0) lines.push(...value.warnings.map(warning => `warning: ${warning}`))
      return lines.join('\n')
    }
    case 'release': {
      const released = value.released
      if (released === undefined) return 'Release: no result.'
      const lines = [`Released ${released.path} — parked idle for reuse.`]
      if (value.warnings.length > 0) lines.push(...value.warnings.map(warning => `warning: ${warning}`))
      return lines.join('\n')
    }
    case 'list': {
      const items = value.worktrees ?? []
      if (items.length === 0) return 'No worktrees in the pool for this repository.'
      const lines = [`Worktree pool (${items.length}):`]
      for (const item of items) {
        const detail = [
          `#${item.name}`,
          item.status,
          item.path,
          item.leaseHolder !== undefined ? `holder=${item.leaseHolder}` : undefined,
          item.branch !== undefined ? `branch=${item.branch}` : 'detached',
          item.dirty ? 'DIRTY' : undefined,
          item.merged ? 'merged' : 'unmerged',
        ].filter(part => part !== undefined).join(' ')
        lines.push(`  ${detail}`)
      }
      return lines.join('\n')
    }
    case 'prune': {
      const prune = value.prune
      if (prune === undefined) return 'Nothing to prune.'
      const lines: string[] = []
      for (const item of prune.candidates) {
        lines.push(`prunable: ${item.path}`)
      }
      for (const item of prune.skipped) {
        lines.push(`skip (${item.reason}): ${item.path}`)
      }
      for (const path of prune.removed) {
        lines.push(`removed: ${path}`)
      }
      if (lines.length === 0) lines.push('Nothing to prune.')
      if (prune.candidates.length > 0 && prune.removed.length === 0) {
        lines.push('(dry run — pass yes to remove the prunable slots)')
      }
      return lines.join('\n')
    }
    case 'destroy': {
      const destroyed = value.destroyed
      if (destroyed === undefined) return 'Destroy: no result.'
      if (destroyed.removed) return `Destroyed ${destroyed.path}.`
      return `Dry run: would destroy ${destroyed.path} (pass yes to execute).`
    }
  }
}
