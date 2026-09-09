/**
 * `codebase:tools` system-prompt section: a compact contract card on the
 * codebase-memory tool surface and the operational rules that keep the graph
 * authoritative (index before asking, prefer graph answers over repeated
 * greps, page with limit/offset, and know the project vocabulary).
 * @module @hy-sde-org/dsh-tool-codebase-memory/prompt
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

const SECTION_NAME = 'codebase:tools'
const SECTION_ORDER = 131

const TEXT = [
  'Codebase intelligence runs over the codebase-memory CLI tools (`codebase_list_projects`, `codebase_index_repository`, `codebase_index_status`, `codebase_search_graph`, `codebase_query_graph`, `codebase_trace_path`, `codebase_get_code_snippet`, `codebase_get_graph_schema`, `codebase_get_architecture`, `codebase_search_code`, `codebase_detect_changes`, `codebase_manage_adr`, `codebase_ingest_traces`, `codebase_delete_project`) — one-shot queries against the local codebase-memory daemon, not a long-lived MCP server.',
  'Before relying on graph answers, confirm the project is indexed (`codebase_list_projects` / `codebase_index_status`); index new repos with `codebase_index_repository` (full mode for deep research).',
  'Prefer `codebase_search_graph` over repeated grep/read cycles for definitions, callers, call chains, routes, and architecture; use `codebase_query_graph` (Cypher) for patterns the curated tools cannot express.',
  'Page with `limit`/`offset` until `has_more` is false; result sizes are capped and truncation is reported explicitly.',
  '`codebase_delete_project` is destructive — use only for superseded indexes.',
  'Underlying CLI: `codebase-memory-mcp cli --json <tool>`; it shares the same daemon as any MCP client, so indexes are consistent across sessions.',
].join('\n')

/**
 * Build the codebase-tools prompt section.
 * @param config - configuration; `enabled: false` disables the section.
 * @returns the {@link PromptSection} to register.
 */
export function buildCodebaseMemoryPromptSection(config: { enabled?: boolean } = {}): PromptSection {
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: config.enabled === false ? '' : TEXT,
  }
}
