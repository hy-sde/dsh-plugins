import { describe, expect, it } from 'vitest'
import {
  applyQueryConstraints,
  DUCKDUCKGO_QUERY_SYNTAX,
  formatQuery,
  formatScraperQuery,
  GOOGLE_QUERY_SYNTAX,
  MOJEEK_QUERY_SYNTAX,
  parseDateValue,
  parseSearchQuery,
  unsupportedQueryConstraints,
} from '../src/query.ts'

describe('public search query controls', () => {
  it('canonicalizes aliases and formats only syntax the target engine supports', () => {
    const raw = 'release domain:example.com intitle:"API guide" since:2026-01 filetype:pdf'
    const parsed = parseSearchQuery(raw)

    expect(formatScraperQuery(raw, parsed)).toBe(
      'release site:example.com intitle:"API guide" filetype:pdf after:2026-01-01',
    )
    expect(formatScraperQuery(raw, parsed, DUCKDUCKGO_QUERY_SYNTAX)).toBe(
      'release site:example.com intitle:"API guide" filetype:pdf',
    )
  })

  it('keeps unknown and malformed directives as search terms', () => {
    const raw = 'TS2345: failure before:someday https://example.com/docs'
    const parsed = parseSearchQuery(raw)

    expect(parsed.before).toBeUndefined()
    expect(parsed.text).toBe(raw)
  })

  it('rejects calendar-impossible dates so the directive degrades to a plain term', () => {
    // Date.parse('2023-02-29') silently ROLLS OVER to 2023-03-01 (V8 MakeDay),
    // shifting the bound instead of rejecting it — probe the calendar instead.
    expect(parseDateValue('2023-02-29')).toBeUndefined()
    expect(parseDateValue('2024-02-31')).toBeUndefined()
    expect(parseDateValue('2024-04-31')).toBeUndefined()
    expect(parseDateValue('2024-02-29')).toBe('2024-02-29')
    // The degraded directive is a plain term — no date bound, so engines
    // without dateRange support are not skipped for a typo'd date.
    const parsed = parseSearchQuery('guide before:2023-02-29 site:docs.test')
    expect(parsed.before).toBeUndefined()
    expect(parsed.terms.map(term => term.text)).toContain('before:2023-02-29')
    expect(parsed.sites).toEqual(['docs.test'])
    expect(parsed.hasConstraints).toBe(true)
    expect(unsupportedQueryConstraints(parsed, DUCKDUCKGO_QUERY_SYNTAX)).toEqual([])
    expect(unsupportedQueryConstraints(parsed, MOJEEK_QUERY_SYNTAX)).toEqual([])
  })

  it('does not adopt a sign-prefixed token as an empty directive value', () => {
    // `site: -example.com` reads as "site: then exclude example.com"; adopting
    // the sign-prefixed token verbatim would strict-empty the merge and render
    // `site:-example.com` into engine queries.
    const parsed = parseSearchQuery('docs site: -example.com')
    expect(parsed.sites).toEqual([])
    expect(parsed.hasConstraints).toBe(false)
    expect(formatQuery(parsed, DUCKDUCKGO_QUERY_SYNTAX)).toBe('docs -example.com')
    const quoted = parseSearchQuery('site: -"exact phrase"')
    expect(quoted.sites).toEqual([])
    // Quoted values still adopt as directive values.
    expect(parseSearchQuery('site: "docs.test"').sites).toEqual(['docs.test'])
  })

  it('identifies constraints an engine cannot enforce from result metadata', () => {
    const parsed = parseSearchQuery('agent -intext:deprecated after:2026-01-01')

    expect(unsupportedQueryConstraints(parsed, MOJEEK_QUERY_SYNTAX)).toEqual([
      '-intext:deprecated',
      'after:2026-01-01',
    ])
    expect(unsupportedQueryConstraints(parsed, DUCKDUCKGO_QUERY_SYNTAX)).toEqual([
      'after:2026-01-01',
    ])
    expect(unsupportedQueryConstraints(parsed, GOOGLE_QUERY_SYNTAX)).toEqual([])
  })

  it('filters observable dimensions after merge without treating undated sources as stale', () => {
    const parsed = parseSearchQuery('guide site:example.com intitle:API filetype:pdf after:2026-01-01')
    const result = applyQueryConstraints([
      { url: 'https://example.com/api.pdf', title: 'API Guide', publishedAt: '2026-02-01' },
      { url: 'https://example.com/api.pdf?mirror=1', title: 'API Guide' },
      { url: 'https://other.test/api.pdf', title: 'API Guide', publishedAt: '2026-02-01' },
      { url: 'https://example.com/old.pdf', title: 'API Guide', publishedAt: '2025-01-01' },
    ], parsed)

    expect(result).toEqual({
      sources: [
        { url: 'https://example.com/api.pdf', title: 'API Guide', publishedAt: '2026-02-01' },
        { url: 'https://example.com/api.pdf?mirror=1', title: 'API Guide' },
      ],
      dropped: [],
    })
  })

  it('relaxes only a constraint dimension that would erase every source when opted in', () => {
    const parsed = parseSearchQuery('guide site:missing.test -site:blocked.test')
    const sources = [
      { url: 'https://allowed.test/guide', title: 'Guide' },
      { url: 'https://blocked.test/guide', title: 'Guide' },
    ]

    expect(applyQueryConstraints(sources, parsed, { relaxPositive: true })).toEqual({
      sources: [{ url: 'https://allowed.test/guide', title: 'Guide' }],
      dropped: ['site:missing.test'],
    })
  })

  it('keeps positive constraints strict unless relaxation is opted in', () => {
    const parsed = parseSearchQuery('guide site:missing.test')
    const sources = [{ url: 'https://allowed.test/guide', title: 'Guide' }]

    expect(applyQueryConstraints(sources, parsed)).toEqual({
      sources: [],
      dropped: [],
      emptiedBy: 'site:missing.test',
    })
    expect(applyQueryConstraints(sources, parsed, { relaxPositive: true })).toEqual({
      sources: [{ url: 'https://allowed.test/guide', title: 'Guide' }],
      dropped: ['site:missing.test'],
    })
  })

  it('never relaxes explicit negative filters', () => {
    const parsed = parseSearchQuery('guide -site:blocked.test')
    const sources = [{ url: 'https://blocked.test/guide', title: 'Guide' }]
    const expected = { sources: [], dropped: [], emptiedBy: '-site:blocked.test' }

    expect(applyQueryConstraints(sources, parsed)).toEqual(expected)
    expect(applyQueryConstraints(sources, parsed, { relaxPositive: true })).toEqual(expected)
  })

  it('preserves OR chains between same-field directives', () => {
    const raw = 'intitle:guide OR intitle:manual'
    const parsed = parseSearchQuery(raw)

    expect(parsed.verbatim).toBeFalsy()
    expect(formatQuery(parsed, GOOGLE_QUERY_SYNTAX)).toBe('intitle:guide OR intitle:manual')
    expect(formatQuery(parsed, DUCKDUCKGO_QUERY_SYNTAX)).toBe('intitle:guide OR intitle:manual')
    const result = applyQueryConstraints([
      { url: 'https://a.test/guide', title: 'A Guide' },
      { url: 'https://b.test/manual', title: 'B Manual' },
      { url: 'https://c.test/other', title: 'C Other' },
    ], parsed)
    expect(result.sources.map(source => source.url)).toEqual([
      'https://a.test/guide',
      'https://b.test/manual',
    ])
  })

  it('passes unsupported Boolean structures through verbatim', () => {
    const raw = 'intitle:(guide OR manual)'
    const parsed = parseSearchQuery(raw)

    expect(parsed.verbatim).toBe(true)
    expect(formatQuery(parsed, GOOGLE_QUERY_SYNTAX)).toBe(raw)
    expect(formatScraperQuery(raw, parsed, GOOGLE_QUERY_SYNTAX)).toBe(raw)
    // Verbatim queries are enforced by the engines; local filtering stands down.
    const sources = [{ url: 'https://a.test/x', title: 'Unrelated' }]
    expect(applyQueryConstraints(sources, parsed)).toEqual({ sources, dropped: [] })
  })

  it('treats mixed term/directive OR chains as verbatim', () => {
    const parsed = parseSearchQuery('intitle:guide OR manual')

    expect(parsed.verbatim).toBe(true)
    expect(formatQuery(parsed)).toBe('intitle:guide OR manual')
  })
})
