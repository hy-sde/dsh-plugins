/**
 * Model-facing Automic Vault tools (`av_scan`, `av_doctor`, `av_catalog`,
 * `av_list`) over the host `ctx.av` service, plus an `av:tools`
 * system-prompt section. Agent-plane: this package mounts as a preset row and
 * resolves the host `av` service; it registers no service of its own.
 * @module @hy-sde-org/dsh-tool-av
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@hy-sde-org/dsh-av'
import { applyAvTools } from './av.ts'
import { buildAvPromptSection } from './prompt.ts'
import type { AvPromptConfig } from './prompt.ts'

/** Plugin configuration. */
export interface Config extends AvPromptConfig {
  /** Cap on `av_scan` findings rendered + returned (default 30). */
  maxFindings?: number
  /** Cap on catalog entries per scope (default 60). */
  maxCatalogEntries?: number
}

export { buildAvPromptSection } from './prompt.ts'
export type { AvPromptConfig } from './prompt.ts'
export {
  applyAvTools,
  renderScan,
  renderDoctor,
  renderCatalog,
  renderList,
  rethrowAvError,
} from './av.ts'
export type {
  AvToolConfig,
  AvScanArgs,
  AvScanValue,
  AvScanFindingValue,
  AvDoctorArgs,
  AvDoctorValue,
  AvDoctorResultValue,
  AvDoctorIssueValue,
  AvCatalogsArgs,
  AvCatalogValue,
  AvCatalogEntryValue,
  AvHardenerCatalogEntryValue,
  AvListValue,
} from './av.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-av'

/** Services consumed by this plugin (av resolved from the host bundle). */
export const inject = ['tools', 'systemPrompt', 'av']

/**
 * Register the Automic Vault tools and the `av:tools` prompt section.
 * @param ctx - the agent-plane plugin context (injects `tools`, `systemPrompt`, `av`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  applyAvTools(ctx, {
    ...config.maxFindings !== undefined ? { maxFindings: config.maxFindings } : {},
    ...config.maxCatalogEntries !== undefined ? { maxCatalogEntries: config.maxCatalogEntries } : {},
  })
  ctx.systemPrompt.section(buildAvPromptSection(config))
}

/**
 * The plugin core: registers the av tools.
 *
 */
export default { name, inject, apply }
