/**
 * Vendored from fork @deepseek-ai/dsh-internal-urls (packages/fs/internal-urls/src/parse.ts) — keep in sync.
 * The published harness does not ship this package, so @hy-sde-org/dsh-session-url vendors the small
 * internal-URL surface it consumes (types + parse + router) to stay dependency-free and standalone.
 */
/**
 * RFC 3986 scheme detection and internal-URL parsing that preserves the raw
 * host/pathname bytes before URL normalization.
 * @module @deepseek-ai/dsh-internal-urls/parse
 */

import type { ParsedInternalUrl } from './types.ts'

/** A hierarchical `scheme://` prefix with an RFC 3986 scheme (first char alpha, then alnum/+/./-). */
const URI_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i

/**
 * The scheme of an input that looks like a hierarchical `scheme://` URL, or
 * `undefined` when the input is not of that shape at all (so filesystem paths
 * like `a:/b` or `scheme:x` never count as internal URLs).
 * @param input - the raw model-supplied path.
 * @returns the lowercased scheme, or `undefined`.
 */
export function extractUriScheme(input: string): string | undefined {
  const match = URI_SCHEME_RE.exec(input)
  return match?.[1]?.toLowerCase()
}

/**
 * Parse a hierarchical internal URL preserving the raw host and pathname.
 * Only the `scheme://…` form routes through the registry — opaque inputs
 * (`urn:…`) never parse here.
 *
 * Segment handling follows the router's strictness: an empty, `.`, or `..`
 * path segment throws, and a malformed URL throws with the input echoed back.
 *
 * @param input - the raw model-supplied path (`conflict://3/ours`, `pr://1428`).
 * @returns the parsed URL with raw segments, decoded segments, query params, and exact input.
 * @throws when the input is not a parseable hierarchical `scheme://` URL or contains a bad segment.
 */
export function parseInternalUrl(input: string): ParsedInternalUrl {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`Invalid internal URL: ${input}`)
  }
  const scheme = extractUriScheme(input)
  if (scheme === undefined) {
    throw new Error(`Invalid internal URL: ${input}`)
  }

  const afterScheme = input.slice(input.indexOf('://') + 3)
  // The host ends at the first `/`, `?`, or `#` — everything else belongs to it.
  const hostileStart = afterScheme.search(/[/?#]/)
  const rawHost = hostileStart === -1 ? afterScheme : afterScheme.slice(0, hostileStart)
  const tail = hostileStart === -1 ? '' : afterScheme.slice(hostileStart)
  // The raw pathname is everything from the first `/` up to the first `?`/`#`.
  const pathEnd = tail.search(/[?#]/)
  const rawPathname = pathEnd === -1 ? tail : tail.slice(0, pathEnd)

  const stripped = rawPathname.startsWith('/') ? rawPathname.slice(1) : rawPathname
  const pathSegments: string[] = []
  if (stripped !== '') {
    for (const segment of stripped.split('/')) {
      let decoded: string
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        throw new Error(`Invalid internal URL: ${input}`)
      }
      if (decoded === '' || decoded === '.' || decoded === '..') {
        throw new Error(`Invalid internal URL: ${input}`)
      }
      pathSegments.push(decoded)
    }
  }

  return {
    scheme,
    rawHost,
    rawPathname,
    pathSegments,
    searchParams: url.searchParams,
    href: url.href,
    rawHref: input,
  }
}

/**
 * Parse the `<path>:conflict://<id>` selector form — a filesystem path glued to
 * a conflict URL by a colon (sibling of the `path:conflicts` read selector).
 * The conflict handler reads `.rawHref` directly and strips the prefix itself,
 * so the returned URL keeps the original bytes as `rawHref` while the rest of
 * the shape describes the conflict URL proper.
 *
 * @returns the parsed conflict URL, or `null` when `input` is not of that shape.
 */
export function parseConflictReference(input: string): ParsedInternalUrl | null {
  const marker = input.toLowerCase().lastIndexOf(':conflict://')
  if (marker <= 0) return null
  const tail = input.slice(marker + ':conflict://'.length)
  const inner = parseInternalUrl(`conflict://${tail}`)
  return { ...inner, href: `conflict://${tail}`, rawHref: input }
}
