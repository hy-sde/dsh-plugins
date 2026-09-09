/**
 * Conventional-commit message normalization.
 * Direct port of omp's `commit/conventional/normalization.ts`, reduced to the
 * deterministic parts (Unicode normalization, summary verb repair, body
 * cleanup, final formatting) — the token-estimation detail capping uses a
 * configurable budget so it works with or without an LLM pipeline.
 * @module @hy-sde-org/dsh-git/conventional/normalization
 */

import type { ConventionalCommit } from './types.ts'
import { presentToPast, isPastTenseVerb, splitVerbToken, verbStem } from './validation.ts'

/** Runtime limits consumed by normalization/validation (llm-git thresholds). */
export interface ConventionalConfig {
  readonly summaryGuideline: number
  readonly summarySoftLimit: number
  readonly summaryHardLimit: number
  readonly maxDetailTokens: number
}

/** llm-git's standard standard limits, in effect when callers pass `undefined`. */
export const DEFAULT_CONVENTIONAL_CONFIG: ConventionalConfig = {
  summaryGuideline: 50,
  summarySoftLimit: 72,
  summaryHardLimit: 100,
  maxDetailTokens: 3000,
}

const PRE_NFKD_REPLACEMENTS: Record<string, string> = {
  '≠': '!=',
  '½': '1/2',
  '¼': '1/4',
  '¾': '3/4',
  '⅓': '1/3',
  '⅔': '2/3',
  '⅕': '1/5',
  '⅖': '2/5',
  '⅗': '3/5',
  '⅘': '4/5',
  '⅙': '1/6',
  '⅚': '5/6',
  '⅛': '1/8',
  '⅜': '3/8',
  '⅝': '5/8',
  '⅞': '7/8',
  '⁰': '^0',
  '¹': '^1',
  '²': '^2',
  '³': '^3',
  '⁴': '^4',
  '⁵': '^5',
  '⁶': '^6',
  '⁷': '^7',
  '⁸': '^8',
  '⁹': '^9',
  '₀': '_0',
  '₁': '_1',
  '₂': '_2',
  '₃': '_3',
  '₄': '_4',
  '₅': '_5',
  '₆': '_6',
  '₇': '_7',
  '₈': '_8',
  '₉': '_9',
}

const POST_NFKD_REPLACEMENTS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‹': "'",
  '›': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '«': '"',
  '»': '"',
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '--',
  '—': '--',
  '―': '--',
  '−': '-',
  '→': '->',
  '←': '<-',
  '↔': '<->',
  '⇒': '=>',
  '⇐': '<=',
  '⇔': '<=>',
  '↑': '^',
  '↓': 'v',
  '≤': '<=',
  '≥': '>=',
  '≈': '~=',
  '≡': '==',
  '×': 'x',
  '÷': '/',
  '…': '...',
  '⋯': '...',
  '⋮': '...',
  '•': '-',
  '◦': '-',
  '▪': '-',
  '▫': '-',
  '◆': '-',
  '◇': '-',
  '✓': 'v',
  '✔': 'v',
  '✗': 'x',
  '✘': 'x',
  'λ': 'lambda',
  'α': 'alpha',
  'β': 'beta',
  'γ': 'gamma',
  'δ': 'delta',
  'ε': 'epsilon',
  'θ': 'theta',
  'μ': 'mu',
  'π': 'pi',
  'σ': 'sigma',
  'Σ': 'Sigma',
  'Δ': 'Delta',
  'Π': 'Pi',
  '\u00a0': ' ',
  '\u2000': ' ',
  '\u2001': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u2004': ' ',
  '\u2005': ' ',
  '\u2006': ' ',
  '\u2007': ' ',
  '\u2008': ' ',
  '\u2009': ' ',
  '\u200a': ' ',
  '\u202f': ' ',
  '\u205f': ' ',
  '\u3000': ' ',
  '\u200b': '',
  '\u200c': '',
  '\u200d': '',
  '\ufeff': '',
}

/**
 * Normalize Unicode punctuation, symbols, fractions, arrows, and spaces.
 * @param text - raw summary/body text.
 * @returns the cleaned ASCII-oriented text.
 */
export function normalizeCommitUnicode(text: string): string {
  return replaceCharacters(replaceCharacters(text, PRE_NFKD_REPLACEMENTS).normalize('NFKD'), POST_NFKD_REPLACEMENTS)
}

/**
 * Estimate tokens with llm-git's four-UTF-8-bytes rule.
 * @param text - the string to estimate.
 * @returns the estimated token count.
 */
export function estimateCommitTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

/**
 * Keep the highest-priority details inside the configured token budget.
 * Priority: security/breaking/perf/bug/API keywords, then by length. MUTATES
 * `details` in place (llm-git `cap_commit_details`).
 * @param details - the details array to cap (mutated in place).
 * @param maxTokens - the token budget to respect.
 */
export function capCommitDetails(details: string[], maxTokens: number): void {
  if (details.length === 0) return
  if (details.reduce((total, detail) => total + estimateCommitTokens(detail), 0) <= maxTokens) return
  const scored = details.map((detail, index) => {
    const lower = detail.toLowerCase()
    let score = 0
    if (
      lower.includes('security') ||
      lower.includes('vulnerability') ||
      lower.includes('exploit') ||
      lower.includes('critical') ||
      (lower.includes('fix') && lower.includes('crash'))
    ) {
      score += 100
    }
    if (lower.includes('breaking') || lower.includes('incompatible')) score += 90
    if (lower.includes('performance') || lower.includes('faster') || lower.includes('optimization')) score += 80
    if (lower.includes('fix') || lower.includes('bug')) score += 70
    if (lower.includes('api') || lower.includes('interface') || lower.includes('public')) score += 50
    if (lower.includes('user') || lower.includes('client')) score += 40
    if (lower.includes('deprecated') || lower.includes('removed')) score += 35
    score += Math.min(Math.floor(Buffer.byteLength(detail, 'utf8') / 20), 10)
    return { index, score, tokens: estimateCommitTokens(detail) }
  })
  let budget = Math.max(0, Math.trunc(maxTokens))
  const keep: number[] = []
  for (const item of scored.sort((left, right) => right.score - left.score)) {
    if (item.tokens > budget) continue
    keep.push(item.index)
    budget -= item.tokens
  }
  keep.sort((left, right) => left - right)
  const retained = keep.map(index => details[index] ?? '')
  details.splice(0, details.length, ...retained)
}

/**
 * Convert a known leading present-tense summary verb to past tense.
 * @param summary - the summary line to repair.
 * @param commitType - the commit type (drives `refactor` → `restructured`).
 * @returns the repaired summary (unchanged when no repair applies).
 */
export function normalizeSummaryVerb(summary: string, commitType: string): string {
  const stripped = summary.trim()
  if (!stripped) return stripped
  const parts = stripped.split(/\s+/)
  const firstWord = parts[0] ?? ''
  const rest = parts.slice(1).join(' ')
  const firstLower = firstWord.toLowerCase()
  if (isPastTenseVerb(firstLower)) {
    return commitType === 'refactor' && firstLower === 'refactored' ? joinFirstRest('restructured', rest) : stripped
  }
  const split = splitVerbToken(firstWord)
  if (!split || verbStem(firstWord) === null) return stripped
  const [rawStem, suffix] = split
  const stem = rawStem.toLowerCase()
  if (suffix && !suffix.startsWith('-') && !suffix.startsWith('/')) return stripped
  if (stem === 're' && suffix.startsWith('-')) {
    const match = suffix.slice(1).match(/^[A-Za-z]+/)
    if (!match) return stripped
    const inner = match[0].toLowerCase()
    const tail = suffix.slice(1 + match[0].length)
    let innerPast = pastForPresentish(inner)
    if (!innerPast) return stripped
    if (commitType === 'refactor' && innerPast === 'refactored') innerPast = 'restructured'
    return joinFirstRest(`re-${innerPast}${tail}`, rest)
  }
  let past = pastForPresentish(stem)
  if (!past) return stripped
  if (commitType === 'refactor' && past === 'refactored') past = 'restructured'
  return joinFirstRest(`${past}${suffix}`, rest)
}

/**
 * Normalize summary, body, and footers before final validation.
 * @param message - the raw conventional commit to normalize.
 * @param config - optional limits (defaults to {@link DEFAULT_CONVENTIONAL_CONFIG}).
 * @returns the normalized message (summary verb-repaired, body bulleted).
 */
export function postProcessCommitMessage(
  message: ConventionalCommit,
  config: ConventionalConfig = DEFAULT_CONVENTIONAL_CONFIG,
): ConventionalCommit {
  let summary = normalizeCommitUnicode(message.summary)
  summary = summary.replaceAll('\r', ' ').replaceAll('\n', ' ').split(/\s+/).filter(Boolean).join(' ')
  summary = summary
    .trim()
    .replace(/[.;:]+$/g, '')
    .trim()
  summary = lowercaseFirstToken(summary)
  summary = normalizeSummaryVerb(summary, message.type)
  summary = lowercaseFirstToken(summary.trim()).replace(/\.+$/g, '').trim()
  if (Buffer.byteLength(summary, 'utf8') > config.summaryHardLimit) {
    throw new Error(`Summary exceeds ${config.summaryHardLimit} bytes`)
  }

  const body: string[] = []
  for (const raw of message.body) {
    let detail = normalizeCommitUnicode(raw).replaceAll('\r', ' ').replaceAll('\n', ' ')
    detail = detail
      .trim()
      .replace(/^[•\-*+]+/, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(' ')
    detail = detail.replace(/[.;,]+$/g, '').trim()
    if (!detail) continue
    const first = firstCodePoint(detail)
    if (first && first === first.toLowerCase() && first !== first.toUpperCase()) {
      detail = first.toUpperCase() + detail.slice(first.length)
    }
    if (!detail.endsWith('.')) detail += '.'
    body.push(detail)
  }
  capCommitDetails(body, config.maxDetailTokens)
  return {
    ...message,
    summary,
    body,
    footers: message.footers.map(normalizeCommitUnicode),
  }
}

/**
 * Format a normalized conventional commit as Git commit-message text.
 * @param message - the normalized commit.
 * @returns the rendered commit-message body.
 */
export function formatConventionalCommit(message: ConventionalCommit): string {
  const scope = message.scope ? `(${message.scope})` : ''
  let result = `${message.type}${scope}: ${message.summary}`
  if (message.body.length > 0) result += `\n\n${message.body.map(item => `- ${item}`).join('\n')}`
  if (message.footers.length > 0) result += `\n\n${message.footers.join('\n')}`
  return result
}

function replaceCharacters(text: string, replacements: Record<string, string>): string {
  const result: string[] = []
  for (const character of text) result.push(replacements[character] ?? character)
  return result.join('')
}

function pastForPresentish(stem: string): string | null {
  const direct = presentToPast(stem)
  if (direct) return direct
  if (stem.endsWith('s')) {
    const singular = presentToPast(stem.slice(0, -1))
    if (singular) return singular
  }
  if (stem.endsWith('es')) {
    const singular = presentToPast(stem.slice(0, -2))
    if (singular) return singular
  }
  if (stem.endsWith('ies')) return presentToPast(`${stem.slice(0, -3)}y`) ?? null
  return null
}

function joinFirstRest(first: string, rest: string): string {
  return rest ? `${first} ${rest}` : first
}

function lowercaseFirstToken(text: string): string {
  if (!text) return text
  const token = text.split(/\s+/, 1)[0] ?? ''
  let hasLetters = false
  let allUppercase = true
  for (const character of token) {
    if (!/\p{L}/u.test(character)) continue
    hasLetters = true
    if (character !== character.toUpperCase()) allUppercase = false
  }
  if (hasLetters && allUppercase) return text
  const first = firstCodePoint(text)
  return first && first === first.toUpperCase() && first !== first.toLowerCase()
    ? `${first.toLowerCase()}${text.slice(first.length)}`
    : text
}

function firstCodePoint(text: string): string {
  const codePoint = text.codePointAt(0)
  return codePoint === undefined ? '' : String.fromCodePoint(codePoint)
}
