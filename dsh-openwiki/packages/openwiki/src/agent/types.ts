/**
 * Minimal OpenWiki lifecycle types for the in-fork engine port.
 *
 * Upstream openwiki keeps these in `agent/types.ts` alongside DeepAgents run
 * plumbing. The fork engine needs only the output-mode and update-metadata
 * surface; the DeepAgents run machinery is replaced by the harness agent loop.
 * @module @hy-sde-org/dsh-openwiki/agent
 */

/** Repository generation command that owns a wiki run. */
export type OpenWikiCommand = 'chat' | 'init' | 'update'

/** Output layout for generated wiki content. */
export type OpenWikiOutputMode = 'local-wiki' | 'repository'

/** Durable status written to `.last-update.json` by a failed run. */
export type UpdateRunStatus = 'complete' | 'interrupted'

/** Durable per-run metadata persisted below `openwiki/.last-update.json`. */
export interface UpdateMetadata {
  updatedAt: string
  command: OpenWikiCommand
  gitHead?: string
  model: string
  status?: UpdateRunStatus
  language?: string
}

/** Reconstructed run context used by planning prompts. */
export interface RunContext {
  lastUpdate: UpdateMetadata | null
  language?: string
  wikiGoal?: string
}
