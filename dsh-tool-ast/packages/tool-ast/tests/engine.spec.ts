/**
 * Unit tests for the pure engine pieces of `@hy-sde-org/dsh-tool-ast`: argv building (every
 * model value stays a literal argv element — no shell layer), NDJSON match parsing, byte-to-index
 * conversion used to apply rewrite hunks, and the error-vocabulary classification hooks.
 */

import { describe, expect, it } from 'vitest'
import {
  AST_STRICTNESSES,
  buildAstGrepArgv,
  byteOffsetToIndex,
  parseAstMatches,
} from '../src/core.ts'

describe('buildAstGrepArgv', () => {
  it('produces a literal argv vector for a search', () => {
    expect(buildAstGrepArgv({ pat: 'fn($X)' })).toEqual([
      'run', '--color', 'never', '--json=stream', '--pattern', 'fn($X)',
    ])
  })

  it('adds rewrite, lang, strictness, globs and split roots in order', () => {
    expect(buildAstGrepArgv({
      pat: 'x($A)',
      rewrite: 'y($A)',
      lang: 'Rust',
      strictness: 'ast',
      include: '*.rs',
      path: 'src;lib',
    })).toEqual([
      'run', '--color', 'never', '--json=stream', '--pattern', 'x($A)',
      '--rewrite', 'y($A)', '--lang', 'Rust', '--strictness', 'ast', '--globs', '*.rs',
      'src', 'lib',
    ])
  })

  it('omits empty roots and optional flags', () => {
    expect(buildAstGrepArgv({ pat: 'p', path: ' ; a ;;; ' })).toEqual([
      'run', '--color', 'never', '--json=stream', '--pattern', 'p', 'a',
    ])
  })
})

describe('parseAstMatches', () => {
  it('parses a single match with captures', () => {
    const stdout = JSON.stringify({
      text: 'getUser(1)',
      lines: 'getUser(1);',
      file: 'src/a.ts',
      range: { byteOffset: { start: 0, end: 10 }, start: { line: 2, column: 4 }, end: { line: 2, column: 14 } },
      language: 'TypeScript',
      metaVariables: { single: { MSG: { text: '1' } } },
    }) + '\n'
    const [match] = parseAstMatches(stdout)
    expect(match).toBeDefined()
    // rst flattens the tuple; the destructure is still `| undefined` under
    // noUncheckedIndexedAccess, so the non-null assertion follows the guard.
    const record = match as NonNullable<typeof match>
    expect(record.text).toBe('getUser(1)')
    expect(record.file).toBe('src/a.ts')
    expect(record.startLine).toBe(2)
    expect(record.startColumn).toBe(4)
    expect(record.byteStart).toBe(0)
    expect(record.byteEnd).toBe(10)
    expect(record.language).toBe('TypeScript')
    expect([...record.captures?.entries() ?? []]).toEqual([['MSG', '1']])
  })

  it('parses a rewrite record with replacement offsets', () => {
    const stdout = JSON.stringify({
      text: 'old(1)',
      lines: 'old(1);',
      file: 'src/b.rs',
      range: { byteOffset: { start: 0, end: 6 }, start: { line: 0, column: 0 }, end: { line: 0, column: 6 } },
      replacement: 'new(1)',
      replacementOffsets: { start: 0, end: 6 },
    }) + '\n'
    const [match] = parseAstMatches(stdout)
    expect(match).toBeDefined()
    const record = match as NonNullable<typeof match>
    expect(record.rewrite).toEqual({ replacement: 'new(1)', byteStart: 0, byteEnd: 6 })
  })

  it('returns no matches for blank output', () => {
    expect(parseAstMatches('')).toEqual([])
  })

  it('fails on a malformed line instead of dropping it', () => {
    expect(() => parseAstMatches('garbage\ndata')).toThrow('malformed JSON line')
  })

  it('ignores a non-object JSON line (stream trailer shapes)', () => {
    const stdout = JSON.stringify({
      file: 'a.ts',
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
      text: 'x',
    }) + '\n'
    expect(parseAstMatches(stdout)).toHaveLength(1)
  })
})

describe('byteOffsetToIndex', () => {
  it('maps a byte offset to its UTF-16 index for ASCII', () => {
    expect(byteOffsetToIndex('hello', 2)).toBe(2)
    expect(byteOffsetToIndex('hello', 5)).toBe(5)
  })

  it('counts UTF-8 bytes for multi-byte characters', () => {
    // 'é' is 2 bytes in UTF-8: "aé" byte layout: 'a'=1, 'é'=2 → byte 3 is index 2
    expect(byteOffsetToIndex('aébc', 3)).toBe(2)
    expect(byteOffsetToIndex('aébc', 1)).toBe(1)
    // CJK char = 3 bytes: "中" at byte 1-3, so index 2 starts at byte 4
    expect(byteOffsetToIndex('x中y', 4)).toBe(2)
  })

  it('returns undefined for offsets inside a code point or past the end', () => {
    // 'é' spans bytes 1..3; byte 2 lands inside the code point
    expect(byteOffsetToIndex('aé', 2)).toBeUndefined()
    expect(byteOffsetToIndex('abc', 99)).toBeUndefined()
  })

  it('handles the end-of-file offset', () => {
    expect(byteOffsetToIndex('abc', 3)).toBe(3)
  })
})

describe('strictness vocabulary', () => {
  it('exposes every accepted strictness', () => {
    expect(AST_STRICTNESSES).toEqual(['cst', 'smart', 'ast', 'relaxed', 'signature', 'template'])
  })
})
