import { gunzipSync } from 'node:zlib'
import { openArchive } from '../src/ar/open.ts'
import { DEFAULT_ARCHIVE_LIMITS } from '../src/ar/limits.ts'

/**
 * Every `ar/` test fixture bundled as a single `tar.gz`, loaded once per test
 * run (mirrors the upstream @oh-my-pi/pi-utils layout — loose blobs would
 * thrash git status/diff on every checkout). Names inside the archive are the
 * same relative paths the loose files used to have (e.g.
 * `"codecs/bzip-level-1.txt.bz2"`). Reading the archive itself exercises the
 * ported tar + gzip path on every test run.
 */

let filesPromise: Promise<Map<string, Uint8Array>> | null = null

async function loadFiles(): Promise<Map<string, Uint8Array>> {
  filesPromise ??= (async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const raw = gunzipSync(await readFile(fileURLToPath(new URL('./fixtures/ar.tar.gz', import.meta.url))))
    const reader = await openArchive(
      { bytes: raw, format: 'tar' },
      {
        limits: { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 512 * 1024 * 1024 },
      },
    )
    const map = new Map<string, Uint8Array>()
    for (const entry of reader.indexEntries()) {
      if (entry.isDirectory) continue
      const member = await reader.readFile(entry.path)
      map.set(entry.path, member.bytes)
    }
    return map
  })()
  return filesPromise
}

/** Reads one fixture's bytes by its archive-relative name (e.g. `"zip-basic.zip"`, `"codecs/bzip-level-1.txt.bz2"`). */
export async function arFixture(name: string): Promise<Uint8Array> {
  const files = await loadFiles()
  const file = files.get(name)
  if (!file) throw new Error(`Missing ar fixture: ${name}`)
  return file
}
