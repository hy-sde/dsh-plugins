import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  TSFORK_DEFAULT_BINARY,
  expandTilde,
  parseDiagnostics,
  parseVersionLine,
  resolveBinary,
  runTsfork,
} from '../src/core.ts'

/** Skips cleanly on hosts without the parked binary (CI, other machines). */
const hasBinary = (() => {
  try { resolveBinary(TSFORK_DEFAULT_BINARY); return true } catch { return false }
})()

describe.skipIf(!hasBinary)('tsfork integration (parked binary)', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'tsfork-it-'))
  afterAll(() => { rmSync(fixtureRoot, { recursive: true, force: true }) })

  it('reports the compiler version', async () => {
    const run = await runTsfork({ binary: resolveBinary(TSFORK_DEFAULT_BINARY), args: ['--version'], timeoutMs: 20_000 })
    expect(run.code).toBe(0)
    expect(parseVersionLine(run.stdout)).toMatch(/^\d+\.\d+\.\d+/)
    expect(run.wallMs).toBeLessThan(20_000)
  })

  it('typechecks a failing fixture project and parses the diagnostics', async () => {
    const project = path.join(fixtureRoot, 'bad')
    mkdirSync(project, { recursive: true })
    writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
    }))
    writeFileSync(path.join(project, 'bad.ts'), `const level: number = 'nope'\n`)
    const run = await runTsfork({
      binary: resolveBinary(TSFORK_DEFAULT_BINARY),
      args: ['-p', project, '--noEmit'],
      timeoutMs: 120_000,
    })
    expect(run.timedOut).toBe(false)
    const parsed = parseDiagnostics(`${run.stdout}\n${run.stderr}`)
    expect(parsed.errorCount).toBeGreaterThan(0)
    expect(parsed.diagnostics[0]?.code ?? '').toMatch(/^TS\d+$/)
    expect(parsed.diagnostics[0]?.file ?? '').toContain('bad.ts')
  })

  it('expands the tilde default binary path', () => {
    expect(expandTilde(TSFORK_DEFAULT_BINARY)).not.toContain('~')
  })
})
