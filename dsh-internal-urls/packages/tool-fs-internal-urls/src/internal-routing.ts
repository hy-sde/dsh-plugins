/**
 * The read tool's internal-URL routing: when `ctx.internalUrls` is mounted and
 * the requested path is a handled `scheme://` URL (or a `<path>:conflicts`
 * selector), the read resolves through the registry instead of the filesystem,
 * renders the virtual content as a line-numbered window, and — for regular
 * filesystem reads — scans the surfaced lines for git conflict blocks,
 * registering them with the session history and appending a resolution notice.
 * @module @hy-sde-org/dsh-tool-fs-internal-urls/internal-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { InternalUrlsService } from '@hy-sde-org/dsh-internal-urls'
import {
  ConflictHistory,
  formatConflictSummary,
  formatConflictWarning,
  scanConflictsInContent,
  scanConflictLines,
} from '@hy-sde-org/dsh-internal-urls/conflict'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { buildWindow } from './read-render.ts'
import type { FileTextLine } from './read-render.ts'
import { sessionCwd } from './session-cwd.ts'

/** The subset of read caps the routing needs to build a bounded window. */
export interface InternalReadCaps {
  maxLineLength: number
  maxBytes: number
}

/** Tool-owned window request (validated read args). */
export interface ReadRequest {
  filePath: string
  offset: number
  limit: number
}

/** A fully-formed read outcome, virtual or filesystem-backed. */
export interface InternalReadOutcome {
  /** Model-facing path (the internal URL for virtual reads). */
  path: string
  offset: number
  lines: FileTextLine[]
  totalLines: number
  /** Optional conflict-resolution notice, rendered after the file body. */
  notice?: string
}

/** The calling agent's session id, used to key session-scoped handler state. */
export function sessionKeyOf(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.id
}

/** Build a {@link ResolveContext} for the calling tool execution. */
export function resolveContextOf(exec: ToolExecution, path: string): { cwd?: string; signal: AbortSignal; sessionKey?: string } {
  const cwd = sessionCwd(exec, path)
  const sessionKey = sessionKeyOf(exec)
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
    ...sessionKey !== undefined ? { sessionKey } : {},
  }
}

/**
 * Resolve a scheme URL (or `<path>:conflicts` selector) into a virtual window.
 * Returns `undefined` when the path is not an internal URL, so the caller
 * falls through to the filesystem path untouched.
 */
export async function tryReadInternal(
  ctx: Context,
  iu: InternalUrlsService,
  exec: ToolExecution,
  request: ReadRequest,
  caps: InternalReadCaps,
): Promise<InternalReadOutcome | undefined> {
  const filePath = request.filePath

  // `<path>:conflicts` — whole-file conflict summary for a plain file.
  if (!iu.canHandle(filePath) && filePath.endsWith(':conflicts')) {
    return readConflictSummary(ctx, iu, exec, filePath, request, caps)
  }

  if (!iu.canHandle(filePath)) return undefined
  const resource = await iu.resolve(filePath, resolveContextOf(exec, filePath))
  if (resource.isDirectory === true) {
    throw new FsError(`cannot read "${resource.url}": directory listing must be read as text (content summary)`, 'FS_NOT_REGULAR_FILE')
  }
  const window = await buildWindow(
    [resource.content],
    { offset: request.offset, limit: request.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes },
    resource.url,
  )
  return { path: resource.url, offset: request.offset, lines: window.lines, totalLines: window.totalLines }
}

/** Read `<path>:conflicts` — scan the whole file, register every block, render a summary. */
async function readConflictSummary(
  ctx: Context,
  iu: InternalUrlsService,
  exec: ToolExecution,
  rawPath: string,
  request: ReadRequest,
  caps: InternalReadCaps,
): Promise<InternalReadOutcome> {
  const base = rawPath.slice(0, -':conflicts'.length)
  const cwd = sessionCwd(exec, base)
  const target = await ctx.fs.resolve(base, cwd !== undefined ? { cwd } : undefined)
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new FsError(`cannot read "${base}": not found`, 'FS_NOT_FOUND')
  if (info.type !== 'file') throw new FsError(`cannot read "${base}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  const content = await ctx.fs.readText(target, exec.signal)
  const blocks = scanConflictsInContent(content)
  const history = iu.conflicts(sessionKeyOf(exec))
  const absolutePath = ctx.fs.processPath(target)
  const entries = blocks.map(block => history.register({
    ...block,
    absolutePath,
    displayPath: base,
  }))
  const summary = entries.length === 0
    ? `No unresolved conflicts in ${base}.`
    : formatConflictSummary(entries, base)
  const window = await buildWindow(
    [summary],
    { offset: request.offset, limit: request.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes },
    rawPath,
  )
  return { path: rawPath, offset: request.offset, lines: window.lines, totalLines: window.totalLines }
}

/**
 * Scan a completed filesystem read's window for conflict blocks, register them
 * with the calling session's history (id reuse by path+start line), and render
 * the resolution notice. Returns `undefined` when nothing to report or no
 * session key / registry are available.
 */
export function conflictNoticeForRead(
  ctx: Context,
  iu: InternalUrlsService,
  exec: ToolExecution,
  target: FsTarget,
  outcome: { path: string; offset: number; lines: FileTextLine[] },
): string | undefined {
  const sessionKey = sessionKeyOf(exec)
  if (sessionKey === undefined) return undefined
  const blocks = scanConflictLines(outcome.lines.map(line => line.text), outcome.offset)
  if (blocks.length === 0) return undefined
  const history: ConflictHistory = iu.conflicts(sessionKey)
  const absolutePath = ctx.fs.processPath(target)
  const entries = blocks.map(block => history.register({
    ...block,
    absolutePath,
    displayPath: outcome.path,
  }))
  return formatConflictWarning(entries)
}
