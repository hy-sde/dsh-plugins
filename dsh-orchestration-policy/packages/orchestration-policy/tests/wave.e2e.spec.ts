/**
 * P1 wave E2E: one parallel fan-out under the orchestration policy, over a
 * REAL git repository — one isolated `git worktree` per chunk, `subagent
 * { workspace }` per child, then removal. Also asserts the fail-closed guard
 * rejects a policy-on start without a workspace through the real tool path.
 *
 * Standalone adaptation of the fork's harness E2E:
 * - The fork obtained isolated copies through the `worktree` tool in
 *   `@deepseek-ai/dsh-tool-git`, which was never published (the worktree
 *   slice lives in the standalone `dsh-git` repo, where its own worktree E2E
 *   covers the acquire → release lifecycle). This repo owns the POLICY, so
 *   the two isolated working copies come from the real `git worktree` CLI.
 * - The fork's policy seam lives inside `@deepseek-ai/dsh-tool-subagent`
 *   (`ctx.get('orchestrationPolicy')` + `assertWorkspace`), which is also
 *   unpublished: the published 0.1.2-rc.1 `dsh-tool-subagent` predates it and
 *   never consults the policy service. The seam is therefore reproduced here
 *   VERBATIM against the same published harness APIs (a `defineTool`
 *   `subagent` tool that lazily reads `orchestrationPolicy` and calls
 *   `assertWorkspace(args.workspace, provider.capabilities.workspace === true)`
 *   exactly as the fork's tool does) so the policy-relevant assertions — guard
 *   armed, workspace carried per child, no warning on a guarded start,
 *   fail-closed rejection with zero provider starts — are unchanged.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import policyPackage, { type OrchestrationPolicyService } from '../src/index.ts'

interface Fixture {
  dir: string
  pool: string
  ctx: Context
  provider: WaveProvider
  cleanup: () => Promise<void>
}

/** The shape the model-facing subagent start carries in this fork's seam. */
interface SeamStart {
  description: string
  prompt: string
  workspace?: string
}

/** One-task recording provider: captures every start's `workspace`. */
class WaveProvider {
  readonly name = 'wave'
  readonly capabilities = { workspace: true as const }
  readonly starts: SeamStart[] = []

  start(request: SeamStart): void {
    this.starts.push(request)
  }
}

const cleanups: Array<() => Promise<void>> = []

function gitRun(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

async function makeFixture(): Promise<Fixture> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-policy-wave-')))
  const pool = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-policy-wave-pool-')))
  gitRun(dir, ['init', '-q', '-b', 'master'])
  gitRun(dir, ['config', 'user.email', 'test@example.com'])
  gitRun(dir, ['config', 'user.name', 'Test User'])
  gitRun(dir, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(dir, 'seed.txt'), 'seed\n')
  gitRun(dir, ['add', '.'])
  gitRun(dir, ['commit', '-qm', 'init'])

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const provider = new WaveProvider()
  // The unpublished `tool-subagent` policy seam, verbatim from the fork:
  // lazy `ctx.get('orchestrationPolicy')`, then `assertWorkspace(...)` with
  // the provider's `workspace` capability; warnings surface, throws propagate.
  await ctx.plugin({
    name: 'policy-seam-subagent',
    inject: ['tools'],
    apply(pluginCtx: Context): void {
      const disposeTool = pluginCtx.tools.register(defineTool({
        name: 'subagent',
        description: 'Delegates one task to a task child (test seam).',
        parameters: {
          description: {
            type: 'string',
            required: true,
            description: 'A short (3-5 word) description of the delegated task, for display.',
          },
          prompt: {
            type: 'string',
            required: true,
            description: 'The complete, self-contained task for the task child.',
          },
          workspace: {
            type: 'string' as const,
            description: 'Absolute path of an existing isolated working copy the child works in.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true },
              runId: { type: 'string', required: true },
              warnings: { type: 'array', items: { type: 'string' } },
            },
          },
          render: (_args, value) => [
            ...(value.warnings ?? []).map(warning => ({ type: 'text' as const, text: `warning: ${warning}` })),
            { type: 'text' as const, text: 'wave child done' },
          ],
        },
        async execute(args: { description: string; prompt: string; workspace?: string }): Promise<{
          kind: string
          runId: string
          warnings?: string[]
        }> {
          const start = args as SeamStart
          const policy = pluginCtx.get('orchestrationPolicy') as OrchestrationPolicyService | undefined
          const policyWarning = policy?.assertWorkspace(start.workspace, provider.capabilities.workspace === true)
          provider.start(start)
          return {
            kind: 'foreground' as const,
            runId: `wave-child-${provider.starts.length}`,
            ...policyWarning !== undefined ? { warnings: [policyWarning] } : {},
          }
        },
      }))
      // No explicit disposal needed: the owning fiber is disposed in cleanup
      // and ToolRuntime unregisters its tools with the context.
      void disposeTool
    },
  })
  await ctx.plugin(policyPackage, { enabled: true, maxFanOut: 2 })

  const fixture: Fixture = {
    dir,
    pool,
    ctx,
    provider,
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true })
      rmSync(pool, { recursive: true, force: true })
      await ctx.fiber.dispose()
    },
  }
  cleanups.push(fixture.cleanup)
  return fixture
}

afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean()
})

interface FakeAgent {
  session: { header: { id: string; cwd: string } }
}

const parentAgent = (cwd: string): FakeAgent => ({ session: { header: { id: 'parent-1', cwd } } })

async function call(ctx: Context, name: string, args: Record<string, unknown>, agent: FakeAgent): Promise<{ value: unknown; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`wave-${name}-${Math.random().toString(16).slice(2, 8)}`),
    name,
    arguments: args,
    agent: agent as never,
  })
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join(' ')
  if (result.isError) throw new Error(text || 'tool failed')
  return { value: result.value, text }
}

/** `git worktree add` one isolated working copy off the fixture repo. */
function acquire(fixture: Fixture, branch: string): string {
  const path = join(fixture.pool, `feat-${branch.replaceAll('/', '-')}`)
  gitRun(fixture.dir, ['worktree', 'add', path, '-b', branch])
  return realpathSync(path)
}

describe('P1 wave: isolated worktrees -> subagent workspace -> release', () => {
  it('fans two independent chunks into isolated worktrees and releases both', async () => {
    const f = await makeFixture()
    const agent = parentAgent(f.dir)

    const a = acquire(f, 'feat/a')
    const b = acquire(f, 'feat/b')
    expect(a).not.toBe(b)
    // Both are real, isolated working copies of the same repository.
    expect(gitRun(a, ['rev-parse', '--show-toplevel']).trim()).toBe(a)
    expect(gitRun(b, ['rev-parse', '--show-toplevel']).trim()).toBe(b)

    const [ra, rb] = await Promise.all([
      call(f.ctx, 'subagent', { description: 'chunk a', prompt: 'work on a', workspace: a }, agent),
      call(f.ctx, 'subagent', { description: 'chunk b', prompt: 'work on b', workspace: b }, agent),
    ])
    expect(ra.value).toMatchObject({ kind: 'foreground' })
    expect(rb.value).toMatchObject({ kind: 'foreground' })
    // The policy guard is armed and both children carried their own isolated path.
    expect(f.provider.starts).toHaveLength(2)
    expect(f.provider.starts[0]!.workspace).toBe(a)
    expect(f.provider.starts[1]!.workspace).toBe(b)
    expect(ra.text).not.toContain('warning:')

    gitRun(f.dir, ['worktree', 'remove', '--force', a])
    gitRun(f.dir, ['worktree', 'remove', '--force', b])
    const listed = gitRun(f.dir, ['worktree', 'list', '--porcelain'])
    expect(listed).not.toContain(a)
    expect(listed).not.toContain(b)
  })

  it('fail-closes a policy-on start without a workspace through the real tool path', async () => {
    const f = await makeFixture()
    const agent = parentAgent(f.dir)
    await expect(
      call(f.ctx, 'subagent', { description: 'unguarded', prompt: 'go' }, agent),
    ).rejects.toThrow(/worktree acquire.*workspace/)
    expect(f.provider.starts).toHaveLength(0)
  })
})
