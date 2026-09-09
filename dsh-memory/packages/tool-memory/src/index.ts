/**
 * Model-facing long-horizon memory tools over the host `ctx.memory` service:
 * `retain`, `recall`, `reflect`, `memory_edit`, and `learn`, plus a
 * `memory:project` system-prompt section that reloads the session's project
 * memory at the start of every session.
 *
 * Port of omp (oh-my-pi)'s memory surface for the DeepSeek Harness — see
 * LICENSE. Agent-plane: this package mounts as a preset row and
 * resolves the host `memory` service; it registers no service of its own.
 * @module @hy-sde-org/dsh-tool-memory
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@hy-sde-org/dsh-memory'
import { buildMemoryPromptSection } from './prompt.ts'
import type { MemoryPromptConfig } from './prompt.ts'
import {
  applyLearnTool, applyMemoryEditTool, applyMineSessionsTool, applyRecallTool, applyReflectTool, applyRetainTool,
} from './tools.ts'

/** Plugin configuration. */
export interface Config extends MemoryPromptConfig {
  /** Result cap for one `recall` without an explicit `limit` (default 10). */
  searchLimit?: number
  /** Whether `recall`/`reflect` merge past-session hits (default true). */
  sessionRecall?: boolean
  /** Max session hits merged into one recall result (default 3). */
  sessionRecallLimit?: number
  /** Max sessions `mine_sessions` reads per run (default 3). */
  mineSessionLimit?: number
  /** Max mined lessons stored per `mine_sessions` run (default 10). */
  mineLessonLimit?: number
}

export {
  buildMemoryPromptSection,
  readProjectMemoryBlock,
  cwdFromAssemblyContext,
} from './prompt.ts'
export type { MemoryPromptConfig } from './prompt.ts'
export {
  applyRetainTool, applyRecallTool, applyReflectTool, applyMemoryEditTool, applyLearnTool, applyMineSessionsTool,
  sessionCwd, memoryContextOf, memorySearchWithHistory,
  DEFAULT_SESSION_HISTORY,
} from './tools.ts'
export { searchSessionHistory, resolveSessionQuery, mineCandidateOf, mineFingerprint, sessionLabel } from './session-history.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-memory'

/** Services consumed by this plugin (all resolved from the host and preset scopes). */
export const inject = ['tools', 'systemPrompt', 'memory']

/**
 * Register the six memory tools and the `memory:project` prompt section.
 * @param ctx - the agent-plane plugin context (injects `tools`, `systemPrompt`, `memory`).
 * @param config - resolved plugin configuration (schema-less; defaults only).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const history = {
    enabled: config.sessionRecall ?? true,
    limit: config.sessionRecallLimit ?? 3,
  }
  applyRetainTool(ctx)
  applyRecallTool(ctx, history)
  applyReflectTool(ctx, history)
  applyMemoryEditTool(ctx)
  applyLearnTool(ctx)
  applyMineSessionsTool(ctx, {
    sessions: config.mineSessionLimit ?? 3,
    lessons: config.mineLessonLimit ?? 10,
  })
  ctx.systemPrompt.section(buildMemoryPromptSection({
    ...config.root !== undefined ? { root: config.root } : {},
    ...config.injectionMaxChars !== undefined ? { injectionMaxChars: config.injectionMaxChars } : {},
    ...config.enabled !== undefined ? { enabled: config.enabled } : {},
  }))
}

export default { name, inject, apply }
