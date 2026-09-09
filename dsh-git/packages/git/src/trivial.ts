/**
 * Trivial-change detection for the commit analyzer.
 * Direct port of omp's `packages/coding-agent/src/commit/agentic/trivial.ts`.
 * @module @hy-sde-org/dsh-git/trivial
 */

import type { CommitType } from './types.ts'

export interface TrivialChangeResult {
  isTrivial: true
  type: CommitType
  summary: string
}

const WHITESPACE_ONLY_PATTERN = /^[-+][\t ]*$/
const IMPORT_LINE_PATTERN = /^[-+]\s*(import\s|from\s|export\s.*from|require\(|module\.exports)/
const EMPTY_LINE_PATTERN = /^[-+]\s*$/

/**
 * Classify a diff as a trivial change (whitespace-only or imports-only), which
 * skips the model round entirely and commits directly.
 * @returns a trivial classification, or null when the change is substantive.
 */
export function detectTrivialChange(diff: string): TrivialChangeResult | null {
  const lines = diff.split('\n')
  const changeLines = lines.filter(line => line.startsWith('+') || line.startsWith('-'))
  const contentLines = changeLines.filter(
    line => !line.startsWith('+++') && !line.startsWith('---') && !line.startsWith('@@'),
  )

  if (contentLines.length === 0) return null

  if (isOnlyWhitespace(contentLines)) {
    return { isTrivial: true, type: 'style', summary: 'formatted code' }
  }

  if (isOnlyImports(contentLines)) {
    return { isTrivial: true, type: 'style', summary: 'reorganized imports' }
  }

  return null
}

function isOnlyWhitespace(lines: string[]): boolean {
  for (const line of lines) {
    const content = line.slice(1)
    if (content.trim().length > 0 && !WHITESPACE_ONLY_PATTERN.test(line)) {
      return false
    }
  }
  return true
}

function isOnlyImports(lines: string[]): boolean {
  for (const line of lines) {
    if (EMPTY_LINE_PATTERN.test(line)) continue
    if (!IMPORT_LINE_PATTERN.test(line)) {
      return false
    }
  }
  return true
}
