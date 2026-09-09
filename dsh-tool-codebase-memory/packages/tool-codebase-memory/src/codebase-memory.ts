/**
 * Model-facing codebase-memory CLI tools over the `codebase-memory-mcp cli`
 * one-shot mode: `codebase_list_projects`, `codebase_index_repository`,
 * `codebase_index_status`, `codebase_search_graph`, `codebase_query_graph`,
 * `codebase_trace_path`, `codebase_get_code_snippet`,
 * `codebase_get_graph_schema`, `codebase_get_architecture`,
 * `codebase_search_code`, `codebase_detect_changes`, `codebase_manage_adr`,
 * `codebase_ingest_traces`, `codebase_delete_project`.
 *
 * Each call spawns `codebase-memory-mcp cli --json <tool>` once with a temp
 * `--args-file` and parses the raw MCP result envelope — the same daemon the
 * stdio MCP server fronts, so indexes, mutation locks and index supervisors
 * are shared. Long-lived process: none; the daemon stays warm across calls.
 * @module @hy-sde-org/dsh-tool-codebase-memory/codebase-memory
 */

import { execFile } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  DefineToolOptions,
  ParameterSchemaSpec,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'

/**
 * `defineTool` passthrough that additionally accepts the fork's `device`
 * device-catalog marker. The published `@deepseek-ai/dsh-tools` 0.1.2-rc.1
 * types predate that option (it landed in the harness's in-repo registry),
 * so the marker rides a widened but fully typed options shape; a consumer
 * registry without the device concept simply ignores it at runtime.
 */
function defineCodebaseMemoryTool<S extends ParameterSchemaSpec, O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O> & { device?: boolean },
) {
  return defineTool<S, O>(options)
}

/** Tool-level configuration (all optional; defaults apply). */
export interface CodebaseMemoryToolConfig {
  /** CLI executable (default `codebase-memory-mcp` on PATH). */
  cliPath?: string
  /** Default project name applied when a tool call omits `project`. */
  project?: string
  /** Per-call process timeout in ms (default 60000). */
  timeoutMs?: number
  /** Timeout for `codebase_index_repository` in ms (default 600000). */
  indexTimeoutMs?: number
  /** Cap on rendered JSON payload chars before truncation (default 200000). */
  maxChars?: number
}

/** Raised when the CLI exits non-zero, the envelope reports isError, or the output is unreadable. */
export class CodebaseMemoryCliError extends Error {
  /** CLI invocation that failed. */
  readonly args: string[]
  /** Captured stdout (may hold a partial MCP envelope). */
  readonly stdout: string
  /** Captured stderr (mem.init/progress noise plus human errors). */
  readonly stderr: string
  /** Process exit code, or null when no process ran (e.g. ENOENT). */
  readonly exitCode: number | null
  /** Parsed error payload from the envelope, when available. */
  readonly payload?: unknown

  constructor(message: string, args: string[], stdout: string, stderr: string, exitCode: number | null, payload?: unknown) {
    super(message)
    this.name = 'CodebaseMemoryCliError'
    this.args = args
    this.stdout = stdout
    this.stderr = stderr
    this.exitCode = exitCode
    this.payload = payload
  }
}

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

/**
 * Run the CLI once; stdout/stderr/exit-code are returned as-is.
 * @param cmd - CLI executable path.
 * @param args - full argv (including `cli --json <tool>` and, when args exist, `--args-file`).
 * @param options - run options (per-call timeout).
 * @returns the captured stdout/stderr and exit code.
 * @throws {@link CodebaseMemoryCliError} when the process fails or times out.
 */
export async function runCli(cmd: string, args: string[], options: { timeoutMs: number }): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    execFile(cmd, args, {
      timeout: options.timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ stdout, stderr, exitCode: 0 })
        return
      }
      const e = err as unknown as { code?: number | string; signal?: string }
      const code = typeof e.code === 'number' ? e.code : null
      if (e.code === 'ENOENT') {
        reject(new CodebaseMemoryCliError(
          `codebase-memory CLI not found (\`${cmd}\`). Install it from the codebase-memory-mcp releases (https://github.com/DeusData/codebase-memory-mcp/releases): tar xzf then ./install.sh, or set config.cliPath.`,
          args, stdout, stderr, code))
        return
      }
      const tail = stderr.trim().slice(0, 400)
      reject(new CodebaseMemoryCliError(
        `codebase-memory CLI exited with ${code === null ? 'unknown error' : `code ${code}`}${tail ? `: ${tail}` : ''}`,
        args, stdout, stderr, code))
    })
  })
}

interface Envelope {
  /** The MCP envelope's text payload, re-parsed into a value. */
  payload: unknown
  /** The envelope's text, verbatim (double-encoded JSON for structured tools). */
  text: string
  /** Raw stdout captured from the CLI. */
  stdout: string
  stderr: string
  exitCode: number | null
}

/** Narrows a parsed error payload to its optional error/hint fields. */
function asErrorPayload(value: unknown): { error?: unknown; hint?: unknown } {
  if (typeof value !== 'object' || value === null) return {}
  return {
    error: 'error' in value ? value.error : undefined,
    hint: 'hint' in value ? value.hint : undefined,
  }
}

/**
 * Parse the raw MCP result envelope printed by `cli --json <tool>`.
 *
 * Under `--json` the CLI always exits 0 and reports tool errors inside the
 * envelope (`{"content":[{"type":"text","text":...}],"isError":true}`), so the
 * envelope — not the process exit code — is the source of truth.
 * @param run - captured run output.
 * @returns the parsed envelope.
 * @throws {@link CodebaseMemoryCliError} when the envelope reports `isError`.
 */
export function parseEnvelope(run: RunResult): Envelope {
  let doc: unknown
  try {
    doc = JSON.parse(run.stdout)
  } catch {
    throw new CodebaseMemoryCliError(
      'codebase-memory CLI returned non-JSON output (expected an MCP result envelope)',
      ['cli', '--json'], run.stdout, run.stderr, run.exitCode)
  }
  const root = doc as { content?: Array<{ type?: string; text?: unknown }>; isError?: boolean } | null
  if (!root || !Array.isArray(root.content) || root.content.length === 0) {
    throw new CodebaseMemoryCliError(
      'codebase-memory CLI returned a malformed MCP result envelope (no content blocks)',
      ['cli', '--json'], run.stdout, run.stderr, run.exitCode)
  }
  const text = root.content[0]?.text
  const textStr = typeof text === 'string' ? text : run.stdout
  let payload: unknown = textStr
  if (textStr.trim().startsWith('{') || textStr.trim().startsWith('[') || textStr.trim().startsWith('"')) {
    try {
      payload = JSON.parse(textStr)
    } catch {
      // stay with the verbatim text
    }
  }
  if (root.isError) {
    const err = asErrorPayload(payload)
    const message = typeof err.error === 'string' ? err.error : 'codebase-memory tool error'
    const hint = typeof err.hint === 'string' ? ` ${err.hint}` : ''
    throw new CodebaseMemoryCliError(message + hint, ['cli', '--json'], run.stdout, run.stderr, run.exitCode, payload)
  }
  return { payload, text: textStr, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode }
}

/** Shared output schema: every tool resolves to one JSON text document. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

/**
 * Render a JSON payload into the tool result text, truncating when it exceeds
 * the cap so oversized graph payloads cannot blow the session context.
 * @param payload - parsed envelope payload.
 * @param maxChars - truncation cap.
 * @returns the rendered text.
 */
export function renderPayload(payload: unknown, maxChars: number): string {
  const text = payload === undefined ? '' : JSON.stringify(payload)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...(truncated by tool-codebase-memory: payload was ${text.length} chars; narrow the query or page with limit/offset)`
}

/**
 * Register all fourteen codebase-memory tools (the prompt section is added by
 * the index plugin; this stays separable for tests).
 * @param ctx - Cordis context carrying `tools` and `systemPrompt`.
 * @param config - tool-level configuration (CLI path/project/timeouts/caps).
 */
export function applyCodebaseMemoryTools(ctx: Context, config: CodebaseMemoryToolConfig = {}): void {
  const cmd = config.cliPath ?? 'codebase-memory-mcp'
  const defaultProject = config.project
  const maxChars = config.maxChars ?? 200000

  const call = async (tool: string, args: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<{ payload: unknown }> => {
    const argv: string[] = ['cli', '--json', tool]
    let tmp: string | undefined
    try {
      if (Object.keys(args).length > 0) {
        tmp = join(tmpdir(), `cbm-${randomUUID()}.json`)
        await writeFile(tmp, JSON.stringify(args), 'utf8')
        argv.push('--args-file', tmp)
      }
      const run = await runCli(cmd, argv, { timeoutMs })
      const env = parseEnvelope(run)
      return { payload: env.payload }
    } finally {
      if (tmp) await unlink(tmp).catch(() => {})
    }
  }

  // project-aware tools default `project` from config when omitted
  const withProject = (args: Record<string, unknown>): Record<string, unknown> => {
    if (args.project !== undefined || defaultProject === undefined) return args
    return { ...args, project: defaultProject }
  }

  // per-tool timeouts; indexing and heavy analysis get longer budgets
  const INDEX_TIMEOUT = config.indexTimeoutMs ?? 600000
  const baseTimeout = config.timeoutMs ?? 60000

  void ctx

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_list_projects',
    device: true,
    description:
      'List every project indexed into the codebase-memory knowledge graph (name, root path, git state). Use before any other codebase_* tool to learn the canonical `project` name for the repository in question, then pass it to the other tools.',
    parameters: {},
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute() {
      const { payload } = await call('list_projects', {}, baseTimeout)
      return { text: JSON.stringify(payload) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_index_repository',
    device: true,
    description:
      'Index a repository into the codebase-memory knowledge graph. Use INSTEAD of ad-hoc greps when you need structural answers (callers/callees, routes, architectures, cross-service links) that the filesystem tools would need many read/grep cycles to piece together. Runs in the daemon; repos are indexed once and queried repeatedly afterwards.',
    parameters: {
      repoPath: { type: 'string', description: 'Path to the repository to index.' },
      mode: { type: 'string', enum: ['full', 'moderate', 'fast', 'cross-repo-intelligence'], description: 'full (default): all files + similarity/semantic edges. moderate: filtered files + similarity/semantic. fast: filtered files, no similarity/semantic. cross-repo-intelligence: only match routes/channels across already-indexed projects (requires targetProjects).' },
      targetProjects: { type: 'array', items: { type: 'string' }, description: 'Projects to search for cross-repo links (cross-repo-intelligence mode). Use ["*"] for all indexed projects.' },
      name: { type: 'string', description: 'Override the derived project name (defaults to the path slug).' },
      persistence: { type: 'boolean', description: 'Write a compressed artifact to .codebase-memory/graph.db.zst for team sharing.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as { repoPath?: string; mode?: string; targetProjects?: string[]; name?: string; persistence?: boolean }
      if (!a.repoPath) throw new CodebaseMemoryCliError('repoPath is required', [], '', '', null)
      const payload: Record<string, unknown> = { repo_path: a.repoPath }
      if (a.mode) payload.mode = a.mode
      if (a.targetProjects) payload.target_projects = a.targetProjects
      if (a.name) payload.name = a.name
      if (a.persistence !== undefined) payload.persistence = a.persistence
      const { payload: out } = await call('index_repository', payload, INDEX_TIMEOUT)
      return { text: JSON.stringify(out) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_index_status',
    device: true,
    description:
      'Report indexing status and coverage for a project: node/edge counts, freshness, skipped and partially-parsed files, and any logfile of the last index run. Use before trusting an answer about a recently-changed repo.',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args
      const { payload } = await call('index_status', withProject(a), baseTimeout)
      return { text: renderPayload(payload, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_search_graph',
    device: true,
    description:
      'Search the codebase-memory knowledge graph for functions, classes, routes, and variables. Preferred over plain grep/glob when finding definitions, implementations, or relationships: three independent modes — query (BM25 full-text with camelCase splitting and structural label boosting), namePattern (exact regex on symbol names), semanticQuery (vector cosine; fills the vocabulary gap, e.g. find "publish" when you search "send"). Responds with prefix-grouped tree rows of qn/label/file/lines and in/out degrees.',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
      query: { type: 'string', description: 'Natural-language or keyword full-text search. Tokens split on whitespace; camelCase identifiers index as individual words. When provided, namePattern is ignored.' },
      label: { type: 'string', description: 'Restrict to one node label, e.g. Function, Method, Route, Class.' },
      namePattern: { type: 'string', description: 'Exact regex over symbol names (ignored when query is provided).' },
      qnPattern: { type: 'string', description: 'Regex over qualified names.' },
      filePattern: { type: 'string', description: 'Restrict to files matching this substring/glob.' },
      relationship: { type: 'string', description: 'Edge relationship to filter by.' },
      minDegree: { type: 'integer', description: 'Minimum selected degree.' },
      maxDegree: { type: 'integer', description: 'Maximum selected degree.' },
      excludeEntryPoints: { type: 'boolean', description: 'Exclude entry-point symbols.' },
      includeConnected: { type: 'boolean', description: 'Also return connected nodes.' },
      semanticQuery: { type: 'array', items: { type: 'string' }, description: 'Array of keyword strings (NOT a single string) — each scored via per-keyword min-cosine. Requires moderate/full index mode.' },
      limit: { type: 'integer', description: 'Max results per call (default 50). Response carries total and has_more; page with offset when truncated.' },
      offset: { type: 'integer', description: 'Skip the first N results. Combine with limit to page until has_more is false.' },
      format: { type: 'string', enum: ['tree', 'json'], description: 'Response encoding: tree (default) prefix-grouped rows; json the same model as structured JSON.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Extra per-node property columns, e.g. complexity, cognitive, signature, docstring, return_type, is_test, lines(int). Core columns (qn/label/file/lines/in/out) are always present.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as Record<string, unknown>
      const { payload } = await call('search_graph', withProject(a), baseTimeout)
      return { text: renderPayload(payload, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_query_graph',
    device: true,
    description:
      'Execute a raw Cypher query against the codebase-memory knowledge graph for multi-hop patterns, aggregations, and cross-service analysis the curated tools cannot express. Response carries total (returned row count); the graph enforces a hard 100k row ceiling, so add LIMIT for broad queries. Each Function/Method node also carries complexity/cognitive/loop/recursion hot-path properties.',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
      query: { type: 'string', description: 'Cypher query, e.g. MATCH (f:Function) WHERE f.transitive_loop_depth >= 3 RETURN f.qualified_name, f.transitive_loop_depth, f.linear_scan_in_loop ORDER BY f.transitive_loop_depth DESC.' },
      maxRows: { type: 'integer', description: 'Optional row cap (default: unlimited up to the 100k ceiling). No offset support — use codebase_search_graph for paged browsing.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args
      if (!a.query) throw new CodebaseMemoryCliError('query is required', [], '', '', null)
      const payload: Record<string, unknown> = { query: a.query, ...withProject(a) }
      if (a.maxRows !== undefined) payload.max_rows = a.maxRows
      const { payload: out } = await call('query_graph', payload, baseTimeout)
      return { text: renderPayload(out, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_trace_path',
    device: true,
    description:
      'Trace call/dataflow/cross-service paths through the codebase-memory knowledge graph. callers/callees (calls mode), value propagation with argument expressions (data_flow), or through HTTP/async route nodes and across repos (cross_service). Callers surface the declaration plus every inbound edge.',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
      functionName: { type: 'string', description: 'Qualified name from codebase_search_graph, or a short function name.' },
      direction: { type: 'string', enum: ['inbound', 'outbound', 'both'], description: 'Trace direction (default both).' },
      depth: { type: 'integer', description: 'Hop depth (default 3).' },
      mode: { type: 'string', enum: ['calls', 'data_flow', 'cross_service'], description: 'calls: CALLS edges. data_flow: CALLS+DATA_FLOWS with arg expressions. cross_service: HTTP/async routes and CROSS_* cross-repo edges.' },
      parameterName: { type: 'string', description: 'data_flow mode: scope the trace to one parameter name.' },
      edgeTypes: { type: 'array', items: { type: 'string' }, description: 'Restrict to specific edge types.' },
      riskLabels: { type: 'boolean', description: 'Add CRITICAL/HIGH/MEDIUM/LOW risk classes by hop distance.' },
      includeTests: { type: 'boolean', description: 'Include test nodes (default excludes them).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as Record<string, unknown>
      const { payload } = await call('trace_path', withProject(a), baseTimeout)
      return { text: renderPayload(payload, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_get_code_snippet',
    device: true,
    description:
      'Read the source of one symbol from an indexed project — full qualified name from codebase_search_graph, or a short function name. Use instead of several file read + grep cycles when you already know the symbol (from codebase_search_graph / codebase_trace_path).',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
      qualifiedName: { type: 'string', description: 'Full qualified_name from codebase_search_graph, or a short function name.' },
      includeNeighbors: { type: 'boolean', description: "Also render the symbol's structural neighbors." },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as { qualifiedName?: string; includeNeighbors?: boolean }
      if (!a.qualifiedName) throw new CodebaseMemoryCliError('qualifiedName is required', [], '', '', null)
      const payload: Record<string, unknown> = { qualified_name: a.qualifiedName, ...withProject(a) }
      if (a.includeNeighbors !== undefined) payload.include_neighbors = a.includeNeighbors
      const { payload: out } = await call('get_code_snippet', payload, baseTimeout)
      return { text: renderPayload(out, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_get_graph_schema',
    device: true,
    description:
      'Return the node labels and edge types available in a project\'s knowledge graph — the vocabulary for codebase_query_graph Cypher and the labels accepted by codebase_search_graph.',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as Record<string, unknown>
      const { payload } = await call('get_graph_schema', withProject(a), baseTimeout)
      return { text: renderPayload(payload, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_get_architecture',
    device: true,
    description:
      'High-level architecture overview of a project from the knowledge graph: packages, services, dependencies, and de-facto modules (Leiden clusters over the call/import graph) with cohesion and representative nodes. Use before diving into traversal code, and to validate refactors against the real seams. Optional directory prefix scopes the analysis.',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
      path: { type: 'string', description: 'Optional directory prefix to scope the architecture, e.g. apps/hoa.' },
      aspects: { type: 'array', items: { type: 'string' }, description: 'Aspects to include: all, overview, structure, dependencies, routes, languages, packages, entry_points, hotspots, boundaries, layers, file_tree, clusters. Omit = all.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as Record<string, unknown>
      const { payload } = await call('get_architecture', withProject(a), baseTimeout)
      return { text: renderPayload(payload, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_search_code',
    device: true,
    description:
      'Grep-augmented code search: finds text patterns, then enriches matches into containing functions ranked by structural importance (definitions first, popular functions next, tests last). Modes: compact (default, signatures), full (with source), files (just file paths). Use when you need to find code by literal text within one indexed project.',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
      pattern: { type: 'string', description: 'Text pattern to search (grep syntax).' },
      filePattern: { type: 'string', description: 'Glob to restrict files, e.g. *.go or packages/**/*.ts.' },
      pathFilter: { type: 'string', description: 'Regex filter on result file paths, e.g. ^src/ or \\.(go|ts)$.' },
      mode: { type: 'string', enum: ['compact', 'full', 'files'], description: 'compact (default): signatures + metadata. full: with source. files: just file list.' },
      context: { type: 'integer', description: 'Lines of context around each match (grep -C). Only used in compact mode.' },
      regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default literal).' },
      limit: { type: 'integer', description: 'Max enriched results (default 10; responses carry total_grep_matches/total_results so you can detect truncation and raise limit or narrow path_filter).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as Record<string, unknown>
      const { payload } = await call('search_code', withProject(a), baseTimeout)
      return { text: renderPayload(payload, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_detect_changes',
    device: true,
    description:
      'Detect code changes and their impact on an indexed project\'s knowledge graph: git diff from a base branch/ref mapped onto the graph, telling you which symbols/routes/clusters a change touches. Use before and after edits to plan and review work.',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
      scope: { type: 'string', description: 'Optional scope hint for the analysis.' },
      depth: { type: 'integer', description: 'Impact depth (default 2).' },
      baseBranch: { type: 'string', description: 'Base branch to diff from (default main).' },
      since: { type: 'string', description: 'Git ref or tag to compare from, e.g. HEAD~5 or v0.5.0. Diffs <ref>...HEAD.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as Record<string, unknown>
      const { payload } = await call('detect_changes', withProject(a), baseTimeout)
      return { text: renderPayload(payload, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_manage_adr',
    device: true,
    description:
      'Read or write Architecture Decision Records for an indexed project. Modes: get (list ADRs), update (create/replace an ADR), sections (read individual ADR sections). Use to persist load-bearing architectural choices next to the code.',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
      mode: { type: 'string', enum: ['get', 'update', 'sections'], description: 'get: list ADRs; update: create/replace an ADR; sections: read one ADR\'s sections.' },
      content: { type: 'string', description: 'Full ADR content for mode=update.' },
      sections: { type: 'array', items: { type: 'string' }, description: 'Section names to read for mode=sections.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as Record<string, unknown>
      const { payload } = await call('manage_adr', withProject(a), baseTimeout)
      return { text: renderPayload(payload, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_ingest_traces',
    device: true,
    description:
      'Fold runtime call traces into an indexed project\'s knowledge graph so queries and analysis reflect observed behavior, not just static structure. Accepts an array of {caller, callee, count} and returns the accepted/imported counts.',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
      traces: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { caller: { type: 'string', required: true }, callee: { type: 'string', required: true }, count: { type: 'integer', required: true } } }, description: 'Runtime traces to ingest.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as { traces?: unknown[] }
      if (!Array.isArray(a.traces) || a.traces.length === 0) throw new CodebaseMemoryCliError('traces must be a non-empty array', [], '', '', null)
      const payload: Record<string, unknown> = { traces: a.traces, ...withProject(a) }
      const { payload: out } = await call('ingest_traces', payload, baseTimeout)
      return { text: renderPayload(out, maxChars) }
    },
  }))

  ctx.tools.register(defineCodebaseMemoryTool({
    name: 'codebase_delete_project',
    device: true,
    description:
      'Delete a project\'s index from the codebase-memory graph store. Destructive and permanent: the graph is rebuilt only by re-running codebase_index_repository. Use only for cleanup of superseded indexes (e.g. to free disk).',
    parameters: {
      project: { type: 'string', description: 'Indexed project name (see codebase_list_projects).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const a = args as Record<string, unknown>
      const { payload } = await call('delete_project', withProject(a), baseTimeout)
      return { text: renderPayload(payload, maxChars) }
    },
  }))
}
