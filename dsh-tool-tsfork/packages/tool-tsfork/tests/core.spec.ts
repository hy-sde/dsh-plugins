import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  expandTilde,
  parseDiagnostics,
  parseVersionLine,
  resolveProjectPath,
  TsforkError,
} from '../src/core.ts'

describe('expandTilde', () => {
  it('expands bare ~ to the home directory', () => {
    expect(expandTilde('~')).toBe(process.env.HOME ?? expect.any(String))
  })
  it('expands ~/ prefixed paths', () => {
    expect(expandTilde('~/x/y')).toBe(path.join(process.env.HOME ?? '', 'x/y'))
  })
  it('leaves absolute and relative paths alone', () => {
    expect(expandTilde('/opt/tsc')).toBe('/opt/tsc')
    expect(expandTilde('~/x'.replace('~', ''))).toBe('/x')
  })
})

describe('parseDiagnostics', () => {
  it('parses file(line,col) diagnostics, fileless errors, and warnings', () => {
    const fixture = [
      'src/a.ts(3,7): error TS2322: Type "string" is not assignable to type "number".',
      'error TS5023: Unknown compiler option "nope".',
      'src/b.ts(1,1): warning TS6133: "x" is declared but its value is never read.',
      '',
      'Found 2 errors in the same file, starting at: src/a.ts:3',
    ].join('\n')
    const parsed = parseDiagnostics(fixture)
    expect(parsed.errorCount).toBe(2)
    expect(parsed.warningCount).toBe(1)
    expect(parsed.truncated).toBe(false)
    expect(parsed.diagnostics).toHaveLength(3)
    expect(parsed.diagnostics[0]).toEqual({
      file: 'src/a.ts', line: 3, column: 7, code: 'TS2322', severity: 'error',
      message: 'Type "string" is not assignable to type "number".',
    })
    expect(parsed.diagnostics[1]?.file).toBeNull()
    expect(parsed.diagnostics[1]?.line).toBeNull()
    expect(parsed.diagnostics[2]?.severity).toBe('warning')
  })

  it('keeps exact counts while capping the diagnostics list', () => {
    const fixture = Array.from({ length: 5 }, (_, i) =>
      `src/f${i}.ts(${i + 1},1): error TS2${300 + i}: message ${i}`,
    ).join('\n')
    const parsed = parseDiagnostics(fixture, 2)
    expect(parsed.diagnostics).toHaveLength(2)
    expect(parsed.errorCount).toBe(5)
    expect(parsed.truncated).toBe(true)
    expect(parsed.diagnostics[1]?.code).toBe('TS2301')
  })

  it('returns zero counts for clean output', () => {
    const parsed = parseDiagnostics('')
    expect(parsed).toEqual({ diagnostics: [], errorCount: 0, warningCount: 0, truncated: false })
  })
})

describe('parseVersionLine', () => {
  it('extracts the version from the tsgo banner', () => {
    expect(parseVersionLine('Version 7.1.0-dev\n')).toBe('7.1.0-dev')
    expect(parseVersionLine('')).toBeNull()
  })
})

describe('resolveProjectPath', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsfork-core-'))
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  it('accepts a directory containing tsconfig.json', () => {
    writeFileSync(path.join(dir, 'tsconfig.json'), '{}')
    expect(resolveProjectPath(dir, tmpdir())).toBe(dir)
  })

  it('throws project_missing for a nonexistent path', () => {
    const missing = path.join(dir, 'nope')
    try {
      resolveProjectPath(missing, tmpdir())
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(TsforkError)
      expect((e as TsforkError).code).toBe('project_missing')
    }
  })
})
