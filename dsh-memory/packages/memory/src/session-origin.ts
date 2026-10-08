/**
 * Canonical `dsh-session` mention rendering for stored session origin.
 * Format-compatible with the harness's session-reference scheme: the URI is
 * `dsh-session:` + base64url of the JSON-encoded id, and the label is escaped
 * for markdown. Implemented locally (no `@deepseek-ai/*` dependency) so bank
 * rows, `memory://` views, and recall hits share one encoder; mentions are
 * produced only by `sessionOriginMention`, so every rendered target
 * round-trips {@link decodeSessionOriginUri}.
 * @module @hy-sde-org/dsh-memory/session-origin
 */

/** URI scheme reserved for DeepSeek Harness session snapshots. */
export const SESSION_ORIGIN_SCHEME = 'dsh-session:'

/**
 * Encode any session-id string as a canonical lossless URI.
 * @param sessionId - opaque session id to serialize.
 * @returns canonical `dsh-session:` URI.
 */
export function encodeSessionOriginUri(sessionId: string): string {
  const payload = Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
  return `${SESSION_ORIGIN_SCHEME}${payload}`
}

/**
 * Decode and canonicalize one session-origin URI.
 * @param uri - complete canonical URI.
 * @returns decoded session id.
 */
export function decodeSessionOriginUri(uri: string): string {
  if (!uri.startsWith(SESSION_ORIGIN_SCHEME)) throw invalidSessionOriginUri(uri)
  const payload = uri.slice(SESSION_ORIGIN_SCHEME.length)
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw invalidSessionOriginUri(uri)
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof parsed !== 'string') throw new TypeError('decoded session id is not a string')
    if (encodeSessionOriginUri(parsed) !== uri) throw new TypeError('URI is not canonical')
    return parsed
  } catch (error: unknown) {
    throw invalidSessionOriginUri(uri, error)
  }
}

/**
 * Canonical `@[label](dsh-session:…)` mention for one stored session id.
 * @param sessionId - raw session id as persisted by the backend.
 * @param label - optional display label (defaults to the raw session id).
 * @returns mention whose label is escaped for markdown.
 */
export function sessionOriginMention(sessionId: string, label?: string): string {
  return `@[${escapeSessionLabel(label ?? sessionId)}](${encodeSessionOriginUri(sessionId)})`
}

/** Escape a mention label for `\` and `]`, matching session-reference. */
function escapeSessionLabel(label: string): string {
  return label.replace(/[\\\]]/gu, match => `\\${match}`)
}

function invalidSessionOriginUri(uri: string, cause?: unknown): Error {
  return new Error(
    `invalid session origin URI ${JSON.stringify(uri)}`,
    cause === undefined ? undefined : { cause },
  )
}
