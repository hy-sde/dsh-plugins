/**
 * `@hy-sde-org/dsh-tool-codebase-memory` tests: hermetic coverage of the MCP
 * result-envelope parsing, argv/args-file building, payload truncation and the
 * mounted tool surface over a fake `codebase-memory-mcp` shim, plus (when the
 * real CLI is present) a guarded read-only live pass.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { applyCodebaseMemoryTools, CodebaseMemoryCliError, renderPayload } from '../src/codebase-memory.ts'
import { buildCodebaseMemoryPromptSection } from '../src/prompt.ts'

const dirs: string[] = []
let ctx: Context
let counter = 0

afterEach(async () => {
  await ctx?.fiber.dispose()
  await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true })))
})

async function makeDir(tag: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dsh-tool-cbm-${tag}-`))
  dirs.push(path)
  return path
}

async function writeShim(dir: string, script: string): Promise<string> {
  const path = join(dir, 'codebase-memory-mcp')
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return path
}

// Shim: the real CLI is `cli --json <tool> [--args-file <path>]`. Here we
// decode the args file and answer with raw MCP result envelopes exactly like
// the real binary (`--json` always exits 0; errors live in the envelope).
const SHIM = `#!/bin/bash
if [ "$1" = "--version" ]; then
  echo "codebase-memory-mcp 0.9.0-test"
  exit 0
fi
if [ "$1" != "cli" ] || [ "$2" != "--json" ]; then
  echo "unexpected invocation: $*" >&2
  exit 9
fi
tool="$3"
args='{}'
if [ "$4" = "--args-file" ]; then
  args="$(cat "$5")"
fi
case "$tool" in
  list_projects)
    echo '{"content":[{"type":"text","text":"{\\"projects\\":[{\\"name\\":\\"demo\\",\\"root_path\\":\\"/repo/demo\\"}]}"}],"isError":false}'
    exit 0 ;;
  search_graph)
    if echo "$args" | grep -q '"project"'; then
      echo '{"content":[{"type":"text","text":"{\\"total\\":1,\\"results\\":[{\\"name\\":\\"run\\",\\"qualified_name\\":\\"demo.run\\",\\"label\\":\\"Function\\",\\"file_path\\":\\"src/index.ts\\",\\"start_line\\":4}]}"}],"isError":false}'
    else
      echo '{"content":[{"type":"text","text":"{\\"error\\":\\"missing required argument: project\\"}"}],"isError":true}'
    fi
    exit 0 ;;
  index_repository)
    echo '{"content":[{"type":"text","text":"{\\"status\\":\\"ok\\",\\"nodes\\":123}"}],"isError":false}'
    exit 0 ;;
  get_code_snippet)
    echo '{"content":[{"type":"text","text":"{\\"source\\":\\"export function run() {}\\",\\"file\\":\\"src/index.ts\\"}"}],"isError":false}'
    exit 0 ;;
  query_graph)
    echo '{"content":[{"type":"text","text":"{\\"total\\":1,\\"rows\\":[[1,2]]}"}],"isError":false}'
    exit 0 ;;
  not-a-real-tool)
    echo '{"content":[{"type":"text","text":"unknown tool: not-a-real-tool"}],"isError":true}'
    exit 0 ;;
  *)
    echo '{"content":[{"type":"text","text":"{\\"echo\\":\\"ok\\"}"}],"isError":false}'
    exit 0 ;;
esac
`

async function realCbmAvailable(): Promise<string | null> {
  const candidates = ['codebase-memory-mcp', join(homedir(), '.local', 'bin', 'codebase-memory-mcp')]
  for (const candidate of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      execFile(candidate, ['--version'], { timeout: 8000 }, (err) => { resolve(!err) })
    })
    if (ok) return candidate
  }
  return null
}

const agent = { session: { header: { id: 'cbm1', cwd: '' } } } as never

async function call<T>(name: string, args: unknown): Promise<T> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`cbm-${++counter}`),
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

async function setup(shimPath: string, toolConfig: Parameters<typeof applyCodebaseMemoryTools>[1] = {}) {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  applyCodebaseMemoryTools(ctx, { ...toolConfig, cliPath: shimPath })
  ctx.systemPrompt.section(buildCodebaseMemoryPromptSection())
}

describe('pure helpers', () => {
  it('renderPayload stringifies JSON and truncates over the cap', () => {
    expect(renderPayload({ a: 1 }, 200000)).toBe('{"a":1}')
    expect(renderPayload('plain', 200000)).toBe('"plain"')
    const text = renderPayload({ big: 'x'.repeat(100) }, 50)
    expect(text).toContain('...(truncated by tool-codebase-memory')
  })

  it('CodebaseMemoryCliError carries invocation diagnostics', () => {
    const err = new CodebaseMemoryCliError('boom', ['cli', '--json'], 'out', 'err', 1, { error: 'boom' })
    expect(err.name).toBe('CodebaseMemoryCliError')
    expect(err.args).toEqual(['cli', '--json'])
    expect(err.exitCode).toBe(1)
    expect(err.payload).toEqual({ error: 'boom' })
  })

  it('buildCodebaseMemoryPromptSection toggles on enabled', () => {
    expect(buildCodebaseMemoryPromptSection().text.length).toBeGreaterThan(0)
    expect(buildCodebaseMemoryPromptSection({ enabled: false }).text).toBe('')
  })
})

describe('codebase-memory tools over a shim CLI', () => {
  it('registers all fourteen tools over the shim', async () => {
    const dir = await makeDir('surface')
    await setup(await writeShim(dir, SHIM))
    const names = ['codebase_list_projects', 'codebase_index_repository', 'codebase_index_status',
      'codebase_search_graph', 'codebase_query_graph', 'codebase_trace_path', 'codebase_get_code_snippet',
      'codebase_get_graph_schema', 'codebase_get_architecture', 'codebase_search_code',
      'codebase_detect_changes', 'codebase_manage_adr', 'codebase_ingest_traces', 'codebase_delete_project']
    for (const name of names) {
      expect(ctx.tools.get(name), name).toBeDefined()
    }
  })

  it('codebase_list_projects passes empty args (no args-file) and parses the envelope', async () => {
    const dir = await makeDir('list')
    await setup(await writeShim(dir, SHIM))
    const value = await call<{ text: string }>('codebase_list_projects', {})
    expect(value.text).toContain('"name":"demo"')
  })

  it('codebase_index_repository sends repo_path and parses the result', async () => {
    const dir = await makeDir('index')
    await setup(await writeShim(dir, SHIM), { indexTimeoutMs: 9999 })
    const value = await call<{ text: string }>('codebase_index_repository', { repoPath: '/repo/demo', mode: 'fast' })
    expect(value.text).toContain('"nodes":123')
  })

  it('codebase_index_repository rejects a missing repoPath without invoking the CLI', async () => {
    const dir = await makeDir('index-required')
    await setup(await writeShim(dir, SHIM))
    await expect(call('codebase_index_repository', {})).rejects.toThrow(/repoPath is required/)
  })

  it('codebase_search_graph defaults project from config', async () => {
    const dir = await makeDir('search')
    await setup(await writeShim(dir, SHIM), { project: 'demo' })
    const value = await call<{ text: string }>('codebase_search_graph', { query: 'run' })
    expect(value.text).toContain('"total":1')
    expect(value.text).toContain('demo.run')
  })

  it('codebase_search_graph without a project surfaces the envelope error', async () => {
    const dir = await makeDir('search-err')
    await setup(await writeShim(dir, SHIM))
    await expect(call('codebase_search_graph', { query: 'run' })).rejects.toThrow(/missing required argument: project/)
  })

  it('codebase_query_graph requires query before invoking the CLI', async () => {
    const dir = await makeDir('query')
    await setup(await writeShim(dir, SHIM))
    await expect(call('codebase_query_graph', { project: 'demo' })).rejects.toThrow(/query is required/)
  })

  it('codebase_get_code_snippet maps qualifiedName to qualified_name', async () => {
    const dir = await makeDir('snippet')
    await setup(await writeShim(dir, SHIM), { project: 'demo' })
    const value = await call<{ text: string }>('codebase_get_code_snippet', { qualifiedName: 'demo.run' })
    expect(value.text).toContain('export function run')
  })

  it('codebase_ingest_traces rejects an empty traces array', async () => {
    const dir = await makeDir('traces')
    await setup(await writeShim(dir, SHIM))
    await expect(call('codebase_ingest_traces', { project: 'demo', traces: [] })).rejects.toThrow(/traces must be a non-empty array/)
  })

  it('missing CLI fails with an install hint', async () => {
    const dir = await makeDir('missing')
    await setup(join(dir, 'does-not-exist'))
    await expect(call('codebase_list_projects', {})).rejects.toThrow(/not found/)
  })
})

describe('codebase-memory tools — live integration (CBM_INTEGRATION=1 only)', () => {
  const live = process.env.CBM_INTEGRATION === '1'

  it.skipIf(!live)('reads the graph via the real CLI (read-only)', async () => {
    const real = await realCbmAvailable()
    if (!real) return
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    applyCodebaseMemoryTools(ctx, { project: 'deepseek-harness', cliPath: real })
    ctx.systemPrompt.section(buildCodebaseMemoryPromptSection())
    const projects = await call<{ text: string }>('codebase_list_projects', {})
    expect(projects.text).toContain('deepseek-harness')
    const found = await call<{ text: string }>('codebase_search_graph', { query: 'search_graph', limit: 2 })
    expect(found.text).toContain('"total"')
  }, 60000)
})
