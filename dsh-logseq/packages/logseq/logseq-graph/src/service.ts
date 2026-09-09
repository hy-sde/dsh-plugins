/**
 * The `ctx.wikiGraph` service: a host-plane, headless seam over the Logseq CLI
 * for the LLM-wiki workflow. The web UI and the host API proxy read and write
 * the graph through these typed methods; the model-facing tool surface stays
 * in `@hy-sde-org/dsh-tool-logseq`. All return values are plain JSON shapes
 * (see types.ts) so they cross the wire and the API proxy untouched.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { BlockNode, LinkedBlock, PageRow, PageRoot, PropertyRow, SearchItem, ServerRow, TagRow, TagRef } from './types.ts'

/** Configuration for the graph binding (CLI executable + target graph). */
export interface LogseqGraphConfig {
  /** Executable for the logseq CLI. Default: `logseq` on PATH. */
  cliPath?: string
  /** Graph name passed as `--graph <name>` on every call. Default: none (current graph). */
  graph?: string
  /** Optional `--root-dir` override (default: the CLI's own root directive). */
  rootDir?: string
  /** Per-call process timeout in ms. Default: 60000. */
  timeoutMs?: number
}

/** One upsert result, mirroring the CLI's envelope. */
export interface UpsertResult {
  entityType: string
  status: 'ok' | 'dry-run'
  detail: string
  /** New/updated entity db id when the CLI reports one. */
  id?: number
}

/** One remove result. */
export interface RemoveResult {
  entityType: string
  detail: string
}

/** wiki.server list result: the current server table. */
export interface ServerListResult {
  servers: ServerRow[]
}

/** wiki.server action result (start/stop/restart/cleanup). */
export interface ServerActionResult {
  action: string
  message: string
}

/** wiki.getPage result: one page root + its linked references. */
export interface GetPageResult {
  root: PageRoot
  linked: LinkedBlock[]
}

function asNum(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asUuid(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  return value
}

/** Project the db/id + name/title of a tag reference. */
function projectTagRef(raw: unknown): TagRef {
  const record = (raw ?? {}) as Record<string, unknown>
  return {
    id: asNum(record['db/id']) ?? 0,
    name: asStr(record['block/name']),
    title: asStr(record['block/title']),
  }
}

/** Project a nested block entity tree. */
function projectBlock(raw: unknown): BlockNode {
  const e = (raw ?? {}) as Record<string, unknown>
  return {
    id: asNum(e['db/id']) ?? 0,
    uuid: asUuid(e['block/uuid']),
    content: asStr(e['block/title']) ?? '',
    order: asStr(e['block/order']),
    createdAt: asNum(e['block/created-at']),
    updatedAt: asNum(e['block/updated-at']),
    tags: Array.isArray(e['block/tags']) ? e['block/tags'].map(projectTagRef) : [],
    children: Array.isArray(e['block/children']) ? e['block/children'].map(projectBlock) : [],
  }
}

/** Project the `show` root entity into a {@link PageRoot}. */
function projectRoot(e: Record<string, unknown>): PageRoot {
  const props: Record<string, number> = {}
  for (const [key, value] of Object.entries(e)) {
    if (!key.startsWith('user.property/')) continue
    const ref = value as Record<string, unknown> | undefined
    const id = asNum(ref?.['db/id'])
    if (id !== null) props[key] = id
  }
  return {
    id: asNum(e['db/id']) ?? 0,
    name: asStr(e['block/name']),
    title: asStr(e['block/title']) ?? '',
    uuid: asUuid(e['block/uuid']),
    createdAt: asNum(e['block/created-at']),
    updatedAt: asNum(e['block/updated-at']),
    tags: Array.isArray(e['block/tags']) ? e['block/tags'].map(projectTagRef) : [],
    props,
    children: Array.isArray(e['block/children']) ? e['block/children'].map(projectBlock) : [],
  }
}

/** Project one linked-reference block. */
function projectLinked(raw: unknown): LinkedBlock {
  const e = (raw ?? {}) as Record<string, unknown>
  const page = e['block/page'] as Record<string, unknown> | undefined
  return {
    id: asNum(e['db/id']) ?? 0,
    content: asStr(e['block/title']) ?? '',
    pageName: page === undefined ? null : asStr(page['block/name']),
    pageTitle: page === undefined ? null : asStr(page['block/title']),
    pageId: page === undefined ? null : asNum(page['db/id']),
    updatedAt: asNum(e['block/updated-at']),
  }
}

/** A flat CLI row (list/search server rows). */
type Row = Record<string, unknown>

function itemsOf(data: unknown): Row[] {
  if (data === null || typeof data !== 'object') return []
  const items = (data as { items?: unknown }).items
  return Array.isArray(items) ? items as Row[] : []
}

function rowToPage(row: Row): PageRow {
  return {
    id: asNum(row['db/id']) ?? 0,
    title: asStr(row['block/title']),
    createdAt: asNum(row['block/created-at']),
    updatedAt: asNum(row['block/updated-at']),
  }
}

function rowToTag(row: Row): TagRow {
  return {
    id: asNum(row['db/id']) ?? 0,
    name: asStr(row['block/name']) ?? asStr(row['block/title']),
    title: asStr(row['block/title']),
  }
}

function rowToProperty(row: Row): PropertyRow {
  return {
    id: asNum(row['db/id']) ?? 0,
    name: asStr(row['db/ident']) ?? asStr(row['block/title']),
    title: asStr(row['block/title']),
  }
}


function rowToServer(row: Row): ServerRow {
  return {
    id: asNum(row['pid']),
    name: asStr(row['graph']),
    url: asStr(row['base-url']),
    status: asStr(row['status']) ?? 'unknown',
    graph: asStr(row['graph']),
    port: asNum(row['port']),
  }
}

function toEdn(values: readonly string[]): string {
  return `[${values.map(value => JSON.stringify(value)).join(' ')}]`
}

function toEdnMap(values: Record<string, unknown>): string {
  const parts = Object.entries(values).map(([key, value]) => `${JSON.stringify(key)} ${JSON.stringify(value)}`)
  return `{${parts.join(' ')}}`
}

function addArg(argv: string[], flag: string, value: string | number | undefined): void {
  if (value !== undefined && value !== '') argv.push(flag, String(value))
}

function addBool(argv: string[], flag: string, value: boolean | undefined): void {
  if (value === true) argv.push(flag)
}

/** Error type from a CLI spawn/parse failure (re-exported for callers). */
export { LogseqCliError } from './cli.ts'

/**
 * The `ctx.wikiGraph` service implementation: one bound CLI executor + the
 * graph surface of the LLM-wiki workflow.
 */
export class LogseqGraphService extends Service {
  private readonly cliPath: string
  private readonly graph: string | undefined
  private readonly rootDir: string | undefined
  private readonly timeoutMs: number

  constructor(ctx: Context, config: LogseqGraphConfig = {}) {
    super(ctx, 'wikiGraph')
    this.cliPath = config.cliPath ?? 'logseq'
    this.graph = config.graph
    this.rootDir = config.rootDir
    this.timeoutMs = config.timeoutMs ?? 60_000
  }

  /** Base argv shared by every invocation (graph + root-dir + json output appended per call). */
  private base(): string[] {
    const out: string[] = []
    if (this.graph !== undefined) out.push('--graph', this.graph)
    if (this.rootDir !== undefined) out.push('--root-dir', this.rootDir)
    return out
  }

  /** Run the CLI and return the parsed envelope data. Throws LogseqCliError on any failure. */
  private async run(args: string[]): Promise<unknown> {
    const { execCli } = await import('./cli.ts')
    const result = await execCli(this.cliPath, args, {
      timeoutMs: this.timeoutMs,
      ...(this.graph !== undefined ? { graph: this.graph } : {}),
    })
    return result.data
  }

  /** List pages (built-ins excluded unless requested).
   * @param options - paging/filter options.
   * @returns projected page rows. */
  async listPages(options?: { includeBuiltIn?: boolean; limit?: number; offset?: number }): Promise<{ pages: PageRow[] }> {
    const argv = ['list', 'page']
    addBool(argv, '--include-built-in', options?.includeBuiltIn)
    addArg(argv, '--limit', options?.limit)
    addArg(argv, '--offset', options?.offset)
    const data = await this.run(argv)
    return { pages: itemsOf(data).map(rowToPage) }
  }

  /** List user tags.
   * @returns projected tag rows. */
  async listTags(): Promise<{ tags: TagRow[] }> {
    const data = await this.run(['list', 'tag'])
    return { tags: itemsOf(data).map(rowToTag) }
  }

  /** List properties.
   * @returns projected property rows. */
  async listProperties(): Promise<{ properties: PropertyRow[] }> {
    const data = await this.run(['list', 'property'])
    return { properties: itemsOf(data).map(rowToProperty) }
  }

  /** Get one page root with its nested block tree and linked references.
   * @param options - page/id/uuid selector (mutually exclusive).
   * @returns root tree + linked references. */
  async getPage(options: { page?: string; id?: number; uuid?: string }): Promise<GetPageResult> {
    const argv = ['show']
    addArg(argv, '--page', options.page)
    addArg(argv, '--id', options.id)
    addArg(argv, '--uuid', options.uuid)
    argv.push('--linked-references')
    const data = (await this.run(argv)) as Record<string, unknown> | null ?? {}
    const root = data['root'] as Record<string, unknown> | undefined ?? {}
    const linkedRaw = data['linked-references'] ?? {}
    const linkedBlocks = Array.isArray((linkedRaw as Record<string, unknown>)['blocks']) ? (linkedRaw as Record<string, unknown>)['blocks'] as unknown[] : []
    return {
      root: projectRoot(root),
      linked: linkedBlocks.map(projectLinked),
    }
  }

  /** Search pages/blocks/properties/tags by text content.
   * @param options - type/content/limit.
   * @returns search hits (page hits carry no pageName; block hits do). */
  async search(options: { type?: 'block' | 'page' | 'property' | 'tag'; content: string; limit?: number }): Promise<{ items: SearchItem[] }> {
    const type = options.type ?? 'block'
    const argv = ['search', type, '--content', options.content]
    const data = await this.run(argv)
    const rows = itemsOf(data)
    if (type === 'page') {
      return { items: rows.map(row => ({ id: asNum(row['db/id']) ?? 0, title: asStr(row['block/title']) ?? '', pageName: null })) }
    }
    const page = rows[0]
    return {
      items: rows.map(row => ({
        id: asNum(row['db/id']) ?? 0,
        title: asStr(row['block/title']) ?? '',
        pageName: page === undefined ? null : asStr((page['block/page'] as Record<string, unknown> | undefined)?.['block/name']),
      })),
    }
  }

  /** Run a Datascript query; returns the raw result rows.
   * @param options - query text + optional inputs/limit.
   * @returns the unflattened `result` value. */
  async query(options: { query: string; inputs?: string; limit?: number }): Promise<{ rows: unknown }> {
    const argv = ['query', '--query', options.query]
    addArg(argv, '--inputs', options.inputs)
    addArg(argv, '--limit', options.limit)
    const data = await this.run(argv)
    const result = data as Record<string, unknown> | undefined
    return { rows: result?.['result'] ?? [] }
  }

  /** Create/update a page/block/tag/property. Mirrors the CLI flag surface.
   * @param args - the requested entity change (one logical change per call).
   * @returns an acknowledgement; `dryRun` returns what would be run. */
  async upsert(args: Record<string, unknown>): Promise<UpsertResult> {
    const t = typeof args.entityType === 'string' ? args.entityType : 'page'
    const allowed = ['block', 'page', 'tag', 'property'] as const
    if (!allowed.includes(t as (typeof allowed)[number])) {
      throw new Error(`unsupported entityType ${t}`)
    }
    const argv = ['upsert', t]
    const isNewBlockish = t === 'block' && typeof args.content !== 'string'
      && args.id === undefined && args.uuid === undefined && typeof args.targetId !== 'number'
    if (isNewBlockish) throw new Error('missing-content: content is required')
    addArg(argv, '--page', typeof args.page === 'string' ? args.page : undefined)
    addArg(argv, '--name', typeof args.name === 'string' ? args.name : undefined)
    addArg(argv, '--content', typeof args.content === 'string' ? args.content : undefined)
    addArg(argv, '--id', typeof args.id === 'number' ? args.id : undefined)
    addArg(argv, '--uuid', typeof args.uuid === 'string' ? args.uuid : undefined)
    addArg(argv, '--target-page', typeof args.targetPage === 'string' ? args.targetPage : undefined)
    addArg(argv, '--target-id', typeof args.targetId === 'number' ? args.targetId : undefined)
    addArg(argv, '--pos', typeof args.pos === 'string' ? args.pos : undefined)
    addArg(argv, '--type', typeof args.propertyType === 'string' ? args.propertyType : undefined)
    addArg(argv, '--cardinality', typeof args.cardinality === 'string' ? args.cardinality : undefined)
    if (Array.isArray(args.updateTags)) argv.push('--update-tags', toEdn(args.updateTags as string[]))
    if (Array.isArray(args.removeTags)) argv.push('--remove-tags', toEdn(args.removeTags as string[]))
    if (args.updateProperties !== undefined && typeof args.updateProperties === 'object' && args.updateProperties !== null) {
      argv.push('--update-properties', toEdnMap(args.updateProperties as Record<string, unknown>))
    }
    if (Array.isArray(args.removeProperties)) argv.push('--remove-properties', toEdn(args.removeProperties as string[]))
    addBool(argv, '--restore', typeof args.restore === 'boolean' ? args.restore : undefined)
    if (args.dryRun === true) {
      return { entityType: t, status: 'dry-run', detail: `would run: \`logseq ${[...this.base(), ...argv].join(' ')}\`` }
    }
    const data = (await this.run(argv)) as Record<string, unknown> | undefined ?? {}
    const title = typeof data['block/title'] === 'string' ? data['block/title'] : null
    const id = asNum(data['db/id'])
    return {
      entityType: t,
      status: 'ok',
      detail: `${t}${title !== null ? ` \`${title}\`` : ''} upserted`,
      ...(id !== null ? { id } : {}),
    }
  }

  /** Remove a page/block/tag/property. Destruction is permanent.
   * @param args - entityType + one selector (id/uuid/page/name).
   * @returns an acknowledgement. */
  async remove(args: { entityType?: string; id?: number; uuid?: string; page?: string; name?: string }): Promise<RemoveResult> {
    const t = args.entityType ?? 'block'
    const argv = ['remove', t]
    addArg(argv, '--id', args.id)
    addArg(argv, '--uuid', args.uuid)
    addArg(argv, '--page', args.page)
    addArg(argv, '--name', args.name)
    if (!argv.some(x => x === '--id' || x === '--uuid' || x === '--page' || x === '--name')) {
      throw new Error('provide a selector: id / uuid / page / name')
    }
    await this.run(argv)
    return { entityType: t, detail: `${t} removed` }
  }

  /** Server lifecycle: list the db-worker-node servers, or run start/stop/restart/cleanup.
   * @param action - the lifecycle verb; `list` (default) returns the server table.
   * @param options - optional graph name for start/stop/restart.
   * @returns the server table for `list`, otherwise an action acknowledgement. */
  async server(action?: 'list' | 'start' | 'stop' | 'restart' | 'cleanup', options?: { name?: string }): Promise<ServerListResult | ServerActionResult> {
    const act = action ?? 'list'
    if (act === 'list') {
      const data = (await this.run(['server', 'list'])) as Record<string, unknown> | null ?? {}
      const servers = Array.isArray(data['servers']) ? data['servers'] as unknown[] : []
      return { servers: servers.map(server => rowToServer(server as Row)) }
    }
    const argv = ['server', act]
    addArg(argv, '--name', options?.name)
    const data = (await this.run(argv)) as Record<string, unknown> | null ?? {}
    const message = typeof data['message'] === 'string' ? data['message'] : `${act} requested`
    return { action: act, message }
  }
}
