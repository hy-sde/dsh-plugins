/**
 * `@hy-sde-org/dsh-logseq-graph` — the host-plane, headless wiki graph service
 * (`ctx.wikiGraph`) that the web UI and host API proxy use to read and write
 * the LLM-wiki Logseq graph through the installed `logseq` CLI. Model-facing
 * tools stay in `@hy-sde-org/dsh-tool-logseq`; this package owns the seam.
 * @module @hy-sde-org/dsh-logseq-graph
 */

import { Context } from '@deepseek-ai/cordis'
import { LogseqGraphService } from './service.ts'
import type { LogseqGraphConfig } from './service.ts'

export * from './types.ts'
export * from './service.ts'
export { execCli, LogseqCliError } from './cli.ts'
export type { CliResult } from './cli.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host-plane wiki graph service (headless Logseq CLI seam). */
    wikiGraph: LogseqGraphService
  }
}

export { LogseqGraphService } from './service.ts'
export type { LogseqGraphConfig } from './service.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'logseq-graph'

/**
 * Register `ctx.wikiGraph`. Host-plane service consumed by the host API proxy
 * and (in the future) other host rows, so the row belongs in the host
 * composition, not behind a preset realm.
 */
export function apply(ctx: Context, config: LogseqGraphConfig = {}): void {
  void new LogseqGraphService(ctx, config)
}

/** Cordis plugin object form (loader reads the `inject` list from this shape). */
export default { name, inject: [] as string[], apply }
