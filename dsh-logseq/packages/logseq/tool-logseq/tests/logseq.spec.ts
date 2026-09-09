/**
 * `@hy-sde-org/dsh-tool-logseq` tests: hermetic coverage of the JSON envelope
 * parsing / rendering / argv building over a fake `logseq` shim, plus (when the
 * real CLI is present and LOGSEQ_INTEGRATION=1) a guarded read-only live pass.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { applyLogseqTools, LogseqCliError } from '../src/logseq.ts'
import { parseOutput, renderItems, renderValue } from '../src/logseq.ts'
import { buildLogseqPromptSection } from '../src/prompt.ts'

const dirs: string[] = []
let ctx: Context
let counter = 0

afterEach(async () => {
  await ctx?.fiber.dispose()
  await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true })))
})

async function makeDir(tag: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dsh-tool-logseq-${tag}-`))
  dirs.push(path)
  return path
}

async function writeShim(dir: string, script: string): Promise<string> {
  const path = join(dir, 'logseq')
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return path
}

const SHIM = `#!/bin/bash
case "$1" in
  --version) echo "logseq 0.10.0-test"; exit 0 ;;
  list)
    shift
    echo '{"status":"ok","data":{"items":[{"block/title":"Home","db/id":1,"block/name":"home"},{"block/title":"Bugs","db/id":2,"block/name":"bugs"}]}}'
    exit 0 ;;
  search)
    shift
    echo "{\\"status\\":\\"ok\\",\\"data\\":{\\"items\\":[{\\"block/title\\":\\"Bugs\\",\\"db/id\\":2}]}}"
    exit 0 ;;
  upsert)
    if [ "$3" = "--content" ] && [ -z "$4" ]; then
      echo "Error (missing-content): content is required" >&2
      exit 0
    fi
    shift
    echo '{"status":"ok","data":{"block/title":"Bugs","db/id":3}}'
    exit 0 ;;
  remove)
    shift
    echo '{"status":"ok","data":{"removed":1}}'
    exit 0 ;;
  query)
    shift
    echo '{"status":"ok","data":{"result":[["Home",1],["Bugs",2]]}}'
    exit 0 ;;
  show|server|graph)
    # pass through everything else as plain text
    cat
    exit 0 ;;
esac
`

async function realLogseqAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('logseq', ['--version'], { timeout: 8000 }, (err) => { resolve(!err) })
  })
}

const agent = { session: { header: { id: 'lg1', cwd: '' } } } as never

async function call<T>(name: string, args: unknown): Promise<T> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`logseq-${++counter}`),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) {
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    throw new Error(text || 'tool failed')
  }
  return (result as unknown as { value: T }).value
}

async function setup(shimPath: string, toolConfig: Parameters<typeof applyLogseqTools>[1] = {}) {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  applyLogseqTools(ctx, { ...toolConfig, cliPath: shimPath })
  ctx.systemPrompt.section(buildLogseqPromptSection())
}

describe('pure helpers', () => {
  it('parseOutput classifies ok envelopes, error envelopes and non-JSON', () => {
    expect(parseOutput('{"status":"ok","data":{"items":[]}}').status).toBe('ok')
    expect(parseOutput('{"status":"error","error":"boom"}').status).toBe('error')
    expect(parseOutput('not json at all').status).toBe('text')
  })

  it('renderItems renders titles and caps at max', () => {
    const items = [
      { 'block/title': 'Home', 'db/id': 1 },
      { 'block/title': 'Bugs', 'db/id': 2 },
    ]
    expect(renderItems(items, 1, 'pages')).toContain('pages: 2 (truncated to 1)')
    expect(renderItems(items, 1, 'pages')).toContain('Home')
    expect(renderItems([], 5, 'tasks')).toBe('tasks: none')
  })

  it('renderValue flattens query results', () => {
    const text = renderValue({ result: [['Home', 1], ['Bugs', 2]] }, 10, 'query result', true)
    expect(text).toContain('query result: 2 rows')
    expect(text).toContain('- Home | 1')
  })
})

describe('logseq tools over a shim CLI', () => {
  it('logseq_list returns capped item text', async () => {
    const dir = await makeDir('list')
    await setup(await writeShim(dir, SHIM))
    const value = await call<{ count: number; text: string }>('logseq_list', { entityType: 'page', limit: 1 })
    expect(value.count).toBe(2)
    expect(value.text).toContain('Home')
  })

  it('logseq_search passes content through', async () => {
    const dir = await makeDir('search')
    await setup(await writeShim(dir, SHIM))
    const value = await call<{ text: string }>('logseq_search', { entityType: 'block', content: 'bugs' })
    expect(value.text).toContain('Bugs')
  })

  it('logseq_upsert reports a missing-content CLI error', async () => {
    const dir = await makeDir('upsert')
    await setup(await writeShim(dir, SHIM))
    await expect(call('logseq_upsert', { entityType: 'block' })).rejects.toThrow(/missing-content/)
  })

  it('logseq_upsert succeeds in update mode by uuid', async () => {
    const dir = await makeDir('upsert-ok')
    await setup(await writeShim(dir, SHIM))
    const value = await call<{ status: string; detail: string }>('logseq_upsert', {
      entityType: 'block', uuid: '11111111-1111-1111-1111-111111111111', content: 'new body', targetPage: 'Home',
    })
    expect(value.status).toBe('ok')
    expect(value.detail).toContain('id=3')
  })

  it('logseq_remove reports removal', async () => {
    const dir = await makeDir('remove')
    await setup(await writeShim(dir, SHIM))
    const value = await call<{ detail: string }>('logseq_remove', { entityType: 'page', page: 'Home' })
    expect(value.detail).toBe('page removed')
  })

  it('logseq_query returns flattened rows', async () => {
    const dir = await makeDir('query')
    await setup(await writeShim(dir, SHIM))
    const value = await call<{ count: number; text: string }>('logseq_query', { query: '[:find [?t ?e] :where [?b :block/title ?t]]' })
    expect(value.count).toBe(2)
    expect(value.text).toContain('- Home | 1')
  })

  it('logseq_upsert dryRun does not invoke the CLI', async () => {
    const dir = await makeDir('dryrun')
    await setup(await writeShim(dir, SHIM))
    const value = await call<{ status: string; detail: string }>('logseq_upsert', {
      entityType: 'page', page: 'Never', dryRun: true,
    })
    expect(value.status).toBe('dry-run')
    expect(value.detail).toContain('would run:')
  })

  it('LogseqCliError carries argv for diagnostics', () => {
    const err = new LogseqCliError('x', ['list', 'page'], '', '', 2)
    expect(err.name).toBe('LogseqCliError')
    expect(err.args).toContain('list')
    expect(err.exitCode).toBe(2)
  })
})

describe('logseq tools — live integration (LOGSEQ_INTEGRATION=1 only)', () => {
  const live = process.env.LOGSEQ_INTEGRATION === '1'

  it.skipIf(!live)('reads the graph via the real CLI (read-only)', async () => {
    if (!(await realLogseqAvailable())) return
    await setup('logseq', { graph: 'llm-wiki', maxItems: 5 })
    const value = await call<{ count: number; text: string }>('logseq_list', { entityType: 'page' })
    expect(value.count).toBeGreaterThan(0)
    const query = await call<{ count: number; text: string }>('logseq_query', {
      query: '[:find [?t ...] :where [?b :block/title ?t]]',
    })
    expect(query.count).toBeGreaterThan(0)
  })
})
