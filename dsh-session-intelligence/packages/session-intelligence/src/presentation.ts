/**
 * Markdown report rendering for one or many {@link SessionSignals}.
 *
 * @module @hy-sde-org/dsh-session-intelligence/presentation
 */

import type { SessionSignals } from './adapter/dsh.ts'
import type { ToolFrequencyReport } from './insights/analyze.ts'

/**
 * Render one session's full health report as compact markdown.
 * @param signals - the analyzed session signals.
 * @returns the printable report text.
 */
export function formatSessionHealth(signals: SessionSignals): string {
  const lines: string[] = []
  lines.push(`Session health for ${signals.sessionId}`)
  lines.push(
    `Span: ${dateTime(signals.startedAt)} → ${dateTime(signals.endedAt)} · `
    + `${signals.messageCount} messages · ${signals.model || 'model unknown'}`,
  )
  lines.push('')
  lines.push(
    `Outcome: ${signals.outcome.outcome} (${signals.outcome.confidence} confidence)`
    + `${signals.outcome.isRecent ? ' · still active' : ''}`,
  )
  const score = signals.score.score
  lines.push(
    score === null
      ? 'Health: not scored (unknown/low outcome and no supporting signals)'
      : `Health: ${signals.score.grade} (${score}/100) · basis: ${signals.score.basis.join(', ') || 'none'}`,
  )
  const penalties = Object.entries(signals.score.penalties)
  if (penalties.length > 0) {
    lines.push('Penalties: ' + penalties.map(([name, value]) => `${name}=${value}`).join(', '))
  }
  lines.push('')
  lines.push(
    `Tool health: ${signals.toolHealth.failureSignalCount} failures · `
    + `${signals.toolHealth.retryCount} retries · ${signals.toolHealth.editChurnCount} edit-churn events · `
    + `consecutive-failure max ${signals.toolHealth.consecutiveFailureMax}`,
  )
  lines.push(
    `Heuristics: ${signals.heuristics.shortPromptCount} short prompts`
    + (signals.heuristics.unstructuredStart ? ' · unstructured start' : '')
    + (signals.heuristics.missingSuccessCriteriaCount > 0 ? ' · missing success criteria' : '')
    + (signals.heuristics.missingVerificationCount > 0 ? ' · missing verification' : '')
    + ` · ${signals.heuristics.duplicatePromptCount} duplicate prompts`
    + (signals.heuristics.noCodeContextCount > 0 ? ' · no code context' : '')
    + (signals.heuristics.runawayToolLoopCount > 0 ? ' · runaway tool loop' : ''),
  )
  lines.push(
    `Context: ${signals.compactionCount} compactions · `
    + `${signals.midTaskCompactionCount} mid-task · peak ${count(signals.peakContextTokens)} tokens`
    + (signals.pressureMax === null ? '' : ` · pressure ${(signals.pressureMax * 100).toFixed(0)}%`),
  )
  lines.push(`Final failure streak: ${signals.finalFailureStreak}`)
  return lines.join('\n')
}

/**
 * Render a health table for many sessions, most-recent first.
 * @param signals - analyzed sessions (any order; sorted by start desc).
 * @param options - optional unreadable-session count.
 * @returns the printable report text.
 */
export function formatRecentHealth(
  signals: readonly SessionSignals[],
  options: { readonly unreadable?: number } = {},
): string {
  const lines: string[] = []
  lines.push(`Session health across ${signals.length} session(s)`)
  if (options.unreadable !== undefined && options.unreadable > 0) {
    lines.push(`(${count(options.unreadable)} unreadable session(s) skipped)`)
  }
  lines.push('')
  if (signals.length === 0) {
    lines.push('No readable sessions found.')
    return lines.join('\n')
  }
  lines.push('| Session | Started | Outcome | Grade | Score | Failures | Retries | Churn | Compact | Mid-task | Short | Dup | Loop |')
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  const sorted = [...signals].sort((a, b) => b.startedAt - a.startedAt)
  for (const s of sorted) {
    lines.push(
      `| ${shortId(s.sessionId)} | ${dateOnly(s.startedAt)} | ${s.outcome.outcome} | ${s.score.grade || '-'}`
      + ` | ${s.score.score ?? '-'} | ${count(s.toolHealth.failureSignalCount)} | ${count(s.toolHealth.retryCount)}`
      + ` | ${count(s.toolHealth.editChurnCount)} | ${count(s.compactionCount)} | ${count(s.midTaskCompactionCount)}`
      + ` | ${count(s.heuristics.shortPromptCount)} | ${count(s.heuristics.duplicatePromptCount)}`
      + ` | ${s.heuristics.runawayToolLoopCount > 0 ? 'yes' : '-'} |`,
    )
  }
  lines.push('')
  lines.push('Use action "session" with a session id for the full report (basis, penalties, tool-health details).')
  return lines.join('\n')
}

/**
 * Render the recent-edits feed: one row per file, most-recent edit first.
 * @param files - grouped files (already sorted newest-first).
 * @param options - optional skip count and path filter echo.
 * @returns the printable report text.
 */
export function formatRecentEdits(
  files: readonly import('./recentedits.ts').RecentEditFile[],
  options: { readonly limit?: number; readonly path?: string } = {},
): string {
  const lines: string[] = []
  const scope = options.path === undefined ? 'all files' : `files matching "${options.path}"`
  lines.push(`Recent edits across ${files.length} file(s) (${scope})`)
  lines.push('')
  if (files.length === 0) {
    lines.push('No Edit/Write calls with a resolvable file path found.')
    return lines.join('\n')
  }
  lines.push('| File | Last edited | Edits | Last session |')
  lines.push('| --- | --- | ---: | --- |')
  const selected = options.limit === undefined ? files : files.slice(0, options.limit)
  for (const file of selected) {
    lines.push(
      `| ${file.filePath} | ${dateTime(file.lastEditedAt)} | ${count(file.editCount)} | ${shortId(file.lastSessionId)} |`,
    )
  }
  const inlined = selected.some(f => f.edits.length > 1)
  if (inlined) {
    lines.push('')
    lines.push('Per-file recent edits (newest first):')
    for (const file of selected) {
      if (file.edits.length <= 1) continue
      for (const edit of file.edits) {
        lines.push(
          `- ${file.filePath} @ ${dateTime(edit.timestamp)} — ${edit.category} (${edit.toolName}) `
          + `in ${shortId(edit.sessionId)}`,
        )
      }
    }
  }
  return lines.join('\n')
}

const numberFormat = new Intl.NumberFormat('en-US')

function count(value: number): string {
  return numberFormat.format(value)
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 13)}…` : id
}

function dateOnly(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function dateTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

/* ------------------------------------------------------------------ */
/* Tool-frequency report (merged from dsh-tool-session-insights)       */
/* ------------------------------------------------------------------ */

interface FormatFrequencyOptions {
  /** Return only the top N tools (rows beyond the cap are omitted). */
  readonly top?: number
}

/**
 * Render a tool-frequency report as a compact markdown table sorted by call
 * count descending, plus a two-line insight summary.
 * @param report - the aggregator output.
 * @param options - optional top-N cap.
 * @returns the printable report text.
 */
export function formatToolFrequency(report: ToolFrequencyReport, options: FormatFrequencyOptions = {}): string {
  const lines: string[] = []
  lines.push(`Tool call frequency for ${report.workspace}`)
  const sessionSummary = report.sessionsAnalyzed === 0
    ? 'sessions analyzed: 0'
    : `sessions analyzed: ${count(report.sessionsAnalyzed)}`
  const failures = report.sessionReadFailures > 0
    ? ` (${count(report.sessionReadFailures)} unreadable)`
    : ''
  lines.push(
    `${sessionSummary}${failures} · tool calls: ${count(report.toolCalls)}`
    + ` · tool results: ${count(report.toolResults)} · distinct tools: ${count(report.distinctTools)}`,
  )
  if (report.callsStart !== null && report.callsEnd !== null) {
    lines.push(`Window: ${dateOnly(report.callsStart)} → ${dateOnly(report.callsEnd)} (UTC)`)
  } else {
    lines.push('Window: no tool calls found')
  }
  lines.push('')

  if (report.toolCalls === 0) {
    lines.push('No tool calls found in the analyzed sessions.')
  } else {
    const visible = options.top !== undefined ? report.rows.slice(0, options.top) : report.rows
    lines.push(
      '| Rank | Tool | Command | Category | Calls | % of calls | Sessions | Errors | % of calls by errors |',
    )
    lines.push('| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |')
    visible.forEach((row, index) => {
      const errorShare = row.errors === 0
        ? '0.0%'
        : `${((row.errors / report.toolCalls) * 100).toFixed(1)}%`
      lines.push(
        `| ${index + 1} | ${row.tool} | ${row.command ?? '—'} | ${row.category} | ${count(row.calls)}`
        + ` | ${percent(row.calls, report.toolCalls)}`
        + ` | ${count(row.sessions)} | ${count(row.errors)} | ${errorShare} |`,
      )
    })
    if (options.top !== undefined && options.top < report.rows.length) {
      lines.push('')
      lines.push(`... and ${count(report.rows.length - options.top)} more tools (omit top for the full ranking).`)
    }
    lines.push('')
    lines.push(insightLines(report))
  }

  if (report.inheritedToolCallsSkipped > 0) {
    lines.push('')
    lines.push(
      `Note: ${count(report.inheritedToolCallsSkipped)} inherited (parent-session) tool calls were skipped `
      + 'so subagent children are not double-counted.',
    )
  }
  return lines.join('\n')
}

/** One or two insight lines: tool concentration and error hot spots. */
function insightLines(report: ToolFrequencyReport): string {
  const parts: string[] = []
  // Command rows overlap (one bash call runs several commands), so the
  // concentration metric uses the per-tool CALL counts from the analyzer:
  // they sum to toolCalls and never double-count a call.
  const topTools = report.toolCallsByTool.slice(0, 5)
  if (topTools.length > 1) {
    const share = topTools.reduce((sum, entry) => sum + entry.calls, 0) / report.toolCalls * 100
    parts.push(`top ${topTools.length} tools = ${share.toFixed(1)}% of all calls`)
  }
  const errorRows = report.rows.filter(row => row.errors > 0).sort((a, b) => b.errors - a.errors)
  if (errorRows.length > 0) {
    const worst = errorRows[0] as ToolFrequencyReport['rows'][number]
    parts.push(`${worst.tool} shows the most errors (${count(worst.errors)} of ${count(report.toolResults)} results)`)
  }
  return `Insight: ${parts.join('; ') || 'no meaningful cross-tool pattern yet'}.`
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '0.0%'
  return `${((part / whole) * 100).toFixed(1)}%`
}
