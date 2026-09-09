/**
 * Model-facing AST tools (`ast_grep` and `ast_edit`) over the packaged `@ast-grep/cli` native
 * binary. This package owns schemas, validation, prompt guidance, limits, and presentation; the
 * engine (binary resolution, spawn, argv, JSON parse, error vocabulary) lives in `core.ts` and
 * the two tool bodies in `search.ts`/`edit.ts`.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 * @module @hy-sde-org/dsh-tool-ast
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  AST_GRACE_MS,
  AST_RAW_OUTPUT_MAX_BYTES,
  AST_STDERR_MAX_BYTES,
  AST_TIMEOUT_MS,
} from './core.ts'
import { applyAstGrepTool, AST_GREP_MAX_MATCHES, AST_GREP_MAX_NODE_BYTES } from './search.ts'
import { applyAstEditTool, AST_EDIT_MAX_FILES, AST_EDIT_MAX_HUNK_BYTES } from './edit.ts'
import { MutationPolicy } from './edit.ts'

export {
  AST_GRACE_MS,
  AST_RAW_OUTPUT_MAX_BYTES,
  AST_STDERR_MAX_BYTES,
  AST_TIMEOUT_MS,
  AstError,
  astGrepPath,
  buildAstGrepArgv,
  byteOffsetToIndex,
  parseAstMatches,
  runAstGrep,
  toWorkspaceTarget,
} from './core.ts'
export type { AstErrorCode, AstMatchRecord, AstRun, AstStrictness } from './core.ts'
export {
  AST_GREP_MAX_MATCHES,
  AST_GREP_MAX_NODE_BYTES,
  applyAstGrepTool,
  astGrepMeta,
  formatAstGrepMatches,
  formatAstGrepOutput,
  parseAstGrepArgs,
  presentAstGrepCall,
  presentAstGrepResult,
} from './search.ts'
export type { AstGrepMatchValue, AstGrepResultValue } from './search.ts'
export {
  AST_EDIT_MAX_FILES,
  AST_EDIT_MAX_HUNK_BYTES,
  MutationPolicy,
  applyAstEditTool,
  parseAstEditArgs,
  presentAstEditCall,
  presentAstEditResult,
} from './edit.ts'
export type { AstEditFileValue, AstEditResultValue } from './edit.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-ast'

/** Services required by this plugin. */
export const inject = ['tools', 'subprocess', 'systemPrompt', 'fs']

/** Plugin configuration: result caps and the timeout budget shared by both tools. */
export interface Config {
  /** Largest number of matches one `ast_grep` call retains inline (default 100). */
  astGrepMaxMatches?: number
  /** Largest previewed bytes of one matched node (default 2000). */
  astGrepMaxNodeBytes?: number
  /** Largest previewed bytes of one `ast_edit` hunk side (default 4000). */
  astEditMaxHunkBytes?: number
  /** Largest number of files one `ast_edit` run reports/writes (default 200). */
  astEditMaxFiles?: number
  /** Largest serialized `presentationMeta` for one result (default 65536). */
  searchMetaMaxBytes?: number
  /** Largest raw engine stdout a run will parse (default 8 MiB). */
  rawOutputMaxBytes?: number
  /** Terminate-escalation grace (ms), bounded by `MAX_TIMER_DELAY_MS` (default 3000). */
  graceMs?: number
  /** Max retained stderr tail bytes (default 64 KiB). */
  stderrMaxBytes?: number
  /** Cooperative tool-call timeout budget (ms) on both tools (default 30000). */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  astGrepMaxMatches: z.number().default(AST_GREP_MAX_MATCHES),
  astGrepMaxNodeBytes: z.number().default(AST_GREP_MAX_NODE_BYTES),
  astEditMaxHunkBytes: z.number().default(AST_EDIT_MAX_HUNK_BYTES),
  astEditMaxFiles: z.number().default(AST_EDIT_MAX_FILES),
  searchMetaMaxBytes: z.number().default(65_536),
  rawOutputMaxBytes: z.number().default(AST_RAW_OUTPUT_MAX_BYTES),
  graceMs: z.number().default(AST_GRACE_MS),
  stderrMaxBytes: z.number().default(AST_STDERR_MAX_BYTES),
  timeoutMs: z.number().default(AST_TIMEOUT_MS),
})

/** Complete config after schemastery applied every default. */
type ResolvedConfig = Required<Config>

/** Every cap counts items/bytes/milliseconds — a positive integer, or retention and timeout arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-ast: ${name} must be a positive integer`)
  }
}

/**
 * Register the `ast_grep`/`ast_edit` tool suite over the packaged ast-grep engine. The binary is
 * always available (an npm dependency), so registration is unconditional; a missing platform binary
 * fails at call time, not load time.
 * @param ctx - plugin context; registrations are effects scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
// oxlint-disable-next-line typescript/require-await -- async keeps a load-time config rejection a rejection, not a synchronous throw
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('astGrepMaxMatches', resolved.astGrepMaxMatches)
  assertPositiveInteger('astGrepMaxNodeBytes', resolved.astGrepMaxNodeBytes)
  assertPositiveInteger('astEditMaxHunkBytes', resolved.astEditMaxHunkBytes)
  assertPositiveInteger('astEditMaxFiles', resolved.astEditMaxFiles)
  assertPositiveInteger('searchMetaMaxBytes', resolved.searchMetaMaxBytes)
  assertPositiveInteger('rawOutputMaxBytes', resolved.rawOutputMaxBytes)
  assertPositiveInteger('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-ast: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  assertPositiveInteger('stderrMaxBytes', resolved.stderrMaxBytes)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)

  const engine = {
    rawOutputMaxBytes: resolved.rawOutputMaxBytes,
    graceMs: resolved.graceMs,
    stderrMaxBytes: resolved.stderrMaxBytes,
  }
  applyAstGrepTool(ctx, {
    engine,
    maxMatches: resolved.astGrepMaxMatches,
    maxNodeBytes: resolved.astGrepMaxNodeBytes,
    maxMetaBytes: resolved.searchMetaMaxBytes,
    timeoutMs: resolved.timeoutMs,
  })
  // The sandbox-policy adapter is shared by both tools' mutation paths (ast_edit only).
  const policy = new MutationPolicy(ctx)
  applyAstEditTool(ctx, {
    engine,
    maxFiles: resolved.astEditMaxFiles,
    maxHunkBytes: resolved.astEditMaxHunkBytes,
    maxMetaBytes: resolved.searchMetaMaxBytes,
    timeoutMs: resolved.timeoutMs,
  }, policy)
}
