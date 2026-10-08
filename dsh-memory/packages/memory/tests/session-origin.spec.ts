/**
 * The session-origin encoder: canonical `dsh-session:` URIs round-trip, and
 * hostile session ids cannot break the markdown mention label.
 */

import { describe, expect, it } from 'vitest'
import {
  decodeSessionOriginUri, encodeSessionOriginUri, SESSION_ORIGIN_SCHEME, sessionOriginMention,
} from '../src/session-origin.ts'

describe('session-origin encoding', () => {
  it('encodes the id as base64url JSON and round-trips it', () => {
    const uri = encodeSessionOriginUri('abc-123_session/x')
    expect(uri.startsWith(SESSION_ORIGIN_SCHEME)).toBe(true)
    expect(uri).toBe(`dsh-session:${Buffer.from(JSON.stringify('abc-123_session/x'), 'utf8').toString('base64url')}`)
    expect(decodeSessionOriginUri(uri)).toBe('abc-123_session/x')
  })

  it('escapes hostile labels so the markdown link stays intact', () => {
    const mention = sessionOriginMention('label]breaker')
    expect(mention).toBe(`@[label\\]breaker](${encodeSessionOriginUri('label]breaker')})`)
    const uri = mention.match(/dsh-session:[A-Za-z0-9_-]+/g)?.[0] ?? ''
    expect(decodeSessionOriginUri(uri)).toBe('label]breaker')
    expect(sessionOriginMention('sess-1', 'my ] label\\x')).toBe(
      `@[my \\] label\\\\x](${encodeSessionOriginUri('sess-1')})`,
    )
  })

  it('defaults the label to the raw session id', () => {
    expect(sessionOriginMention('sess-1')).toBe(`@[sess-1](${encodeSessionOriginUri('sess-1')})`)
  })

  it('rejects URIs that are not canonical dsh-session encodings', () => {
    expect(() => decodeSessionOriginUri('https://example.invalid')).toThrow(/invalid session origin URI/)
    expect(() => decodeSessionOriginUri('dsh-session:!!!')).toThrow(/invalid session origin URI/)
    // Decodes to a JSON number, not a string.
    expect(() => decodeSessionOriginUri(`dsh-session:${Buffer.from('42').toString('base64url')}`))
      .toThrow(/invalid session origin URI/)
    // Valid base64url whose trailing bits make the re-encode differ (not canonical).
    expect(() => decodeSessionOriginUri('dsh-session:ImFhIh')).toThrow(/invalid session origin URI/)
  })
})
