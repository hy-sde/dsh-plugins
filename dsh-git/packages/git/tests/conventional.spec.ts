/**
 * Tests for the ported `conventional/` deterministic surface: the 22-type
 * vocabulary + alias coercion, summary/message validation rules (llm-git),
 * message normalization + formatting, and Unicode helpers.
 */

import { describe, expect, it } from 'vitest'
import {
  COMMIT_TYPE_ORDER,
  isCommitType,
  canonicalCommitType,
  coerceCommitType,
  coerceOptionalScope,
  formatTypesDescription,
  conventionalAnalysis,
  conventionalCommit,
} from '../src/conventional/commit-types.ts'
import {
  validateSummaryQuality,
  validateCommitMessage,
  presentToPast,
  repairSummaryTense,
  isPastTenseFirstWord,
} from '../src/conventional/validation.ts'
import {
  DEFAULT_CONVENTIONAL_CONFIG,
  formatConventionalCommit,
  postProcessCommitMessage,
  normalizeCommitUnicode,
  normalizeSummaryVerb,
  estimateCommitTokens,
} from '../src/conventional/normalization.ts'
import { codePointLength, sliceCodePoints } from '../src/conventional/text.ts'

const CONFIG = DEFAULT_CONVENTIONAL_CONFIG

describe('commit type vocabulary (22 types, llm-git order)', () => {
  it('lists the canonical 22 types in classification order', () => {
    expect(COMMIT_TYPE_ORDER).toEqual([
      'feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'style', 'perf', 'build', 'ci', 'revert',
      'deps', 'security', 'config', 'ux', 'release', 'hotfix', 'infra', 'init', 'merge', 'hack', 'wip',
    ])
    expect(COMMIT_TYPE_ORDER).toHaveLength(22)
  })

  it('isCommitType / canonicalCommitType resolve names and aliases', () => {
    expect(isCommitType('feat')).toBe(true)
    expect(isCommitType('bogus')).toBe(false)
    expect(canonicalCommitType('bug')).toBe('fix')
    expect(canonicalCommitType('enhancement')).toBe('feat')
    expect(canonicalCommitType('FEATURE')).toBe('feat')
    expect(canonicalCommitType('nope')).toBeUndefined()
  })

  it('coerceCommitType falls back to chore; coerceOptionalScope normalizes lossily', () => {
    expect(coerceCommitType('bogus')).toBe('chore')
    expect(coerceCommitType('security')).toBe('security')
    expect(coerceOptionalScope('UI / Core')).toBe('ui/core')
    expect(coerceOptionalScope(null)).toBeNull()
    expect(coerceOptionalScope('none')).toBeNull()
    expect(coerceOptionalScope('  ')).toBeNull()
  })

  it('formatTypesDescription renders the vocabulary incl. classifier hint', () => {
    const description = formatTypesDescription()
    expect(description).toContain('- feat:')
    expect(description).toContain('- fix:')
    expect(description).toContain('CRITICAL disambiguation rules')
  })

  it('conventionalAnalysis / conventionalCommit normalize raw model output', () => {
    const analysis = conventionalAnalysis({
      type: 'bugfix',
      scope: 'core',
      summary: 'fixed the crash',
      details: ['Handled empty input', { text: 'Added logger', user_visible: true, changelog_category: 'added' }],
      issueRefs: '#123',
    })
    expect(analysis.type).toBe('fix')
    expect(analysis.scope).toBe('core')
    expect(analysis.summary).toBe('fixed the crash')
    expect(analysis.details).toHaveLength(2)
    expect(analysis.issueRefs).toEqual(['#123'])
    expect(analysis.scope).toBe('core')
    expect(analysis.summary).toBe('fixed the crash')
    expect(analysis.details).toHaveLength(2)
    expect(analysis.issueRefs).toEqual(['#123'])

    const commit = conventionalCommit({ type: 'docs', scope: null, summary: 'update readme' })
    expect(commit.type).toBe('docs')
    expect(commit.scope).toBeNull()
    expect(() => conventionalCommit({ type: 'bogus', summary: 'x' })).toThrow(/Invalid commit type/)
  })
})

describe('validation (llm-git rules)', () => {
  it('validateSummaryQuality flags present-tense first word and empty summaries', () => {
    const past = validateSummaryQuality('Fixed the crash', 'fix')
    expect(past.ok).toBe(true)
    const present = validateSummaryQuality('fix the crash', 'fix')
    expect(present.ok).toBe(false)
    expect(present.errors.map(issue => issue.code)).toContain('present_tense_first_word')
    const empty = validateSummaryQuality('', 'fix')
    expect(empty.errors.map(issue => issue.code)).toContain('empty_summary')
  })

  it('validateSummaryQuality flags type-word repetition', () => {
    const report = validateSummaryQuality('Fixed things', 'fix')
    // "Fixed" is not a repetition of "fix"; but the repetition check fires
    // when the first word equals the type.
    expect(report.ok).toBe(true)
    const repeated = validateSummaryQuality('fix things', 'fix')
    expect(repeated.ok).toBe(false)
    expect(repeated.errors.map(issue => issue.code)).toContain('type_word_repetition')
  })

  it('validateCommitMessage checks type validity, length limits, trailing period, scope', () => {
    const good = validateCommitMessage(
      { type: 'feat', scope: null, summary: 'Added paging to list view', body: [], footers: [] },
      CONFIG,
    )
    expect(good.ok).toBe(true)

    const invalidType = validateCommitMessage(
      { type: 'bogus', scope: null, summary: 'Added x', body: [], footers: [] } as unknown as Parameters<typeof validateCommitMessage>[0],
      CONFIG,
    )
    expect(invalidType.errors.map(issue => issue.code)).toContain('invalid_type')

    const trailingPeriod = validateCommitMessage(
      { type: 'feat', scope: null, summary: 'Add paging.', body: [], footers: [] },
      CONFIG,
    )
    expect(trailingPeriod.errors.map(issue => issue.code)).toContain('trailing_period')

    const tooLong = validateCommitMessage(
      { type: 'feat', scope: null, summary: 'A'.repeat(120), body: [], footers: [] },
      CONFIG,
    )
    expect(tooLong.errors.map(issue => issue.code)).toContain('summary_too_long')

    const projectScope = validateCommitMessage(
      { type: 'feat', scope: 'My_Project', summary: 'Add x', body: [], footers: [] },
      CONFIG,
      { projectNames: ['my-project'] },
    )
    expect(projectScope.errors.map(issue => issue.code)).toContain('project_name_scope')
  })

  it('repairSummaryTense / presentToPast / isPastTenseFirstWord mirror the tables', () => {
    expect(presentToPast('add')).toBe('added')
    expect(repairSummaryTense('add pagination')).toBe('added pagination')
    expect(repairSummaryTense('Added x')).toBeNull()
    expect(isPastTenseFirstWord('added')).toBe(true)
    expect(isPastTenseFirstWord('Add')).toBe(false)
  })
})

describe('normalization + formatting', () => {
  it('formatConventionalCommit renders header, body bullets, footers', () => {
    const text = formatConventionalCommit({
      type: 'feat',
      scope: 'parser',
      summary: 'Add streaming parse',
      body: ['Handles large inputs.', 'Keeps memory bounded.'],
      footers: ['Refs: #42'],
    })
    expect(text).toBe('feat(parser): Add streaming parse\n\n- Handles large inputs.\n- Keeps memory bounded.\n\nRefs: #42')
  })

  it('postProcessCommitMessage normalizes summary verb tense and body bullets', () => {
    const message = postProcessCommitMessage(
      { type: 'fix', scope: null, summary: 'Fix the crash', body: ['*handles empty input', 'add test coverage'], footers: [] },
      CONFIG,
    )
    expect(message.summary).toBe('fixed the crash')
    expect(message.body).toEqual(['Handles empty input.', 'Add test coverage.'])
  })

  it('normalizeSummaryVerb repairs re-prefixed and s-suffixed verbs', () => {
    expect(normalizeSummaryVerb('rebuild the cache', 'chore')).toMatch(/^rebuilt/)
    expect(normalizeSummaryVerb('Refactors the parser', 'refactor')).toBe('restructured the parser')
  })

  it('normalizeCommitUnicode collapses smart quotes/fractions and estimateCommitTokens uses 4-byte rule', () => {
    expect(normalizeCommitUnicode('Split “fast” ½→¼')).toBe('Split "fast" 1/2->1/4')
    expect(estimateCommitTokens('hello world')).toBe(3)
  })
})

describe('text helpers', () => {
  it('codePointLength counts scalar values, not UTF-16 units', () => {
    expect(codePointLength('abc')).toBe(3)
    expect(codePointLength('a😀b')).toBe(3)
  })

  it('sliceCodePoints slices by scalar offsets', () => {
    expect(sliceCodePoints('a😀bc', 1, 3)).toBe('😀b')
    expect(sliceCodePoints('abc', 1)).toBe('bc')
  })
})
