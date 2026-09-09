/**
 * wiki-graph service tests: pure projection via a shim `logseq` executable
 * (canned JSON envelopes) + live integration gated behind LOGSEQ_INTEGRATION=1.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LogseqGraphService } from '../src/service.ts'
import { execCli } from '../src/cli.ts'

/** Canned envelope factory. */
function envelope(data: unknown): string {
  return JSON.stringify({ status: 'ok', data })
}

const SHOW_RUST_JSON = envelope({
  root: {
    'db/id': 240,
    'block/name': 'rust',
    'block/title': 'Rust',
    'block/created-at': 1787808086650,
    'block/updated-at': 1787808165009,
    'block/tags': [{ 'db/id': 199, 'block/name': 'topic-osv2nd9b', 'block/title': 'topic' }, { 'db/id': 4, 'block/title': 'Page', 'block/name': 'page' }],
    'user.property/status-mnIvao0n': { 'db/id': 272 },
    'block/children': [{
      'db/id': 273,
      'block/title': 'Systems language benefiting from the LLM-era vibe shift in [[Fast and Hard Code]]',
      'block/order': 'a0',
      'block/created-at': 1787808165164,
      'block/updated-at': 1787808165164,
      'block/children': [{
        'db/id': 274,
        'block/title': 'nested child',
        'block/order': 'a0',
        'block/children': [],
      }],
    }],
  },
  'linked-references': { count: 2, blocks: [{ 'db/id': 241, 'block/title': 'Two vibe shifts…', 'block/page': { 'db/id': 232, 'block/name': 'fast and hard code', 'block/title': 'Fast and Hard Code' }, 'block/updated-at': 1787808086664 }] },
})

const LIST_PAGES_JSON = envelope({
  items: [
    { 'db/id': 240, 'block/title': 'Rust', 'block/created-at': 1787808086650, 'block/updated-at': 1787808165009 },
    { 'db/id': 242, 'block/title': 'Zig', 'block/created-at': 1787808087002, 'block/updated-at': 1787808159455 },
  ],
})

const LIST_TAGS_JSON = envelope({
  items: [{ 'db/id': 205, 'block/title': 'todo', 'db/ident': 'user.class/todo-h76Hmnr3' }, { 'db/id': 199, 'block/title': 'topic', 'block/name': 'topic-osv2nd9b' }],
})

const SERVER_LIST_JSON = envelope({
  servers: [{ 'repo': 'logseq_db_llm-wiki', 'graph': 'llm-wiki', 'pid': 26331, 'host': '127.0.0.1', 'port': 59198, 'base-url': 'http://127.0.0.1:59198', 'status': 'ready', 'owner-source': 'electron', 'owned': false }],
})

function shimSource(): string {
  return `#!/usr/bin/env node
import { stdout } from 'node:process'
void (() => {
const args0 = process.argv.slice(2)
const out = args0[args0.indexOf('--output') + 1]
if (out !== 'json') { stdout.write('ERROR: expected --output json\\n'); process.exit(1) }
// Strip the global --graph/--root-dir/--output flag pairs before classifying.
const skip = { '--graph': true, '--root-dir': true, '--output': true }
const args = args0.filter((a, i, arr) => {
  if (skip[a] || (arr[i - 1] && skip[arr[i - 1]])) return false
  return true
})
const first = args[0]
if (first === 'list') {
  const entity = args.find(a => a !== 'list' && !a.startsWith('-'))
  const payloads = {
    'page': ${JSON.stringify(LIST_PAGES_JSON)},
    'tag': ${JSON.stringify(LIST_TAGS_JSON)},
  }
  const found = payloads[entity ?? '']
  if (found !== undefined) { stdout.write(found + '\\n'); return }
}
if (first === 'show') { stdout.write(${JSON.stringify(SHOW_RUST_JSON)} + '\\n'); return }
if (first === 'server' && args[1] === 'list') { stdout.write(${JSON.stringify(SERVER_LIST_JSON)} + '\\n'); return }
if (first === 'upsert' || first === 'remove' || first === 'query' || first === 'server') {
  // Echo canonical args back so tests can assert forwarding.
  stdout.write(JSON.stringify({ status: 'ok', data: { argv: args } }) + '\\n')
  return
}
if (first === 'search') {
  // Mirror the real CLI: search takes --content only; a --limit flag is rejected.
  if (args.includes('--limit')) {
    stdout.write(JSON.stringify({ status: 'error', error: { code: 'invalid-options', message: 'Unknown option: :limit' } }) + '\\n')
    process.exit(1)
  }
  stdout.write(JSON.stringify({ status: 'ok', data: { items: [] } }) + '\\n')
  return
}
stdout.write(JSON.stringify({ status: 'error', error: 'unknown command: ' + args.join(' ') }) + '\\n')
process.exit(1)
})()
`
}

describe('wikiGraph service (shim CLI)', () => {
  let dir: string
  let shimPath: string
  let service: LogseqGraphService
  let ctx: Context

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-graph-'))
    shimPath = join(dir, 'logseq.mjs')
    writeFileSync(shimPath, shimSource())
    chmodExecutable(shimPath)
    ctx = new Context()
    service = new LogseqGraphService(ctx, { cliPath: shimPath, graph: 'llm-wiki', timeoutMs: 10_000 })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('listPages projects flat page rows', async () => {
    const { pages } = await service.listPages({})
    expect(pages).toHaveLength(2)
    expect(pages[0]).toMatchObject({ id: 240, title: 'Rust', updatedAt: 1787808165009 })
  })

  it('getPage projects the nested block tree, tags and linked references', async () => {
    const { root, linked } = await service.getPage({ page: 'Rust' })
    expect(root.id).toBe(240)
    expect(root.name).toBe('rust')
    expect(root.props['user.property/status-mnIvao0n']).toBe(272)
    expect(root.tags.map(t => t.title)).toEqual(['topic', 'Page'])
    expect(root.children).toHaveLength(1)
    expect(root.children[0]!.content).toContain('[[Fast and Hard Code]]')
    expect(root.children[0]!.children[0]!.content).toBe('nested child')
    expect(linked).toHaveLength(1)
    expect(linked[0]).toMatchObject({ id: 241, pageName: 'fast and hard code', pageTitle: 'Fast and Hard Code' })
  })

  it('listTags projects tag rows', async () => {
    const { tags } = await service.listTags()
    expect(tags[0]).toMatchObject({ id: 205, title: 'todo' })
  })

  it('server list projects the server table', async () => {
    const result = await service.server('list')
    if ('servers' in result) {
      expect(result.servers[0]).toMatchObject({ graph: 'llm-wiki', port: 59198, status: 'ready' })
    } else {
      throw new Error('expected server list')
    }
  })

  it('upsert forwards flags; missing content on a new blockish entity is rejected', async () => {
    await expect(service.upsert({ entityType: 'block' })).rejects.toThrow('missing-content')
    const result = await service.upsert({
      entityType: 'block',
      content: 'new block',
      targetPage: 'Rust',
      pos: 'last-child',
      updateProperties: { status: 'draft' },
    })
    expect(result.status).toBe('ok')
  })

  it('remove requires a selector', async () => {
    await expect(service.remove({ entityType: 'block' })).rejects.toThrow('provide a selector')
    await expect(service.remove({ entityType: 'page', page: 'Rust' })).resolves.toMatchObject({ entityType: 'page' })
  })

  it('dryRun returns a would-run line without spawning writes', async () => {
    const result = await service.upsert({ entityType: 'page', page: 'NewPage', content: 'first', dryRun: true })
    expect(result.status).toBe('dry-run')
    expect(result.detail).toContain('would run')
  })

  it('execCli surfaces flushable CLI errors with argv attached', async () => {
    const shim = join(dir, 'broken.mjs')
    writeFileSync(shim, '#!/usr/bin/env node\nconsole.error("boom"); process.exit(2)\n')
    chmodExecutable(shim)
    await expect(execCli(shim, ['list', 'page'], { timeoutMs: 5000 })).rejects.toMatchObject({ name: 'LogseqCliError' })
  })

  it('execCli reports a missing executable with an install hint', async () => {
    const { execCli: run } = await import('../src/cli.ts')
    await expect(run('/nonexistent/logseq', ['--version'], { timeoutMs: 5000 })).rejects.toThrow(/not found|ENOENT|install/)
  })

  it('search pages projects page hits', async () => {
    const { items } = await service.search({ type: 'page', content: 'Rust' })
    expect(Array.isArray(items)).toBe(true)
  })

  it('search forwards content-only argv and rejects an unsupported --limit flag', async () => {
    // The real CLI has no --limit; the service must not forward one.
    const { items } = await service.search({ type: 'block', content: 'borrow', limit: 25 })
    expect(items).toEqual([])
  })

  it('query returns the result rows', async () => {
    const { rows } = await service.query({ query: '[:find ?t :where [?b :block/title ?t]]' })
    expect(rows).toBeDefined()
  })
})

// Live integration: read-only against the real graph (needs a running logseq CLI).
describe.skipIf(!process.env.LOGSEQ_INTEGRATION)('wikiGraph service (live graph)', () => {
  it('reads the real llm-wiki graph', async () => {
    const fresh = new Context()
    const live = new LogseqGraphService(fresh, { graph: 'llm-wiki', timeoutMs: 30_000 })
    const { pages } = await live.listPages({})
    expect(pages.length).toBeGreaterThan(0)
    const rust = pages.find(p => p.title === 'Rust')
    expect(rust).toBeDefined()
    const { root } = await live.getPage({ page: 'Rust' })
    expect(root.id).toBe(rust!.id)
  })
})

function chmodExecutable(path: string): void {
  try {
    chmodSync(path, 0o755)
  } catch {
    // Windows: no-op
  }
}
