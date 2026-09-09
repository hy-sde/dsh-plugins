/**
 * The local memory backend: durable, project-scoped memory under
 * `<harness home>/memories/<project>/`. Three artifacts per project:
 *
 * - `bank.jsonl.zstd` — editable working entries written by `retain` (id,
 *   content, context, source, importance, timestamps, active flag). Backs
 *   `retain` and `memory_edit`.
 * - `learned.md` — newest-first, deduped, capped lesson bullets written by
 *   `learn` (survives consolidation; the same format omp keeps).
 * - `memory_summary.md` — optional consolidated long-term summary (hand or
 *   tool maintained) that recall and prompt injection surface.
 *
 * The working bank (`bank.jsonl.zstd`) uses the same on-disk container as
 * the session persistence backend: each save batch is one checksummed
 * Zstandard frame, so memory reuses the vendored frame codec, stays
 * append-friendly and self-healing, and migrates the pre-rename plaintext
 * `bank.jsonl` transparently on first write (reads are encoding-agnostic;
 * the filename advertises the container). `learned.md` stays plaintext
 * markdown for human/tool readability.
 *
 * Everything is plain files plus an in-process write-chain so concurrent
 * read-modify-write calls (sibling subagents, batched tool calls) cannot drop
 * each other's writes. No model, network, or binary dependency — this is the
 * portable subset of omp's `local` memory backend, upgraded with the full
 * retain/recall/reflect/memory_edit surface its remote backends enjoy.
 * @module @hy-sde-org/dsh-memory/local
 */

import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from './zstd-frame/index.ts'
import type {
  MemoryBackend,
  MemoryContext,
  MemoryEditInput,
  MemoryEditOp,
  MemoryEditResult,
  MemoryEntryView,
  MemorySaveInput,
  MemorySaveResult,
  MemorySearchItem,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryStatus,
  MemorySummaries,
} from './types.ts'

/** Name of the working-memory bank file under a project root (zstd framed by default). */
export const BANK_FILE = 'bank.jsonl.zstd'
/** Pre-rename plaintext bank file, migrated to {@link BANK_FILE} on first write. */
export const LEGACY_BANK_FILE = 'bank.jsonl'
/** Name of the captured-lessons file. */
export const LEARNED_FILE = 'learned.md'
/** Name of the optional consolidated summary file. */
export const SUMMARY_FILE = 'memory_summary.md'
/** Newest-first cap on retained lessons, bounding file growth by entry count. */
export const MAX_LEARNED_LESSONS = 100
/** Per-field char caps so a single huge capture cannot bloat learned.md. */
export const MAX_LEARNED_CONTENT_CHARS = 2000
export const MAX_LEARNED_CONTEXT_CHARS = 400
/** Per-entry caps for the working bank. */
export const MAX_BANK_CONTENT_CHARS = 4000
export const MAX_BANK_CONTEXT_CHARS = 800

/** One persisted working-memory row in `bank.jsonl.zstd`. */
export interface BankRow {
  id: string
  content: string
  context?: string
  source: string
  importance: number
  createdAt: number
  updatedAt: number
  tags?: string[]
  /** False when `invalidate` superseded or a future op retired the row. */
  active: boolean
  /** Id of the entry that superseded this one, when retired by `invalidate`. */
  supersededBy?: string
  /** Session that captured this entry (cross-session provenance). */
  sessionId?: string
}

/** On-disk encoding of the working bank file. */
export type BankCompression = 'zstd' | 'none'

/** Options for {@link LocalMemoryBackend}. */
export interface LocalMemoryConfig {
  /** Memory root; defaults to `<harness home>/memories`. */
  root?: string
  /** Baseline importance applied when a save omits it. */
  defaultImportance?: number
  /** Default result cap for one search. */
  searchLimit?: number
  /**
   * Working-bank encoding. `zstd` (default) stores each save batch as a
   * checksummed Zstandard frame — the same container format the session
   * persistence backend uses — and transparently reads and migrates plaintext
   * banks. `none` keeps the original line-append format.
   */
  compression?: BankCompression
}

const DEFAULTS = {
  defaultImportance: 0.7,
  searchLimit: 10,
  compression: 'zstd',
} as const

/** Expand host/`~`-style roots and resolve a stable absolute memory root. */
export function resolveMemoryRoot(config: LocalMemoryConfig = {}): string {
  const configured = config.root ?? join(resolveDshHome(), 'memories')
  return resolve(expandHomePath(configured))
}

/**
 * Encode one absolute cwd into a collision-free, filesystem-safe project key
 * (`--`-wrapped; `/\:` and friends become `-`), matching omp's layout so a
 * project keeps one memory root across tools and sessions.
 */
export function encodeProjectKey(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[^A-Za-z0-9._-]+/g, '-')}--`
}

/** Absolute project memory root for one session cwd. */
export function projectRootOf(memoryRoot: string, cwd: string): string {
  return join(memoryRoot, encodeProjectKey(cwd))
}

/** Strip pattern-bred secret patterns before anything is persisted or rendered. */
function redactSecrets(input: string): string {
  let out = input
  const patterns = [
    /(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/g,
    /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
    /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /npm_[A-Za-z0-9]{30,}/g,
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    /AIza[A-Za-z0-9_-]{30,}/g,
  ]
  for (const pattern of patterns) out = out.replace(pattern, '[REDACTED]')
  return out
}

/**
 * Strip prompt-injection vectors from one line of lesson text: control/format
 * chars, angle brackets, backticks, and `~~~` fences, then collapse
 * whitespace. Applied on BOTH write and read (the block renders unescaped
 * into the system prompt).
 */
function neutralizeInjection(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[<>`]/g, '')
    .replace(/~{2,}/g, '~')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Slice to `maxChars`, dropping a trailing unpaired high surrogate. */
function boundChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const sliced = text.slice(0, maxChars)
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced
}

/** Normalize one stored text: neutralize delimiters, redact, bound. */
function normalizeStored(text: string, maxChars: number): string {
  return boundChars(redactSecrets(neutralizeInjection(text)).trim(), maxChars)
}

/** Whether a filesystem error is a plain missing file. */
function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Read a small file, or '' when absent/unreadable-with-ENOENT. */
async function readMaybe(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return ''
    throw error
  }
}

/** Read a small file's raw bytes, or an empty buffer when absent. */
async function readMaybeBytes(file: string): Promise<Buffer> {
  try {
    return await readFile(file)
  } catch (error) {
    if (isEnoent(error)) return Buffer.alloc(0)
    throw error
  }
}

/** Fresh lowercase word tokens (letters/digits, length >= 2) from text. */
function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []
  return [...new Set(tokens)]
}

/** Pseudo-id for one learned lesson bullet (stable across reads). */
function lessonIdOf(line: string): string {
  const digest = createHash('sha256').update(line).digest('hex').slice(0, 12)
  return `lesson_${digest}`
}

const SUMMARY_ID = 'summary_0'

/** Split a markdown bullet list (with a leading heading) into bare bullets. */
function parseLessonBullets(raw: string): string[] {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(Boolean)
}

/**
 * The local backend. All reads go through an in-process per-file write chain
 * so concurrent mutation never interleaves halfway through a file rewrite.
 */
export class LocalMemoryBackend implements MemoryBackend {
  readonly id = 'local' as const
  private readonly memoryRoot: string
  private readonly defaultImportance: number
  private readonly searchLimit: number
  private readonly compression: BankCompression
  /** Per-file serialization chains: `file -> tail promise`. */
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(config: LocalMemoryConfig = {}) {
    this.memoryRoot = resolveMemoryRoot(config)
    this.defaultImportance = config.defaultImportance ?? DEFAULTS.defaultImportance
    this.searchLimit = config.searchLimit ?? DEFAULTS.searchLimit
    this.compression = config.compression ?? DEFAULTS.compression
  }

  /** Absolute project root (exposed for tool presentation and tests). */
  projectRoot(cwd: string): string {
    return projectRootOf(this.memoryRoot, cwd)
  }

  /** Serialize one read-modify-write over `file`. */
  private withChain<T>(file: string, run: () => Promise<T>): Promise<T> {
    const tail = this.chains.get(file) ?? Promise.resolve()
    const next = tail.then(run, run)
    const guarded = next.then(
      () => { if (this.chains.get(file) === guarded) this.chains.delete(file) },
      () => { if (this.chains.get(file) === guarded) this.chains.delete(file) },
    )
    this.chains.set(file, guarded)
    return next
  }

  async status(context: MemoryContext): Promise<MemoryStatus> {
    const root = this.projectRoot(context.cwd)
    const rows = await this.readBank(root)
    const lessons = parseLessonBullets(await readMaybe(join(root, LEARNED_FILE)))
    const active = rows.filter(row => row.active)
    let lastMemoryAt: number | undefined
    for (const row of active) {
      if (lastMemoryAt === undefined || row.updatedAt > lastMemoryAt) lastMemoryAt = row.updatedAt
    }
    return {
      backend: 'local',
      active: true,
      writable: true,
      searchable: true,
      scope: root,
      workingCount: active.length,
      lessonCount: lessons.length,
      ...lastMemoryAt === undefined ? {} : { lastMemoryAt },
      message: `Local project memory at ${root} — ${active.length} working ${active.length === 1 ? 'entry' : 'entries'}, ${lessons.length} lessons.`,
    }
  }

  async save(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult> {
    const content = normalizeStored(input.content, MAX_BANK_CONTENT_CHARS)
    if (!content) {
      return { stored: 0, message: 'Empty memory; nothing stored.' }
    }
    const contextText = input.context ? normalizeStored(input.context, MAX_BANK_CONTEXT_CHARS) : ''
    const now = Date.now()
    const row: BankRow = {
      id: `m_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      ...contextText.length > 0 ? { context: contextText } : {},
      source: input.source ?? 'retain',
      importance: clampImportance(input.importance ?? this.defaultImportance),
      createdAt: now,
      updatedAt: now,
      active: true,
      ...input.sessionId !== undefined && input.sessionId.length > 0 ? { sessionId: input.sessionId } : {},
    }
    return this.withChain(this.bankFile(context.cwd), async () => {
      await mkdir(this.projectRoot(context.cwd), { recursive: true })
      await appendBankEntry(
        this.bankFile(context.cwd),
        JSON.stringify(row),
        this.compression,
        this.defaultImportance,
      )
      return { id: row.id, stored: 1, message: 'Stored in project memory.' }
    })
  }

  async learn(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult> {
    const content = normalizeStored(input.content, MAX_LEARNED_CONTENT_CHARS)
    if (!content) {
      return { stored: 0, message: 'Empty lesson; nothing stored.' }
    }
    const contextText = input.context ? normalizeStored(input.context, MAX_LEARNED_CONTEXT_CHARS) : ''
    const line = contextText ? `- ${content} _(context: ${contextText})_` : `- ${content}`
    const file = join(this.projectRoot(context.cwd), LEARNED_FILE)
    await this.withChain(file, async () => {
      await mkdir(this.projectRoot(context.cwd), { recursive: true })
      await appendLearnedLine(file, line)
    })
    return { id: lessonIdOf(line), stored: 1, message: `Lesson saved to ${LEARNED_FILE}.` }
  }

  async search(context: MemoryContext, query: string, options?: MemorySearchOptions): Promise<MemorySearchResult> {
    const limit = Math.max(1, options?.limit ?? this.searchLimit)
    const root = this.projectRoot(context.cwd)
    const rows = await this.readBank(root).catch((error: unknown) => {
      if (isEnoent(error)) return []
      throw error
    })
    const active = rows.filter(row => row.active)
    const lessons = parseLessonBullets(await readMaybe(join(root, LEARNED_FILE)))
    const rawSummary = (await readMaybe(join(root, SUMMARY_FILE))).trim()

    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return { backend: 'local', query, count: 0, items: [] }
    const idf = this.computeIdf(active, queryTokens)

    const hits: MemorySearchItem[] = []
    for (const row of active) {
      const haystack = tokenize([row.content, row.context ?? '', row.source].join(' '))
      const raw = scoreTokens(queryTokens, idf, haystack)
      if (raw <= 0) continue
      hits.push({
        id: row.id,
        content: row.content,
        source: row.source,
        timestamp: new Date(row.updatedAt).toISOString(),
        importance: row.importance,
        score: normalizeScore(raw, row.importance),
        ...row.sessionId !== undefined ? { sessionId: row.sessionId } : {},
      })
    }
    for (const line of lessons) {
      const raw = scoreTokens(queryTokens, idf, tokenize(line))
      if (raw <= 0) continue
      hits.push({
        id: lessonIdOf(line),
        content: line,
        source: 'learn',
        score: normalizeScore(raw, 0.8),
        readonly: true,
      })
    }
    if (rawSummary.length > 0) {
      const raw = scoreTokens(queryTokens, idf, tokenize(rawSummary))
      if (raw > 0) {
        hits.push({
          id: SUMMARY_ID,
          content: rawSummary,
          source: 'memory_summary.md',
          score: normalizeScore(raw, 1),
          readonly: true,
        })
      }
    }

    hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const items = hits.slice(0, limit)
    return { backend: 'local', query, count: items.length, items }
  }

  async edit(context: MemoryContext, op: MemoryEditOp, input: MemoryEditInput): Promise<MemoryEditResult> {
    const { id, content, importance, replacementId } = input
    if (id.startsWith('lesson_') || id === SUMMARY_ID) {
      return { status: 'not_editable', message: `${id} is a read-only fact; memory_edit cannot change it.` }
    }
    if (op === 'update' && content === undefined && importance === undefined) {
      throw new Error('memory_edit update requires content or importance.')
    }

    const file = this.bankFile(context.cwd)
    return this.withChain(file, async () => {
      const rows = await this.readBank(this.projectRoot(context.cwd)).catch((error: unknown) => {
        if (isEnoent(error)) return []
        throw error
      })
      const index = rows.findIndex(row => row.id === id)
      if (index === -1) return { status: 'not_found', message: `Memory ${id} was not found.` }

      if (op === 'forget') {
        rows.splice(index, 1)
      } else if (op === 'invalidate') {
        const target = rows[index]
        if (target === undefined) return { status: 'not_found', message: `Memory ${id} was not found.` }
        if (replacementId !== undefined) {
          const replacement = rows.some(row => row.id === replacementId)
          if (!replacement) {
            throw new Error(`replacement id ${replacementId} does not exist; invalidate aborted.`)
          }
        }
        target.active = false
        target.updatedAt = Date.now()
        if (replacementId !== undefined) target.supersededBy = replacementId
        else delete target.supersededBy
      } else {
        const target = rows[index]
        if (target === undefined) return { status: 'not_found', message: `Memory ${id} was not found.` }
        const nextContent = content !== undefined ? normalizeStored(content, MAX_BANK_CONTENT_CHARS) : target.content
        if (nextContent.length === 0) {
          throw new Error('memory_edit update produced empty content; aborted.')
        }
        target.content = nextContent
        if (importance !== undefined) target.importance = clampImportance(importance)
        target.updatedAt = Date.now()
      }
      await writeBank(this.bankFile(context.cwd), rows, this.compression)
      return { status: op === 'update' ? 'updated' : op === 'forget' ? 'forgotten' : 'invalidated' }
    })
  }

  async summaries(context: MemoryContext): Promise<MemorySummaries> {
    const root = this.projectRoot(context.cwd)
    const summary = (await readMaybe(join(root, SUMMARY_FILE))).trim()
    const learned = (await readMaybe(join(root, LEARNED_FILE))).trim()
    const rows = await this.readBank(root).catch((error: unknown) => {
      if (isEnoent(error)) return []
      throw error
    })
    const bank = formatBankRows(rows, MAX_INJECTED_BANK_ENTRIES)
    const block = renderSummariesBlock({ summary, learned, bank })
    return {
      backend: 'local',
      ...summary.length > 0 ? { summary } : {},
      ...learned.length > 0 ? { learned } : {},
      ...bank.length > 0 ? { bank: bank.join('\n') } : {},
      block,
    }
  }

  async clear(context: MemoryContext): Promise<void> {
    const root = this.projectRoot(context.cwd)
    await rm(root, { recursive: true, force: true })
    this.chains.clear()
  }

  async readEntry(context: MemoryContext, id: string): Promise<MemoryEntryView | undefined> {
    const root = this.projectRoot(context.cwd)
    const rows = await this.readBank(root).catch((error: unknown) => {
      if (isEnoent(error)) return []
      throw error
    })
    const row = rows.find(candidate => candidate.id === id && candidate.active)
    if (row !== undefined) return bankEntryView(row)
    if (id.startsWith('lesson_')) {
      const line = parseLessonBullets(await readMaybe(join(root, LEARNED_FILE)))
        .find(candidate => lessonIdOf(candidate) === id)
      if (line !== undefined) return { id, content: line, source: 'learn', readonly: true }
    }
    if (id === SUMMARY_ID) {
      const summary = (await readMaybe(join(root, SUMMARY_FILE))).trim()
      if (summary.length > 0) {
        return { id: SUMMARY_ID, content: summary, source: 'memory_summary.md', readonly: true }
      }
    }
    return undefined
  }

  async listEntries(context: MemoryContext, limit: number): Promise<MemoryEntryView[]> {
    const root = this.projectRoot(context.cwd)
    const rows = await this.readBank(root).catch((error: unknown) => {
      if (isEnoent(error)) return []
      throw error
    })
    const views: MemoryEntryView[] = rows
      .filter(row => row.active)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(bankEntryView)
    for (const line of parseLessonBullets(await readMaybe(join(root, LEARNED_FILE)))) {
      views.push({ id: lessonIdOf(line), content: line, source: 'learn', readonly: true })
    }
    const summary = (await readMaybe(join(root, SUMMARY_FILE))).trim()
    if (summary.length > 0) {
      views.push({ id: SUMMARY_ID, content: summary, source: 'memory_summary.md', readonly: true })
    }
    return views.slice(0, Math.max(0, limit))
  }

  private bankFile(cwd: string): string {
    return join(this.projectRoot(cwd), BANK_FILE)
  }

  private async readBank(root: string): Promise<BankRow[]> {
    // Prefer the current bank; fall back to a pre-rename plaintext
    // `bank.jsonl` (prompt injection and any read-only path see it too).
    const bytes = await readMaybeBytes(join(root, BANK_FILE))
    if (bytes.length === 0) {
      const legacy = await readMaybeBytes(join(root, LEGACY_BANK_FILE))
      if (legacy.length > 0) return parseBankText(legacy.toString('utf8'), this.defaultImportance)
    }
    let text: string
    if (isZstdData(bytes)) {
      try {
        text = Buffer.from(await decodeBankFrames(bytes)).toString('utf8')
      } catch {
        // A structurally corrupt frame stream still yields earlier knowledge
        // when read as text; parseBankText skips malformed lines (self-healing).
        text = Buffer.from(bytes).toString('utf8')
      }
    } else {
      text = Buffer.from(bytes).toString('utf8')
    }
    return parseBankText(text, this.defaultImportance)
  }

  /** Inverse-document-frequency weights for the query tokens across the bank. */
  private computeIdf(rows: BankRow[], queryTokens: string[]): Map<string, number> {
    const total = Math.max(1, rows.length)
    const weights = new Map<string, number>()
    for (const token of queryTokens) {
      let docs = 1
      for (const row of rows) {
        if (tokenMatchWeight(token, tokenize(row.content)) > 0) docs += 1
      }
      weights.set(token, 1 + Math.log(total / docs))
    }
    return weights
  }
}

/** Length of the common leading run of two words. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let n = 0
  while (n < max && a[n] === b[n]) n++
  return n
}

/**
 * Light stemming match:
 * - exact token → full weight;
 * - one token is a prefix of the other sharing >= 4 chars → 0.75
 *   (`deploy`/`deployment`, `run`/`running`);
 * - a common root of >= 6 chars with suffix variation of at most 3 chars
 *   → 0.6 (`prefers`/`preferred`, `deploys`/`deployment`)
 */
function tokenMatchWeight(token: string, haystack: readonly string[]): number {
  if (haystack.includes(token)) return 1
  for (const candidate of haystack) {
    const shared = commonPrefixLength(token, candidate)
    if (shared >= 4 && (token.startsWith(candidate) || candidate.startsWith(token))) return 0.75
    if (shared >= 6 && Math.abs(candidate.length - token.length) <= 3) return 0.6
  }
  return 0
}

function clampImportance(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.7))
}

/** Sum of per-token weights for tokens matching the haystack token set. */
function scoreTokens(queryTokens: string[], idf: Map<string, number>, haystack: string[]): number {
  let raw = 0
  for (const token of queryTokens) {
    raw += tokenMatchWeight(token, haystack) * (idf.get(token) ?? 1)
  }
  return raw
}

/** Normalize a raw score to `[0,1]`, blending importance and recency. */
function normalizeScore(raw: number, importance: number): number {
  // `raw` already carries IDF weight; a sqrt-compressed normalization keeps
  // small differences meaningful while confining the value to [0,1].
  const scale = Math.sqrt(raw) / (1 + Math.sqrt(raw))
  return Math.max(0, Math.min(1, clampImportance(scale * 0.8 + importance * 0.2)))
}

/** Append raw lines to a file, creating parent directories. */
async function appendLines(file: string, lines: string[]): Promise<void> {
  await writeFile(file, `${lines.join('\n')}\n`, { flag: 'a' })
}

/** Whether `bytes` begin with a Zstandard frame magic (28 b5 2f fd). */
export function isZstdData(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4
    && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd
}

/** Decode all complete checksummed frames in `bytes` (session-style container). */
async function decodeBankFrames(bytes: Uint8Array): Promise<Uint8Array> {
  const buffer = Buffer.from(bytes)
  const { frames } = scanZstdFrames(buffer)
  const decoded: Uint8Array[] = []
  for (const frame of frames) {
    decoded.push(await decompressZstdFrame(buffer.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(decoded)
}

/** Encode JSONL lines as concatenated checksummed zstd frames (one per line). */
async function encodeBankFrames(lines: readonly string[]): Promise<Uint8Array> {
  const frames: Uint8Array[] = []
  for (const line of lines) {
    frames.push(await compressZstdFrame(`${line}\n`))
  }
  return Buffer.concat(frames)
}

/**
 * Append one bank line under the configured bank encoding. For `zstd`, an
 * already-framed file gets exactly one appended frame (no rewrite); a
 * plaintext or absent file is migrated to frames first so every future append
 * stays frame-only. For `none`, preserves the original line-append format.
 */
async function appendBankEntry(
  file: string,
  line: string,
  compression: BankCompression,
  fallbackImportance: number,
): Promise<void> {
  if (compression === 'none') {
    await appendLines(file, [line])
    return
  }
  const root = resolve(file, '..')
  const existing = await readMaybeBytes(file)
  if (existing.length === 0) {
    // Absent bank → first frame. Also fold in a pre-rename plaintext
    // `bank.jsonl` so the rename migrates existing projects transparently.
    const legacyText = await readMaybe(join(root, LEGACY_BANK_FILE))
    const previous = legacyText.length > 0 ? parseBankText(legacyText, fallbackImportance) : []
    const payload = Buffer.from(await encodeBankFrames([
      ...previous.map(row => JSON.stringify(row)),
      line,
    ]))
    await writeFile(file, payload)
    if (legacyText.length > 0) await rm(join(root, LEGACY_BANK_FILE), { force: true }).catch(() => {})
    return
  }
  if (isZstdData(existing)) {
    await appendFile(file, Buffer.from(await compressZstdFrame(`${line}\n`)))
    return
  }
  // plaintext new file (e.g. 'none'-mode leftovers): migrate rows to frames first.
  const rows = parseBankText(existing.toString('utf8'), fallbackImportance)
  const head = rows.map(row => JSON.stringify(row))
  const payload = Buffer.from(await encodeBankFrames([...head, line]))
  await writeFile(file, payload)
}

/**
 * Rewrite the bank file from parsed rows under one encoding (used by `edit`).
 * `zstd` writes concatenated frames; `none` writes plain JSONL lines.
 */
async function writeBank(file: string, rows: BankRow[], compression: BankCompression): Promise<void> {
  await mkdir(resolve(file, '..'), { recursive: true })
  const lines = rows.map(row => JSON.stringify(row))
  if (lines.length === 0) {
    await writeFile(file, '', 'utf8')
  } else if (compression === 'zstd') {
    await writeFile(file, Buffer.from(await encodeBankFrames(lines)))
  } else {
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
  }
  // A rewrite under the canonical name supersedes any pre-rename plaintext bank.
  await rm(join(resolve(file, '..'), LEGACY_BANK_FILE), { force: true }).catch(() => {})
}

/**
 * Append one bullet to `learned.md` (newest-first, deduped, capped at
 * {@link MAX_LEARNED_LESSONS}). Non-bullet content (headings, prose) keeps its
 * position; the cap drops the oldest bullets.
 */
async function appendLearnedLine(file: string, line: string): Promise<void> {
  const existing = await readMaybe(file)
  const lines = existing.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const isLesson = (candidate: string) => candidate.trimStart().startsWith('- ')
  const out = lines.filter(candidate => !(isLesson(candidate) && candidate.trim() === line))
  const firstBullet = out.findIndex(isLesson)
  if (firstBullet === -1) out.push(line)
  else out.splice(firstBullet, 0, line)
  let lessonCount = 0
  for (const candidate of out) if (isLesson(candidate)) lessonCount++
  for (let i = out.length - 1; i >= 0 && lessonCount > MAX_LEARNED_LESSONS; i--) {
    const candidate = out[i]
    if (candidate !== undefined && isLesson(candidate)) {
      out.splice(i, 1)
      lessonCount--
    }
  }
  await writeFile(file, `${out.join('\n')}\n`)
}

/** Largest number of working-bank entries the injected block lists (newest first). */
export const MAX_INJECTED_BANK_ENTRIES = 20

/** Addressable view of one active bank row (full content, no preview truncation). */
function bankEntryView(row: BankRow): MemoryEntryView {
  return {
    id: row.id,
    content: row.content,
    ...row.context !== undefined ? { context: row.context } : {},
    source: row.source,
    importance: row.importance,
    timestamp: new Date(row.updatedAt).toISOString(),
  }
}

/** Render active bank rows as injection bullets, newest first, capped. */
export function formatBankRows(rows: readonly BankRow[], cap: number): string[] {
  const active = rows
    .filter(row => row.active)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, cap))
  return active.map(row => neutralizeInjection(row.content))
}

/** Parse `bank.jsonl.zstd` text into rows, skipping malformed lines (self-healing). */
export function parseBankText(text: string, fallbackImportance = 0.7): BankRow[] {
  const rows: BankRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as Partial<BankRow>
      if (typeof parsed.id !== 'string' || typeof parsed.content !== 'string') continue
      rows.push({
        id: parsed.id,
        content: parsed.content,
        ...parsed.context !== undefined && typeof parsed.context === 'string' ? { context: parsed.context } : {},
        source: typeof parsed.source === 'string' ? parsed.source : 'retain',
        importance: typeof parsed.importance === 'number' ? parsed.importance : fallbackImportance,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
        ...parsed.tags !== undefined && Array.isArray(parsed.tags) ? { tags: parsed.tags } : {},
        active: parsed.active !== false,
        ...parsed.supersededBy !== undefined && typeof parsed.supersededBy === 'string'
          ? { supersededBy: parsed.supersededBy }
          : {},
        ...parsed.sessionId !== undefined && typeof parsed.sessionId === 'string'
          ? { sessionId: parsed.sessionId }
          : {},
      })
    } catch {
      // Skip malformed lines; the file remains editable and self-heals on rewrite.
    }
  }
  return rows
}

/** The prompt-injection block from summary + lessons + working bank entries. */
export function renderSummariesBlock(parts: { summary?: string; learned?: string; bank?: string[] }): string {
  const blocks: string[] = []
  if (parts.summary && parts.summary.trim().length > 0) {
    blocks.push(`## Consolidated memory summary\n${parts.summary.trim()}`)
  }
  if (parts.learned && parts.learned.trim().length > 0) {
    blocks.push(`## Learned lessons\n${parts.learned.trim()}`)
  }
  const bank = (parts.bank ?? []).filter(line => line.length > 0)
  if (bank.length > 0) {
    blocks.push(`## Working memory (recall for ranked search; memory_edit by recall id)\n${bank.map(line => `- ${line}`).join('\n')}`)
  }
  return blocks.join('\n\n')
}

/** Read-neutralize lesson text on read too (a hand-edited file bypasses the write path). */
export function neutralizeLearnedText(raw: string): string {
  return raw
    .split('\n')
    .map(line => redactSecrets(neutralizeInjection(line)))
    .join('\n')
}

/** Friendly display path relative to the home when inside it. */
export function displayRoot(memoryRoot: string): string {
  const home = resolveDshHome()
  const rel = relative(home, memoryRoot)
  return rel.startsWith('..') ? memoryRoot : `~/.dsh/${rel}`
}

export { redactSecrets, neutralizeInjection, tokenize, boundChars }
