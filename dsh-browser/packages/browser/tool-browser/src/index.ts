/**
 * Model-facing `browser` tool over the host `ctx.browser` service, plus a
 * `browser:tools` system-prompt section. Agent-plane: this package mounts as
 * a preset row and resolves the host `browser` service; it registers no
 * service of its own.
 *
 * Port of omp (oh-my-pi)'s browser tool with stealth + relay/CDP-attach for
 * the DeepSeek Harness — see LICENSE. Backends mirror
 * omp: spawned (stealth-patched launch via app.path), attached (existing CDP
 * endpoint via app.cdp_url), and relay (`app.relay` / browser.relay setting —
 * the local dsh relay server + companion Chrome extension drive the user's own
 * tabs). Observations are Playwright ARIA snapshots with `[ref=eN]` ids.
 * @module @hy-sde-org/dsh-tool-browser
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@hy-sde-org/dsh-browser'
import { applyBrowserTool } from './browser.ts'
import { buildBrowserPromptSection } from './prompt.ts'
import type { BrowserPromptConfig } from './prompt.ts'

/** Plugin configuration. */
export interface Config extends BrowserPromptConfig {
  /** Char cap on the ARIA snapshot returned by the tool (default 20000). */
  maxAriaChars?: number
}

export { buildBrowserPromptSection } from './prompt.ts'
export type { BrowserPromptConfig } from './prompt.ts'
export { applyBrowserTool } from './browser.ts'
export type { BrowserToolConfig, BrowserRunArgs, BrowserRunValue } from './browser.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-browser'

/** Services consumed by this plugin (browser resolved from the host bundle). */
export const inject = ['tools', 'systemPrompt', 'browser']

/**
 * Register the browser tool and the `browser:tools` prompt section.
 * @param ctx - the agent-plane plugin context (injects `tools`, `systemPrompt`, `browser`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  applyBrowserTool(ctx, {
    ...config.maxAriaChars !== undefined ? { maxAriaChars: config.maxAriaChars } : {},
  })
  ctx.systemPrompt.section(buildBrowserPromptSection(config))
}

/**
 * The plugin core: registers the browser tool.
 *
 */
export default { name, inject, apply }
