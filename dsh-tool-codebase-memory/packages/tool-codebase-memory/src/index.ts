/**
 * Model-facing codebase-memory CLI tools (`codebase_list_projects`,
 * `codebase_index_repository`, `codebase_index_status`, `codebase_search_graph`,
 * `codebase_query_graph`, `codebase_trace_path`, `codebase_get_code_snippet`,
 * `codebase_get_graph_schema`, `codebase_get_architecture`,
 * `codebase_search_code`, `codebase_detect_changes`, `codebase_manage_adr`,
 * `codebase_ingest_traces`, `codebase_delete_project`) over the installed
 * `codebase-memory-mcp` CLI, plus a `codebase:tools` system-prompt section.
 * Agent-plane: this package mounts as a preset or patch row and registers no
 * service of its own.
 * @module @hy-sde-org/dsh-tool-codebase-memory
 */

import { Context } from '@deepseek-ai/cordis'
import { applyCodebaseMemoryTools } from './codebase-memory.ts'
import type { CodebaseMemoryToolConfig } from './codebase-memory.ts'
import { buildCodebaseMemoryPromptSection } from './prompt.ts'

/** Plugin configuration (camera over the CLI invocation). */
export interface Config extends CodebaseMemoryToolConfig {}

export { buildCodebaseMemoryPromptSection } from './prompt.ts'
export { applyCodebaseMemoryTools, CodebaseMemoryCliError, renderPayload } from './codebase-memory.ts'
export type { CodebaseMemoryToolConfig } from './codebase-memory.ts'
export { checkCodebaseMemoryCli } from './invariant.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-codebase-memory'

/** Services consumed by this plugin (tools + systemPrompt from the agent bundle). */
export const inject = ['tools', 'systemPrompt']

/**
 * Register the codebase-memory CLI tools and the `codebase:tools` prompt section.
 * @param ctx - the agent-plane plugin context (injects `tools`, `systemPrompt`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  applyCodebaseMemoryTools(ctx, config)
  ctx.systemPrompt.section(buildCodebaseMemoryPromptSection())
}

/** Cordis plugin object for `@hy-sde-org/dsh-tool-codebase-memory`. */
export default { name, inject, apply }
