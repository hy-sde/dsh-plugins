/**
 * `openwiki:tools` system-prompt section: the OpenWiki repository wiki protocol
 * contract card — the required lifecycle sequence (begin → submit_plan →
 * next_page → submit_page → finish), the durable-page rules, and the
 * codebase-memory integration that replaces repeated LLM×repo scans with
 * deterministic structural discovery.
 * @module @hy-sde-org/dsh-tool-openwiki/prompt
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

const SECTION_NAME = 'openwiki:tools'
const SECTION_ORDER = 130

const TEXT = [
  'Repository wiki generation runs over the OpenWiki lifecycle tools (`openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`, `openwiki_submit_page`, `openwiki_finish`) — a resumable in-process engine, no external CLI.',
  'Required sequence: call `openwiki_begin` (root, mode=init|update) → `openwiki_submit_plan` (ordered page queue) → loop `openwiki_next_page` → write the page Markdown below /openwiki with the standard file tools → `openwiki_submit_page` (complete Claim set) until next returns complete → `openwiki_finish`. Never skip stages; each call is durable and resumable.',
  'Use the codebase-memory tools (`codebase_index_repository`, `codebase_search_graph`, `codebase_query_graph`, `codebase_trace_path`, `codebase_get_code_snippet`) for structural discovery instead of scanning the repository file-by-file; the engine already fingerprints source structure deterministically.',
  'A page is complete only when its front matter validates, its claims resolve to repository evidence resources (`repo://path#L20-L48` URIs or file paths), and every Claim agrees with the final page bytes.',
  'Every material Claim needs at least one grounding evidence resource. Preserve the id, exact statement, and evidence resource values of each unchanged existing Claim; reuse its id for a necessary revision; omit it to retract it; omit id for a genuinely new Claim.',
  '`openwiki_submit_plan` is final: the ordered queue is persisted and cannot be silently replaced. Plan once, then execute page by page.',
  'Finish only after every PageJob is complete. The finish pass runs deterministic deletion, Mermaid validation, wiki index synchronization, link validation, generated provenance, Claims finalization, and run metadata persistence; partial runs are resumable via `openwiki_begin` until `.run.json` is removed.',
].join('\n')

/**
 * Build the OpenWiki-tools prompt section.
 * @param config - configuration; `enabled: false` disables the section.
 * @returns the {@link PromptSection} to register.
 */
export function buildOpenWikiPromptSection(config: { enabled?: boolean } = {}): PromptSection {
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: config.enabled === false ? '' : TEXT,
  }
}
