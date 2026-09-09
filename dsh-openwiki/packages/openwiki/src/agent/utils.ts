/**
 * Git-backed run context and snapshot helpers for the ported OpenWiki engine.
 *
 * Ported from openwiki `src/agent/utils.ts` with the DeepAgents and
 * home-directory onboarding coupling removed: this fork reads the repository's
 * own `openwiki/INSTRUCTIONS.md` for the wiki goal (there is no global
 * onboarding store) and keeps every other behavior byte-compatible.
 * @module @hy-sde-org/dsh-openwiki/agent
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  constants as fsConstants,
  type BigIntStats,
  type Dirent,
} from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  OPEN_WIKI_DIR,
  PAGE_MANIFEST_PATH,
  UPDATE_METADATA_PATH,
} from '../config/constants.ts'
import {
  isExpectedSnapshotRaceError,
  isFileNotFoundError,
} from '../platform/fs-errors.ts'
import {
  getPrimaryLanguageSubtag,
  requireResolvedLanguage,
} from '../platform/language.ts'
import { OPENWIKI_IGNORE_FILE, OpenWikiIgnore } from './openwiki-ignore.ts'
import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
  RunContext,
  UpdateMetadata,
  UpdateRunStatus,
} from './types.ts'

const execFileAsync = promisify(execFile)
const LOCAL_WIKI_METADATA_PATH = '.last-update.json'
const REPOSITORY_RUN_STATE_BASENAME = '.run.json'
const REPOSITORY_INSTRUCTIONS_FILE = 'INSTRUCTIONS.md'

export type OpenWikiContentSnapshot = string

export type UpdateNoopStatus =
  | {
    shouldSkip: true
    gitHead: string
    model: string

    /**
       * The wiki's persisted language, carried through so a no-op metadata
       * refresh re-writes `.last-update.json` without dropping it.
       */
    language?: string
  }
  | {
    shouldSkip: false
    reason: string
  }

/**
 * Reads the repository-owned `openwiki/INSTRUCTIONS.md` wiki goal, if present.
 */
export async function readRepositoryWikiInstructions(
  cwd: string,
): Promise<string | undefined> {
  const instructionsPath = path.join(
    cwd,
    OPEN_WIKI_DIR,
    REPOSITORY_INSTRUCTIONS_FILE,
  )
  try {
    const content = (await readFile(instructionsPath, 'utf8')).trim()
    return content.length > 0 ? content : undefined
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined
    throw error
  }
}

/**
 * Builds the persisted per-run context used by the prompt.
 */
export async function createRunContext(
  cwd: string,
  outputMode: OpenWikiOutputMode = 'repository',
  language?: string | null,
): Promise<RunContext> {
  const lastUpdate = await readLastUpdate(cwd, outputMode)
  const requestedLanguage = requireResolvedLanguage(language)
  const effectiveLanguage = requestedLanguage ?? lastUpdate?.language ?? 'en'
  const wikiGoal =
    outputMode === 'repository'
      ? await readRepositoryWikiInstructions(cwd)
      : undefined

  return {
    lastUpdate,
    language: effectiveLanguage,
    wikiGoal,
  }
}

/**
 * Decides whether an update can skip its model invocation.
 */
export async function getUpdateNoopStatus(
  cwd: string,
  openWikiIgnore = new OpenWikiIgnore([]),
  requestedLanguage?: string | null,
): Promise<UpdateNoopStatus> {
  const lastUpdate = await readLastUpdate(cwd, 'repository')

  if (!lastUpdate?.gitHead) {
    return { shouldSkip: false, reason: 'missing previous update git head' }
  }

  if (lastUpdate.status === 'interrupted') {
    return { shouldSkip: false, reason: 'previous update was interrupted' }
  }

  const resolvedRequestedLanguage = requireResolvedLanguage(requestedLanguage)
  if (
    resolvedRequestedLanguage !== undefined &&
    getPrimaryLanguageSubtag(resolvedRequestedLanguage) !==
      getPrimaryLanguageSubtag(lastUpdate.language)
  ) {
    return { shouldSkip: false, reason: 'output language changed' }
  }

  const head = await getGitHead(cwd)

  if (!head) {
    return { shouldSkip: false, reason: 'missing current git head' }
  }

  const status = await runGit(cwd, [
    'status',
    '--short',
    '--untracked-files=all',
  ])
  const meaningfulStatus = status
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .filter(line => !isUpdateMetadataStatusLine(line))
    .filter(line => !lineReferencesIgnoredPath(line, openWikiIgnore))

  if (meaningfulStatus.length > 0) {
    return { shouldSkip: false, reason: 'worktree has changes' }
  }

  if (head !== lastUpdate.gitHead) {
    const committedPaths = await getChangedPathsSinceLastUpdate(
      cwd,
      lastUpdate.gitHead,
    )

    if (
      committedPaths.length === 0 ||
      committedPaths.some(
        changedPath =>
          !isOpenWikiPath(changedPath) && !openWikiIgnore.ignores(changedPath),
      )
    ) {
      return { shouldSkip: false, reason: 'git head changed' }
    }
  }

  return {
    shouldSkip: true,
    gitHead: head,
    model: lastUpdate.model,
    language: lastUpdate.language,
  }
}

/**
 * Records an init/update run so future updates can diff from this git head.
 */
export async function writeLastUpdateMetadata(
  command: OpenWikiCommand,
  cwd: string,
  modelId: string,
  outputMode: OpenWikiOutputMode = 'repository',
  status: UpdateRunStatus = 'complete',
  language?: string,
  gitHeadOverride?: string | null,
): Promise<void> {
  const metadataFile = getMetadataFilePath(cwd, outputMode)
  const gitHead =
    outputMode !== 'repository'
      ? undefined
      : gitHeadOverride === null
        ? undefined
        : (gitHeadOverride ?? (await getGitHead(cwd)))
  const metadata: UpdateMetadata = {
    updatedAt: new Date().toISOString(),
    command,
    gitHead,
    model: modelId,
    status,
    ...(language ? { language } : {}),
  }

  await mkdir(path.dirname(metadataFile), { recursive: true })
  await writeFile(
    metadataFile,
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  )
}

/**
 * Persists run metadata after an update/init run.
 */
export async function persistRunMetadataIfChanged(
  command: OpenWikiCommand,
  cwd: string,
  modelId: string,
  outputMode: OpenWikiOutputMode,
  snapshotBefore: OpenWikiContentSnapshot | null,
  status: UpdateRunStatus = 'complete',
  language?: string,
): Promise<boolean> {
  if (command === 'chat' || snapshotBefore === null) {
    return false
  }

  await writeLastUpdateMetadata(
    command,
    cwd,
    modelId,
    outputMode,
    status,
    language,
  )

  return true
}

/**
 * Hashes OpenWiki content, excluding run metadata, to detect real changes.
 */
export async function createOpenWikiContentSnapshot(
  cwd: string,
  outputMode: OpenWikiOutputMode = 'repository',
): Promise<OpenWikiContentSnapshot> {
  const openWikiDir = getWikiContentRoot(cwd, outputMode)
  const hash = createHash('sha256')

  await addDirectoryToSnapshot(hash, openWikiDir, '')

  return hash.digest('hex')
}

const SOURCE_FINGERPRINT_VERSION = 'openwiki-source-fingerprint-v1'
const SOURCE_FINGERPRINT_MAX_BUFFER_BYTES = 64 * 1024 * 1024

interface SourceStatusEntry {
  code: string
  path: string
}

/**
 * Exact repository source identity captured for one semantic plan.
 */
export interface RepositorySourceSnapshot {
  fingerprint: string
  gitHead?: string
}

/**
 * Hashes model-visible source input and returns its observed Git commit.
 */
export async function createRepositorySourceSnapshot(
  cwd: string,
  openWikiIgnore: OpenWikiIgnore,
): Promise<RepositorySourceSnapshot> {
  if (!path.isAbsolute(cwd)) {
    throw new Error('Repository source fingerprint requires an absolute root.')
  }

  const [head, trackedOutput, untrackedOutput, statusOutput] =
    await Promise.all([
      readFingerprintHead(cwd),
      runFingerprintGit(cwd, ['ls-files', '--cached', '-z']),
      runFingerprintGit(cwd, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ]),
      runFingerprintGit(cwd, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--no-renames',
        '-z',
      ]),
    ])

  const trackedPaths = new Set(
    splitFingerprintNul(trackedOutput).map(assertFingerprintGitPath),
  )
  const candidatePaths = new Set([
    ...trackedPaths,
    ...splitFingerprintNul(untrackedOutput).map(assertFingerprintGitPath),
  ])
  if (await fingerprintEntryExists(path.join(cwd, OPENWIKI_IGNORE_FILE))) {
    candidatePaths.add(OPENWIKI_IGNORE_FILE)
  }

  const visiblePaths = [...candidatePaths]
    .filter(candidate => isFingerprintSourcePath(candidate, openWikiIgnore))
    .sort(compareFingerprintStrings)
  const statusEntries = parseFingerprintStatus(statusOutput)
    .filter(({ path: candidate }) =>
      isFingerprintSourcePath(candidate, openWikiIgnore),
    )
    .sort((left, right) =>
      compareFingerprintStrings(
        `${left.code}\u0000${left.path}`,
        `${right.code}\u0000${right.path}`,
      ),
    )

  const hash = createHash('sha256')
  updateFingerprintField(hash, 'format', SOURCE_FINGERPRINT_VERSION)
  updateFingerprintField(hash, 'head', head)
  for (const entry of statusEntries) {
    updateFingerprintField(hash, 'status-code', entry.code)
    updateFingerprintField(hash, 'status-path', entry.path)
  }
  for (const sourcePath of visiblePaths) {
    await updateFingerprintSourceEntry(
      hash,
      cwd,
      sourcePath,
      trackedPaths.has(sourcePath),
    )
  }

  const fingerprint = `sha256:${hash.digest('hex')}`
  return {
    fingerprint,
    ...(head.startsWith('unborn:') ? {} : { gitHead: head }),
  }
}

/**
 * Hashes every model-visible repository source input.
 */
export async function createRepositorySourceFingerprint(
  cwd: string,
  openWikiIgnore: OpenWikiIgnore,
): Promise<string> {
  return (await createRepositorySourceSnapshot(cwd, openWikiIgnore))
    .fingerprint
}

async function readFingerprintHead(cwd: string): Promise<string> {
  try {
    const head = (
      await runFingerprintGit(cwd, ['rev-parse', '--verify', 'HEAD'])
    ).trimEnd()
    if (!head) throw new Error('Git returned an empty HEAD.')
    return head
  } catch (headError) {
    try {
      const symbolicHead = (
        await runFingerprintGit(cwd, ['symbolic-ref', '-q', 'HEAD'])
      ).trimEnd()
      if (symbolicHead) return `unborn:${symbolicHead}`
    } catch {
      // The original rev-parse failure is the actionable correctness error.
    }
    throw new Error('Unable to resolve repository HEAD for fingerprinting.', {
      cause: headError,
    })
  }
}

async function runFingerprintGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-pager', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: SOURCE_FINGERPRINT_MAX_BUFFER_BYTES,
    })
    return stdout
  } catch (error) {
    throw new Error(
      `Git failed while creating the repository source fingerprint: git ${args.join(' ')}`,
      { cause: error },
    )
  }
}

function splitFingerprintNul(output: string): string[] {
  if (output.length === 0) return []
  if (!output.endsWith('\u0000')) {
    throw new Error('Git returned non-NUL-terminated fingerprint output.')
  }
  return output.slice(0, -1).split('\u0000')
}

function parseFingerprintStatus(output: string): SourceStatusEntry[] {
  return splitFingerprintNul(output).map((record) => {
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('Git returned malformed porcelain status output.')
    }
    return {
      code: record.slice(0, 2),
      path: assertFingerprintGitPath(record.slice(3)),
    }
  })
}

function assertFingerprintGitPath(value: string): string {
  if (!value || path.posix.isAbsolute(value)) {
    throw new Error(`Git returned an invalid repository path: ${value}`)
  }
  const normalized = path.posix.normalize(value)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Git returned an escaping repository path: ${value}`)
  }
  return normalized
}

function isFingerprintSourcePath(
  candidate: string,
  openWikiIgnore: OpenWikiIgnore,
): boolean {
  if (candidate === OPENWIKI_IGNORE_FILE) return true
  if (candidate === '.git' || candidate.startsWith('.git/')) return false
  return !isOpenWikiPath(candidate) && !openWikiIgnore.ignores(candidate)
}

async function fingerprintEntryExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (isFileNotFoundError(error)) return false
    throw error
  }
}

async function updateFingerprintSourceEntry(
  hash: ReturnType<typeof createHash>,
  cwd: string,
  sourcePath: string,
  tracked: boolean,
): Promise<void> {
  const absoluteRoot = path.resolve(cwd)
  const absolutePath = path.resolve(absoluteRoot, sourcePath)
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(
      `Source fingerprint path escaped the repository: ${sourcePath}`,
    )
  }

  updateFingerprintField(hash, 'path', sourcePath)

  let stats: BigIntStats
  try {
    stats = await lstat(absolutePath, { bigint: true })
  } catch (error) {
    if (tracked && isFileNotFoundError(error)) {
      updateFingerprintField(hash, 'kind', 'tracked-missing')
      return
    }
    throw new Error(`Unable to inspect source path ${sourcePath}.`, {
      cause: error,
    })
  }

  if (stats.isFile()) {
    const file = await readFingerprintRegularFile(
      absolutePath,
      sourcePath,
      stats,
    )
    updateFingerprintField(hash, 'executable', file.executable ? 'yes' : 'no')
    updateFingerprintField(hash, 'kind', 'file')
    updateFingerprintField(hash, 'bytes', file.bytes)
    return
  }

  updateFingerprintField(
    hash,
    'executable',
    (stats.mode & 0o111n) !== 0n ? 'yes' : 'no',
  )
  if (stats.isSymbolicLink()) {
    updateFingerprintField(hash, 'kind', 'symlink')
    updateFingerprintField(
      hash,
      'target',
      await readlink(absolutePath, { encoding: 'buffer' }),
    )
    return
  }
  if (stats.isDirectory()) {
    updateFingerprintField(hash, 'kind', 'directory')
    return
  }
  throw new Error(`Unsupported source entry type at ${sourcePath}.`)
}

async function readFingerprintRegularFile(
  absolutePath: string,
  sourcePath: string,
  inspectedStats: BigIntStats,
): Promise<{ bytes: Buffer; executable: boolean }> {
  let fileHandle
  try {
    fileHandle = await open(absolutePath, getFingerprintFileOpenFlags())
  } catch (error) {
    throw new Error(`Unable to safely open source path ${sourcePath}.`, {
      cause: error,
    })
  }

  try {
    const openedStats = await fileHandle.stat({ bigint: true })
    if (
      !openedStats.isFile() ||
      openedStats.dev !== inspectedStats.dev ||
      openedStats.ino !== inspectedStats.ino
    ) {
      throw new Error(
        `Source path changed while fingerprinting ${sourcePath}.`,
      )
    }

    return {
      bytes: await fileHandle.readFile(),
      executable: (openedStats.mode & 0o111n) !== 0n,
    }
  } finally {
    await fileHandle.close()
  }
}

function getFingerprintFileOpenFlags(): number {
  return (
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
  )
}

function updateFingerprintField(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Buffer,
): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  hash.update(label, 'utf8')
  hash.update('\u0000')
  hash.update(String(bytes.length), 'utf8')
  hash.update('\u0000')
  hash.update(bytes)
  hash.update('\u0000')
}

function compareFingerprintStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function readLastUpdate(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): Promise<UpdateMetadata | null> {
  const metadataFile = getMetadataFilePath(cwd, outputMode)

  try {
    const rawMetadata = await readFile(metadataFile, 'utf8')
    const parsedMetadata = JSON.parse(rawMetadata) as Partial<UpdateMetadata>

    if (
      typeof parsedMetadata.updatedAt === 'string' &&
      typeof parsedMetadata.command === 'string' &&
      typeof parsedMetadata.model === 'string'
    ) {
      return {
        updatedAt: parsedMetadata.updatedAt,
        command: parsedMetadata.command === 'init' ? 'init' : 'update',
        gitHead:
          typeof parsedMetadata.gitHead === 'string'
            ? parsedMetadata.gitHead
            : undefined,
        model: parsedMetadata.model,
        status:
          parsedMetadata.status === 'interrupted' ? 'interrupted' : 'complete',
        language:
          typeof parsedMetadata.language === 'string'
            ? parsedMetadata.language
            : undefined,
      }
    }

    return null
  } catch (error) {
    if (isFileNotFoundError(error) || error instanceof SyntaxError) {
      return null
    }

    throw error
  }
}

async function addDirectoryToSnapshot(
  hash: ReturnType<typeof createHash>,
  directory: string,
  relativeDirectory: string,
): Promise<void> {
  let entries: Dirent[]

  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isExpectedSnapshotRaceError(error)) {
      hash.update('missing')
      return
    }

    throw error
  }

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name)
    const relativePath = path.join(relativeDirectory, entry.name)

    if (isIgnoredSnapshotPath(relativePath)) {
      continue
    }

    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\0`)
      await addDirectoryToSnapshot(hash, entryPath, relativePath)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const fileContent = await readSnapshotFile(entryPath)

    if (fileContent === null) {
      continue
    }

    hash.update(`file:${relativePath}\0`)
    hash.update(fileContent)
    hash.update('\0')
  }
}

function getWikiContentRoot(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): string {
  return outputMode === 'local-wiki' ? cwd : path.join(cwd, OPEN_WIKI_DIR)
}

function getMetadataFilePath(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): string {
  return outputMode === 'local-wiki'
    ? path.join(cwd, LOCAL_WIKI_METADATA_PATH)
    : path.join(cwd, UPDATE_METADATA_PATH)
}

function isIgnoredSnapshotPath(relativePath: string): boolean {
  return (
    relativePath === path.basename(UPDATE_METADATA_PATH) ||
    relativePath === LOCAL_WIKI_METADATA_PATH ||
    relativePath === REPOSITORY_RUN_STATE_BASENAME
  )
}

async function readSnapshotFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath)
  } catch (error) {
    if (isExpectedSnapshotRaceError(error)) {
      return null
    }

    throw error
  }
}

async function getGitHead(cwd: string): Promise<string | undefined> {
  const head = await runGit(cwd, ['rev-parse', 'HEAD'])

  return head.length > 0 ? head : undefined
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['--no-pager', ...args],
      {
        cwd,
        maxBuffer: 1024 * 1024,
      },
    )

    return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').trim()
  } catch (error) {
    if (isExecError(error)) {
      return [error.stdout?.trim(), error.stderr?.trim()]
        .filter(Boolean)
        .join('\n')
        .trim()
    }

    throw error
  }
}

const GIT_STATUS_LINE_PATTERN = /^[ !?ACDMRTU]{1,2} (.+)$/u

function isUpdateMetadataStatusLine(line: string): boolean {
  const statusPath = (GIT_STATUS_LINE_PATTERN.exec(line)?.[1] ?? line).trim()
  const normalizedPath = statusPath.replace(/\\/gu, '/')

  return [PAGE_MANIFEST_PATH, UPDATE_METADATA_PATH].some(
    metadataPath =>
      normalizedPath === metadataPath ||
      normalizedPath.endsWith(` -> ${metadataPath}`),
  )
}

/**
 * Returns best-effort repository-relative paths for planner context.
 */
export async function getRepositoryChangedPaths(
  cwd: string,
  openWikiIgnore: OpenWikiIgnore,
  baseGitHead?: string,
): Promise<string[]> {
  const paths = new Set<string>()

  if (baseGitHead) {
    for (const candidate of await runGitLines(cwd, [
      'diff',
      '--name-only',
      `${baseGitHead}..HEAD`,
    ])) {
      paths.add(normalizeGitPath(candidate))
    }
  }

  for (const candidate of await runGitLines(cwd, [
    'diff',
    '--name-only',
    'HEAD',
  ])) {
    paths.add(normalizeGitPath(candidate))
  }

  for (const candidate of await runGitLines(cwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
  ])) {
    paths.add(normalizeGitPath(candidate))
  }

  return [...paths]
    .filter(Boolean)
    .filter(candidate => !isOpenWikiPath(candidate))
    .filter(candidate => !openWikiIgnore.ignores(candidate))
    .sort(compareFingerprintStrings)
}

async function runGitLines(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-pager', ...args], {
      cwd,
      maxBuffer: 1024 * 1024,
    })
    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function getChangedPathsSinceLastUpdate(
  cwd: string,
  gitHead: string,
): Promise<string[]> {
  const diff = await runGit(cwd, ['diff', '--name-only', `${gitHead}..HEAD`])

  return diff
    .split('\n')
    .map(line => normalizeGitPath(line))
    .filter(Boolean)
}

function isOpenWikiPath(changedPath: string): boolean {
  return (
    changedPath === OPEN_WIKI_DIR || changedPath.startsWith(`${OPEN_WIKI_DIR}/`)
  )
}

function normalizeGitPath(value: string): string {
  return value.trim().replace(/\\/gu, '/')
}

function lineReferencesIgnoredPath(
  line: string,
  openWikiIgnore: OpenWikiIgnore,
): boolean {
  return extractGitPaths(line).some(changedPath =>
    openWikiIgnore.ignores(changedPath),
  )
}

function extractGitPaths(line: string): string[] {
  const shortStatusMatch = /^(?:[ MARCUD?!]{2})\s+(.+)$/u.exec(line)
  const nameStatusMatch = /^(?:[ACDMRTUXB]\d*)\s+(.+)$/u.exec(line.trim())
  const pathsText = shortStatusMatch?.[1] ?? nameStatusMatch?.[1]

  if (!pathsText) {
    return []
  }

  return splitGitPaths(pathsText).map(normalizeGitPath).filter(Boolean)
}

function splitGitPaths(pathsText: string): string[] {
  if (pathsText.includes('\t')) {
    return pathsText.split('\t')
  }

  if (pathsText.includes(' -> ')) {
    return pathsText.split(' -> ')
  }

  return [pathsText]
}

function isExecError(
  error: unknown,
): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error && ('stdout' in error || 'stderr' in error)
}
