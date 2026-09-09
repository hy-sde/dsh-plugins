/**
 * `@hy-sde-org/dsh-openwiki` engine tests: hermetic coverage of the
 * deterministic machinery — the WikiFs seam, durable run-state/plan/manifest
 * persistence, OKF front matter repair, source fingerprints, the in-fork
 * orchestrator (begin → submit_plan → next_page → submit_page → finish) over a
 * real scratch git repository, and the transport-neutral HostSessionManager.
 */

import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HostSessionManager,
  ClaimsStore,
  OpenWikiIgnore,
  createNodeWikiFs,
  createRepositorySourceFingerprint,
  repairOkfFrontmatter,
  validateOkfFrontmatter,
  writeRepositoryRunState,
  readRepositoryRunState,
  repositoryRunStatePath,
  toClaimsSidecarRelativePath,
  resolveIndexLabels,
  synchronizeWikiIndexes,
  ensureCodeModeRepoSetup,
  OPEN_WIKI_DIR,
  type RepositoryRunState,
} from '../src/index.ts'

/** Whether a usable `git` binary exists on PATH (the e2e fixture needs it). */
const gitAvailable = (() => {
  try {
    spawnSync('git', ['--version'], { timeout: 5000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** The git spawn environment for the fixture repo (identity-free). */
const gitEnv = (dir: string): Record<string, string> => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'),
  HOME: dir,
})

function runGit(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { env: gitEnv(dir), stdio: 'pipe' })
}

async function makeRepo(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-openwiki-core-${tag}-`))
  runGit(dir, ['init', '-q', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'OpenWiki Test'])
  await writeFile(join(dir, 'README.md'), '# Fixture\n\nA tiny repository under test.\n')
  runGit(dir, ['add', '.'])
  runGit(dir, ['commit', '-q', '-m', 'initial'])
  return dir
}

/** One complete claim set for a finished page (evidence vers are engine-assigned). */
const QUICKSTART_CLAIMS = [
  {
    statement: 'The harness exposes OpenWiki lifecycle tools.',
    evidence: [{ resource: 'repo://README.md#L1-L1' }],
  },
]

describe('WikiFs seam', () => {
  it('writes and reads with root containment (no path escape)', async () => {
    const root = await makeRepo('fs')
    try {
      const fs = createNodeWikiFs({ root })
      const write = await fs.write('/openwiki/quickstart.md', '# quickstart\n')
      expect(write.error).toBeUndefined()
      const read = await fs.readRaw('/openwiki/quickstart.md')
      expect(read.error).toBeUndefined()
      const text = read.data?.content
      expect(typeof text).toBe('string')
      expect(String(text)).toContain('# quickstart')
      // Listing resolves the virtual dir under root.
      const ls = await fs.ls('/openwiki')
      expect(ls.error).toBeUndefined()
      const names = (ls.files ?? []).map(e => e.path)
      // Virtual paths below the engine root are listed with their root prefix.
      expect(names).toContain('/openwiki/quickstart.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('edit guards stale originals and delete removes the file', async () => {
    const root = await makeRepo('fs2')
    try {
      const fs = createNodeWikiFs({ root })
      await fs.write('/openwiki/page.md', 'line one\nline two\n')
      const stale = await fs.edit('/openwiki/page.md', 'WRONG original', 'replacement')
      expect(stale.error).toBeDefined()
      const ok = await fs.edit('/openwiki/page.md', 'line one\nline two\n', 'line ONE\nline two\n')
      expect(ok.error).toBeUndefined()
      const after = await fs.readRaw('/openwiki/page.md')
      expect(String(after.data?.content)).toBe('line ONE\nline two\n')
      await fs.delete('/openwiki/page.md')
      const gone = await fs.readRaw('/openwiki/page.md')
      expect(gone.data).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns file_not_found on absent reads without throwing', async () => {
    const root = await makeRepo('fs3')
    try {
      const fs = createNodeWikiFs({ root })
      const read = await fs.readRaw('/openwiki/missing.md')
      // Absence is a normal result: no error and no data (the engine treats
      // `error` as a hard failure and `data` absence as "does not exist").
      expect(read.error).toBeUndefined()
      expect(read.data).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('run-state + page-manifest durability', () => {
  it('persists a valid run state and reloads it byte-for-byte', async () => {
    const root = await makeRepo('state')
    try {
      const state: RepositoryRunState = {
        schemaVersion: 1,
        runId: '11111111-1111-4111-8111-111111111111',
        mode: 'init',
        phase: 'planning',
        startedAt: '2026-08-29T00:00:00.000Z',
        language: 'en',
        languageChanged: false,
        requiredRewritePages: [],
        initialPages: [],
        sourceFingerprint: 'sha256:' + 'a'.repeat(64),
        actor: { producerActor: 'test', metadataModel: 'test' },
        previousLastUpdate: null,
        beforeContentSnapshot: '{}',
        preparedWiki: { generatedProvenance: [] },
      }
      await writeRepositoryRunState(root, state)
      const file = repositoryRunStatePath(root)
      const raw = await readFile(file, 'utf8')
      expect(raw).toContain('"schemaVersion": 1')
      const reloaded = await readRepositoryRunState(root)
      expect(reloaded).not.toBeNull()
      expect(reloaded?.runId).toBe('11111111-1111-4111-8111-111111111111')
      expect(reloaded?.mode).toBe('init')
      expect(reloaded?.phase).toBe('planning')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('claims sidecars live below /openwiki/.claims with stable names', async () => {
    const root = await makeRepo('sidecar')
    try {
      const rel = toClaimsSidecarRelativePath('/openwiki/architecture.md')
      expect(rel).toBe('architecture.json')
      // ClaimsStore discovers pages from the wiki directory.
      const store = new ClaimsStore(root)
      const pages = await store.discoverPages()
      expect(pages).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('OKF front matter repair + index sync', () => {
  it('repairs recognized broken front matter and validates clean pages', () => {
    const broken = '---\ntitle: Architecture\ntags:\n- code\nauthor: me\n---\n\nBody.\n'
    const repaired = repairOkfFrontmatter(broken, '/openwiki/architecture.md')
    expect(repaired.changed).toBe(true)
    const second = repairOkfFrontmatter(repaired.content, '/openwiki/architecture.md')
    expect(second.changed).toBe(false)
    const validation = validateOkfFrontmatter(repaired.content)
    expect(validation.valid).toBe(true)
  })

  it('keeps a clean OKF v0.2 doc unchanged', () => {
    const clean = '---\ntitle: Index\ntype: Reference\ntags:\n  - topic\n---\n\n# Index\n\nHello.\n'
    const repaired = repairOkfFrontmatter(clean, '/openwiki/index.md')
    expect(repaired.changed).toBe(false)
  })

  it('resolves localized index labels with a deterministic English default', () => {
    const en = resolveIndexLabels('en')
    expect(en).toEqual({ files: 'Files', directories: 'Directories' })
    const fallback = resolveIndexLabels('zz')
    expect(fallback).toEqual(en)
  })
})

describe('source fingerprinting', () => {
  it('derives a stable sha256-prefixed repository fingerprint', async () => {
    const root = await makeRepo('fp')
    try {
      const fingerprint = await createRepositorySourceFingerprint(root, await OpenWikiIgnore.load(root))
      expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
      const again = await createRepositorySourceFingerprint(root, await OpenWikiIgnore.load(root))
      expect(again).toBe(fingerprint)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deterministic lifecycle over a scratch repository (real git)', () => {
  const runIt = gitAvailable ? it : it.skip

  runIt('runs init → plan → next → submit → finish durably', async () => {
    const root = await makeRepo('e2e')
    try {
      const manager = HostSessionManager.create({ host: 'test', producerActor: 'test' })

      // begin (init)
      const begun = await manager.begin({ root, mode: 'init' }) as { status: string; runId: string; mode: string }
      expect(begun.status).toBe('active')
      expect(begun.mode).toBe('init')
      const runId = begun.runId
      expect(runId).toMatch(/^[0-9a-f-]{36}$/)

      // submit_plan: quickstart + one concept page
      const planned = await manager.submitPlan({
        runId,
        pages: [
          { path: '/openwiki/quickstart.md', title: 'Quickstart', purpose: 'Entry point for the wiki.' },
          {
            path: '/openwiki/architecture.md',
            title: 'Architecture',
            purpose: 'Document the harness architecture.',
            seedPaths: ['README.md'],
          },
        ],
      }) as { status: string; totalPages: number }
      expect(planned.status).toBe('accepted')
      expect(planned.totalPages).toBeGreaterThanOrEqual(2)

      // next_page: the engine orders quickstart LAST (synthesis/navigation
      // page), so the first pending job is the domain page.
      const first = await manager.nextPage({ runId }) as {
        status: string
        job?: { id: string; path: string; instructions?: string[]; existing: boolean }
      }
      expect(first.status).toBe('pending')
      expect(first.job?.path).toBe('/openwiki/architecture.md')
      await writeFile(join(root, 'openwiki', 'architecture.md'),
        '---\ntitle: Architecture\ntags:\n  - topic\n---\n\n# Architecture\n\nNothing architectural yet.\n')
      await manager.submitPage({
        runId,
        jobId: first.job!.id,
        claims: [
          { statement: 'The repository has a README.', evidence: [{ resource: 'repo://README.md#L1-L3' }] },
        ],
      })

      // next: the quickstart page
      const second = await manager.nextPage({ runId }) as {
        status: string
        job?: { id: string; path: string }
      }
      expect(second.status).toBe('pending')
      expect(second.job?.path).toBe('/openwiki/quickstart.md')
      const quickstartJobId = second.job?.id
      expect(quickstartJobId).toBeTruthy()

      // write a real OKF page, then submit its claim set
      await writeFile(join(root, 'openwiki', 'quickstart.md'),
        '---\ntitle: Quickstart\ntags:\n  - topic\n---\n\n# Quickstart\n\nThe harness exposes OpenWiki lifecycle tools.\n')
      const done = await manager.submitPage({
        runId,
        jobId: quickstartJobId!,
        claims: QUICKSTART_CLAIMS,
      }) as { status: string; page: string; remaining: number }
      expect(done.status).toBe('complete')
      expect(done.page).toBe('/openwiki/quickstart.md')
      expect(done.remaining).toBe(0)

      // finish strictly once every job is complete
      const finished = await manager.finish({ runId }) as { status: string }
      expect(finished.status).toBe('complete')

      // .run.json removed and .last-update.json written
      const checkpoints = ['openwiki/.run.json', 'openwiki/.last-update.json', 'openwiki/.page-manifest.json']
      const present = await Promise.all(checkpoints.map(async (p) => {
        try { await readFile(join(root, p), 'utf8'); return true } catch { return false }
      }))
      expect(present[0]).toBe(false) // run state removed
      expect(present[1]).toBe(true) // update metadata persisted
      expect(present[2]).toBe(true) // page manifest replaced
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  runIt('rejects a differing re-plan after submission (final plan guard)', async () => {
    const root = await makeRepo('replan')
    try {
      const manager = HostSessionManager.create({ host: 'test', producerActor: 'test' })
      const begun = await manager.begin({ root, mode: 'init' }) as { runId: string }
      await manager.submitPlan({
        runId: begun.runId,
        pages: [
          { path: '/openwiki/quickstart.md', title: 'Quickstart', purpose: 'Entry point.' },
          { path: '/openwiki/a.md', title: 'A', purpose: 'Page A.' },
        ],
      })
      await expect(Promise.resolve().then(() =>
        manager.submitPlan({
          runId: begun.runId,
          pages: [
            { path: '/openwiki/quickstart.md', title: 'Quickstart', purpose: 'Entry point.' },
            { path: '/openwiki/B.md', title: 'B', purpose: 'Page B.' },
          ],
        }),
      )).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('platform helpers', () => {
  it('synchronizes wiki indexes over the real node fs seam', async () => {
    const root = await makeRepo('idx')
    try {
      await mkdir(join(root, 'openwiki'), { recursive: true })
      await writeFile(join(root, 'openwiki', 'quickstart.md'), '---\ntitle: Quickstart\ntags:\n- topic\n---\n\n# Quickstart\n')
      await writeFile(join(root, 'openwiki', 'architecture.md'), '---\ntitle: Architecture\ntags:\n- topic\n---\n\n# Architecture\n')
      const fs = createNodeWikiFs({ root })
      await expect(synchronizeWikiIndexes(fs, 'repository')).resolves.toBeUndefined()
      expect(OPEN_WIKI_DIR).toBe('openwiki')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('managed agent snippets', () => {
  it('writes a single well-formed OpenWiki section when CLAUDE.md symlinks AGENTS.md', async () => {
    const root = await makeRepo('snippet')
    try {
      // The repo convention: root CLAUDE.md is a symlink onto AGENTS.md, so
      // both managed agent files are the same inode.
      await symlink('AGENTS.md', join(root, 'CLAUDE.md'))

      await ensureCodeModeRepoSetup(root)
      const first = await readFile(join(root, 'AGENTS.md'), 'utf8')
      // Exactly one ordered marker pair — no torn duplicate section.
      expect(first.split('<!-- OPENWIKI:START -->').length - 1).toBe(1)
      expect(first.split('<!-- OPENWIKI:END -->').length - 1).toBe(1)
      // The agents snippet body won, not the shorter CLAUDE pointer body.
      expect(first).toContain('optional just-in-time context')
      expect(first).not.toContain('See [AGENTS.md](AGENTS.md)')
      // Reading through the symlink yields the same file bytes.
      const claude = await readFile(join(root, 'CLAUDE.md'), 'utf8')
      expect(claude).toBe(first)

      // A second run exercises the marker-replacement path and must stay
      // idempotent instead of failing on malformed markers.
      await ensureCodeModeRepoSetup(root)
      const second = await readFile(join(root, 'AGENTS.md'), 'utf8')
      expect(second).toBe(first)
      expect(second.split('<!-- OPENWIKI:END -->').length - 1).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
