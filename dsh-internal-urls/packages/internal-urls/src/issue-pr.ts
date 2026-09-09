/**
 * GitHub-as-filesystem: `issue://` and `pr://` protocol handlers that resolve
 * through the `gh` CLI so read/grep can consume issues, pull requests, and PR
 * diffs without tool sprawl. Ported in shape from oh-my-pi
 * (`coding-agent/src/internal-urls/issue-pr-protocol.ts`), MIT; the
 * fetching layer is injectable for tests.
 *
 * URL shapes:
 * - `issue://` / `pr://` — list recent items in the caller's default repo.
 * - `issue://owner/repo` / `pr://owner/repo` — list a specific repo.
 * - `issue://123` / `pr://123` — single item; repo derived from the session cwd.
 * - `issue://owner/repo/123` / `pr://owner/repo/123` — fully qualified.
 * - `issue://…?comments=0` — suppress comments.
 * - `issue://owner/repo?state=closed&limit=20` — list options pass through to `gh`.
 * - `pr://N/diff` — changed-file listing; `pr://N/diff/all` — full unified diff;
 *   `pr://N/diff/<i>` — one file's diff chunk (and the repo-qualified variants).
 * @module @hy-sde-org/dsh-internal-urls/issue-pr
 */

import type { Context } from '@deepseek-ai/cordis'
import { ghJson, ghOutput } from './gh.ts'
import type { InternalResource, ParsedInternalUrl, ProtocolHandler, ResolveContext } from './types.ts'

/** The `gh` surface a handler needs; injectable so tests never hit the CLI. */
export interface GitHubCli {
  /** Run a `gh … --json …` command and return the parsed JSON payload. */
  json(cwd: string, args: readonly string[], signal: AbortSignal | undefined): Promise<unknown>
  /** Run a `gh …` text command and return complete stdout. */
  output(cwd: string, args: readonly string[], signal: AbortSignal | undefined): Promise<string>
}

/** The concrete `gh` runner bound to a plugin context. */
export function gitHubCliOf(ctx: Context): GitHubCli {
  return {
    json: (cwd, args, signal) => ghJson(ctx, cwd, args, signal),
    output: (cwd, args, signal) => ghOutput(ctx, cwd, args, signal),
  }
}

type Scheme = 'issue' | 'pr'

interface ParsedSingle {
  kind: 'single'
  repo?: string
  number: number
  comments: boolean
}

interface ParsedPrDiff {
  kind: 'pr-diff'
  repo?: string
  number: number
  /** `list` → enumerate changed files; `all` → full unified diff; `slice` → one file's diff section. */
  mode: 'list' | 'all' | 'slice'
  index?: number
}

interface ParsedList {
  kind: 'list'
  repo?: string
  state: string
  limit: number
  author: string | undefined
  label: string | undefined
}

type Parsed = ParsedSingle | ParsedList | ParsedPrDiff

const LIST_LIMIT_DEFAULT = 30
const LIST_LIMIT_MAX = 100

function parsePositiveDecimalInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined
}

function parseListOptions(url: ParsedInternalUrl, scheme: Scheme, repo: string | undefined): ParsedList {
  const stateRaw = url.searchParams.get('state')
  const allowedStates: string[] = scheme === 'pr' ? ['open', 'closed', 'merged', 'all'] : ['open', 'closed', 'all']
  if (stateRaw !== null && !allowedStates.includes(stateRaw)) {
    throw new Error(`Invalid ${scheme}:// list state '${stateRaw}'. Expected one of: ${allowedStates.join(', ')}.`)
  }
  const state = stateRaw ?? 'open'

  let limit = LIST_LIMIT_DEFAULT
  const limitRaw = url.searchParams.get('limit')
  if (limitRaw !== null) {
    const parsed = parsePositiveDecimalInt(limitRaw)
    if (parsed === undefined) {
      throw new Error(`Invalid ${scheme}:// list limit '${limitRaw}'. Expected a positive integer (max ${LIST_LIMIT_MAX}).`)
    }
    limit = Math.min(parsed, LIST_LIMIT_MAX)
  }
  return {
    kind: 'list',
    ...repo !== undefined ? { repo } : {},
    state,
    limit,
    author: url.searchParams.get('author') ?? undefined,
    label: url.searchParams.get('label') ?? undefined,
  }
}

/**
 * Parse an `issue://`/`pr://` URL into the union shape. Pure and exported for tests.
 *
 * GitHub Enterprise and other self-hosted GitHub instances are addressed by a
 * leading `<host>/` prefix: `issue://ghe.example.com/owner/repo/1` resolves
 * `owner/repo` on that host. A dotted first segment can only be a host, because
 * GitHub owner names are alphanumeric-plus-hyphen, so dotted hosts work with
 * every shape below. A single-label host (`ghe`, `localhost`) is only
 * recognizable from the item number's position, so it is accepted in the
 * numbered form alone — `<host>/<owner>/<repo>` with no number is
 * indistinguishable from `<owner>/<repo>/<bad-number>`, and keeping the
 * latter's error beats guessing.
 */
export function parseIssuePrUrl(url: ParsedInternalUrl, scheme: Scheme): Parsed {
  let host = url.rawHost
  let parts = url.pathSegments
  // A leading `<host>/` prefix (GitHub Enterprise et al.), stripped out so the
  // shape rules below see `OWNER/REPO[/N]` exactly as they do on github.com.
  let repoHost: string | undefined
  const dottedHost = host.includes('.')
  if (dottedHost && parts.length < 2) {
    throw new Error(
      `Invalid ${scheme}:// URL. Expected ${scheme}://<host>/<owner>/<repo> or ${scheme}://<host>/<owner>/<repo>/<number>`,
    )
  }
  const hostPrefixed = dottedHost
    ? parts.length >= 2
    : parts.length >= 3 && parsePositiveDecimalInt(parts[2] ?? '') !== undefined
  if (hostPrefixed) {
    repoHost = host
    host = parts[0] ?? ''
    parts = parts.slice(1)
  }

  if (!host && parts.length === 0) {
    return parseListOptions(url, scheme, undefined)
  }
  if (host && parts.length === 0) {
    // scheme://N (numeric) — a bare host is the item number.
    const num = parsePositiveDecimalInt(host)
    if (num === undefined) {
      throw new Error(`Invalid ${scheme}:// number: ${host}`)
    }
    return { kind: 'single', number: num, comments: commentsOn(url) }
  }
  if (scheme === 'pr' && parts.length >= 1 && parts[0] === 'diff') {
    // pr://N/diff[/<sub>] — the number lives in the host, the suffix in parts.
    const num = parsePositiveDecimalInt(host)
    if (num === undefined) {
      throw new Error(`Invalid pr:// number: ${host}`)
    }
    return parsePrDiff(parts[1], { kind: 'pr-diff', number: num, mode: 'list' })
  }
  if (scheme === 'issue' && host && /^\d+$/.test(host)) {
    throw new Error('Invalid issue:// URL. Issue views do not have a diff; use pr://<owner>/<repo>/<n>/diff for pull requests.')
  }
  if (host && parts.length === 1) {
    // scheme://owner/repo → list
    return parseListOptions(url, scheme, formatRepoRef(repoHost, `${host}/${parts[0]}`))
  }
  if (host && parts.length >= 2) {
    // scheme://owner/repo/N[/diff[/<sub>]]
    const repo = formatRepoRef(repoHost, `${host}/${parts[0]}`)
    const numberPart = parts[1]
    const num = parsePositiveDecimalInt(numberPart ?? '')
    if (num === undefined) {
      throw new Error(`Invalid ${scheme}:// number: ${numberPart ?? '(missing)'}`)
    }
    const diffParts = parts.slice(2)
    if (diffParts.length > 0) {
      if (scheme === 'issue') {
        throw new Error('Invalid issue:// URL. Issue views do not have a diff; use pr://<owner>/<repo>/<n>/diff for pull requests.')
      }
      if (diffParts[0] !== 'diff' || diffParts.length > 2) {
        throw new Error('Invalid pr:// URL. Expected pr://<n>/diff, pr://<n>/diff/all, or pr://<n>/diff/<i>')
      }
      return parsePrDiff(diffParts[1], { kind: 'pr-diff', repo, number: num, mode: 'list' })
    }
    return { kind: 'single', repo, number: num, comments: commentsOn(url) }
  }
  throw new Error(`Invalid ${scheme}:// URL. Expected ${scheme}://, ${scheme}://<number>, ${scheme}://<owner>/<repo>, or ${scheme}://<owner>/<repo>/<number>`)
}

/** Join a known enterprise host and `OWNER/REPO` into the `--repo` form `gh` accepts. */
function formatRepoRef(host: string | undefined, slug: string): string {
  return host ? `${host}/${slug}` : slug
}

/** Split the diff sub-path and range-check the index/slice. */
function parsePrDiff(sub: string | undefined, base: ParsedPrDiff): ParsedPrDiff {
  if (sub === undefined || sub === 'all') return { ...base, mode: sub === undefined ? 'list' : 'all' }
  const idx = parsePositiveDecimalInt(sub)
  if (idx === undefined) {
    throw new Error(`Invalid pr:// diff sub-path '${sub}'. Use 'all' or a 1-indexed file number.`)
  }
  return { ...base, mode: 'slice', index: idx }
}

function commentsOn(url: ParsedInternalUrl): boolean {
  const raw = url.searchParams.get('comments')
  return raw === null || !(raw === '0' || raw.toLowerCase() === 'false')
}

interface ListItem {
  number?: number
  title?: string
  state?: string
  isDraft?: boolean
  author?: { login?: string } | null
  labels?: Array<{ name?: string }>
  createdAt?: string
  updatedAt?: string
}

function formatListItem(scheme: Scheme, repo: string, item: ListItem): string {
  const number = item.number ?? '?'
  const title = item.title ?? '(no title)'
  const state = item.state?.toLowerCase() ?? '?'
  const author = item.author?.login ?? '?'
  const updated = item.updatedAt ?? item.createdAt ?? ''
  const draftSuffix = scheme === 'pr' && item.isDraft ? ' [draft]' : ''
  const labels = (item.labels ?? []).map(l => l.name).filter(Boolean).join(', ')
  const labelSuffix = labels ? `  labels: ${labels}` : ''
  const itemUrl = number === '?' ? `${scheme}://${repo}` : `${scheme}://${repo}/${number}`
  return `- [${state}${draftSuffix}] #${number}  @${author}  ${updated}\n    ${title}${labelSuffix}\n    ${itemUrl}`
}

/** Render one issue or PR body (title + metadata + body + comment thread) to markdown. */
function renderSingle(scheme: Scheme, repo: string, item: {
  number?: number
  title?: string
  state?: string
  isDraft?: boolean
  author?: { login?: string } | null
  body?: string
  comments?: Array<{ author?: { login?: string } | null; body?: string }>
  baseRefName?: string
  headRefName?: string
  createdAt?: string
  updatedAt?: string
}): string {
  const out: string[] = []
  const noun = scheme === 'issue' ? 'Issue' : 'Pull Request'
  const number = item.number ?? '?'
  out.push(`# ${noun} #${number}: ${item.title ?? '(no title)'}`)
  const bits: string[] = []
  if (item.state) bits.push(item.state)
  if (item.isDraft) bits.push('draft')
  if (item.author?.login) bits.push(`by @${item.author.login}`)
  if (item.updatedAt) bits.push(`updated ${item.updatedAt}`)
  if (scheme === 'pr' && item.baseRefName && item.headRefName) bits.push(`${item.baseRefName} ← ${item.headRefName}`)
  out.push(`**${bits.join(' · ')}**`)
  out.push('')
  out.push((item.body ?? '').trim() || '_No description._')
  out.push('')
  out.push(`---\nRepo: \`${repo}\`  ·  Item URL: \`${scheme}://${repo}/${number}\``)
  if (scheme === 'pr') out.push(`Diff: \`pr://${repo}/${number}/diff\``)
  const comments = item.comments ?? []
  if (comments.length > 0) {
    out.push('', '## Comments')
    for (const comment of comments) {
      out.push('', `**@${comment.author?.login ?? 'unknown'}**:`, (comment.body ?? '').trim())
    }
  }
  return out.join('\n') + '\n'
}

/** The `# Pull Requests in …` listing header and its body/footer. */
function renderList(scheme: Scheme, repo: string, options: ParsedList, items: ListItem[]): string {
  const header = scheme === 'issue'
    ? `# Issues in ${repo} (${options.state}, up to ${options.limit})`
    : `# Pull Requests in ${repo} (${options.state}, up to ${options.limit})`
  const body = items.length === 0
    ? '_No matches._'
    : items.map(item => formatListItem(scheme, repo, item)).join('\n\n')
  const footer = `\n\n---\nRead a specific item: \`${scheme}://${repo}/<N>\` (or \`${scheme}://<N>\` for the current repo).`
  return `${header}\n\n${body}${footer}`
}

/** One changed file inside a `gh pr diff` payload (unified text slice). */
interface PrDiffFile {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  changeType: string
  startOffset: number
  endOffset: number
}

/**
 * Split a complete `gh pr diff` unified text into per-file chunks by scanning
 * `diff --git a/… b/…` headers. Additions/deletions are counted from the hunk
 * body lines themselves (`+`/`-` prefixes inside hunks only), so the scan is
 * single-pass and precise. Pure and exported for tests.
 */
export function splitPrDiff(unified: string): PrDiffFile[] {
  const lines = unified.split('\n')
  const files: PrDiffFile[] = []
  let current: {
    path: string
    oldPath?: string
    start: number
    additions: number
    deletions: number
    changeType: string
    inHunk: boolean
  } | null = null

  const flush = (endLine: number): void => {
    if (current === null) return
    files.push({
      path: current.path,
      ...current.oldPath !== undefined ? { oldPath: current.oldPath } : {},
      additions: current.additions,
      deletions: current.deletions,
      changeType: current.changeType,
      // The slice [startOffset, endOffset) covers this file's header + hunks.
      startOffset: current.start,
      endOffset: endLine,
    })
    current = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('diff --git ')) {
      flush(i)
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      const newPath = (match?.[2] ?? '').split('\t')[0] ?? ''
      const oldPath = (match?.[1] ?? '').split('\t')[0] ?? ''
      current = {
        path: newPath || oldPath,
        ...oldPath !== '' && oldPath !== newPath ? { oldPath } : {},
        start: i,
        additions: 0,
        deletions: 0,
        changeType: 'modified',
        inHunk: false,
      }
      continue
    }
    if (current === null) continue
    if (line.startsWith('new file mode ')) current.changeType = 'added'
    else if (line.startsWith('deleted file mode ')) current.changeType = 'deleted'
    else if (line.startsWith('rename from ')) current.changeType = 'renamed'
    else if (line.startsWith('similarity index ')) current.changeType = 'renamed'
    else if (line.startsWith('Binary files ')) current.changeType = 'binary'
    const hunk = /^@@ -(?:\d+)(?:,\d+)? \+(?:\d+)(?:,\d+)? @@/.exec(line)
    if (hunk !== null) {
      current.inHunk = true
      continue
    }
    if (current.inHunk && line.startsWith('+')) current.additions += 1
    else if (current.inHunk && line.startsWith('-')) current.deletions += 1
  }
  flush(lines.length)
  return files
}

interface HandlerDeps {
  cli: GitHubCli
  defaultRepo: (cwd: string, signal: AbortSignal | undefined) => Promise<string | undefined>
}

function cwdOf(context: ResolveContext | undefined): string | undefined {
  return context?.cwd
}

/** Resolve the caller's default repo or throw with a short-form hint. */
async function resolveRepo(
  deps: HandlerDeps,
  scheme: Scheme,
  parsedRepo: string | undefined,
  context: ResolveContext | undefined,
): Promise<string> {
  if (parsedRepo) return parsedRepo
  const cwd = cwdOf(context)
  if (cwd === undefined) {
    throw new Error(`${scheme}:// needs a repo. Use ${scheme}://<owner>/<repo> — the calling session has no working directory to derive one from.`)
  }
  try {
    const repo = await deps.defaultRepo(cwd, context?.signal)
    if (repo !== undefined) return repo
  } catch {
    // fall through to the friendly error
  }
  throw new Error(`${scheme}:// could not resolve a default repo from the current session. Use ${scheme}://<owner>/<repo> instead.`)
}

async function fetchAndRenderList(
  deps: HandlerDeps,
  scheme: Scheme,
  options: ParsedList,
  url: ParsedInternalUrl,
  context: ResolveContext | undefined,
): Promise<InternalResource> {
  const repo = await resolveRepo(deps, scheme, options.repo, context)
  const cwd = cwdOf(context)
  if (cwd === undefined) throw new Error(`${scheme}:// listing needs a working directory`)
  const fields = scheme === 'issue'
    ? 'number,title,state,author,labels,createdAt,updatedAt'
    : 'number,title,state,isDraft,author,labels,createdAt,updatedAt'
  const args = [
    scheme,
    'list',
    '--repo', repo,
    '--state', options.state,
    '--limit', String(options.limit),
    '--json', fields,
  ]
  if (options.author) args.push('--author', options.author)
  if (options.label) args.push('--label', options.label)
  const items = await deps.cli.json(cwd, args, context?.signal) as ListItem[]
  const rendered = renderList(scheme, repo, options, items)
  return {
    url: url.href,
    content: rendered,
    contentType: 'text/markdown',
    size: Buffer.byteLength(rendered, 'utf-8'),
    notes: [`Live \`gh ${scheme} list\` for ${repo}`],
  }
}

async function fetchAndRenderSingle(
  deps: HandlerDeps,
  scheme: Scheme,
  parsed: ParsedSingle,
  url: ParsedInternalUrl,
  context: ResolveContext | undefined,
): Promise<InternalResource> {
  const repo = await resolveRepo(deps, scheme, parsed.repo, context)
  const cwd = cwdOf(context)
  if (cwd === undefined) throw new Error(`${scheme}:// needs a working directory`)
  // `gh view` renders comments by default; the `--json comments` field is what
  // brings them into the payload, so disabling comments just drops the field.
  const baseFields = 'number,title,state,isDraft,author,body,baseRefName,headRefName,createdAt,updatedAt'
  const fields = parsed.comments ? `${baseFields},comments` : baseFields
  const args = [scheme, 'view', String(parsed.number), '--repo', repo, '--json', fields]
  const item = await deps.cli.json(cwd, args, context?.signal) as {
    number?: number
    title?: string
    state?: string
    isDraft?: boolean
    author?: { login?: string } | null
    body?: string
    comments?: Array<{ author?: { login?: string } | null; body?: string }>
    baseRefName?: string
    headRefName?: string
    updatedAt?: string
  }
  // `gh view` renders comments by default; the `--json comments` field is what
  // brings them into the payload, so disabling comments drops the field and
  // strips whatever the payload carried anyway.
  const { comments: _omitted, ...body } = item
  const rendered = renderSingle(scheme, parsed.repo ?? repo, parsed.comments ? { ...item } : { ...body })
  const notes: string[] = []
  if (!parsed.comments) notes.push('Comments disabled')
  if (scheme === 'pr') {
    const repoSegment = parsed.repo ?? repo
    notes.push(`Diff: pr://${repoSegment}/${parsed.number}/diff`)
  }
  return {
    url: url.href,
    content: rendered,
    contentType: 'text/markdown',
    size: Buffer.byteLength(rendered, 'utf-8'),
    notes,
  }
}

async function fetchAndRenderPrDiff(
  deps: HandlerDeps,
  parsed: ParsedPrDiff,
  url: ParsedInternalUrl,
  context: ResolveContext | undefined,
): Promise<InternalResource> {
  const repo = await resolveRepo(deps, 'pr', parsed.repo, context)
  const cwd = cwdOf(context)
  if (cwd === undefined) throw new Error('pr:// diff needs a working directory')
  const unified = await deps.cli.output(cwd, ['pr', 'diff', String(parsed.number), '--repo', repo], context?.signal)
  const files = splitPrDiff(unified)

  if (parsed.mode === 'all') {
    return {
      url: url.href,
      content: unified,
      contentType: 'text/plain',
      size: Buffer.byteLength(unified, 'utf-8'),
      notes: [`Full diff for pr://${repo}/${parsed.number} (${files.length} file${files.length === 1 ? '' : 's'})`],
    }
  }
  if (parsed.mode === 'slice') {
    const index = parsed.index ?? 1
    if (index < 1 || index > files.length) {
      throw new Error(`pr://${repo}/${parsed.number}/diff/${index} is out of range; PR has ${files.length} file${files.length === 1 ? '' : 's'}. Use pr://${repo}/${parsed.number}/diff to list available indices.`)
    }
    const file = files[index - 1]
    if (!file) throw new Error(`pr://${repo}/${parsed.number}/diff/${index} resolved to a missing slice (parser bug).`)
    // startOffset/endOffset are line indices over the unified text.
    const content = unified.split('\n').slice(file.startOffset, file.endOffset).join('\n')
    return {
      url: url.href,
      content,
      contentType: 'text/plain',
      size: Buffer.byteLength(content, 'utf-8'),
      notes: [`Showing file ${index}/${files.length}: ${file.path}`, `Read all: pr://${repo}/${parsed.number}/diff/all`],
    }
  }
  // mode === 'list'
  const header = `# Pull Request Diff: ${repo}#${parsed.number} (${files.length} file${files.length === 1 ? '' : 's'})`
  const body = files.length === 0
    ? '_No file changes._'
    : files.map((file, i) => {
      const stats = file.changeType === 'binary' ? '(binary)' : `+${file.additions} -${file.deletions}`
      const rename = file.oldPath ? `  (renamed from ${file.oldPath})` : ''
      return `${i + 1}. ${file.path}  ${stats}  [${file.changeType}]${rename}\n   pr://${repo}/${parsed.number}/diff/${i + 1}`
    }).join('\n\n')
  const footer = `\n\n---\nRead all: \`pr://${repo}/${parsed.number}/diff/all\`. Each file is also available as \`pr://${repo}/${parsed.number}/diff/<i>\`.`
  const content = `${header}\n\n${body}${footer}`
  return {
    url: url.href,
    content,
    contentType: 'text/markdown',
    size: Buffer.byteLength(content, 'utf-8'),
    notes: [`File listing for pr://${repo}/${parsed.number}`],
  }
}

/** Shared resolve: parse the URL, branch list / pr-diff / single. */
async function handleResolve(
  deps: HandlerDeps,
  scheme: Scheme,
  url: ParsedInternalUrl,
  context: ResolveContext | undefined,
): Promise<InternalResource> {
  if (context?.signal?.aborted) throw new Error('aborted')
  const parsed = parseIssuePrUrl(url, scheme)
  try {
    if (parsed.kind === 'list') return await fetchAndRenderList(deps, scheme, parsed, url, context)
    if (parsed.kind === 'pr-diff') return await fetchAndRenderPrDiff(deps, parsed, url, context)
    return await fetchAndRenderSingle(deps, scheme, parsed, url, context)
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Invalid')) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${scheme}:// resolution failed: ${message}`)
  }
}

/** Handler for `issue://` URLs. Immutable — issues are read-only surfaces. */
export class IssueProtocolHandler implements ProtocolHandler {
  readonly scheme = 'issue'
  readonly immutable = true
  constructor(private readonly deps: HandlerDeps) {}

  resolve(url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource> {
    return handleResolve(this.deps, 'issue', url, context)
  }
}

/** Handler for `pr://` URLs, including the diff family. Immutable. */
export class PrProtocolHandler implements ProtocolHandler {
  readonly scheme = 'pr'
  readonly immutable = true
  constructor(private readonly deps: HandlerDeps) {}

  resolve(url: ParsedInternalUrl, context?: ResolveContext): Promise<InternalResource> {
    return handleResolve(this.deps, 'pr', url, context)
  }
}
