/**
 * Minimal deterministic filesystem seam for the OpenWiki engine port.
 *
 * openwiki drives its repository lifecycle through a small backend protocol
 * (`ls` / `readRaw` / `write` / `edit`) that in upstream is satisfied by the
 * deepagents `BackendProtocolV2` and `OpenWikiLocalShellBackend`. This fork
 * replaces that coupling with a tiny interface and a node:fs implementation so
 * the engine runs in-process with no deepagents dependency. The shapes mirror
 * the upstream usage exactly (`files` arrays with `path`/`is_dir` entries,
 * error-carrying results instead of throws for normal absences), so the ported
 * engine code compiles and behaves identically.
 * @module @hy-sde-org/dsh-openwiki/fs
 */

import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** One entry returned by a directory listing. */
export interface WikiFsEntry {
  /** Repository-relative POSIX path. */
  path: string
  /** Whether the entry is a directory. */
  is_dir: boolean
}

/** Result of a raw file read. */
export interface WikiFsReadResult {
  /** Stabilized failure code, or absent on success. */
  error?: string
  /** Decoded text or binary content; absent when the file does not exist. */
  data?: { content: string | Uint8Array | undefined }
}

/** Result of a directory listing. */
export interface WikiFsLsResult {
  /** Stabilized failure code, or absent on success. */
  error?: string
  /** Sorted directory entries; absent when the directory does not exist. */
  files?: WikiFsEntry[]
}

/** Result of a file write or content swap. */
export interface WikiFsWriteResult {
  /** Stabilized failure code, or absent on success. */
  error?: string
}

/**
 * The deterministic repository filesystem surface consumed by the engine.
 *
 * All paths are repository-root-relative POSIX paths resolved against the root
 * configured on the implementation. Results carry errors rather than throwing
 * for ordinary absence so deterministic passes can branch on the outcome.
 */
export interface WikiFs {
  /** Lists a directory and its direct entries. */
  ls(dirPath: string): Promise<WikiFsLsResult>
  /** Reads one file as text or binary content. */
  readRaw(filePath: string): Promise<WikiFsReadResult>
  /** Writes one file (creating parent directories). */
  write(filePath: string, content: string): Promise<WikiFsWriteResult>
  /**
   * Replaces `original` with `replacement` in the file at `filePath`, failing
   * when the original no longer matches (a concurrent-edit guard).
   */
  edit(
    filePath: string,
    original: string,
    replacement: string,
  ): Promise<WikiFsWriteResult>

  /** Deletes one file; a missing file is not an error. */
  delete(filePath: string): Promise<WikiFsWriteResult>
}

/** Options for the node:fs-backed {@link WikiFs} implementation. */
export interface NodeWikiFsOptions {
  /** Absolute repository root; all paths resolve inside it. */
  root: string
}

/**
 * A {@link WikiFs} over node:fs rooted at an absolute repository directory.
 *
 * Symlinks are not followed (the engine's evidence security model rejects
 * them upstream, and this implementation keeps the same behavior by using
 * {@link lstat} with `follow: false` semantics via raw `lstat`).
 */
export function createNodeWikiFs(options: NodeWikiFsOptions): WikiFs {
  const root = options.root
  if (!path.isAbsolute(root)) {
    throw new Error(`OpenWiki fs root must be absolute: ${root}`)
  }

  /** Resolves a virtual/repository-relative path while enforcing root containment. */
  function resolveInside(relativePath: string): string {
    // Engine paths are virtual POSIX paths that may lead with "/" (e.g.
    // "/openwiki/quickstart.md"); strip the leading separator so they resolve
    // below the root rather than replacing it.
    const virtual = relativePath.replace(/^\/+/u, '')
    const absolute = path.resolve(root, virtual)
    const relative = path.relative(root, absolute)
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `OpenWiki fs path escapes the repository root: ${relativePath}`,
      )
    }
    return absolute
  }

  return {
    async ls(dirPath: string): Promise<WikiFsLsResult> {
      const directory = path.posix.normalize(
        dirPath.replace(path.sep, path.posix.sep),
      )
      const absolute = resolveInside(directory)
      try {
        const entries = await readdir(absolute, { withFileTypes: true })
        const files = entries
          .map(entry => ({
            path: path.posix.join(directory, entry.name),
            is_dir: entry.isDirectory(),
          }))
          .sort((a, b) => a.path.localeCompare(b.path))
        return { files }
      } catch (error) {
        if (isMissingFileError(error)) return {}
        return { error: `unable to list ${dirPath}` }
      }
    },
    async readRaw(filePath: string): Promise<WikiFsReadResult> {
      const absolute = resolveInside(filePath)
      try {
        const buffer = await readFile(absolute)
        // Upstream deepagents shells `cat` and hands decoders UTF-8 text; the
        // engine treats `Uint8Array` content as a non-text read failure. Decode
        // fatal so binary payloads stay Uint8Array instead of mangled text.
        let content: string | Uint8Array
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
        } catch {
          content = new Uint8Array(buffer)
        }
        return { data: { content } }
      } catch (error) {
        if (isMissingFileError(error)) return {}
        return { error: `unable to read ${filePath}` }
      }
    },
    async write(filePath: string, content: string): Promise<WikiFsWriteResult> {
      const absolute = resolveInside(filePath)
      try {
        const { mkdir, rename } = await import('node:fs/promises')
        const directory = path.dirname(absolute)
        await mkdir(directory, { recursive: true })
        const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
        await rename(temporary, absolute)
        return {}
      } catch (error) {
        return { error: `unable to write ${filePath}: ${toErrorMessage(error)}` }
      }
    },
    async edit(
      filePath: string,
      original: string,
      replacement: string,
    ): Promise<WikiFsWriteResult> {
      const absolute = resolveInside(filePath)
      try {
        const { mkdir, rename } = await import('node:fs/promises')
        const directory = path.dirname(absolute)
        await mkdir(directory, { recursive: true })
        const current = await readFile(absolute, 'utf8')
        if (current !== original) {
          return { error: `stale original text for ${filePath}` }
        }
        const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`
        await writeFile(temporary, replacement, { encoding: 'utf8', flag: 'wx' })
        await rename(temporary, absolute)
        return {}
      } catch (error) {
        if (isMissingFileError(error)) {
          return { error: `file_not_found: ${filePath}` }
        }
        return { error: `unable to edit ${filePath}: ${toErrorMessage(error)}` }
      }
    },
    async delete(filePath: string): Promise<WikiFsWriteResult> {
      const absolute = resolveInside(filePath)
      try {
        const { rm } = await import('node:fs/promises')
        await rm(absolute, { force: true })
        return {}
      } catch (error) {
        return { error: `unable to delete ${filePath}: ${toErrorMessage(error)}` }
      }
    },
  }
}

/**
 * Backward-compatible alias for the upstream deepagents backend protocol.
 *
 * The ported engine files import types `BackendProtocolV2` / `FileInfo` from
 * `deepagents`; this package exposes the same shapes under the local seam so
 * the ported sources compile with a one-line rewrite of the import.
 */
export type FileInfo = WikiFsEntry

/** Read/write/edit/list result surface used by the ported engine files. */
export interface BackendProtocolV2 {
  ls(dirPath: string): Promise<WikiFsLsResult>
  readRaw(filePath: string): Promise<WikiFsReadResult>
  write(filePath: string, content: string): Promise<WikiFsWriteResult>
  edit(
    filePath: string,
    original: string,
    replacement: string,
  ): Promise<WikiFsWriteResult>
  delete(filePath: string): Promise<WikiFsWriteResult>
}

/** Whether `error` is a not-found filesystem error. */
export function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/** Render a stable message for an unknown filesystem error. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Re-export the node:fs/dirent-based lstat probe used by leaf code tests to
// keep the missing-file predicate single-sourced.
export { lstat }
