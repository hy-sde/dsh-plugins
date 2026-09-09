/**
 * Fork-native repository-run lifecycle for the ported OpenWiki engine.
 *
 * This is the deterministic orchestrator that drives one resumable wiki run
 * through its five stages — begin, submit_plan, next_page, submit_page,
 * finish — using the ported openwiki modules (run-state, page-manifest,
 * page-jobs, Claims runtime, OKF finalizer) behind the in-fork {@link WikiFs}
 * seam. It replaces openwiki's DeepAgents-coupled `repository-run.ts` with the
 * same on-disk formats (`.run.json`, `.page-manifest.json`, `.claims/`
 * sidecars, OKF front matter) so repositories are interoperable with both
 * engines.
 * @module @hy-sde-org/dsh-openwiki/generation
 */

import { randomUUID } from 'node:crypto'
import { OpenWikiIgnore } from '../agent/openwiki-ignore.ts'
import type { RunContext } from '../agent/types.ts'
import {
  createOpenWikiContentSnapshot,
  createRepositorySourceSnapshot,
  createRunContext,
  getRepositoryChangedPaths,
  getUpdateNoopStatus,
  persistRunMetadataIfChanged,
  type UpdateNoopStatus,
  writeLastUpdateMetadata,
} from '../agent/utils.ts'
import {
  deserializePreparedWikiState,
  finalizeWikiArtifacts,
  prepareWikiForAuthoring,
  serializePreparedWikiState,
  type PreparedWikiState,
} from '../agent/wiki-finalizer.ts'
import { beginRepositoryWikiReplacement } from '../agent/wiki-replacement.ts'
import { ensureCodeModeRepoSetup } from '../agent/code-mode.ts'
import {
  prepareClaimsRuntime,
  type ClaimsRuntime,
} from '../claims/brains/code/runtime.ts'
import { ClaimsStore } from '../claims/brains/code/store.ts'
import type {
  GroundingIssue,
  InspectedClaim,
  PageClaims,
} from '../claims/brains/code/types.ts'
import type { WikiFs } from '../fs/wiki-fs.ts'
import { createNodeWikiFs } from '../fs/wiki-fs.ts'
import {
  parseFrontmatterFields,
  repairPersistedFile,
} from '../okf/frontmatter.ts'
import {
  resolveConceptTypeLabel,
  resolveIndexLabels,
} from '../okf/index-labels.ts'
import {
  getPrimaryLanguageSubtag,
  requireResolvedLanguage,
  resolveLanguage,
} from '../platform/language.ts'
import { isFileNotFoundError } from '../platform/fs-errors.ts'
import { RepositoryRunError } from './errors.ts'
import {
  getCurrentRepositoryPageCompletion,
  readRepositoryPageManifest,
  recordRepositoryPageCompletion,
  replaceRepositoryPageManifest,
  seedRepositoryPageManifest,
  type RepositorySourceCheckpoint,
} from './page-manifest.ts'
import {
  createRepositoryPlan,
  replacePageClaims,
  type ProposedPageClaim,
  type ProposedRepositoryPlan,
} from './page-jobs.ts'
import {
  readRepositoryRunState,
  removeRepositoryRunState,
  writeRepositoryRunState,
  type PageJob,
  type RepositoryRunActor,
  type RepositoryRunMode,
  type RepositoryRunState,
} from './run-state.ts'

/**
 * Inputs required to start or resume one repository-generation run.
 */
export interface BeginRepositoryRunInput {
  /** Absolute Git repository root for the run. */
  root: string

  /** Repository generation command to start or resume. */
  mode: RepositoryRunMode

  /** Requested documentation language, resolved before persistence. */
  language?: string

  /** Whether update no-op detection must be bypassed. */
  force?: boolean

  /** Actual user and connector context supplied to planning. */
  planningContext?: string

  /** Producer and metadata identities for the current session. */
  actor: RepositoryRunActor

  /** Optional deterministic clock used by production metadata and tests. */
  now?: () => Date
}

/**
 * Process-local runtime rebuilt from one durable repository checkpoint.
 */
export interface ActiveRepositoryRun {
  /** Absolute Git repository root owned by the run. */
  root: string
  /** Current authoritative state, replaced only after persistence succeeds. */
  state: RepositoryRunState
  /** In-fork filesystem seam used by code-owned lifecycle operations. */
  backend: WikiFs
  /** Ignore boundary loaded for source and evidence access. */
  ignore: OpenWikiIgnore
  /** Strict process-local Claims runtime rebuilt from durable state. */
  claimsRuntime: ClaimsRuntime
}

/**
 * Pages sharing one committed source baseline and changed-path window.
 */
export interface RepositoryPageUpdateWindow {
  baseGitHead?: string
  pages: string[]
  changedPaths: string[]
  fullReview: boolean
}

/** Page-local durable state captured before a bounded worker starts. */
export interface RepositoryPageSnapshot {
  jobId: string
  path: string
  markdown: string | null
  claims: PageClaims | null
}

/**
 * Host/model-facing view of an active planning or generation run.
 */
export interface ActiveBeginView {
  status: 'active'
  runId: string
  root: string
  mode: RepositoryRunMode
  language: string
  languageChanged: boolean
  phase: 'planning' | 'generating'
  resumed: boolean
  lastUpdate: RunContext['lastUpdate']
  wikiGoal?: string
  changedPaths: string[]
  pageUpdateWindows: RepositoryPageUpdateWindow[]
  claimIssues: readonly GroundingIssue[]
  completedPages: number
  totalPages?: number
}

/** Clean update result produced only after strict Claims preflight. */
export interface NoopBeginView {
  status: 'noop'
  root: string
  mode: 'update'
  language: string
  updatePreflight: Extract<UpdateNoopStatus, { shouldSkip: true }>
}

export type BeginRepositoryRunResult =
  | { view: ActiveBeginView; run: ActiveRepositoryRun }
  | { view: NoopBeginView }

/**
 * Projects the active run's immutable source identity into page coverage.
 */
export function getRepositoryRunSourceCheckpoint(
  state: RepositoryRunState,
): RepositorySourceCheckpoint {
  return {
    sourceFingerprint: state.sourceFingerprint,
    ...(state.targetGitHead ? { gitHead: state.targetGitHead } : {}),
  }
}

/**
 * Starts a fresh durable run or reconstructs an interrupted run.
 */
export async function beginRepositoryRun(
  input: BeginRepositoryRunInput,
): Promise<BeginRepositoryRunResult> {
  const now = input.now ?? (() => new Date())
  // Reject an unrecognized language before touching the repository.
  const resolvedRequest = resolveLanguage(input.language)
  if (resolvedRequest.kind === 'unrecognized') {
    throw new RepositoryRunError('invalid_input', resolvedRequest.message)
  }
  const requestedLanguage =
    resolvedRequest.kind === 'resolved' ? resolvedRequest.language : undefined

  await ensureCodeModeRepoSetup(input.root, {
    seedInstructions: input.mode === 'init',
  })

  const persisted = await readRepositoryRunState(input.root)
  if (persisted) {
    return resumeRepositoryRun(input, persisted)
  }

  const context = await createRunContext(input.root, 'repository', input.language)
  const language = context.language ?? 'en'
  const languageChanged =
    requestedLanguage !== undefined &&
    getPrimaryLanguageSubtag(requestedLanguage) !==
      getPrimaryLanguageSubtag(context.lastUpdate?.language)
  const ignore = await OpenWikiIgnore.load(input.root)

  const replacement =
    input.mode === 'init'
      ? await beginRepositoryWikiReplacement(input.root)
      : undefined
  let runStateWritten = false
  let replacementCommitted = false

  try {
    const backend = createRepositoryBackend(input.root)
    const claimsRuntime = await prepareClaimsRuntime(
      input.mode,
      'repository',
      input.root,
      ignore,
      () => undefined,
      { resumeInit: false },
    )
    if (!claimsRuntime) {
      throw new Error('Repository Claims runtime was not prepared.')
    }

    const claimsStore = new ClaimsStore(input.root)
    const initialPages = await claimsStore.discoverPages()
    const source = await createRepositorySourceSnapshot(input.root, ignore)
    if (
      input.mode === 'update' &&
      context.lastUpdate?.gitHead &&
      context.lastUpdate.status === 'complete'
    ) {
      await seedRepositoryPageManifest(
        input.root,
        initialPages,
        context.lastUpdate.gitHead,
      )
    }
    if (input.mode === 'update') {
      await fastForwardUnchangedRepositoryPageCoverage(
        input.root,
        ignore,
        initialPages,
        {
          sourceFingerprint: source.fingerprint,
          ...(source.gitHead ? { gitHead: source.gitHead } : {}),
        },
      )
    }
    const seededManifest =
      input.mode === 'update'
        ? await readRepositoryPageManifest(input.root)
        : undefined
    const hasCompleteBaselineCoverage =
      input.mode !== 'update' ||
      initialPages.every(page => seededManifest?.pages[page] !== undefined)

    // Claims validation precedes update no-op detection.
    if (input.mode === 'update' && input.force !== true) {
      const preflight = await getUpdateNoopStatus(
        input.root,
        ignore,
        input.language,
      )
      if (
        preflight.shouldSkip &&
        claimsRuntime.issueCount === 0 &&
        hasCompleteBaselineCoverage
      ) {
        const source = await createRepositorySourceSnapshot(input.root, ignore)
        await claimsRuntime.finalize(now().toISOString())
        const stableSource = await createRepositorySourceSnapshot(
          input.root,
          ignore,
        )
        if (stableSource.fingerprint === source.fingerprint) {
          await replaceRepositoryPageManifest(input.root, initialPages, {
            sourceFingerprint: source.fingerprint,
            ...(source.gitHead ? { gitHead: source.gitHead } : {}),
          })
          const publishedSource = await createRepositorySourceSnapshot(
            input.root,
            ignore,
          )
          if (publishedSource.fingerprint === source.fingerprint) {
            await writeLastUpdateMetadata(
              'update',
              input.root,
              preflight.model,
              'repository',
              'complete',
              preflight.language,
            )
            return {
              view: {
                status: 'noop',
                root: input.root,
                mode: 'update',
                language,
                updatePreflight: preflight,
              },
            }
          }
        }
      }
    }

    const beforeContentSnapshot = await createOpenWikiContentSnapshot(
      input.root,
      'repository',
    )
    const preparedWiki: PreparedWikiState = await prepareWikiForAuthoring({
      backend,
      outputMode: 'repository',
      conceptType: resolveConceptTypeLabel(language),
    })
    const requiredRewritePages =
      input.mode === 'update' && languageChanged ? initialPages : []

    const state: RepositoryRunState = {
      schemaVersion: 1,
      runId: randomUUID(),
      mode: input.mode,
      phase: 'planning',
      startedAt: now().toISOString(),
      language,
      languageChanged,
      requiredRewritePages,
      initialPages,
      sourceFingerprint: source.fingerprint,
      ...(source.gitHead ? { targetGitHead: source.gitHead } : {}),
      ...(input.planningContext
        ? { planningContext: input.planningContext }
        : {}),
      actor: { ...input.actor },
      previousLastUpdate: context.lastUpdate,
      ...(context.lastUpdate?.gitHead
        ? { baseGitHead: context.lastUpdate.gitHead }
        : {}),
      ...(context.wikiGoal ? { wikiGoal: context.wikiGoal } : {}),
      beforeContentSnapshot,
      preparedWiki: serializePreparedWikiState(preparedWiki),
    }

    // This is the durability point.
    await writeRepositoryRunState(input.root, state)
    runStateWritten = true
    await writeLastUpdateMetadata(
      input.mode,
      input.root,
      input.actor.metadataModel,
      'repository',
      'interrupted',
      language,
      context.lastUpdate?.gitHead ?? null,
    )

    if (replacement) {
      await replacement.commit()
      replacementCommitted = true
    }

    const run: ActiveRepositoryRun = {
      root: input.root,
      state,
      backend,
      ignore,
      claimsRuntime,
    }
    return {
      run,
      view: await toActiveBeginView(run, false),
    }
  } catch (error) {
    if (replacement && !replacementCommitted) {
      if (runStateWritten) {
        await removeRepositoryRunState(input.root)
      }
      await replacement.rollback()
    }
    throw error
  }
}

/**
 * Reconstructs a durable run and invalidates its complete plan on source drift.
 */
async function resumeRepositoryRun(
  input: BeginRepositoryRunInput,
  state: RepositoryRunState,
): Promise<BeginRepositoryRunResult> {
  let activeState = state
  if (state.mode !== input.mode) {
    throw new RepositoryRunError(
      'conflict',
      `An interrupted OpenWiki ${state.mode} run already exists. Resume that run before starting ${input.mode}.`,
    )
  }

  const requestedLanguage = requireResolvedLanguage(input.language)
  if (requestedLanguage && requestedLanguage !== state.language) {
    throw new RepositoryRunError(
      'conflict',
      `Interrupted OpenWiki run uses ${state.language}; resume it before changing the wiki language to ${requestedLanguage}.`,
    )
  }

  const ignore = await OpenWikiIgnore.load(input.root)
  const currentSource = await createRepositorySourceSnapshot(input.root, ignore)
  const sourceChanged = currentSource.fingerprint !== state.sourceFingerprint
  const resetSkippedPages =
    state.plan?.pages.some(({ status }) => status === 'skipped') ?? false
  let nextState: RepositoryRunState = {
    ...state,
    actor: { ...input.actor },
    ...(state.plan && resetSkippedPages
      ? {
        plan: {
          ...state.plan,
          pages: state.plan.pages.map(page =>
            page.status === 'skipped'
              ? { ...page, status: 'pending' as const }
              : page,
          ),
        },
      }
      : {}),
  }
  if (sourceChanged) {
    nextState.phase = 'planning'
    nextState.sourceFingerprint = currentSource.fingerprint
    if (currentSource.gitHead) {
      nextState.targetGitHead = currentSource.gitHead
    } else {
      delete nextState.targetGitHead
    }
    delete nextState.plan
  } else {
    if (!nextState.targetGitHead && currentSource.gitHead) {
      nextState.targetGitHead = currentSource.gitHead
    }
    nextState = await reconcileManifestPageJobs(
      input.root,
      nextState,
      state.actor.producerActor,
    )
  }
  if (!nextState.plan && input.planningContext) {
    nextState.planningContext = input.planningContext
  }
  if (JSON.stringify(nextState) !== JSON.stringify(state)) {
    await writeRepositoryRunState(input.root, nextState)
    activeState = nextState
  }

  const backend = createRepositoryBackend(input.root)
  const claimsRuntime = await prepareClaimsRuntime(
    activeState.mode,
    'repository',
    input.root,
    ignore,
    () => undefined,
    { resumeInit: activeState.mode === 'init' },
  )
  if (!claimsRuntime) {
    throw new Error('Repository Claims runtime was not prepared.')
  }

  const run: ActiveRepositoryRun = {
    root: input.root,
    state: activeState,
    backend,
    ignore,
    claimsRuntime,
  }
  return {
    run,
    view: await toActiveBeginView(run, true),
  }
}

/**
 * Reconciles the transient queue with authoritative completed-page coverage.
 */
async function reconcileManifestPageJobs(
  root: string,
  state: RepositoryRunState,
  legacyCompletedBy: string,
): Promise<RepositoryRunState> {
  if (!state.plan) return state
  const source = getRepositoryRunSourceCheckpoint(state)
  let changed = false
  const pages: PageJob[] = []
  for (const page of state.plan.pages) {
    let current = await getCurrentRepositoryPageCompletion(
      root,
      page.path,
      source,
    )
    if (page.status === 'complete' && !current) {
      current = await recordRepositoryPageCompletion(
        root,
        page.path,
        source,
        page.completedBy ?? legacyCompletedBy,
        state.runId,
      )
    }
    if (
      page.status === 'complete' &&
      current &&
      (!current.completedBy || current.completedRunId !== state.runId)
    ) {
      current = await recordRepositoryPageCompletion(
        root,
        page.path,
        source,
        page.completedBy ?? legacyCompletedBy,
        state.runId,
      )
    }
    if (page.status === 'pending' && current?.completedRunId === state.runId) {
      pages.push({
        ...page,
        status: 'complete' as const,
        completedBy: current.completedBy ?? legacyCompletedBy,
      })
      changed = true
    } else if (page.status === 'complete' && !page.completedBy) {
      pages.push({
        ...page,
        completedBy: current?.completedBy ?? legacyCompletedBy,
      })
      changed = true
    } else {
      pages.push(page)
    }
  }
  if (!changed) return state
  return { ...state, plan: { ...state.plan, pages } }
}

/**
 * Creates the in-fork filesystem backend for code-owned repository work.
 */
function createRepositoryBackend(root: string): WikiFs {
  return createNodeWikiFs({ root })
}

/**
 * Projects process-local run state into the model-facing begin response.
 */
async function toActiveBeginView(
  run: ActiveRepositoryRun,
  resumed: boolean,
): Promise<ActiveBeginView> {
  const pages = run.state.plan?.pages ?? []
  const pageUpdateWindows =
    run.state.mode === 'update'
      ? await getRepositoryPageUpdateWindows(
        run.root,
        run.ignore,
        run.state.initialPages,
      )
      : []
  const changedPaths = [
    ...new Set(pageUpdateWindows.flatMap(window => window.changedPaths)),
  ].sort(compareCodeUnits)
  return {
    status: 'active',
    runId: run.state.runId,
    root: run.root,
    mode: run.state.mode,
    language: run.state.language,
    languageChanged: run.state.languageChanged,
    phase: run.state.phase,
    resumed,
    lastUpdate: run.state.previousLastUpdate,
    ...(run.state.wikiGoal ? { wikiGoal: run.state.wikiGoal } : {}),
    changedPaths,
    pageUpdateWindows,
    claimIssues: run.claimsRuntime.issues,
    completedPages: pages.filter(({ status }) => status === 'complete').length,
    ...(run.state.plan ? { totalPages: pages.length } : {}),
  }
}

/**
 * Groups existing pages by their committed Git baseline for update planning.
 */
async function getRepositoryPageUpdateWindows(
  root: string,
  ignore: OpenWikiIgnore,
  pages: readonly string[],
): Promise<RepositoryPageUpdateWindow[]> {
  const manifest = await readRepositoryPageManifest(root)
  const pagesByBaseline = new Map<string, string[]>()
  for (const page of pages) {
    const baseline = manifest.pages[page]?.gitHead ?? ''
    const group = pagesByBaseline.get(baseline) ?? []
    group.push(page)
    pagesByBaseline.set(baseline, group)
  }

  const windows: RepositoryPageUpdateWindow[] = []
  const baselines = [...pagesByBaseline.keys()].sort(compareCodeUnits)
  for (const baseline of baselines) {
    windows.push({
      ...(baseline ? { baseGitHead: baseline } : {}),
      pages: [...(pagesByBaseline.get(baseline) ?? [])].sort(compareCodeUnits),
      changedPaths: await getRepositoryChangedPaths(
        root,
        ignore,
        baseline || undefined,
      ),
      fullReview: baseline.length === 0,
    })
  }
  return windows
}

/**
 * Advances page coverage across commits that changed only generated wiki files.
 */
async function fastForwardUnchangedRepositoryPageCoverage(
  root: string,
  ignore: OpenWikiIgnore,
  pages: readonly string[],
  source: RepositorySourceCheckpoint,
): Promise<void> {
  if (!source.gitHead) return

  const manifest = await readRepositoryPageManifest(root)
  for (const page of [...pages].sort(compareCodeUnits)) {
    const entry = manifest.pages[page]
    if (!entry?.gitHead || entry.gitHead === source.gitHead) continue

    const changedPaths = await getRepositoryChangedPaths(
      root,
      ignore,
      entry.gitHead,
    )
    if (changedPaths.length > 0) continue

    await recordRepositoryPageCompletion(
      root,
      page,
      source,
      entry.completedBy,
      entry.completedRunId,
    )
  }
}

/**
 * Validates and durably installs the ordered PageJob queue.
 */
export async function submitRepositoryPlan(
  run: ActiveRepositoryRun,
  input: ProposedRepositoryPlan,
): Promise<{ status: 'accepted'; totalPages: number }> {
  if (run.state.plan) {
    const proposed = createRepositoryPlan(
      run.state.mode,
      input,
      run.claimsRuntime.issues,
      run.state.requiredRewritePages,
    )
    if (!samePlanIgnoringJobIds(run.state.plan, proposed)) {
      throw new RepositoryRunError(
        'invalid_state',
        'This OpenWiki run already has a different persisted plan.',
      )
    }
    return { status: 'accepted', totalPages: run.state.plan.pages.length }
  }

  if (run.state.phase !== 'planning') {
    throw new RepositoryRunError(
      'invalid_state',
      'OpenWiki plan can only be submitted during planning.',
    )
  }

  const plan = createRepositoryPlan(
    run.state.mode,
    input,
    run.claimsRuntime.issues,
    run.state.requiredRewritePages,
  )
  const nextState: RepositoryRunState = {
    ...run.state,
    phase: 'generating',
    plan,
  }
  await writeRepositoryRunState(run.root, nextState)
  run.state = nextState
  return { status: 'accepted', totalPages: plan.pages.length }
}

/**
 * Compares semantic plans while ignoring generated job IDs and progress state.
 */
function samePlanIgnoringJobIds(
  left: NonNullable<RepositoryRunState['plan']>,
  right: NonNullable<RepositoryRunState['plan']>,
): boolean {
  const simplify = (plan: NonNullable<RepositoryRunState['plan']>) => ({
    pages: plan.pages.map(
      ({ path, title, purpose, seedPaths, relatedPages, instructions }) => ({
        path,
        title,
        purpose,
        seedPaths,
        relatedPages,
        instructions,
      }),
    ),
    deletePages: [...plan.deletePages],
  })
  return JSON.stringify(simplify(left)) === JSON.stringify(simplify(right))
}

/**
 * First pending job with current page context, or queue completion.
 */
export type NextRepositoryPageResult =
  | {
    status: 'pending'
    job: PageJob & {
      mode: RepositoryRunMode
      existing: boolean
      existingClaims: InspectedClaim[]
    }
  }
  | { status: 'complete' }

/**
 * Returns the first pending job without reserving or mutating it.
 */
export async function nextRepositoryPage(
  run: ActiveRepositoryRun,
): Promise<NextRepositoryPageResult> {
  const plan = run.state.plan
  if (!plan || run.state.phase !== 'generating') {
    throw new RepositoryRunError(
      'invalid_state',
      'Submit the OpenWiki plan before requesting page work.',
    )
  }

  const job = plan.pages.find(({ status }) => status === 'pending')
  if (!job) return { status: 'complete' }

  let existing = false
  try {
    const read = await run.backend.readRaw(job.path)
    existing = !read.error && read.data?.content !== undefined
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error
  }

  return {
    status: 'pending',
    job: {
      ...job,
      mode: run.state.mode,
      existing,
      existingClaims: run.claimsRuntime.session.inspectClaims(job.path),
    },
  }
}

/**
 * Captures the current pending page and Claims sidecar before model-owned work.
 */
export async function captureRepositoryPageSnapshot(
  run: ActiveRepositoryRun,
  jobId: string,
): Promise<RepositoryPageSnapshot> {
  const current = run.state.plan?.pages.find(
    ({ status }) => status === 'pending',
  )
  if (!current || current.id !== jobId) {
    throw new RepositoryRunError(
      'invalid_state',
      'Only the current pending OpenWiki page job may be snapshotted.',
    )
  }

  let markdown: string | null = null
  try {
    const read = await run.backend.readRaw(current.path)
    if (read.error && read.error !== 'file_not_found') {
      throw new RepositoryRunError(
        'invalid_state',
        `Could not snapshot ${current.path}: ${read.error}`,
      )
    }
    const content = read.data?.content
    if (content !== undefined && typeof content !== 'string') {
      throw new RepositoryRunError(
        'invalid_state',
        `Could not snapshot non-text Markdown page ${current.path}.`,
      )
    }
    markdown = content ?? null
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error
  }

  return {
    jobId: current.id,
    path: current.path,
    markdown,
    claims: await new ClaimsStore(run.root).loadPage(current.path),
  }
}

/**
 * Rolls a failed page worker back without advancing its pending checkpoint.
 */
export async function skipRepositoryPage(
  run: ActiveRepositoryRun,
  snapshot: RepositoryPageSnapshot,
): Promise<void> {
  const plan = run.state.plan
  const current = plan?.pages.find(({ status }) => status === 'pending')
  if (
    !plan ||
    !current ||
    current.id !== snapshot.jobId ||
    current.path !== snapshot.path
  ) {
    throw new RepositoryRunError(
      'invalid_state',
      'The failed page worker no longer owns the current pending job.',
    )
  }

  await restoreRepositoryPageMarkdown(run, snapshot)

  const store = new ClaimsStore(run.root)
  if (snapshot.claims) {
    await store.writePage(snapshot.path, snapshot.claims)
  } else {
    await store.deletePage(snapshot.path)
  }

  const claimsRuntime = await prepareClaimsRuntime(
    run.state.mode,
    'repository',
    run.root,
    run.ignore,
    () => undefined,
    { resumeInit: run.state.mode === 'init' },
  )
  if (!claimsRuntime) {
    throw new Error('Repository Claims runtime was not restored.')
  }
  run.claimsRuntime = claimsRuntime

  await writeLastUpdateMetadata(
    run.state.mode,
    run.root,
    run.state.actor.metadataModel,
    'repository',
    'interrupted',
    run.state.language,
    run.state.baseGitHead ?? null,
  )

  const nextState: RepositoryRunState = {
    ...run.state,
    plan: {
      ...plan,
      pages: plan.pages.map(page =>
        page.id === snapshot.jobId
          ? { ...page, status: 'skipped' as const }
          : page,
      ),
    },
  }
  await writeRepositoryRunState(run.root, nextState)
  run.state = nextState
}

async function restoreRepositoryPageMarkdown(
  run: ActiveRepositoryRun,
  snapshot: RepositoryPageSnapshot,
): Promise<void> {
  const result =
    snapshot.markdown === null
      ? await run.backend.delete(snapshot.path)
      : await run.backend.write(snapshot.path, snapshot.markdown)
  if (
    result.error &&
    !(snapshot.markdown === null && result.error === 'file_not_found')
  ) {
    throw new RepositoryRunError(
      'invalid_state',
      `Could not restore ${snapshot.path}: ${result.error}`,
    )
  }
}

/**
 * Persists and proves one page's Claims before completing its current job.
 */
export async function submitRepositoryPage(
  run: ActiveRepositoryRun,
  input: {
    jobId: string
    claims: ProposedPageClaim[]
  },
): Promise<{ status: 'complete'; page: string; remaining: number }> {
  const plan = run.state.plan
  if (!plan || run.state.phase !== 'generating') {
    throw new RepositoryRunError(
      'invalid_state',
      'Submit the OpenWiki plan before submitting pages.',
    )
  }

  const requested = plan.pages.find(({ id }) => id === input.jobId)
  if (!requested) {
    throw new RepositoryRunError('not_found', 'Unknown OpenWiki page job.')
  }

  if (requested.status === 'complete') {
    return {
      status: 'complete',
      page: requested.path,
      remaining: plan.pages.filter(({ status }) => status === 'pending').length,
    }
  }

  const current = plan.pages.find(({ status }) => status === 'pending')
  if (!current || current.id !== requested.id) {
    throw new RepositoryRunError(
      'invalid_state',
      'Only the current pending OpenWiki page job may be submitted.',
    )
  }

  let pageReadable = false
  try {
    const read = await run.backend.readRaw(current.path)
    const content = read.data?.content
    pageReadable =
      !read.error && content !== undefined && !(content instanceof Uint8Array)
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error
  }
  if (!pageReadable) {
    throw new RepositoryRunError(
      'invalid_input',
      `Write ${current.path} before submitting its page job.`,
    )
  }

  const frontmatter = await repairPersistedFile(
    run.backend,
    current.path,
    resolveConceptTypeLabel(run.state.language),
  )
  if (!frontmatter.validation.valid) {
    const details = frontmatter.validation.issues
      .map(
        ({ code, line, message }) =>
          `[${code}]${line ? ` line ${line}:` : ''} ${message}`,
      )
      .join('; ')
    throw new RepositoryRunError(
      'invalid_input',
      `Could not deterministically repair front matter in ${current.path}: ${details}`,
    )
  }

  try {
    await replacePageClaims(run.claimsRuntime.session, current.path, input.claims)
    // Persist the page's dirty Claim state before recording job completion.
    await run.claimsRuntime.finalize(run.state.startedAt)
    await assertPageClaimsDurable(run, current.path)
  } catch (error) {
    if (error instanceof RepositoryRunError) throw error
    throw new RepositoryRunError(
      'invalid_input',
      error instanceof Error ? error.message : 'Claims validation failed.',
    )
  }

  await recordRepositoryPageCompletion(
    run.root,
    current.path,
    getRepositoryRunSourceCheckpoint(run.state),
    run.state.actor.producerActor,
    run.state.runId,
  )

  const nextPlan = {
    ...plan,
    pages: plan.pages.map(page =>
      page.id === current.id
        ? {
          ...page,
          status: 'complete' as const,
          completedBy: run.state.actor.producerActor,
        }
        : page,
    ),
  }
  const nextState: RepositoryRunState = {
    ...run.state,
    plan: nextPlan,
  }
  await writeRepositoryRunState(run.root, nextState)
  run.state = nextState

  return {
    status: 'complete',
    page: current.path,
    remaining: nextPlan.pages.filter(({ status }) => status === 'pending')
      .length,
  }
}

/**
 * Proves one page's complete Claims, page version, and verification are durable.
 */
async function assertPageClaimsDurable(
  run: ActiveRepositoryRun,
  page: string,
  retryOperation: 'submit_page' | 'finish' = 'submit_page',
): Promise<void> {
  const store = new ClaimsStore(run.root)
  const persisted = await store.loadPage(page)
  if (!persisted) {
    throw new RepositoryRunError(
      'invalid_state',
      `Claims for ${page} were not durably persisted; retry ${retryOperation}.`,
    )
  }

  const currentPageVersion = await store.hashPage(page)
  if (persisted.pageVersion !== currentPageVersion) {
    throw new RepositoryRunError(
      'invalid_state',
      `Claims for ${page} do not match the current Markdown bytes; retry ${retryOperation}.`,
    )
  }

  const verification = persisted.verification
  if (!verification) {
    throw new RepositoryRunError(
      'invalid_state',
      `Claims for ${page} were not verified; retry ${retryOperation}.`,
    )
  }
  const { by: verificationBy, at: verificationAt } = verification

  const verified: unknown = parseFrontmatterFields(
    await store.readMarkdown(page),
  )?.verified
  const verificationEvents: unknown[] = Array.isArray(verified)
    ? verified
    : verified === undefined
      ? []
      : [verified]
  const verificationProjected = verificationEvents.some(
    event =>
      isVerificationEvent(event) &&
      event.by === verificationBy &&
      event.at === verificationAt,
  )
  if (!verificationProjected) {
    throw new RepositoryRunError(
      'invalid_state',
      `Claims verification for ${page} was not durably projected; retry ${retryOperation}.`,
    )
  }

  const expected = run.claimsRuntime.session.inspectClaims(page)
  const persistedById = new Map(
    persisted.claims.map(claim => [claim.id, claim]),
  )
  if (persistedById.size !== expected.length) {
    throw new RepositoryRunError(
      'invalid_state',
      `Claims for ${page} were only partially persisted; retry ${retryOperation}.`,
    )
  }

  for (const claim of expected) {
    const durable = persistedById.get(claim.id)
    if (
      !durable ||
      durable.statement !== claim.statement ||
      !sameResourceSet(
        durable.evidence.map(({ resource }) => resource),
        claim.evidence,
      )
    ) {
      throw new RepositoryRunError(
        'invalid_state',
        `Claims for ${page} were only partially persisted; retry ${retryOperation}.`,
      )
    }
  }
}

/**
 * Narrows one frontmatter value to a complete verification event.
 */
function isVerificationEvent(
  value: unknown,
): value is { by: string; at: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'by' in value &&
    typeof value.by === 'string' &&
    'at' in value &&
    typeof value.at === 'string'
  )
}

/**
 * Proves the final repository has no orphaned or partially durable Claims.
 */
async function assertRepositoryClaimsDurable(
  run: ActiveRepositoryRun,
  excludedPages: ReadonlySet<string> = new Set(),
): Promise<void> {
  const store = new ClaimsStore(run.root)
  const currentPages = new Set(await store.discoverPages())
  const sidecarPages = await store.discoverSidecarPages()

  for (const page of sidecarPages) {
    if (!currentPages.has(page)) {
      throw new RepositoryRunError(
        'invalid_state',
        `Deleted or missing page ${page} still has a Claims sidecar; retry finish.`,
      )
    }
  }

  for (const page of run.claimsRuntime.session
    .getEvidenceResourcesByPage()
    .keys()) {
    if (excludedPages.has(page)) continue
    if (run.claimsRuntime.session.inspectClaims(page).length === 0) continue
    if (!currentPages.has(page)) {
      throw new RepositoryRunError(
        'invalid_state',
        `Claimed page ${page} is missing; retry finish.`,
      )
    }
    await assertPageClaimsDurable(run, page, 'finish')
  }
}

/**
 * Compares strings by deterministic JavaScript UTF-16 code-unit order.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Compares two evidence-resource collections as deterministic sets.
 */
function sameResourceSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalize = (values: readonly string[]) =>
    [...new Set(values)].sort(compareCodeUnits)
  const a = normalize(left)
  const b = normalize(right)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Deterministically finalizes a complete run and records any source drift.
 */
export async function finishRepositoryRun(
  run: ActiveRepositoryRun,
  options: {
    skippedPageSnapshots?: readonly RepositoryPageSnapshot[]
  } = {},
): Promise<{ status: 'complete'; sourceChanged?: true }> {
  const plan = run.state.plan
  if (!plan) {
    throw new RepositoryRunError(
      'invalid_state',
      'OpenWiki cannot finish before a plan is submitted.',
    )
  }
  const pending = plan.pages.filter(({ status }) => status === 'pending')
  if (pending.length > 0) {
    throw new RepositoryRunError(
      'invalid_state',
      `OpenWiki cannot finish with ${pending.length} pending page job(s).`,
    )
  }

  const skippedJobs = plan.pages.filter(({ status }) => status === 'skipped')
  const snapshots = options.skippedPageSnapshots ?? []
  const snapshotsByJobId = new Map(
    snapshots.map(snapshot => [snapshot.jobId, snapshot]),
  )
  if (
    skippedJobs.length !== snapshots.length ||
    skippedJobs.some(job => snapshotsByJobId.get(job.id)?.path !== job.path)
  ) {
    throw new RepositoryRunError(
      'invalid_state',
      'Every skipped OpenWiki page job requires its original page snapshot before finish.',
    )
  }
  const skippedPages = new Set(skippedJobs.map(({ path }) => path))
  const sourceChangedBeforeFinish = await hasRepositorySourceChanged(run)
  const producerActorsByPage = new Map<string, string>()
  for (const [page, entry] of Object.entries(
    (await readRepositoryPageManifest(run.root)).pages,
  )) {
    if (entry && entry.completedBy && entry.completedRunId === run.state.runId) {
      producerActorsByPage.set(page, entry.completedBy)
    }
  }

  await applyAbandonedGeneratedPageDeletions(run, plan)
  await applyPlannedDeletions(run, plan.deletePages)
  await reconcileDeletedClaimPages(run)

  await finalizeWikiArtifacts({
    backend: run.backend,
    outputMode: 'repository',
    labels: resolveIndexLabels(run.state.language),
    conceptType: resolveConceptTypeLabel(run.state.language),
    prepared: deserializePreparedWikiState(run.state.preparedWiki),
    at: run.state.startedAt,
    producerActor: run.state.actor.producerActor,
    producerActorsByPage,
    claimSources: run.claimsRuntime.session.getEvidenceResourcesByPage(),
  })

  for (const snapshot of snapshots) {
    await restoreRepositoryPageMarkdown(run, snapshot)
  }

  await run.claimsRuntime.finalize(run.state.startedAt, skippedPages)
  await assertRepositoryClaimsDurable(run, skippedPages)
  const store = new ClaimsStore(run.root)
  await replaceRepositoryPageManifest(
    run.root,
    await store.discoverPages(),
    getRepositoryRunSourceCheckpoint(run.state),
    skippedPages,
  )
  const sourceChanged =
    sourceChangedBeforeFinish || (await hasRepositorySourceChanged(run))
  if (skippedPages.size > 0 || sourceChanged) {
    await writeLastUpdateMetadata(
      run.state.mode,
      run.root,
      run.state.actor.metadataModel,
      'repository',
      'interrupted',
      run.state.language,
      run.state.baseGitHead ?? null,
    )
  } else {
    await persistRunMetadataIfChanged(
      run.state.mode,
      run.root,
      run.state.actor.metadataModel,
      'repository',
      run.state.beforeContentSnapshot,
      'complete',
      run.state.language,
    )
  }

  // Delete this LAST. If anything above fails, begin() can reconstruct and retry.
  await removeRepositoryRunState(run.root)

  return sourceChanged
    ? { status: 'complete', sourceChanged: true }
    : { status: 'complete' }
}

/**
 * Checks whether model-visible repository source changed after planning.
 */
async function hasRepositorySourceChanged(
  run: ActiveRepositoryRun,
): Promise<boolean> {
  const current = await createRepositorySourceSnapshot(run.root, run.ignore)
  return current.fingerprint !== run.state.sourceFingerprint
}

/**
 * Removes current-run pages abandoned by a superseded plan, never initial pages.
 */
async function applyAbandonedGeneratedPageDeletions(
  run: ActiveRepositoryRun,
  plan: NonNullable<RepositoryRunState['plan']>,
): Promise<void> {
  const initial = new Set(run.state.initialPages)
  const planned = new Set(plan.pages.map(({ path }) => path))
  const store = new ClaimsStore(run.root)
  for (const page of await store.discoverPages()) {
    if (initial.has(page) || planned.has(page)) continue
    const result = await run.backend.delete(page)
    if (result.error && result.error !== 'file_not_found') {
      throw new RepositoryRunError(
        'invalid_state',
        `Could not remove page abandoned by an invalidated plan ${page}: ${result.error}`,
      )
    }
    await run.claimsRuntime.session.recordDeletion(page)
  }
}

/**
 * Applies the replacement plan's explicit existing-page deletion set.
 */
async function applyPlannedDeletions(
  run: ActiveRepositoryRun,
  pages: readonly string[],
): Promise<void> {
  for (const page of pages) {
    const result = await run.backend.delete(page)
    if (result.error && result.error !== 'file_not_found') {
      throw new RepositoryRunError(
        'invalid_state',
        `Could not delete planned OpenWiki page ${page}: ${result.error}`,
      )
    }
    await run.claimsRuntime.session.recordDeletion(page)
  }
}

/**
 * Records deletions for Claims sidecars whose Markdown pages no longer exist.
 */
async function reconcileDeletedClaimPages(
  run: ActiveRepositoryRun,
): Promise<void> {
  const store = new ClaimsStore(run.root)
  const currentPages = new Set(await store.discoverPages())
  for (const page of await store.discoverSidecarPages()) {
    if (!currentPages.has(page)) {
      await run.claimsRuntime.session.recordDeletion(page)
    }
  }
}
