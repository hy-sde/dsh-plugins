/**
 * Model-facing Logseq CLI tools: `logseq_list`, `logseq_show`, `logseq_search`,
 * `logseq_query`, `logseq_upsert`, `logseq_remove`, `logseq_graph`,
 * `logseq_server`.
 *
 * The surface wraps the `logseq` OCaml CLI (`--output json` where shapeable)
 * and drives the Logseq database graph directly — including the operations the
 * desktop MCP bridge cannot do: Datalog `query`, `remove`, first-class `task`
 * upserts, and graph/server lifecycle. Reads are JSON-parseable; `show` and
 * the graph/server tables pass through the CLI's human text.
 * @module @hy-sde-org/dsh-tool-logseq/logseq
 */

import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Tool-level configuration (all optional; defaults apply). */
export interface LogseqToolConfig {
  /** CLI executable (default `logseq` on PATH). */
  cliPath?: string
  /** Graph name passed with `--graph` (default: none — CLI uses its own current). */
  graph?: string
  /** CLI root dir passed with `--root-dir` (default: none — CLI uses ~/logseq). */
  rootDir?: string
  /** Per-call process timeout in ms (default 60000). */
  timeoutMs?: number
  /** Cap on rendered items for list/search results (default 50). */
  maxItems?: number
}

/** Raised when the underlying CLI exits non-zero or the envelope reports an error. */
export class LogseqCliError extends Error {
  /** CLI invocation that failed. */
  readonly args: string[]
  /** Caputured stdout (may hold a partial JSON envelope). */
  readonly stdout: string
  /** Captured stderr (often holds the human error line). */
  readonly stderr: string
  /** Process exit code, or null when no process ran (e.g. ENOENT). */
  readonly exitCode: number | null

  constructor(message: string, args: string[], stdout: string, stderr: string, exitCode: number | null) {
    super(message)
    this.name = 'LogseqCliError'
    this.args = args
    this.stdout = stdout
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

interface Envelope {
  status: 'ok' | 'error' | 'text'
  data?: unknown
  error?: unknown
}

/** Run the CLI once; timeout and maxBuffer are fixed per call. */
/**
 * Run the CLI once; stdout/stderr/exit-code are returned as-is.
 * @param cmd - CLI executable path.
 * @param args - full argv (including globals and `--output json`).
 * @param options - run options (per-call timeout).
 * @returns the captured stdout/stderr and exit code.
 * @throws {@link LogseqCliError} when the process fails or times out.
 */
export async function runCli(cmd: string, args: string[], options: { timeoutMs: number }): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    execFile(cmd, args, {
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ stdout, stderr, exitCode: 0 })
        return
      }
      const e = err as unknown as { code?: number | string; signal?: string }
      const code = typeof e.code === 'number' ? e.code : null
      if (e.code === 'ENOENT') {
        reject(new LogseqCliError(
          `logseq CLI not found (\`${cmd}\`). Install it from the logseq repository: opam exec -- dune build @bundle, then add to PATH.`,
          args, stdout, stderr, code))
        return
      }
      const tail = stderr.trim().slice(0, 400)
      reject(new LogseqCliError(
        `logseq CLI exited with ${code === null ? 'unknown error' : `code ${code}`}${tail ? `: ${tail}` : ''}`,
        args, stdout, stderr, code))
    })
  })
}

/**
 * Parse `--output json` stdout into an envelope; fall back to text mode.
 * @param stdout - raw CLI stdout.
 * @returns classified envelope ({@link Envelope}).
 */
export function parseOutput(stdout: string): Envelope {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (isEnvelope(parsed) && parsed.status === 'ok') return { status: 'ok', data: parsed.data, error: undefined }
    if (isEnvelope(parsed) && parsed.status === 'error') return { status: 'error', data: undefined, error: parsed.error ?? parsed }
    return { status: 'text', data: stdout }
  } catch {
    return { status: 'text', data: stdout }
  }
}

/** Narrows parsed CLI stdout to a classified {@link Envelope}. */
function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('status' in value)) return false
  const status = value.status
  return status === 'ok' || status === 'error' || status === 'text'
}

/* ── small argv helpers ─────────────────────────────────────────────────── */

function addStr(out: string[], flag: string, value: string | undefined): void {
  if (value !== undefined && value !== '') out.push(flag, value)
}

function addNum(out: string[], flag: string, value: number | undefined): void {
  if (value !== undefined) out.push(flag, String(value))
}

function addBool(out: string[], flag: string, value: boolean | undefined): void {
  if (value !== undefined) out.push(flag, value ? 'true' : 'false')
}

function addEdn(out: string[], flag: string, value: string | string[] | Record<string, unknown> | undefined): void {
  if (value === undefined) return
  const edn = typeof value === 'string' ? value : JSON.stringify(value)
  out.push(flag, edn)
}

function titleOf(item: Record<string, unknown> | undefined): string {
  if (!item) return ''
  const t = item['block/title'] ?? item['block/name'] ?? item['title'] ?? item['name']
  return typeof t === 'string' ? t : ''
}

/* ── renderers ──────────────────────────────────────────────────────────── */

/**
 * Render a flat item list with a count line and truncated cap.
 * @param items - CLI item records (or undefined).
 * @param max - item cap before truncation.
 * @param label - list label on the count line.
 * @returns the rendered text.
 */
export function renderItems(items: unknown[] | undefined, max: number, label: string): string {
  if (!items) return `${label}: none`
  const total = items.length
  if (total === 0) return `${label}: none`
  const shown = items.slice(0, max)
  return [
    `${label}: ${total}${total > shown.length ? ` (truncated to ${shown.length})` : ''}`,
    ...shown.map((it, i) => {
      const rec = (it ?? {}) as Record<string, unknown>
      const title = titleOf(rec)
      const side: string[] = []
      for (const k of ['block/name', 'db/ident', 'status', 'block/created-at', 'block/updated-at']) {
        if (rec[k] !== undefined && typeof rec[k] === 'string') side.push(`${k}=${rec[k]}`)
      }
      return `  ${i + 1}. ${title || JSON.stringify(rec).slice(0, 120)}${side.length ? `  [${side.join(' ')}]` : ''}`
    }),
  ].join('\n')
}

/**
 * Render one query result row as a `- a | b | c` line.
 * @param row - a scalar or array row.
 * @returns the rendered line.
 */
export function renderRows(row: unknown): string {
  if (Array.isArray(row)) return `- ${row.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' | ')}`
  if (typeof row === 'string' || typeof row === 'number') return `- ${String(row)}`
  return `- ${JSON.stringify(row ?? '')}`
}

/**
 * Render a tool value uniformly: item lists, query rows, block lists, or JSON.
 * @param value - envelope data (may expose items/result/blocks).
 * @param max - item/row cap.
 * @param label - heading label.
 * @param rows - prefer row rendering for result arrays (default false).
 * @returns the rendered text.
 */
export function renderValue(value: unknown, max: number, label: string, rows?: boolean): string {
  if (isRecord(value) && Array.isArray(value.items)) return renderItems(value.items, max, label)
  if (isRecord(value) && Array.isArray(value.result)) {
    const shown = value.result.slice(0, max)
    return [
      `${label}: ${value.result.length} rows${value.result.length > shown.length ? ` (truncated to ${shown.length})` : ''}`,
      ...shown.map(r => (rows === false ? `- ${typeof r === 'string' ? r : JSON.stringify(r).slice(0, 160)}` : renderRows(r))),
    ].join('\n')
  }
  if (isRecord(value) && Array.isArray(value.blocks)) return renderItems(value.blocks, max, label)
  return `${label}: ${JSON.stringify(value).slice(0, 2000)}`
}

/** Narrows a rendered tool value to a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * String-coerces an unknown CLI error value exactly the way `String(value)`
 * would, without relying on `String()` (which the linter rejects for
 * object-typed values): primitives stringify natively and objects take their
 * default `Object.prototype.toString` form.
 */
function stringifyErrorValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return String(value)
  }
  return Object.prototype.toString.call(value)
}

/* ── the tools ──────────────────────────────────────────────────────────── */

/** Supported `logseq_list` entity kinds (CLI `list <entity>` subcommands). */
export const ENTITY_TYPES = ['page', 'tag', 'property', 'task', 'node', 'asset'] as const
/** Supported {@link ENTITY_TYPES} element type. */
export type LogseqListEntity = (typeof ENTITY_TYPES)[number]

/**
 * Register all eight logseq tools (the prompt section is added by the index
 * plugin; this stays separable for tests).
 * @param ctx - Cordis context carrying `tools` and `systemPrompt`.
 * @param config - tool-level configuration (CLI path/graph/rootDir/timeout/caps).
 */
export function applyLogseqTools(ctx: Context, config: LogseqToolConfig = {}): void {
  const cmd = config.cliPath ?? 'logseq'
  const timeoutMs = config.timeoutMs ?? 60000
  const maxItems = config.maxItems ?? 50
  const base = (): string[] => {
    const out: string[] = []
    if (config.graph) out.push('--graph', config.graph)
    if (config.rootDir) out.push('--root-dir', config.rootDir)
    return out
  }
  // Shared runner: parse JSON envelopes, surface human errors on stderr, and
  // throw a LogseqCliError for error envelopes (exit code attached if real).
  const exec = async (argv: string[]): Promise<{ env: Envelope; raw: string }> => {
    const run = await runCli(cmd, argv, { timeoutMs })
    let env = parseOutput(run.stdout)
    if (env.status === 'text' && run.stderr.trim().length > 0) {
      env = { status: 'error', data: undefined, error: run.stderr.trim() }
    }
    if (env.status === 'error') {
      const message = typeof env.error === 'string' ? env.error : JSON.stringify(env.error ?? '')
      throw new LogseqCliError(message || 'logseq CLI error', argv, run.stdout, run.stderr, run.exitCode)
    }
    return { env, raw: run.stdout }
  }
  // shared flags for list commands
  const listCommon = (args: { limit?: number; offset?: number; sort?: string; order?: string; fields?: string }): string[] => {
    const out: string[] = []
    addNum(out, '--limit', args.limit)
    addNum(out, '--offset', args.offset)
    addStr(out, '--sort', args.sort)
    addStr(out, '--order', args.order)
    addStr(out, '--fields', args.fields)
    return out
  }

  void ctx

  ctx.tools.register(defineTool({
    name: 'logseq_list',
    description:
      'List Logseq graph entities (pages, tags, properties, tasks, nodes, assets) from the db graph via the `logseq list <entity>` CLI.',
    parameters: {
      entityType: { type: 'string', enum: [...ENTITY_TYPES], description: 'Kind of entity to list.' },
      limit: { type: 'integer', description: 'Maximum result count (default: 50).' },
      offset: { type: 'integer', description: 'Result offset.' },
      sort: { type: 'string', description: 'Sort field (e.g. id, title, updated-at).' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order.' },
      fields: { type: 'string', description: 'Comma-separated fields to include (id, title, ident, uuid, status, ...).' },
      includeBuiltIn: { type: 'boolean', description: 'Include built-in/system entries (pages/tags/properties).' },
      journalOnly: { type: 'boolean', description: 'Pages: only journal pages.' },
      includeHidden: { type: 'boolean', description: 'Pages: include hidden pages.' },
      withProperties: { type: 'boolean', description: 'Tags: include properties data.' },
      withExtends: { type: 'boolean', description: 'Tags: include extends data.' },
      taskStatus: { type: 'string', description: 'Tasks: filter by status (todo/doing/done/...).' },
      taskPriority: { type: 'string', description: 'Tasks: filter by priority.' },
      content: { type: 'string', description: 'Tasks: content filter; Search: search text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entityType: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text', text: renderValue(value, maxItems, '') }],
    },
    async execute(args) {
      const t = (args as { entityType?: string }).entityType ?? 'page'
      if (!ENTITY_TYPES.includes(t as LogseqListEntity)) {
        throw new LogseqCliError(`unsupported entityType ${t}`, [], '', '', null)
      }
      const argv = [...base(), 'list', t, ...listCommon(args as Record<string, number | string | undefined>)]
      addBool(argv, '--include-built-in', (args as { includeBuiltIn?: boolean }).includeBuiltIn)
      addBool(argv, '--include-hidden', (args as { includeHidden?: boolean }).includeHidden)
      addBool(argv, '--journal-only', (args as { journalOnly?: boolean }).journalOnly)
      addBool(argv, '--with-properties', (args as { withProperties?: boolean }).withProperties)
      addBool(argv, '--with-extends', (args as { withExtends?: boolean }).withExtends)
      addStr(argv, '--status', (args as { taskStatus?: string }).taskStatus)
      addStr(argv, '--priority', (args as { taskPriority?: string }).taskPriority)
      addStr(argv, '--content', (args as { content?: string }).content)
      argv.push('--output', 'json')
      const { env } = await exec(argv)
      const data = env.data as { items?: unknown[] } | undefined
      const items = data?.items ?? []
      return { entityType: t, count: items.length, truncated: items.length > maxItems, text: renderItems(items, maxItems, `pages (${t})`) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'logseq_search',
    description:
      'Search Logseq blocks/pages/properties/tags by content text (`logseq search <type> --content <text>`). Returns matching items.',
    parameters: {
      entityType: { type: 'string', enum: ['block', 'page', 'property', 'tag'], description: 'Kind to search.' },
      content: { type: 'string', description: 'Search text.' },
      limit: { type: 'integer', description: 'Cap on returned items (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entityType: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text', text: renderValue(value, maxItems, 'search') }],
    },
    async execute(args) {
      const t = (args as { entityType?: string }).entityType ?? 'block'
      const content = (args as { content?: string }).content ?? ''
      if (!content) throw new LogseqCliError('search requires `content`', [], '', '', null)
      const argv = [...base(), 'search', t, '--content', content, '--output', 'json']
      const { env } = await exec(argv)
      const items = ((env.data ?? {}) as { items?: unknown[] }).items ?? []
      const cap = args.limit ?? maxItems
      return { entityType: t, count: items.length, text: renderItems(items, cap, `search ${t}`) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'logseq_query',
    description:
      'Run a Datascript query against the graph (`logseq query --query <EDN>`), or a saved query by name with optional inputs. Use for structural questions page/blocks/tags cannot answer in one hop.',
    parameters: {
      query: { type: 'string', description: 'Datascript query EDN, e.g. `[:find [?t ...] :where [?b :block/title ?t]]`.' },
      name: { type: 'string', description: 'Saved query name (from `logseq query list`).' },
      inputs: { type: 'string', description: 'Query inputs EDN, e.g. `[:foo "value"]` or `[30]`.' },
      limit: { type: 'integer', description: 'Cap on returned rows (default 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text', text: renderValue(value, 20, 'query', true) }],
    },
    async execute(args) {
      const q = (args as { query?: string }).query
      const name = (args as { name?: string }).name
      const inputs = (args as { inputs?: string }).inputs
      if (!q && !name) throw new LogseqCliError('provide either `query` (Datascript EDN) or `name`', [], '', '', null)
      const argv = [...base(), 'query']
      addStr(argv, '--query', q)
      addStr(argv, '--name', name)
      addStr(argv, '--inputs', inputs)
      argv.push('--output', 'json')
      const { env } = await exec(argv)
      const data = env.data as { result?: unknown[]; status?: unknown } | undefined
      // query returns {"result": [...]} directly in data; guard shape drift
      const result = (data ?? {}).result
      return { count: Array.isArray(result) ? result.length : 0, text: renderValue({ result }, maxItems, 'query result', true) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'logseq_show',
    description:
      'Show the block/page tree (`logseq show --page <name>` or `--id`/`--uuid`), optionally with hierarchy: returns the CLI human tree text.',
    parameters: {
      page: { type: 'string', description: 'Page name to show.' },
      id: { type: 'integer', description: 'Entity db/id to show.' },
      uuid: { type: 'string', description: 'Block/page UUID to show.' },
      level: { type: 'integer', description: 'Tree depth cap.' },
      pageHierarchy: { type: 'boolean', description: 'Include page hierarchy.' },
      linkedReferences: { type: 'boolean', description: 'Include linked references.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text', text: (value as { text?: string }).text ?? '' }],
    },
    async execute(args) {
      const argv = [...base(), 'show']
      addStr(argv, '--page', (args as { page?: string }).page)
      addNum(argv, '--id', (args as { id?: number }).id)
      addStr(argv, '--uuid', (args as { uuid?: string }).uuid)
      addNum(argv, '--level', (args as { level?: number }).level)
      addBool(argv, '--page-hierarchy', (args as { pageHierarchy?: boolean }).pageHierarchy)
      addBool(argv, '--linked-references', (args as { linkedReferences?: boolean }).linkedReferences)
      if (!argv.some(a => a === '--page' || a === '--id' || a === '--uuid')) {
        throw new LogseqCliError('set one of page / id / uuid', [], '', '', null)
      }
      const { stdout } = await runCli(cmd, argv, { timeoutMs })
      return { text: `${stdout.trim()}\n` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'logseq_upsert',
    description:
      'Create or update a Logseq entity (block/page/tag/property/task). Update mode when id/uuid is given; tags/properties/task status are structured options, never embedded in content.',
    parameters: {
      entityType: { type: 'string', enum: ['block', 'page', 'tag', 'property', 'task'], description: 'Kind to upsert.' },
      id: { type: 'integer', description: 'Entity db/id (update mode).' },
      uuid: { type: 'string', description: 'Entity UUID (update mode).' },
      // block / task
      content: { type: 'string', description: 'block/task content text (required to create).' },
      targetPage: { type: 'string', description: 'block/task: page to place under.' },
      targetId: { type: 'integer', description: 'block/task: target block id (position anchor).' },
      pos: { type: 'string', enum: ['first-child', 'last-child', 'sibling'], description: 'block/task: insert position.' },
      // page
      page: { type: 'string', description: 'page name.' },
      // tag / property
      name: { type: 'string', description: 'tag/property name.' },
      propertyType: { type: 'string', enum: ['default', 'number', 'date', 'checkbox', 'url'], description: 'property type.' },
      cardinality: { type: 'string', enum: ['one', 'many'], description: 'property cardinality.' },
      // structured tags/properties/status
      updateTags: { type: 'array', items: { type: 'string' }, description: 'tags to add (page/block).' },
      updateProperties: { type: 'object', additionalProperties: true, description: 'properties map to add/update (page/block).' },
      removeTags: { type: 'array', items: { type: 'string' }, description: 'tags to remove.' },
      removeProperties: { type: 'array', items: { type: 'string' }, description: 'property names to remove.' },
      status: { type: 'string', enum: ['todo', 'doing', 'done', 'waiting', 'later', 'cancelled'], description: 'task status (structured, not in content).' },
      priority: { type: 'string', description: 'task priority (A/B/C/...).' },
      scheduled: { type: 'string', description: 'task scheduled date.' },
      deadline: { type: 'string', description: 'task deadline date.' },
      restore: { type: 'boolean', description: 'page: restore recycled page before updating.' },
      dryRun: { type: 'boolean', description: 'Print the exact CLI invocation only; do not write.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entityType: { type: 'string', required: true },
          status: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text', text: renderValue(value, maxItems, 'upsert') }],
    },
    async execute(args) {
      const t = (args as { entityType?: string }).entityType ?? 'page'
      const allowed = ['block', 'page', 'tag', 'property', 'task'] as const
      if (!allowed.includes(t as typeof allowed[number])) {
        throw new LogseqCliError(`unsupported entityType ${t}`, [], '', '', null)
      }
      const argv = [...base(), 'upsert', t]
      const a = args as Record<string, unknown>
      // Mirror the real CLI's own guard so we fail fast without spawning.
      const isNewBlockish = (t === 'block' || t === 'task')
        && typeof a.content !== 'string' && a.id === undefined && a.uuid === undefined && typeof a.targetId !== 'number'
      if (isNewBlockish) {
        throw new LogseqCliError('missing-content: content is required', argv, '', '', null)
      }
      addStr(argv, '--page', typeof a.page === 'string' ? a.page : undefined)
      addStr(argv, '--name', typeof a.name === 'string' ? a.name : undefined)
      addStr(argv, '--content', typeof a.content === 'string' ? a.content : undefined)
      addNum(argv, '--id', typeof a.id === 'number' ? a.id : undefined)
      addStr(argv, '--uuid', typeof a.uuid === 'string' ? a.uuid : undefined)
      addStr(argv, '--target-page', typeof a.targetPage === 'string' ? a.targetPage : undefined)
      addStr(argv, '--target-id', typeof a.targetId === 'number' ? String(a.targetId) : undefined)
      addStr(argv, '--pos', typeof a.pos === 'string' ? a.pos : undefined)
      addStr(argv, '--type', typeof a.propertyType === 'string' ? a.propertyType : undefined)
      addStr(argv, '--cardinality', typeof a.cardinality === 'string' ? a.cardinality : undefined)
      addStr(argv, '--status', typeof a.status === 'string' ? a.status : undefined)
      addStr(argv, '--priority', typeof a.priority === 'string' ? a.priority : undefined)
      addStr(argv, '--scheduled', typeof a.scheduled === 'string' ? a.scheduled : undefined)
      addStr(argv, '--deadline', typeof a.deadline === 'string' ? a.deadline : undefined)
      addEdn(argv, '--update-tags', Array.isArray(a.updateTags) ? a.updateTags : undefined)
      addEdn(argv, '--remove-tags', Array.isArray(a.removeTags) ? a.removeTags : undefined)
      addEdn(argv, '--update-properties', typeof a.updateProperties === 'object' && a.updateProperties !== null ? a.updateProperties as Record<string, unknown> : undefined)
      addEdn(argv, '--remove-properties', Array.isArray(a.removeProperties) ? a.removeProperties : undefined)
      addBool(argv, '--restore', typeof a.restore === 'boolean' ? a.restore : undefined)
      argv.push('--output', 'json')
      if (a.dryRun === true) {
        return { entityType: t, status: 'dry-run', detail: `would run: \`${cmd} ${argv.join(' ')}\`` }
      }
      const { env } = await exec(argv)
      const data = env.data as Record<string, unknown> | undefined
      const title = titleOf(data)
      const dbId = data?.['db/id']
      const idText = typeof dbId === 'string' || typeof dbId === 'number' ? String(dbId) : ''
      return {
        entityType: t,
        status: 'ok',
        detail: `${t}${title ? ` \`${title}\`` : ''} upserted${data ? ` (id=${idText})` : ''}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'logseq_remove',
    description:
      'Permanently remove entities from the graph (`logseq remove <entity>`). Destruction is real — only use when certain; prefer flagging with status/superseded where the wiki schema allows.',
    parameters: {
      entityType: { type: 'string', enum: ['block', 'page', 'tag', 'property'], description: 'Kind to remove.' },
      id: { type: 'integer', description: 'Entity db/id.' },
      uuid: { type: 'string', description: 'Entity UUID.' },
      page: { type: 'string', description: 'Page name (for page entity).' },
      name: { type: 'string', description: 'Tag/property name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entityType: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text', text: renderValue(value, maxItems, 'remove') }],
    },
    async execute(args) {
      const t = (args as { entityType?: string }).entityType ?? 'block'
      const a = args as Record<string, unknown>
      const argv = [...base(), 'remove', t]
      addNum(argv, '--id', typeof a.id === 'number' ? a.id : undefined)
      addStr(argv, '--uuid', typeof a.uuid === 'string' ? a.uuid : undefined)
      addStr(argv, '--page', typeof a.page === 'string' ? a.page : undefined)
      addStr(argv, '--name', typeof a.name === 'string' ? a.name : undefined)
      if (!argv.some(x => x.startsWith('--id') || x.startsWith('--uuid') || x.startsWith('--page') || x.startsWith('--name'))) {
        throw new LogseqCliError('provide a selector: id / uuid / page / name', [], '', '', null)
      }
      argv.push('--output', 'json')
      await exec(argv)
      return { entityType: t, detail: `${t} removed` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'logseq_graph',
    description:
      'Graph lifecycle ops (`logseq graph ...`): validate, info, export (edn/sqlite to a file), import, backup list/create/restore/remove. Use export/backup before destructive passes.',
    parameters: {
      action: {
        type: 'string',
        enum: ['validate', 'info', 'export', 'import', 'backup-list', 'backup-create', 'backup-restore', 'backup-remove'],
        description: 'Which graph operation to run.',
      },
      type: { type: 'string', enum: ['edn', 'sqlite'], description: 'export: output format.' },
      file: { type: 'string', description: 'export: output file; import: input file.' },
      backupName: { type: 'string', description: 'backup-create/restore: backup name.' },
      fix: { type: 'boolean', description: 'validate: fix problems.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text', text: renderValue(value, maxItems, 'graph') }],
    },
    async execute(args) {
      const a = args as { action?: string; type?: string; file?: string; backupName?: string; fix?: boolean }
      const action = a.action ?? 'info'
      const argv = [...base(), 'graph']
      const tableActs = ['validate', 'info', 'export', 'import', 'backup-list']
      if (action === 'backup-create') argv.push('backup', 'create')
      else if (action === 'backup-restore') argv.push('backup', 'restore')
      else if (action === 'backup-remove') argv.push('backup', 'remove')
      else argv.push(action === 'validate' || action === 'info' || action === 'export' || action === 'import' ? action : 'list')
      addBool(argv, '--fix', a.fix)
      addStr(argv, '--type', a.type)
      addStr(argv, '--file', a.file)
      addStr(argv, '--name', a.backupName)
      argv.push('--output', 'json')
      const { stdout } = await runCli(cmd, argv, { timeoutMs })
      const env = parseOutput(stdout)
      if (env.status === 'error') throw new LogseqCliError(stringifyErrorValue(env.error), argv, stdout, '', null)
      const isTable = tableActs.includes(action) && env.status === 'text'
      return { action, detail: isTable ? `${stdout}\n` : JSON.stringify(env.data).slice(0, 2000) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'logseq_server',
    description:
      'Manage the db-worker-node server(s) (`logseq server ...`): list/start/stop/restart/cleanup. Needed for headless use: start once per graph, then any read/write tool works without the desktop app.',
    parameters: {
      action: { type: 'string', enum: ['list', 'start', 'stop', 'restart', 'cleanup'], description: 'Server operation (default list).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text', text: renderValue(value, maxItems, 'server') }],
    },
    async execute(args) {
      const action = (args as { action?: string }).action ?? 'list'
      const argv = ['server', action]
      argv.push('--output', 'json')
      const { stdout } = await runCli(cmd, argv, { timeoutMs })
      return { action, detail: stdout.length < 4000 ? `${stdout}\n` : `${stdout.slice(0, 4000)}\n… (truncated)` }
    },
  }))
}
