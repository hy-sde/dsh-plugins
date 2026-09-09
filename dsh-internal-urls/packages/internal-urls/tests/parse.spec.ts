/**
 * Internal-URL parsing and scheme detection.
 */

import { describe, expect, it } from 'vitest'
import { extractUriScheme, parseConflictReference, parseInternalUrl } from '../src/parse.ts'

describe('extractUriScheme', () => {
  it('detects hierarchical scheme:// prefixes (case-insensitive)', () => {
    expect(extractUriScheme('conflict://3')).toBe('conflict')
    expect(extractUriScheme('PR://1428')).toBe('pr')
    expect(extractUriScheme('issue://owner/repo/12')).toBe('issue')
    expect(extractUriScheme('x-y+z.1://a')).toBe('x-y+z.1')
  })

  it('rejects non-hierarchical or non-URL inputs', () => {
    expect(extractUriScheme('scheme:x')).toBeUndefined()
    expect(extractUriScheme('a:b://c')).toBeUndefined()
    expect(extractUriScheme('/abs/path.ts')).toBeUndefined()
    expect(extractUriScheme('file.txt')).toBeUndefined()
    expect(extractUriScheme('')).toBeUndefined()
  })
})

describe('parseInternalUrl', () => {
  it('preserves raw host, raw pathname, and exact input', () => {
    const parsed = parseInternalUrl('pr://MyOwner/Repo/1428/diff/all')
    expect(parsed.scheme).toBe('pr')
    expect(parsed.rawHost).toBe('MyOwner')
    expect(parsed.rawPathname).toBe('/Repo/1428/diff/all')
    expect(parsed.pathSegments).toEqual(['Repo', '1428', 'diff', 'all'])
    expect(parsed.rawHref).toBe('pr://MyOwner/Repo/1428/diff/all')
    expect(parsed.searchParams.size).toBe(0)
  })

  it('parses numeric hosts and bare schemes', () => {
    expect(parseInternalUrl('conflict://3').pathSegments).toEqual([])
    expect(parseInternalUrl('conflict://3').rawHost).toBe('3')
    expect(parseInternalUrl('issue://').rawHost).toBe('')
    expect(parseInternalUrl('issue://').pathSegments).toEqual([])
  })

  it('keeps query params reachable', () => {
    const parsed = parseInternalUrl('pr://owner/repo/7?comments=0&state=open')
    expect(parsed.searchParams.get('comments')).toBe('0')
    expect(parsed.searchParams.get('state')).toBe('open')
    expect(parsed.pathSegments).toEqual(['repo', '7']) // the host is not a path segment
  })

  it('rejects empty, dot, and dotdot path segments', () => {
    expect(() => parseInternalUrl('a://one//two')).toThrow(/Invalid internal URL/)
    expect(() => parseInternalUrl('a://one/./two')).toThrow(/Invalid internal URL/)
    expect(() => parseInternalUrl('a://one/../two')).toThrow(/Invalid internal URL/)
  })

  it('rejects inputs that are not hierarchical URLs', () => {
    expect(() => parseInternalUrl('not-a-url')).toThrow()
    expect(() => parseInternalUrl('urn:isbn:123')).toThrow(/Invalid internal URL/)
  })
})

describe('parseConflictReference', () => {
  it('parses the <path>:conflict:// selector form', () => {
    const ref = parseConflictReference('/ws/a.ts:conflict://3/theirs')
    expect(ref).not.toBeNull()
    expect(ref!.scheme).toBe('conflict')
    expect(ref!.rawHref).toBe('/ws/a.ts:conflict://3/theirs')
    expect(ref!.href).toBe('conflict://3/theirs')
    expect(ref!.pathSegments).toEqual(['theirs'])
  })

  it('returns null for plain paths and plain conflict URLs', () => {
    expect(parseConflictReference('/ws/a.ts')).toBeNull()
    expect(parseConflictReference('conflict://3')).toBeNull()
    expect(parseConflictReference('')).toBeNull()
  })
})
