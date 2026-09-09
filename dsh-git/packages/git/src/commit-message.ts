/**
 * Conventional-commit message formatting.
 * Direct port of omp's `packages/coding-agent/src/commit/message.ts`.
 * @module @hy-sde-org/dsh-git/commit-message
 */

import type { ConventionalAnalysis } from './types.ts'

/** Render a conventional-commit message from an analysis and summary line. */
export function formatCommitMessage(analysis: ConventionalAnalysis, summary: string): string {
  const scopePart = analysis.scope ? `(${analysis.scope})` : ''
  const header = `${analysis.type}${scopePart}: ${summary}`
  const bodyLines = analysis.details.map(detail => `- ${detail.text.trim()}`)
  if (bodyLines.length === 0) {
    return header
  }
  return `${header}\n\n${bodyLines.join('\n')}`
}
