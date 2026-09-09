/**
 * Deterministic prompt/workflow quality heuristics.
 *
 * Ported from agentsview (MIT, Kenn Software) `internal/signals/heuristics.go`
 * (`AnalyzeHeuristics` and friends). The computation is pure: every signal is a
 * function of {@link HeuristicInput}, and the numeric constants and thresholds
 * match the Go source exactly (short prompt < 30 chars, stale assistant >
 * 30 min, jaccard >= 0.85, runaway window of 12 calls with >= 6 failures or
 * >= 3 failures + a dominant class >= 10, repeated exact failing run
 * threshold 5 / failure threshold 3, caps ratio >= 0.4 with min 3 words).
 *
 * @module @hy-sde-org/dsh-session-intelligence/engine/heuristics
 */

import { isFailure } from './toolhealth.ts'
import type {
  HeuristicInput,
  HeuristicMessage,
  HeuristicSignals,
  ToolCallRow,
} from './types.ts'

// ---------------------------------------------------------------------------
// Compiled patterns (mirror the Go `regexp.MustCompile` set)
// ---------------------------------------------------------------------------

/**
 * Fenced code block, dotall-style (Go `(?s)```.*?````). Global so
 * `replaceAll`-style semantics match Go's `ReplaceAllString`.
 */
const codeFenceRe = /```[\s\S]*?```/g

/** File-reference pattern (`(?i)` + the Go character classes verbatim). */
const fileRefRe =
  /(?:^|[\s"'`])(?:\.{0,2}\/)?[a-z0-9_.-]+(?:\/[a-z0-9_. -]+)+|[a-z0-9_.-]+\.(?:go|ts|tsx|js|jsx|py|rs|java|kt|rb|php|cs|cpp|c|h|hpp|sql|svelte|vue|css|scss|html|json|ya?ml|toml|md|sh|zsh|bash)/i

/** Line-leading bullet or numbered item (`(?m)^\s*(?:[-*+]|\d+\.)\s+\S+`). */
const bulletRe = /^\s*(?:[-*+]|\d+\.)\s+\S+/m

/** Hostile/frustrated language (`(?i)` alternation). */
const frustrationPhraseRe =
  /!{3,}|\?{3,}|\b(?:wtf|come on|why won't|this is broken|doesn't work|does not work|still broken|same error|you broke|fucking|fuck)\b/i

/** RFC3339 / RFC3339Nano shape accepted by `new Date`. */
const rfc3339Re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/** Space-separated variant accepted by the Go layouts ("2006-01-02 15:04:05..."). */
const spaceTimestampRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/** Control prompts that never count toward short-prompt or duplicate signals. */
const controlPrompts = new Set([
  'yes', 'y', 'no', 'n', 'ok', 'okay',
  'continue', 'go ahead', 'proceed',
  'do it', 'done', 'thanks', 'thank you',
  'please continue', 'keep going',
])

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute deterministic prompt/context/workflow quality signals. Pure; does
 * not call external services.
 * @param input - session messages and tool rows.
 * @returns the computed signal set.
 */
export function analyzeHeuristics(input: HeuristicInput): HeuristicSignals {
  const prompts = userPrompts(input.messages)
  const codeTask = isCodeTask(prompts)

  let shortPromptCount = 0
  let unstructuredStart = false
  let missingSuccessCriteriaCount = 0
  let missingVerificationCount = 0
  let noCodeContextCount = 0

  shortPromptCount = countShortStartPrompts(prompts)

  if (codeTask) {
    const first = firstSubstantivePrompt(prompts)
    if (first !== undefined) {
      unstructuredStart = isUnstructuredStart(first)
    }
    if (!hasSuccessCriteria(prompts)) {
      missingSuccessCriteriaCount = 1
    }
    if (!hasVerificationLanguage(prompts)) {
      missingVerificationCount = 1
    }
    if (!hasPromptContext(prompts) && !hasContextToolActivity(input.toolRows)) {
      noCodeContextCount = 1
    }
  }

  const duplicatePromptCount = countDuplicatePrompts(prompts)
  const runawayToolLoopCount = hasRunawayToolLoop(input.toolRows) ? 1 : 0

  return {
    shortPromptCount,
    unstructuredStart,
    missingSuccessCriteriaCount,
    missingVerificationCount,
    duplicatePromptCount,
    noCodeContextCount,
    runawayToolLoopCount,
  }
}

/**
 * Report whether a user prompt matches the reference Coach frustration rules:
 * repeated punctuation, high caps-word ratio, or direct hostile/frustrated
 * language. Fenced code is stripped first so pasted logs do not become tone
 * signals.
 * @param content - the raw user prompt text.
 * @returns whether the prompt reads as frustration.
 */
export function isFrustrationMarker(content: string): boolean {
  const normalized = normalizePrompt(content)
  if (normalized.length < 10) {
    return false
  }
  if (frustrationPhraseRe.test(normalized)) {
    return true
  }
  return capsWordRatio(content, 3) >= 0.4
}

/**
 * Count user prompts that indicate the session is going badly. This is an
 * analytics marker, not a standalone prompt-quality penalty.
 * @param msgs - all session messages.
 * @returns the number of qualifying user prompts.
 */
export function countFrustrationMarkers(msgs: readonly HeuristicMessage[]): number {
  let count = 0
  for (const message of msgs) {
    if (message.isSystem || message.role !== 'user') {
      continue
    }
    if (isFrustrationMarker(message.content)) {
      count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Prompt indexing
// ---------------------------------------------------------------------------

/** One user prompt's derived facts, mirroring the Go `promptInfo` struct. */
interface PromptInfo {
  readonly content: string
  readonly normalized: string
  readonly tokens: readonly string[]
  readonly index: number
  readonly ordinal: number
  readonly timestamp: string
  readonly hasPreviousAssistant: boolean
  readonly previousAssistantTimestamp: string
  readonly firstUserAfterLastAssistant: boolean
}

/** Reduce the message stream to non-control user prompts with context facts. */
function userPrompts(msgs: readonly HeuristicMessage[]): PromptInfo[] {
  const prompts: PromptInfo[] = []
  let previousAssistantTimestamp = ''
  let hasPreviousAssistant = false
  let userSinceLastAssistant = false
  for (const message of msgs) {
    if (message.isSystem) {
      continue
    }
    if (message.role === 'assistant') {
      previousAssistantTimestamp = message.timestamp
      hasPreviousAssistant = true
      userSinceLastAssistant = false
      continue
    }
    if (message.role !== 'user') {
      continue
    }
    const normalized = normalizePrompt(message.content)
    if (normalized === '') {
      continue
    }
    const firstAfterAssistant = !userSinceLastAssistant
    prompts.push({
      content: message.content,
      normalized,
      tokens: promptTokens(normalized),
      index: prompts.length,
      ordinal: message.ordinal,
      timestamp: message.timestamp,
      hasPreviousAssistant,
      previousAssistantTimestamp,
      firstUserAfterLastAssistant: firstAfterAssistant,
    })
    if (!isControlPrompt(normalized)) {
      userSinceLastAssistant = true
    }
  }
  return prompts
}

/** Count short start prompts: the first substantive one, plus steering after a stale assistant. */
function countShortStartPrompts(prompts: readonly PromptInfo[]): number {
  const first = firstSubstantivePrompt(prompts)
  if (first === undefined) {
    return 0
  }
  let count = 0
  for (const prompt of prompts) {
    if (!isShortPrompt(prompt)) {
      continue
    }
    if (prompt.index === first.index) {
      count++
      continue
    }
    if (prompt.firstUserAfterLastAssistant && hasStaleAssistantBefore(prompt)) {
      count++
    }
  }
  return count
}

function isShortPrompt(prompt: PromptInfo): boolean {
  return !isControlPrompt(prompt.normalized) &&
    prompt.normalized.length > 0 &&
    prompt.normalized.length < 30
}

function hasStaleAssistantBefore(prompt: PromptInfo): boolean {
  if (!prompt.hasPreviousAssistant) {
    return false
  }
  const userTime = parsePromptTime(prompt.timestamp)
  if (userTime === null) {
    return false
  }
  const assistantTime = parsePromptTime(prompt.previousAssistantTimestamp)
  if (assistantTime === null) {
    return false
  }
  return userTime - assistantTime > 30 * 60 * 1000
}

/**
 * Parse one of the layouts agentsview accepts (RFC3339/RFC3339Nano first,
 * then the space-separated variants), into epoch milliseconds.
 * @param raw - the raw timestamp string.
 * @returns epoch ms, or `null` when unparseable.
 */
function parsePromptTime(raw: string): number | null {
  if (raw === '') {
    return null
  }
  let text = raw
  if (spaceTimestampRe.test(text)) {
    text = text.replace(' ', 'T')
  }
  if (!rfc3339Re.test(text)) {
    return null
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime()
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/** Lowercase, trim, strip fenced code, and collapse internal whitespace runs. */
function normalizePrompt(content: string): string {
  let withoutCode = content
  if (content.includes('```')) {
    withoutCode = content.replace(codeFenceRe, ' ')
  }
  const lower = withoutCode.trim().toLowerCase()
  return collapseWhitespace(lower)
}

/** Collapse every whitespace run to a single space (Go `collapseWhitespace`). */
function collapseWhitespace(s: string): string {
  let out = ''
  let inSpace = false
  let wrote = false
  for (const codePoint of s) {
    if (isSpace(codePoint)) {
      if (wrote) {
        inSpace = true
      }
      continue
    }
    if (inSpace) {
      out += ' '
      inSpace = false
    }
    out += codePoint
    wrote = true
  }
  return out
}

function isSpace(ch: string): boolean {
  return /\s/u.test(ch)
}

/**
 * Tokenize a normalized prompt: split on anything that is not a letter,
 * digit, `_` or `-` (Go `FieldsFunc`), keeping tokens of length >= 3.
 */
function promptTokens(normalized: string): string[] {
  const parts = normalized.split(/[^\p{L}\p{N}_-]+/u).filter(part => part.length > 0)
  const tokens: string[] = []
  for (const part of parts) {
    if (part.length >= 3) {
      tokens.push(part)
    }
  }
  return tokens
}

/**
 * Ratio of fully-caps words (letters only, length >= 2) among all words,
 * after stripping fenced code. Returns 0 below the word minimum.
 */
function capsWordRatio(content: string, minWords: number): number {
  const withoutCode = content.replace(codeFenceRe, ' ')
  const words = withoutCode.split(/[^\p{L}]+/u).filter(word => word.length > 0)
  if (words.length < minWords) {
    return 0
  }
  let total = 0
  let caps = 0
  for (const word of words) {
    if ([...word].length < 2) {
      continue
    }
    total++
    const hasLower = /\p{Ll}/u.test(word)
    const hasUpper = /\p{Lu}/u.test(word)
    if (hasUpper && !hasLower) {
      caps++
    }
  }
  if (total < minWords) {
    return 0
  }
  return caps / total
}

function isControlPrompt(normalized: string): boolean {
  return controlPrompts.has(normalized)
}

function firstSubstantivePrompt(prompts: readonly PromptInfo[]): PromptInfo | undefined {
  return prompts.find(prompt => !isControlPrompt(prompt.normalized))
}

// ---------------------------------------------------------------------------
// Code-task classification
// ---------------------------------------------------------------------------

function isCodeTask(prompts: readonly PromptInfo[]): boolean {
  for (const prompt of prompts) {
    const text = prompt.normalized
    if (hasFileRef(prompt.content) && hasCodeAction(prompt.tokens)) {
      return true
    }
    if (hasCodeAction(prompt.tokens) && hasCodeObject(prompt.tokens)) {
      return true
    }
    if (text.includes('failing test') ||
      text.includes('stack trace') ||
      text.includes('build error') ||
      text.includes('compile error')) {
      return true
    }
  }
  return false
}

function hasCodeAction(tokens: readonly string[]): boolean {
  const phrases = [
    'implement', 'fix', 'debug', 'refactor', 'update',
    'change', 'add', 'remove', 'create', 'write',
    'test', 'lint', 'compile', 'build', 'wire',
  ]
  return containsAnyToken(tokens, phrases)
}

function hasCodeObject(tokens: readonly string[]): boolean {
  const phrases = [
    'code', 'codebase', 'repo', 'repository', 'app',
    'backend', 'frontend', 'api', 'endpoint', 'component',
    'function', 'class', 'module', 'package', 'schema',
    'migration', 'test', 'tests', 'bug', 'error',
  ]
  return containsAnyToken(tokens, phrases)
}

function containsAnyToken(tokens: readonly string[], words: readonly string[]): boolean {
  for (const word of words) {
    if (tokens.includes(word)) {
      return true
    }
  }
  return false
}

function isUnstructuredStart(prompt: PromptInfo): boolean {
  if (hasFileRef(prompt.content) || hasConstraintLanguage(prompt.tokens) ||
    hasSpecStructure(prompt.content, prompt.normalized)) {
    return false
  }
  return true
}

function hasConstraintLanguage(tokens: readonly string[]): boolean {
  const phrases = [
    'must', 'never', 'only', 'preserve', 'keep', 'avoid',
    'require', 'requires', 'constraint', 'constraints',
    'acceptance', 'criteria', 'success', 'expected',
    'output', 'format', 'verify', 'validation', 'test',
    'tests',
  ]
  return containsAnyToken(tokens, phrases)
}

function hasSpecStructure(content: string, normalized: string): boolean {
  if (content.includes('\n#') || bulletRe.test(content)) {
    return true
  }
  const phrases = [
    'acceptance criteria', 'success criteria', 'requirements',
    'steps', 'plan', 'scope', 'non-scope',
  ]
  for (const phrase of phrases) {
    if (normalized.includes(phrase)) {
      return true
    }
  }
  return false
}

function hasSuccessCriteria(prompts: readonly PromptInfo[]): boolean {
  for (const prompt of prompts) {
    const text = prompt.normalized
    for (const phrase of [
      'success', 'acceptance', 'expected', 'done when',
      'should result', 'output', 'criteria',
    ]) {
      if (text.includes(phrase)) {
        return true
      }
    }
  }
  return false
}

function hasVerificationLanguage(prompts: readonly PromptInfo[]): boolean {
  for (const prompt of prompts) {
    const text = prompt.normalized
    for (const phrase of [
      'test', 'tests', 'verify', 'verification',
      'validate', 'validation', 'check', 'reproduce',
      'proof', 'run',
    ]) {
      if (text.includes(phrase)) {
        return true
      }
    }
  }
  return false
}

function hasPromptContext(prompts: readonly PromptInfo[]): boolean {
  return prompts.some(prompt => hasFileRef(prompt.content))
}

function hasFileRef(content: string): boolean {
  return fileRefRe.test(content)
}

// ---------------------------------------------------------------------------
// Duplicate prompts
// ---------------------------------------------------------------------------

/**
 * Count repeated prompts: an exact normalized match, or a token-set jaccard
 * >= 0.85 against a previous prompt (excluding control prompts and prompts
 * shorter than 20 chars / 4 tokens), using the frequency posting index from
 * the Go implementation.
 */
function countDuplicatePrompts(prompts: readonly PromptInfo[]): number {
  const seenNormalized = new Set<string>()
  const seenTokenCounts: number[] = []
  const postings = new Map<string, { promptIndex: number; frequency: number }[]>()
  const overlaps: number[] = []
  let repeats = 0

  for (const prompt of prompts) {
    if (isControlPrompt(prompt.normalized) ||
      prompt.normalized.length < 20 || prompt.tokens.length < 4) {
      continue
    }
    if (seenNormalized.has(prompt.normalized)) {
      repeats++
      continue
    }

    const tokenFrequencies = new Map<string, number>()
    for (const token of prompt.tokens) {
      tokenFrequencies.set(token, (tokenFrequencies.get(token) ?? 0) + 1)
    }

    const touched: number[] = []
    for (const token of tokenFrequencies.keys()) {
      for (const posting of postings.get(token) ?? []) {
        // Go's `overlaps[i] == 0` uses the zero value; JS sparse arrays read
        // `undefined` on first touch, so normalize before comparing.
        if ((overlaps[posting.promptIndex] ?? 0) === 0) {
          touched.push(posting.promptIndex)
        }
        overlaps[posting.promptIndex] = (overlaps[posting.promptIndex] ?? 0) + posting.frequency
      }
    }

    let duplicate = false
    for (const promptIndex of touched) {
      // Every touched index was added by a posting, so both lookups are in
      // bounds; `!` marks that invariant for the checker.
      const previousTotal = seenTokenCounts[promptIndex]!
      const intersections = overlaps[promptIndex]!
      if (jaccardFromOverlap(tokenFrequencies.size, previousTotal, intersections) >= 0.85) {
        duplicate = true
        break
      }
    }
    for (const promptIndex of touched) {
      overlaps[promptIndex] = 0
    }
    if (duplicate) {
      repeats++
      continue
    }

    const promptIndex = seenTokenCounts.length
    seenNormalized.add(prompt.normalized)
    seenTokenCounts.push(prompt.tokens.length)
    for (const [token, frequency] of tokenFrequencies) {
      const list = postings.get(token) ?? []
      list.push({ promptIndex, frequency })
      postings.set(token, list)
    }
  }
  return repeats
}

/** Jaccard computed from current-unique / previous-total / overlap counts. */
function jaccardFromOverlap(currentUnique: number, previousTotal: number, intersections: number): number {
  if (currentUnique === 0 || previousTotal === 0) {
    return 0
  }
  const union = currentUnique + previousTotal - intersections
  if (union === 0) {
    return 0
  }
  return intersections / union
}

// ---------------------------------------------------------------------------
// Context-tool activity
// ---------------------------------------------------------------------------

function hasContextToolActivity(calls: readonly ToolCallRow[]): boolean {
  for (const call of calls) {
    switch (call.category) {
      case 'Read':
      case 'Grep':
      case 'Glob':
        return true
      case 'Bash':
        if (isContextCommand(commandText(call.inputJson))) {
          return true
        }
        break
      default:
        break
    }
  }
  return false
}

function isContextCommand(command: string): boolean {
  const fields = command.split(/\s+/).filter(field => field.length > 0)
  if (fields.length === 0) {
    return false
  }
  const name = fields[0]!
  if ([
    'rg', 'grep', 'git', 'ls', 'find', 'cat', 'sed',
    'awk', 'go', 'npm', 'pnpm', 'yarn', 'pytest',
    'cargo', 'make',
  ].includes(name)) {
    return true
  }
  return command.includes(' test') ||
    command.includes(' lint')
}

// ---------------------------------------------------------------------------
// Runaway tool loop
// ---------------------------------------------------------------------------

/** Mirrors the Go `toolLoopFact` struct. */
interface ToolLoopFact {
  readonly failure: boolean
  readonly exactSignature: string
  readonly commandClass: string
}

function hasRunawayToolLoop(calls: readonly ToolCallRow[]): boolean {
  if (calls.length < 12) {
    return false
  }
  const facts: ToolLoopFact[] = calls.map(call => ({
    failure: isFailure(call),
    exactSignature: toolSignature(call),
    commandClass: commandClass(call),
  }))
  if (hasRepeatedFailingExactToolRun(facts, 5, 3)) {
    return true
  }
  return hasRunawayToolWindow(facts)
}

function hasRepeatedFailingExactToolRun(
  facts: readonly ToolLoopFact[],
  threshold: number,
  failureThreshold: number,
): boolean {
  let run = 1
  let failures = facts[0] !== undefined && facts[0].failure ? 1 : 0
  for (let i = 1; i < facts.length; i++) {
    const current = facts[i]!
    const previous = facts[i - 1]!
    if (current.exactSignature === previous.exactSignature) {
      run++
      if (current.failure) {
        failures++
      }
      if (run >= threshold && failures >= failureThreshold) {
        return true
      }
    } else {
      run = 1
      failures = current.failure ? 1 : 0
    }
  }
  return false
}

function hasRunawayToolWindow(facts: readonly ToolLoopFact[]): boolean {
  const windowSize = 12
  let failures = 0
  const classCounts = new Map<string, number>()
  for (let i = 0; i < windowSize; i++) {
    const fact = facts[i]!
    if (fact.failure) {
      failures++
    }
    classCounts.set(fact.commandClass, (classCounts.get(fact.commandClass) ?? 0) + 1)
  }
  if (isRunawayToolWindow(failures, classCounts)) {
    return true
  }
  for (let start = 1; start + windowSize <= facts.length; start++) {
    const removed = facts[start - 1]!
    if (removed.failure) {
      failures--
    }
    const removedCount = classCounts.get(removed.commandClass) ?? 0
    if (removedCount === 1) {
      classCounts.delete(removed.commandClass)
    } else {
      classCounts.set(removed.commandClass, removedCount - 1)
    }
    const added = facts[start + windowSize - 1]!
    if (added.failure) {
      failures++
    }
    classCounts.set(added.commandClass, (classCounts.get(added.commandClass) ?? 0) + 1)
    if (isRunawayToolWindow(failures, classCounts)) {
      return true
    }
  }
  return false
}

function isRunawayToolWindow(failures: number, classCounts: ReadonlyMap<string, number>): boolean {
  if (failures >= 6) {
    return true
  }
  return failures >= 3 && dominantCount(classCounts) >= 10
}

function dominantCount(counts: ReadonlyMap<string, number>): number {
  let maxCount = 0
  for (const count of counts.values()) {
    if (count > maxCount) {
      maxCount = count
    }
  }
  return maxCount
}

function commandClass(call: ToolCallRow): string {
  if (call.category !== 'Bash') {
    return `${call.category}:${call.toolName}`
  }
  const fields = commandText(call.inputJson).split(/\s+/).filter(field => field.length > 0)
  if (fields.length === 0) {
    return `${call.category}:${call.toolName}`
  }
  return `${call.category}:${fields[0]}`
}

function toolSignature(call: ToolCallRow): string {
  return `${call.toolName}\0${call.category}\0${call.inputJson}`
}

/** Extract `command`/`cmd` from a tool's JSON arguments; unchanged on failure. */
function commandText(inputJson: string): string {
  let payload: unknown
  try {
    payload = JSON.parse(inputJson)
  } catch {
    return inputJson
  }
  if (typeof payload !== 'object' || payload === null) {
    return inputJson
  }
  const record = payload as Record<string, unknown>
  for (const key of ['command', 'cmd']) {
    const value = record[key]
    if (typeof value === 'string') {
      return value
    }
  }
  return inputJson
}

// Failure detection lives in `./toolhealth.ts` (`isFailure`), imported above —
// mirroring the Go package where `heuristics.go` calls `toolhealth.IsFailure`.
