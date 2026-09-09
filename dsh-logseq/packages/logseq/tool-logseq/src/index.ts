/**
 * Model-facing Logseq CLI tools (`logseq_list`, `logseq_show`, `logseq_search`,
 * `logseq_query`, `logseq_upsert`, `logseq_remove`, `logseq_graph`,
 * `logseq_server`) over the installed `logseq` CLI, plus a `logseq:tools`
 * system-prompt section. Agent-plane: this package mounts as a preset or patch
 * row and registers no service of its own.
 * @module @hy-sde-org/dsh-tool-logseq
 */

import { Context } from '@deepseek-ai/cordis'
import { applyLogseqTools } from './logseq.ts'
import type { LogseqToolConfig } from './logseq.ts'
import { buildLogseqPromptSection } from './prompt.ts'

/** Plugin configuration (camera over the CLI invocation). */
export interface Config extends LogseqToolConfig {}

export { buildLogseqPromptSection } from './prompt.ts'
export { applyLogseqTools, LogseqCliError } from './logseq.ts'
export type { LogseqToolConfig, LogseqListEntity } from './logseq.ts'
export { checkLogseqCli } from './invariant.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-logseq'

/** Services consumed by this plugin (tools + systemPrompt from the agent bundle). */
export const inject = ['tools', 'systemPrompt']

/**
 * Register the Logseq CLI tools and the `logseq:tools` prompt section.
 * @param ctx - the agent-plane plugin context (injects `tools`, `systemPrompt`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  applyLogseqTools(ctx, config)
  ctx.systemPrompt.section(buildLogseqPromptSection())
}

/** Cordis plugin object for `@hy-sde-org/dsh-tool-logseq`. */
export default { name, inject, apply }
