/**
 * Diff parsing for the git service.
 * Direct port of omp's `coding-agent/src/commit/git/diff.ts` plus the
 * `selectHunks` / `extractFileHeader` helpers from `utils/git.ts` — kept pure
 * text-in / text-out so both the service and the tools can test them directly.
 * @module @hy-sde-org/dsh-git/diff
 */

import type { DiffHunk, FileChange, FileDiff, FileHunks, HunkSelector, NumstatEntry } from './types.ts'

/** Parse `git diff --numstat` output into per-file counts. */
export function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const addedRaw = parts[0] ?? ''
    const deletedRaw = parts[1] ?? ''
    const pathRaw = parts[2] ?? ''
    const additions = Number.parseInt(addedRaw, 10)
    const deletions = Number.parseInt(deletedRaw, 10)
    const path = extractPathFromRename(pathRaw)
    entries.push({
      path,
      additions: Number.isNaN(additions) ? 0 : additions,
      deletions: Number.isNaN(deletions) ? 0 : deletions,
    })
  }
  return entries
}

/** Split a raw diff stream into one {@link FileDiff} per file section. */
export function parseFileDiffs(diff: string): FileDiff[] {
  const sections: FileDiff[] = []
  const parts = diff.split('\ndiff --git ')
  const matched: Array<{ part: string; lines: string[] }> = []
  for (const rawPart of parts) {
    const part = rawPart.startsWith('diff --git ') ? rawPart : `diff --git ${rawPart}`
    if (!part.trim()) continue
    const lines = part.split('\n')
    const header = lines[0] ?? ''
    const match = header.match(/diff --git a\/(.+?) b\/(.+)$/)
    if (!match) continue
    matched.push({ part, lines })
  }
  for (let index = 0; index < matched.length; index += 1) {
    const entry = matched[index]
    if (!entry) continue
    const { part, lines } = entry
    const filename = lines[0]?.match(/diff --git a\/(.+?) b\/(.+)$/)?.[2] ?? ''
    // The `\ndiff --git ` split delimiter consumed the `\n` that terminated
    // every non-final file block. Restore it so each section's content is
    // byte-exact — load-bearing for `GIT binary patch` terminators that are
    // followed by another file, whose closing blank line must survive a
    // verbatim `joinPatches` (#8899).
    const content = index < matched.length - 1 ? `${part}\n` : part
    const isBinary = lines.some(line => line.startsWith('Binary files '))
    let additions = 0
    let deletions = 0
    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) additions += 1
      else if (line.startsWith('-')) deletions += 1
    }
    sections.push({ filename, content, additions, deletions, isBinary })
  }
  return sections
}

/** Parse every file section of a diff into hunks. */
export function parseDiffHunks(diff: string): FileHunks[] {
  const files = parseFileDiffs(diff)
  return files.map(file => parseFileHunks(file))
}

/** Parse one file section into hunks (empty hunks for binary files). */
export function parseFileHunks(fileDiff: FileDiff): FileHunks {
  if (fileDiff.isBinary) {
    return { filename: fileDiff.filename, isBinary: true, hunks: [] }
  }

  const lines = fileDiff.content.split('\n')
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let buffer: string[] = []
  let index = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) {
        current.content = buffer.join('\n')
        hunks.push(current)
      }
      const headerData = parseHunkHeader(line)
      current = {
        index,
        header: line,
        oldStart: headerData.oldStart,
        oldLines: headerData.oldLines,
        newStart: headerData.newStart,
        newLines: headerData.newLines,
        content: '',
      }
      buffer = [line]
      index += 1
      continue
    }
    if (current) {
      buffer.push(line)
    }
  }

  if (current) {
    current.content = buffer.join('\n')
    hunks.push(current)
  }

  return {
    filename: fileDiff.filename,
    isBinary: fileDiff.isBinary,
    hunks,
  }
}

/** Extract the file header (everything before the first `@@` hunk). */
export function extractFileHeader(diffText: string): string {
  const lines = diffText.split('\n')
  const headerLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('@@')) break
    headerLines.push(line)
  }
  return headerLines.join('\n')
}

/** Select the hunks of one file matched by a selector. */
export function selectHunks(file: FileHunks, selector: HunkSelector): FileHunks['hunks'] {
  if (selector.type === 'indices') {
    const wanted = new Set(selector.indices.map(v => Math.max(1, Math.floor(v))))
    return file.hunks.filter(hunk => wanted.has(hunk.index + 1))
  }
  if (selector.type === 'lines') {
    const start = Math.floor(selector.start)
    const end = Math.floor(selector.end)
    return file.hunks.filter(hunk => hunk.newStart <= end && hunk.newStart + hunk.newLines - 1 >= start)
  }
  return file.hunks
}

/**
 * Validate hunk selections against a raw (cached) diff. Returns a readable
 * error per invalid selection; an empty array means the selections are sound.
 */
export function validateHunkSelections(rawDiff: string, selections: readonly FileChange[]): string[] {
  const fileDiffMap = new Map(parseFileDiffs(rawDiff).map(entry => [entry.filename, entry]))
  const errors: string[] = []
  for (const selection of selections) {
    const fileDiff = fileDiffMap.get(selection.path)
    if (!fileDiff) {
      // Unknown-to-the-diff files are validated separately against the staged
      // file list; absent here just means no diff data (e.g. binary or empty).
      continue
    }
    if (selection.hunks.type === 'all') continue
    if (fileDiff.isBinary) {
      errors.push(`cannot select hunks for binary file ${selection.path}`)
      continue
    }
    const selected = selectHunks(parseFileHunks(fileDiff), selection.hunks)
    if (selected.length === 0) {
      errors.push(`no hunks selected for ${selection.path}`)
    }
  }
  return errors
}

function extractPathFromRename(pathPart: string): string {
  const braceStart = pathPart.indexOf('{')
  if (braceStart !== -1) {
    const arrowPos = pathPart.indexOf(' => ', braceStart)
    if (arrowPos !== -1) {
      const braceEnd = pathPart.indexOf('}', arrowPos)
      if (braceEnd !== -1) {
        const prefix = pathPart.slice(0, braceStart)
        const newName = pathPart.slice(arrowPos + 4, braceEnd).trim()
        const tail = pathPart.slice(braceEnd + 1)
        return `${prefix}${newName}${tail}`
      }
    }
  }

  if (pathPart.includes(' => ')) {
    const parts = pathPart.split(' => ')
    return parts[1]?.trim() ?? pathPart.trim()
  }

  return pathPart.trim()
}

function parseHunkHeader(line: string): {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
} {
  const match = line.match(/@@\s-([0-9]+)(?:,([0-9]+))?\s\+([0-9]+)(?:,([0-9]+))?\s@@/)
  if (!match) {
    return { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 }
  }
  const oldStart = Number.parseInt(match[1] ?? '0', 10)
  const oldLines = Number.parseInt(match[2] ?? '1', 10)
  const newStart = Number.parseInt(match[3] ?? '0', 10)
  const newLines = Number.parseInt(match[4] ?? '1', 10)
  return {
    oldStart: Number.isNaN(oldStart) ? 0 : oldStart,
    oldLines: Number.isNaN(oldLines) ? 0 : oldLines,
    newStart: Number.isNaN(newStart) ? 0 : newStart,
    newLines: Number.isNaN(newLines) ? 0 : newLines,
  }
}
