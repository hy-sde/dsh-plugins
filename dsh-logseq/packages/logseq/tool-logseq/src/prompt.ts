/**
 * `logseq:tools` system-prompt section: a compact contract card on the tool
 * surface and the operational rules that keep a graph maintained through the
 * CLI (batch discipline, existence checks before create, structured tasks).
 * @module @hy-sde-org/dsh-tool-logseq/prompt
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

const SECTION_NAME = 'logseq:tools'
const SECTION_ORDER = 132

const TEXT = [
  'Graph-native maintenance runs over the Logseq CLI tools (`logseq_list`, `logseq_show`, `logseq_search`, `logseq_query`, `logseq_upsert`, `logseq_remove`, `logseq_graph`, `logseq_server`) — not the desktop-app MCP bridge.',
  'Batch writes: one logical change per tool call, no multi-call loops; use `logseq_upsert` with update tags/properties for graph edits.',
  'Before creating anything, confirm it does not exist (`logseq_search` / `logseq_list`); duplicate pages are the #1 wiki smell.',
  'Deletions are permanent graph changes: remove only when certain; `logseq_graph` validate/export/backup provide safety nets before destructive passes.',
  'Tasks are first-class: use `logseq_upsert` (entityType=task) with `status`, never store TODO/DONE markers in content.',
  'If a call reports the db-worker-node server is missing, run `logseq_server` start, then retry.',
].join('\n')

/**
 * Build the logseq-tools prompt section.
 * @param config - configuration; `enabled: false` disables the section.
 * @returns the {@link PromptSection} to register.
 */
export function buildLogseqPromptSection(config: { enabled?: boolean } = {}): PromptSection {
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: config.enabled === false ? '' : TEXT,
  }
}
