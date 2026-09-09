/**
 * The Automic Vault tools: end-to-end execute over a fake `av` CLI against a
 * full ctx (subprocess seam + ctx.av + tool registration), plus pure render
 * coverage. Verifies the four read-only tools, the friendly unavailable-binary
 * path, severity/detector filtering, caps, and that no value string leaks into
 * outputs (name-only listing).
 */

import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import avPackage from '@hy-sde-org/dsh-av'
import toolAvPackage from '@hy-sde-org/dsh-tool-av'
import {
  applyAvTools,
  renderScan,
  renderDoctor,
  renderCatalog,
  renderList,
} from '../src/av.ts'
import { buildAvPromptSection } from '../src/prompt.ts'
import type { AvToolConfig } from '../src/av.ts'

const dirs: string[] = []
let ctx: Context
let counter = 0

afterEach(async () => {
  await ctx?.fiber.dispose()
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function makeDir(tag: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dsh-tool-av-${tag}-`))
  dirs.push(path)
  return path
}

/** Write an executable fake `av` binary dispatching on argv. */
async function writeAvShim(dir: string, script: string): Promise<string> {
  const path = join(dir, 'av')
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return path
}

const SCAN = JSON.stringify({ findings: [
  { source: 'gh_cli', severity: 'high', explanation: 'gh stores a token readable by the user', solution: 'av harden gh', affected: [{ path: '/Users/x/.config/gh/hosts.yml', line: 2 }], docs_url: 'https://automicvault.com/docs/', detectors: ['gh_cli'] },
  { source: 'aws_cli', severity: 'medium', explanation: 'long-lived credentials', solution: 'av harden aws', affected: [{ path: '/Users/x/.aws/credentials' }], detectors: ['aws_cli'] },
] })

const SCAN_FILTERED = JSON.stringify({ findings: [
  { source: 'gh_cli', severity: 'high', explanation: 'filtered scan', solution: 'fix', affected: [], detectors: ['gh_cli'] },
] })

const DOCTOR = JSON.stringify({ results: [
  { name: 'gh', commands: ['gh'], issues: [] },
  { name: 'brew', commands: ['brew'], issues: [{ kind: 'not-hardened', command: 'brew', message: 'Homebrew is not hardened', remediation: 'av harden brew', stub_path: '/usr/local/bin/brew', target_path: '/opt/av/brew/bin/brew' }] },
] })

const DETECTORS = JSON.stringify({ detectors: [
  { name: 'gh_cli', docs_url: 'https://automicvault.com/docs/', documentation: 'GitHub CLI', watch_scopes: [{ path: '/Users/x/.config/gh', recursive: true }] },
] })

const HARDENERS = JSON.stringify({ hardeners: [
  { name: 'brew', documentation: 'https://automicvault.com/docs/', hardened: false, applicable: true, commands: [{ name: 'brew', hardened: false, required_paths: ['/usr/local/bin/brew'] }] },
] })

const SHIM = `#!/bin/bash
case "$1" in
  --version) echo "av 3.16.0"; exit 0 ;;
  scan)
    if [ "$#" -gt 2 ]; then
      printf '%s' '${SCAN_FILTERED}'
    else
      printf '%s' '${SCAN}'
    fi
    echo
    exit 0
    ;;
  doctor)
    if [ "$2" = "bogus" ]; then
      echo "av doctor: unknown tool bogus" >&2
      exit 2
    fi
    printf '%s' '${DOCTOR}'
    echo
    exit 0
    ;;
  detectors) printf '%s' '${DETECTORS}'; echo; exit 0 ;;
  hardeners) printf '%s' '${HARDENERS}'; echo; exit 0 ;;
  list) echo "GITHUB_TOKEN"; echo "AWS_ACCESS_KEY"; exit 0 ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
`

const agent = { session: { header: { id: 'av1', cwd: '' } } } as never

async function call<T>(name: string, args: unknown): Promise<T> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`av-${++counter}`),
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

async function setup(overrides: { avPath?: string; toolConfig?: AvToolConfig } = {}) {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(avPackage, { avPath: overrides.avPath ?? 'av' })
  if (overrides.toolConfig !== undefined) {
    // Mount the tools directly so per-test config (e.g. caps) applies.
    applyAvTools(ctx, overrides.toolConfig)
    ctx.systemPrompt.section(buildAvPromptSection())
  } else {
    await ctx.plugin(toolAvPackage)
  }
}

describe('Automic Vault tools', () => {
  it('av_scan summarizes findings with severity, files and fixes', async () => {
    const dir = await makeDir('scan')
    await setup({ avPath: await writeAvShim(dir, SHIM) })
    const value = await call<import('../src/av.ts').AvScanValue>('av_scan', {})
    expect(value.available).toBe(true)
    expect(value.version).toBe('3.16.0')
    expect(value.summary).toEqual({ total: 2, high: 1, medium: 1, low: 0 })
    expect(value.findings).toHaveLength(2)
    expect(value.findings[0]!.affected).toEqual(['/Users/x/.config/gh/hosts.yml:2'])
    expect(value.findings[0]!.detectors).toEqual(['gh_cli'])
    const text = renderScan(value)
    expect(text).toContain('[high] gh_cli')
    expect(text).toContain('av harden gh')
  })

  it('av_scan filters by severity and caps findings', async () => {
    const dir = await makeDir('scan-cap')
    await setup({ avPath: await writeAvShim(dir, SHIM), toolConfig: { maxFindings: 1 } })
    const value = await call<import('../src/av.ts').AvScanValue>('av_scan', { severity: 'high' })
    expect(value.summary.total).toBe(1)
    expect(value.findings).toHaveLength(1)
    expect(value.findings[0]!.source).toBe('gh_cli')
  })

  it('av_scan passes detector names through to the CLI', async () => {
    const dir = await makeDir('scan-detector')
    await setup({ avPath: await writeAvShim(dir, SHIM) })
    const value = await call<import('../src/av.ts').AvScanValue>('av_scan', { detector: 'gh_cli' })
    expect(value.findings[0]!.source).toBe('gh_cli')
    expect(value.findings[0]!.explanation).toBe('filtered scan')
  })

  it('av_doctor reports healthy and unhealthy hardeners with remediation', async () => {
    const dir = await makeDir('doctor')
    await setup({ avPath: await writeAvShim(dir, SHIM) })
    const value = await call<import('../src/av.ts').AvDoctorValue>('av_doctor', {})
    expect(value.available).toBe(true)
    expect(value.results).toHaveLength(2)
    expect(value.results[0]!.healthy).toBe(true)
    const brew = value.results[1]!
    expect(brew.healthy).toBe(false)
    expect(brew.issues[0]!.remediation).toBe('av harden brew')
    expect(renderDoctor(value)).toContain('brew: issues')
  })

  it('av_doctor surfaces a bad selector as a model-visible error', async () => {
    const dir = await makeDir('doctor-bad')
    await setup({ avPath: await writeAvShim(dir, SHIM) })
    await expect(call('av_doctor', { tool: 'bogus' })).rejects.toThrow(/unknown tool bogus/)
  })

  it('av_catalog returns detectors and hardeners with status', async () => {
    const dir = await makeDir('catalog')
    await setup({ avPath: await writeAvShim(dir, SHIM) })
    const value = await call<import('../src/av.ts').AvCatalogValue>('av_catalog', {})
    expect(value.detectors).toHaveLength(1)
    expect(value.detectors![0]!.docs).toContain('automicvault.com')
    expect(value.hardeners).toHaveLength(1)
    expect(value.hardeners![0]!).toMatchObject({ hardened: false, applicable: true })
    expect(renderCatalog(value)).toContain('brew — not hardened')
  })

  it('av_catalog scope=hardeners returns only hardeners', async () => {
    const dir = await makeDir('catalog-hard')
    await setup({ avPath: await writeAvShim(dir, SHIM) })
    const value = await call<import('../src/av.ts').AvCatalogValue>('av_catalog', { scope: 'hardeners' })
    expect(value.detectors).toBeUndefined()
    expect(value.hardeners).toHaveLength(1)
  })

  it('av_list returns secret names only — never values', async () => {
    const dir = await makeDir('list')
    await setup({ avPath: await writeAvShim(dir, SHIM) })
    const value = await call<import('../src/av.ts').AvListValue>('av_list', {})
    expect(value.available).toBe(true)
    expect(value.names).toEqual(['GITHUB_TOKEN', 'AWS_ACCESS_KEY'])
    const text = renderList(value)
    expect(text).toContain('GITHUB_TOKEN')
    expect(text).not.toContain('ghp_') // no value-shaped substring
  })

  it('tools degrade gracefully when the av CLI is missing', async () => {
    const dir = await makeDir('missing')
    await setup({ avPath: join(dir, 'does-not-exist') })
    const value = await call<import('../src/av.ts').AvScanValue>('av_scan', {})
    expect(value.available).toBe(false)
    expect(value.reason).toContain('brew install --cask')
  })

  it('tools degrade gracefully when av --version fails', async () => {
    const dir = await makeDir('bad')
    const shim = '#!/bin/bash\necho "broken install" >&2\nexit 4'
    await setup({ avPath: await writeAvShim(dir, shim) })
    const value = await call<import('../src/av.ts').AvScanValue>('av_scan', {})
    expect(value.available).toBe(false)
    expect(value.reason).toContain('broken install')
  })

  it('renders an empty list and doctor states', () => {
    expect(renderList({ available: true, names: [] })).toContain('no saved secrets')
    expect(renderDoctor({ available: true, results: [] })).toContain('no applicable hardeners')
    expect(renderScan({ available: false, reason: 'nope', summary: { total: 0, high: 0, medium: 0, low: 0 }, findings: [] })).toBe('nope')
  })
})
