/**
 * Model-facing OpenWiki lifecycle tools (`openwiki_begin`,
 * `openwiki_submit_plan`, `openwiki_next_page`, `openwiki_submit_page`,
 * `openwiki_finish`) over the standalone deterministic engine
 * `@hy-sde-org/dsh-openwiki`. Agent-plane: this package mounts as a
 * preset or profile-patch row and registers no service of its own. The engine
 * runs in-process — no external openwiki CLI is required.
 * @module @hy-sde-org/dsh-tool-openwiki
 */

import { Context } from '@deepseek-ai/cordis'
import { applyOpenWikiTools } from './tools.ts'
import type { OpenWikiToolConfig } from './tools.ts'
import { buildOpenWikiPromptSection } from './prompt.ts'

/** Plugin configuration (camera over the engine invocation). */
export interface Config extends OpenWikiToolConfig {}

export { buildOpenWikiPromptSection } from './prompt.ts'
export { applyOpenWikiTools } from './tools.ts'
export type { OpenWikiToolConfig } from './tools.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-openwiki'

/** Services consumed by this plugin (tools + systemPrompt from the agent bundle). */
export const inject = ['tools', 'systemPrompt']

/**
 * Register the OpenWiki lifecycle tools and the `openwiki:tools` prompt section.
 * @param ctx - the agent-plane plugin context (injects `tools`, `systemPrompt`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  applyOpenWikiTools(ctx, config)
  ctx.systemPrompt.section(buildOpenWikiPromptSection())
}

/** Cordis plugin object for `@hy-sde-org/dsh-tool-openwiki`. */
export default { name, inject, apply }
