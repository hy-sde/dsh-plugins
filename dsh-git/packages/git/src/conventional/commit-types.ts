/**
 * Conventional-commit type vocabulary and coercion.
 * Direct port of omp's `commit/conventional/commit-types.ts`, fed by the
 * verbatim `commit_types.json` resource (see `./commit-types-data.ts`).
 * @module @hy-sde-org/dsh-git/conventional/commit-types
 */

import type { ChangelogCategory, CommitType, ConventionalAnalysis, ConventionalCommit, ConventionalDetail } from './types.ts'
import { COMMIT_TYPES_RESOURCE } from './commit-types-data.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isScalar = (value: unknown): value is string | number | boolean | bigint | symbol =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  typeof value === 'bigint' ||
  typeof value === 'symbol'

/** Stringify like `String(value)` without object-typed `String(...)` call sites. */
function toDisplayString(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (isScalar(value)) return String(value)
  return (value as { toString(): string }).toString()
}

/** Conventional commit types in llm-git's canonical classification order. */
export const COMMIT_TYPE_ORDER: readonly CommitType[] = [
  'feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'style', 'perf', 'build', 'ci', 'revert',
  'deps', 'security', 'config', 'ux', 'release', 'hotfix', 'infra', 'init', 'merge', 'hack', 'wip',
]

const COMMIT_TYPE_SET: Record<string, true> = {}
for (const type of COMMIT_TYPE_ORDER) COMMIT_TYPE_SET[type] = true

const TYPE_ALIASES = new Map<string, CommitType>()
for (const entry of COMMIT_TYPES_RESOURCE.types) {
  if (!isCommitType(entry.name)) continue
  for (const alias of entry.aliases) TYPE_ALIASES.set(alias.toLowerCase(), entry.name)
}

const CHANGELOG_CATEGORY_BY_NAME: Record<string, ChangelogCategory> = {
  'breaking changes': 'Breaking Changes',
  breaking: 'Breaking Changes',
  added: 'Added',
  changed: 'Changed',
  deprecated: 'Deprecated',
  removed: 'Removed',
  fixed: 'Fixed',
  security: 'Security',
}

const NULL_SCOPE_MARKERS: Record<string, true> = { null: true, none: true, 'n/a': true }

/**
 * Return whether a string is an accepted conventional commit type.
 * @param value - any candidate type string.
 * @returns true when `value` is one of the 22 canonical types.
 */
export function isCommitType(value: string): value is CommitType {
  return COMMIT_TYPE_SET[value] === true
}

/**
 * Resolve a canonical commit type or configured alias.
 * @param raw - a type, alias, or mixed-case type name.
 * @returns the canonical type, or `undefined` when unresolvable.
 */
export function canonicalCommitType(raw: string): CommitType | undefined {
  const normalized = raw.trim().toLowerCase()
  if (isCommitType(normalized)) return normalized
  return TYPE_ALIASES.get(normalized)
}

/**
 * Resolve a model-emitted type, falling back to `chore` when unknown.
 * @param raw - a type, alias, or mixed-case type name.
 * @returns the canonical type (never `undefined`).
 */
export function coerceCommitType(raw: string): CommitType {
  return canonicalCommitType(raw) ?? 'chore'
}

/**
 * Resolve a model-emitted scope using llm-git's lossy two-segment normalization.
 * @param raw - raw scope string or value.
 * @returns the normalized scope, or `null` when empty/`none`/`n/a`.
 */
export function coerceOptionalScope(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = toDisplayString(raw).trim()
  if (!trimmed || NULL_SCOPE_MARKERS[trimmed.toLowerCase()]) return null
  const segments: string[] = []
  for (const segment of trimmed.replaceAll('\\', '/').toLowerCase().split('/')) {
    const cleaned = sanitizeScopeSegment(segment)
    if (cleaned) segments.push(cleaned)
    if (segments.length === 2) break
  }
  return segments.length > 0 ? segments.join('/') : null
}

/**
 * Render the configured commit-type vocabulary (for analysis prompts).
 * @returns one `- type: description (hint)` line per type, then the classifier hint.
 */
export function formatTypesDescription(): string {
  const lines: string[] = []
  for (const entry of COMMIT_TYPES_RESOURCE.types) {
    if (!isCommitType(entry.name)) continue
    let line = `- ${entry.name}: ${entry.description}`.trimEnd()
    if (entry.hint) line += ` (${entry.hint})`
    lines.push(line)
  }
  const classifierHint = COMMIT_TYPES_RESOURCE.classifier_hint.trim()
  if (classifierHint) lines.push(classifierHint)
  return lines.join('\n')
}

/**
 * Normalize raw model analysis into the conventional commit domain.
 * @param input - the raw analysis (`type`, optional `scope`/`summary`/`details`/`issueRefs`).
 * @returns the normalized {@link ConventionalAnalysis}.
 */
export function conventionalAnalysis(input: {
  type: string
  scope?: unknown
  summary?: unknown
  details?: unknown
  issueRefs?: unknown
}): ConventionalAnalysis {
  const type = canonicalCommitType(input.type)
  if (!type) throw new Error(`Invalid commit type: ${input.type}`)
  const summaryValue = typeof input.summary === 'string' ? input.summary : undefined
  return {
    type,
    scope: coerceOptionalScope(input.scope),
    ...(summaryValue !== undefined ? { summary: summaryValue } : {}),
    details: normalizeDetails(input.details),
    issueRefs: stringsFrom(input.issueRefs),
  }
}

/**
 * Build a normalized conventional commit value.
 * @param input - a raw commit (`type`, optional `scope`/`body`/`footers`, required `summary`).
 * @returns the normalized {@link ConventionalCommit}.
 */
export function conventionalCommit(input: {
  type: string
  scope?: unknown
  summary: string
  body?: readonly string[]
  footers?: readonly string[]
}): ConventionalCommit {
  const type = canonicalCommitType(input.type)
  if (!type) throw new Error(`Invalid commit type: ${input.type}`)
  const scope = coerceOptionalScope(input.scope)
  if (!input.summary.trim()) throw new Error('Commit summary cannot be empty')
  return {
    type,
    scope,
    summary: input.summary,
    body: [...(input.body ?? [])],
    footers: [...(input.footers ?? [])],
  }
}

function sanitizeScopeSegment(segment: string): string | null {
  const out: string[] = []
  let lastWasSeparator = false
  for (const char of segment.trim()) {
    if (/^[a-z0-9]$/.test(char)) {
      out.push(char)
      lastWasSeparator = false
    } else if (char === '-' || char === '_') {
      if (out.length > 0 && !lastWasSeparator) {
        out.push(char)
        lastWasSeparator = true
      }
    } else if ((/\s/.test(char) || char === '.') && out.length > 0 && !lastWasSeparator) {
      out.push('-')
      lastWasSeparator = true
    }
  }
  const cleaned = out.join('').replace(/^[-_]+|[-_]+$/g, '')
  return cleaned || null
}

function normalizeDetails(value: unknown): ConventionalDetail[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const details: ConventionalDetail[] = []
  for (const item of values) {
    if (typeof item === 'string') {
      if (item) details.push({ text: item, userVisible: false })
      continue
    }
    if (!isRecord(item) || item.text === null || item.text === undefined) continue
    const text = toDisplayString(item.text)
    if (!text) continue
    const category =
      typeof item.changelog_category === 'string' ? changelogCategory(item.changelog_category) : undefined
    const userVisible = typeof item.user_visible === 'boolean' ? item.user_visible : false
    details.push(userVisible && category !== undefined
      ? { text, changelogCategory: category, userVisible }
      : { text, userVisible })
  }
  return details
}

function changelogCategory(raw: string): ChangelogCategory {
  const category = CHANGELOG_CATEGORY_BY_NAME[raw.trim().toLowerCase()]
  if (!category) throw new Error(`Unknown changelog category: ${raw}`)
  return category
}

function stringsFrom(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try {
        return stringsFrom(JSON.parse(trimmed))
      } catch {
        // not JSON — fall through to line splitting
      }
    }
    return value
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  }
  if (Array.isArray(value)) return value.flatMap(stringsFrom)
  if (isRecord(value)) {
    const strings: string[] = []
    for (const key in value) {
      const inner = value[key]
      const innerValues = stringsFrom(inner)
      strings.push(...(innerValues.length === 0 ? [key] : innerValues.map(item => `${key}: ${item}`)))
    }
    return strings
  }
  return [toDisplayString(value)]
}
