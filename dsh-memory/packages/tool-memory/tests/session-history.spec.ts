/**
 * Provenance mention helpers in the session-history bridge: `encodeSessionUri`
 * must stay format-compatible with session-reference's canonical `dsh-session:`
 * scheme (base64url of the JSON-encoded id), and `formatSessionMention` must
 * render a mention whose URI round-trips back to the id — so recall output
 * carries a click-through that a session-reference mount can resolve.
 */

import { describe, expect, it } from 'vitest'
import { encodeSessionUri, formatSessionMention, sessionLabel } from '../src/session-history.ts'

/** Mirror of session-reference's decode (kept dependency-free on purpose). */
function decodeUri(uri: string): string {
  expect(uri.startsWith('dsh-session:')).toBe(true)
  const payload = uri.slice('dsh-session:'.length)
  expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
  const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  expect(typeof parsed).toBe('string')
  return parsed as string
}

describe('session history provenance mentions', () => {
  it('encodeSessionUri is canonical-compatible with session-reference', () => {
    const uri = encodeSessionUri('abc-123_session/x')
    expect(uri.startsWith('dsh-session:')).toBe(true)
    // Round-trip via the mirror decoder.
    expect(decodeUri(uri)).toBe('abc-123_session/x')
    // Base64url alphabet only — the URI is a single opaque token.
    expect(uri.slice('dsh-session:'.length)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('formatSessionMention renders a resolvable mention with an escaped label', () => {
    const mention = formatSessionMention('sess_id_01', 'my ] label\\x')
    expect(mention).toBe('@[my \\] label\\\\x](dsh-session:InNlc3NfaWRfMDEi)')
    // The URI portion decodes back to the id.
    const uri = mention.slice(mention.indexOf('(') + 1, mention.indexOf(')'))
    expect(decodeUri(uri)).toBe('sess_id_01')
  })

  it('formatSessionMention defaults the label to the short session label', () => {
    const sessionId = '0123456789abcdef0123456789abcdef'
    const mention = formatSessionMention(sessionId)
    expect(mention).toContain(`@[${sessionLabel(sessionId)}](`)
    expect(sessionLabel(sessionId)).toBe('01234567')
    expect(decodeUri(mention.slice(mention.indexOf('(') + 1, mention.indexOf(')')))).toBe(sessionId)
  })
})
