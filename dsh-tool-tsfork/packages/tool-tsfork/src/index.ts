/**
 * Model-facing tsfork devices (`tsfork_status`, `tsfork_check`) over a parked
 * Go-native TypeScript compiler binary (the can1357/TypeScript perf fork,
 * TS 7.1.0-dev): status/version reporting and one-shot `-b` project-graph
 * checks with parsed diagnostics and timing. Agent-plane: this package mounts
 * as a preset or patch row and registers no service of its own.
 * @module @hy-sde-org/dsh-tool-tsfork
 */

import { Context } from '@deepseek-ai/cordis'
import { applyTsforkTools } from './tools.ts'
import type { TsforkToolConfig } from './tools.ts'

export { buildTsforkPromptSection } from './prompt.ts'
export { applyTsforkTools } from './tools.ts'
export type { TsforkToolConfig } from './tools.ts'
export {
  TSFORK_DEFAULT_BINARY,
  TSFORK_DEFAULT_TIMEOUT_MS,
  TSFORK_MAX_DIAGNOSTICS,
  TSFORK_MAX_OUTPUT_BYTES,
  TsforkError,
  expandTilde,
  parseDiagnostics,
  parseVersionLine,
  readStamp,
  resolveBinary,
  resolveProjectPath,
  runTsfork,
} from './core.ts'
export type {
  ParsedDiagnostics,
  TsforkDiagnostic,
  TsforkErrorCode,
  TsforkRun,
  TsforkRunOptions,
} from './core.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-tsfork'

/** Services consumed by this plugin (tools + systemPrompt from the agent bundle). */
export const inject = ['tools', 'systemPrompt']

/**
 * Register the tsfork devices and the `tsfork:tools` prompt section.
 * @param ctx - the agent-plane plugin context (injects `tools`, `systemPrompt`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: TsforkToolConfig = {}): void {
  applyTsforkTools(ctx, config)
}
