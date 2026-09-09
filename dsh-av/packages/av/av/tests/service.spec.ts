/**
 * The `ctx.av` service over a fake `av` CLI: JSON parsing of the read-only
 * surfaces (scan/doctor/detectors/hardeners/list), error surfaces of the CLI
 * wrapper (unavailable binary, non-zero exits, exit-2 usage, timeout), and the
 * Cordis plugin registration. The fake binary is a chmod +x shim that echoes
 * canned JSON per argv, exactly like the read-native sidecar tests.
 */

import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { AvService } from '../src/service.ts'
import avPlugin from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function makeDir(tag: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dsh-av-${tag}-`))
  dirs.push(path)
  return path
}

/** Write an executable fake `av` binary that dispatches on argv. */
async function writeAvShim(dir: string, script: string): Promise<string> {
  const path = join(dir, 'av')
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return path
}

const SCAN_FIXTURE = JSON.stringify({
  findings: [
    {
      source: 'gh_cli',
      severity: 'high',
      homepage: 'https://cli.github.com',
      explanation: 'gh stores a token readable by the user',
      solution: 'av harden gh',
      affected: [{ path: '/Users/x/.config/gh/hosts.yml', line: 2 }],
      docs_url: 'https://automicvault.com/docs/',
      detectors: ['gh_cli'],
    },
    {
      source: 'aws_cli',
      severity: 'medium',
      explanation: 'long-lived credentials in ~/.aws/credentials',
      solution: 'av harden aws',
      affected: [{ path: '/Users/x/.aws/credentials' }],
      detectors: ['aws_cli'],
    },
  ],
})

const DOCTOR_FIXTURE = JSON.stringify({
  results: [
    {
      name: 'gh',
      commands: ['gh'],
      issues: [],
    },
    {
      name: 'brew',
      commands: ['brew'],
      issues: [
        {
          kind: 'not-hardened',
          command: 'brew',
          message: 'Homebrew is not hardened',
          remediation: 'av harden brew',
          stub_path: '/usr/local/bin/brew',
          target_path: '/opt/av/brew/bin/brew',
        },
      ],
    },
  ],
})

const DETECTORS_FIXTURE = JSON.stringify({
  detectors: [
    { name: 'gh_cli', docs_url: 'https://automicvault.com/docs/', documentation: 'GitHub CLI', watch_scopes: [{ path: '/Users/x/.config/gh', recursive: true }] },
    { name: 'aws_cli', watch_scopes: [{ path: '/Users/x/.aws', recursive: false }] },
  ],
})

const HARDENERS_FIXTURE = JSON.stringify({
  hardeners: [
    { name: 'brew', hardened: false, applicable: true, commands: [{ name: 'brew', hardened: false, required_paths: ['/usr/local/bin/brew'] }] },
    { name: 'gh', hardened: true, applicable: true, commands: [{ name: 'gh', hardened: true, required_paths: [] }] },
  ],
})

const SHIM = `#!/bin/bash
case "\$1" in
  --version)
    echo "av 3.16.0"
    exit 0
    ;;
  scan)
    if [ "\$2" = "--json" ]; then
      if [ "\$#" -gt 2 ]; then
        echo "{\\"findings\\":[{\\"source\\":\\"\$3\\",\\"severity\\":\\"high\\",\\"explanation\\":\\"e\\",\\"solution\\":\\"s\\",\\"affected\\":[],\\"detectors\\":[\\"\$3\\"]}]}"
      else
        printf '%s' '${SCAN_FIXTURE}'
        echo
      fi
      exit 0
    fi
    echo "usage: av scan [--show-all|--json]" >&2
    exit 2
    ;;
  doctor)
    if [ "$#" -ge 2 ]; then
      printf '%s' '${DOCTOR_FIXTURE}'
      echo
      exit 0
    fi
    echo "usage: av doctor [tool] [--json]" >&2
    exit 2
    ;;
  detectors)
    printf '%s' '${DETECTORS_FIXTURE}'
    echo
    exit 0
    ;;
  hardeners)
    printf '%s' '${HARDENERS_FIXTURE}'
    echo
    exit 0
    ;;
  list)
    echo "GITHUB_TOKEN"
    echo "AWS_ACCESS_KEY"
    exit 0
    ;;
  *boom*)
    echo "boom" >&2
    exit 1
    ;;
  *)
    echo "unknown command" >&2
    exit 2
    ;;
esac
`

async function makeService(avPath: string, overrides: ConstructorParameters<typeof AvService>[1] = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  return { ctx, service: new AvService(ctx, { avPath, timeoutMs: 5000, ...overrides }) }
}

describe('AvService', () => {
  it('probes an available av CLI and reports its version', async () => {
    const dir = await makeDir('probe')
    const { service } = await makeService(await writeAvShim(dir, SHIM))
    const probe = await service.probe()
    expect(probe.available).toBe(true)
    expect(probe.version).toBe('3.16.0')
  })

  it('probes an unavailable av CLI without throwing', async () => {
    const dir = await makeDir('probe-missing')
    const { service } = await makeService(join(dir, 'does-not-exist'))
    const probe = await service.probe()
    expect(probe.available).toBe(false)
    expect(probe.reason?.toLowerCase()).toContain('av')
  })

  it('returns a friendly reason when av --version exits non-zero', async () => {
    const dir = await makeDir('probe-bad')
    const shim = '#!/bin/bash\necho "some fatal error" >&2\nexit 3'
    const { service } = await makeService(await writeAvShim(dir, shim))
    const probe = await service.probe()
    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('some fatal error')
  })

  it('parses av scan --json findings with affected paths and detectors', async () => {
    const dir = await makeDir('scan')
    const { service } = await makeService(await writeAvShim(dir, SHIM))
    const report = await service.scan()
    expect(report.findings).toHaveLength(2)
    const gh = report.findings[0]!
    expect(gh.source).toBe('gh_cli')
    expect(gh.severity).toBe('high')
    expect(gh.affected[0]).toEqual({ path: '/Users/x/.config/gh/hosts.yml', line: 2 })
    expect(gh.detectors).toEqual(['gh_cli'])
  })

  it('passes detector names through to av scan --json', async () => {
    const dir = await makeDir('scan-filter')
    const { service } = await makeService(await writeAvShim(dir, SHIM))
    const report = await service.scan(['gh_cli'])
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]!.source).toBe('gh_cli')
    expect(report.findings[0]!.detectors).toEqual(['gh_cli'])
  })

  it('parses av doctor --json results and issues', async () => {
    const dir = await makeDir('doctor')
    const { service } = await makeService(await writeAvShim(dir, SHIM))
    const report = await service.doctor()
    expect(report.results).toHaveLength(2)
    expect(report.results[0]!.name).toBe('gh')
    expect(report.results[0]!.issues).toEqual([])
    const brew = report.results[1]!
    expect(brew.issues[0]!.kind).toBe('not-hardened')
    expect(brew.issues[0]!.remediation).toBe('av harden brew')
  })

  it('passes a selector through to av doctor', async () => {
    const dir = await makeDir('doctor-selector')
    const { service } = await makeService(await writeAvShim(dir, SHIM))
    const report = await service.doctor('brew')
    expect(report.results).toHaveLength(2)
  })

  it('parses av detectors --json', async () => {
    const dir = await makeDir('detectors')
    const { service } = await makeService(await writeAvShim(dir, SHIM))
    const report = await service.detectors()
    expect(report.detectors).toHaveLength(2)
    expect(report.detectors[0]!.name).toBe('gh_cli')
    expect(report.detectors[0]!.watch_scopes[0]!.recursive).toBe(true)
  })

  it('parses av hardeners --json', async () => {
    const dir = await makeDir('hardeners')
    const { service } = await makeService(await writeAvShim(dir, SHIM))
    const report = await service.hardeners()
    expect(report.hardeners).toHaveLength(2)
    expect(report.hardeners[0]!.name).toBe('brew')
    expect(report.hardeners[0]!.hardened).toBe(false)
    expect(report.hardeners[0]!.applicable).toBe(true)
  })

  it('collects secret names from av list without values', async () => {
    const dir = await makeDir('list')
    const { service } = await makeService(await writeAvShim(dir, SHIM))
    const names = await service.list()
    expect(names).toEqual(['GITHUB_TOKEN', 'AWS_ACCESS_KEY'])
  })

  it('surfaces a non-zero av exit as AvCommandError', async () => {
    const dir = await makeDir('nonzero')
    const shim = '#!/bin/bash\necho "some fatal error" >&2\nexit 1'
    const { service } = await makeService(await writeAvShim(dir, shim))
    const fatalError: Record<string, unknown> = { exitCode: 1, stderr: expect.stringContaining('fatal') }
    await expect(service.list()).rejects.toMatchObject(fatalError)
  })

  it('surfaces an exit-2 usage error with retained stderr', async () => {
    const dir = await makeDir('usage')
    const shim = '#!/bin/bash\necho "usage: av scan [--show-all|--json]" >&2\nexit 2'
    const { service } = await makeService(await writeAvShim(dir, shim))
    await expect(service.scan()).rejects.toMatchObject({ exitCode: 2 })
  })

  it('surfaces unparseable stdout as AvCommandError', async () => {
    const dir = await makeDir('bad-json')
    const shim = '#!/bin/bash\necho "not json at all"'
    const { service } = await makeService(await writeAvShim(dir, shim))
    const unparseable: Record<string, unknown> = { message: expect.stringContaining('unparseable') }
    await expect(service.scan()).rejects.toMatchObject(unparseable)
  })

  it('times out a hanging av invocation', async () => {
    const dir = await makeDir('hang')
    const shim = '#!/bin/bash\nsleep 30\n'
    const { service } = await makeService(await writeAvShim(dir, shim), { timeoutMs: 300 })
    const timedOutError: Record<string, unknown> = { message: expect.stringContaining('timed out') }
    await expect(service.list()).rejects.toMatchObject(timedOutError)
  })

  it('registers ctx.av through the Cordis plugin', async () => {
    const dir = await makeDir('plugin')
    const avPath = await writeAvShim(dir, SHIM)
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(avPlugin, { avPath })
    const probe = await ctx.av.probe()
    expect(probe.available).toBe(true)
    expect(probe.version).toBe('3.16.0')
  })
})
