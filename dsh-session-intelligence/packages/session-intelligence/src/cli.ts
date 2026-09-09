#!/usr/bin/env node
/**
 * Standalone session-health CLI: run the same session-intelligence engine as
 * the `session_health` tool directly against a DSH sessions directory.
 *
 * Resolves `<DSH_HOME>/sessions/<projectKey(cwd)>` for `--cwd`, or accepts the
 * project sessions directory directly (e.g.
 * `~/.dsh/sessions/--Users-hui-Documents-workspace--`). Reads
 * `session.jsonl.zstd` (multi-frame zstd via `@hy-sde-org/dsh-zstd-frame`) or
 * `session.jsonl`, reduces the events with the shared engine, and prints the
 * health report.
 *
 * @module @hy-sde-org/dsh-session-intelligence/cli
 */

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createZstdFrameDecoder,
  decompressZstdPrefix,
  scanZstdFrames,
} from '@hy-sde-org/dsh-zstd-frame'
import { analyzeSession } from './adapter/dsh.ts'
import type { HealthSessionEventLike, HealthSessionLike } from './adapter/dsh.ts'
import { parseSinceMs } from './input.ts'
import {
  formatRecentEdits,
  formatRecentHealth,
  formatSessionHealth,
  formatToolFrequency,
} from './presentation.ts'
import { analyzeSessions } from './insights/analyze.ts'
import { collectRecentEdits } from './recentedits.ts'

const USAGE = `usage: dsh-session-intelligence [--cwd <workspace> | <sessions-project-dir>] [options]

Analyze session health across a workspace's DSH sessions (outcome, grade, signals).

Positional:
  <sessions-project-dir>   The workspace's sessions directory, e.g.
                           ~/.dsh/sessions/--Users-hui-Documents-workspace--

Options:
  --cwd <path>             Resolve the sessions dir from a workspace path
                           (DSH_HOME env honored, default ~/.dsh).
  --session <id>           Full health report for one session id.
  --recent                 Health table for the most-recent sessions (default).
  --edits                  Recent-edits feed instead of health (paths grouped
                           per file, newest edit first).
  --path <substring>       With --edits: case-insensitive path filter.
  --per-file <n>           With --edits: inlined edits per file (default 3).
  --frequency              Tool-call frequency ranking (highest → lowest, with
                           session coverage and error counts).
  --top <n>                With --frequency: show only the top n tools.
  --limit <n>              Scan only the n most-recent sessions (default: all);
                           with --edits: max files returned (default 50).
  --since <iso-8601>       Only sessions created at/after this timestamp.
  --help                   Show this help.
`

interface CliOptions {
  readonly kind: 'run'
  readonly sessionsDir: string
  readonly sessionId?: string
  readonly recent: boolean
  readonly edits: boolean
  readonly frequency: boolean
  readonly top?: number
  readonly pathFilter?: string
  readonly perFile?: number
  readonly limit?: number
  readonly sinceMs?: number
}

type ParseResult = CliOptions | { readonly kind: 'help' } | { readonly kind: 'error'; readonly message: string }

function parseArgs(argv: readonly string[]): ParseResult {
  let sessionsDir: string | undefined
  let cwd: string | undefined
  let sessionId: string | undefined
  let recent = false
  let edits = false
  let frequency = false
  let top: number | undefined
  let pathFilter: string | undefined
  let perFile: number | undefined
  let limit: number | undefined
  let since: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    switch (arg) {
      case '--help':
      case '-h':
        return { kind: 'help' }
      case '--cwd': {
        const value = argv[++i]
        if (value === undefined) return { kind: 'error', message: '--cwd requires a path' }
        cwd = value
        break
      }
      case '--session': {
        const value = argv[++i]
        if (value === undefined) return { kind: 'error', message: '--session requires a session id' }
        sessionId = value
        break
      }
      case '--recent':
        recent = true
        break
      case '--edits':
        edits = true
        break
      case '--frequency':
        frequency = true
        break
      case '--top': {
        const raw = argv[++i]
        if (raw === undefined) return { kind: 'error', message: '--top requires a number' }
        const value = Number(raw)
        if (!Number.isSafeInteger(value) || value < 1) {
          return { kind: 'error', message: '--top must be a positive integer' }
        }
        top = value
        break
      }
      case '--path': {
        const value = argv[++i]
        if (value === undefined) return { kind: 'error', message: '--path requires a substring' }
        pathFilter = value
        break
      }
      case '--per-file': {
        const raw = argv[++i]
        if (raw === undefined) return { kind: 'error', message: '--per-file requires a number' }
        const value = Number(raw)
        if (!Number.isSafeInteger(value) || value < 1) {
          return { kind: 'error', message: '--per-file must be a positive integer' }
        }
        perFile = value
        break
      }
      case '--limit': {
        const raw = argv[++i]
        if (raw === undefined) return { kind: 'error', message: '--limit requires a number' }
        const value = Number(raw)
        if (!Number.isSafeInteger(value) || value < 1) {
          return { kind: 'error', message: '--limit must be a positive integer' }
        }
        limit = value
        break
      }
      case '--since': {
        const value = argv[++i]
        if (value === undefined) return { kind: 'error', message: '--since requires an ISO-8601 timestamp' }
        since = value
        break
      }
      default:
        if (arg.startsWith('-')) return { kind: 'error', message: `unknown option: ${arg}` }
        if (sessionsDir !== undefined) return { kind: 'error', message: 'only one positional sessions dir is accepted' }
        sessionsDir = arg
    }
  }

  if (cwd !== undefined && sessionsDir !== undefined) {
    return { kind: 'error', message: 'use either --cwd or a positional sessions dir, not both' }
  }
  const dir = sessionsDir ?? (cwd !== undefined ? sessionsDirForCwd(cwd) : undefined)
  if (dir === undefined) {
    return { kind: 'error', message: 'missing input: pass a sessions dir or --cwd <workspace>' }
  }
  if (pathFilter !== undefined && !edits) {
    return { kind: 'error', message: '--path requires --edits' }
  }
  if (perFile !== undefined && !edits) {
    return { kind: 'error', message: '--per-file requires --edits' }
  }
  if (top !== undefined && !frequency) {
    return { kind: 'error', message: '--top requires --frequency' }
  }
  return {
    kind: 'run',
    sessionsDir: dir,
    ...(sessionId !== undefined ? { sessionId } : {}),
    recent,
    edits,
    frequency,
    ...(top !== undefined ? { top } : {}),
    ...(pathFilter !== undefined ? { pathFilter } : {}),
    ...(perFile !== undefined ? { perFile } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(since !== undefined ? { sinceMs: parseSinceMs(since) } : {}),
  }
}

/** The workspace's sessions project directory under the DSH_HOME sessions root. */
export function sessionsDirForCwd(cwd: string): string {
  const root = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(root, 'sessions', projectKey(cwd))
}

/**
 * Encode a workspace absolute path as the persistence backend's readable
 * project directory key. Port from `@deepseek-ai/dsh-session-persistence-jsonl`
 * `projectKey` (MIT) — the CLI must resolve the same byte layout the backend
 * writes.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

interface ParsedLog {
  readonly id: string
  readonly createdAt: number
  readonly inheritedEventCount: number
  readonly events: HealthSessionEventLike[]
}

/** Read one session's log artifact (zstd or plain JSONL) into event rows. */
async function readSessionLog(dir: string): Promise<ParsedLog> {
  const zstdPath = join(dir, 'session.jsonl.zstd')
  const plainPath = join(dir, 'session.jsonl')
  let text: string
  let source = 'session.jsonl.zstd'
  try {
    text = await readZstd(zstdPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      text = await readFile(plainPath, 'utf8')
      source = 'session.jsonl'
    } else {
      throw new Error(`cannot read ${basename(dir)}/${source}: ${errorMessage(error)}`)
    }
  }
  return parseLogText(text, dir, source)
}

/** Decompress a multi-frame zstd artifact with torn-tail recovery. */
async function readZstd(path: string): Promise<string> {
  const buffer = await readFile(path)
  const { frames, tornStart } = scanZstdFrames(buffer)
  const decoder = createZstdFrameDecoder()
  let text = ''
  try {
    for (const chunk of decoder.decode(buffer, frames)) {
      text += chunk.toString('utf8')
    }
  } finally {
    decoder.close()
  }
  if (tornStart !== undefined) {
    text += (await decompressZstdPrefix(buffer.subarray(tornStart))).toString('utf8')
  }
  return text
}

/** Parse one JSONL artifact into header facts + all typed events. */
export function parseLogText(text: string, dir: string, source: string): ParsedLog {
  let header: Record<string, unknown> | undefined
  const events: HealthSessionEventLike[] = []
  for (const lineRaw of text.split('\n')) {
    if (lineRaw.length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(lineRaw)
    } catch {
      continue // torn line beyond the recovered prefix; ignore
    }
    if (!isRecord(record)) continue
    if (header === undefined) {
      if (record.type !== 'session') {
        throw new Error(`${source} for ${basename(dir)} has no session header line`)
      }
      header = record
    } else {
      if (typeof record.seq !== 'number' || typeof record.time !== 'number') continue
      events.push({
        seq: record.seq,
        time: record.time,
        type: typeof record.type === 'string' ? record.type : 'unknown',
        data: record.data,
      })
    }
  }
  if (header === undefined) throw new Error(`${source} for ${basename(dir)} contains no events`)
  return {
    id: typeof header.id === 'string' ? header.id : basename(dir),
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
    inheritedEventCount: typeof header.seedLength === 'number' ? header.seedLength : 0,
    events,
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`)
    return 2
  }

  const entries = await readdir(parsed.sessionsDir, { withFileTypes: true })
  const sessions: HealthSessionLike[] = []
  let failures = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name as string
    if (parsed.sessionId !== undefined && name !== parsed.sessionId) continue
    try {
      const log = await readSessionLog(join(parsed.sessionsDir, name))
      sessions.push({
        id: log.id,
        createdAt: log.createdAt,
        inheritedEventCount: log.inheritedEventCount,
        events: log.events,
      })
    } catch {
      failures += 1
    }
  }

  const newestFirst = sessions.sort((a, b) => b.createdAt - a.createdAt)
  const scoped = parsed.sinceMs === undefined
    ? newestFirst
    : newestFirst.filter(session => session.createdAt >= (parsed.sinceMs as number))
  const selected = parsed.limit === undefined ? scoped : scoped.slice(0, parsed.limit)

  if (parsed.sessionId !== undefined) {
    const session = selected[0]
    if (session === undefined) {
      process.stderr.write(`no session ${parsed.sessionId} found in ${parsed.sessionsDir}\n`)
      return 1
    }
    process.stdout.write(`${formatSessionHealth(analyzeSession(session))}\n`)
    return 0
  }

  if (parsed.edits) {
    const files = collectRecentEdits(selected, {
      ...(parsed.pathFilter !== undefined ? { path: parsed.pathFilter } : {}),
      ...(parsed.perFile !== undefined ? { perFile: parsed.perFile } : {}),
    })
    process.stdout.write(`${formatRecentEdits(files, {
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.pathFilter !== undefined ? { path: parsed.pathFilter } : {}),
    })}\n`)
    return 0
  }

  if (parsed.frequency) {
    const report = analyzeSessions({
      workspace: parsed.sessionsDir,
      sessions: selected,
      sessionReadFailures: failures,
    })
    process.stdout.write(`${formatToolFrequency(report, {
      ...(parsed.top !== undefined ? { top: parsed.top } : {}),
    })}\n`)
    return 0
  }

  process.stdout.write(`${formatRecentHealth(selected.map(s => analyzeSession(s)), { unreadable: failures })}\n`)
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Only auto-run when this module is the process entry point (not when a test
// or another importer pulls in the CLI helpers).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${errorMessage(error)}\n`)
      process.exit(1)
    },
  )
}
