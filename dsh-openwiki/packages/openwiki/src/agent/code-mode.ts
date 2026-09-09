/**
 * Repository setup for the in-fork OpenWiki engine: managed agent-pointer
 * snippets and the repository INSTRUCTIONS.md wiki goal.
 *
 * Ported from openwiki `src/ingestion/code-mode.ts` with the CI workflow and
 * provider/connector coupling deliberately dropped: the fork engine runs
 * in-process through harness tools, so there is no scheduled GitHub Actions
 * workflow to generate and no provider environment to encode. Everything this
 * module owns — the AGENTS.md/CLAUDE.md managed blocks and the INSTRUCTIONS.md
 * human brief — mirrors upstream behavior byte-for-byte.
 * @module @hy-sde-org/dsh-openwiki/agent
 */

import { mkdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { OPEN_WIKI_DIR } from '../config/constants.ts'
import { isFileNotFoundError } from '../platform/fs-errors.ts'

const OPENWIKI_AGENTS_SNIPPET_START = '<!-- OPENWIKI:START -->'
const OPENWIKI_AGENTS_SNIPPET_END = '<!-- OPENWIKI:END -->'

/** Root agent-instruction files OpenWiki keeps pointed at the generated wiki. */
const CODE_MODE_AGENT_FILES = ['AGENTS.md', 'CLAUDE.md']

const REPOSITORY_INSTRUCTIONS_FILE = 'INSTRUCTIONS.md'

/**
 * Controls which parts of the repo OpenWiki sets up for wiki authoring.
 */
export interface CodeModeRepoSetupOptions {
  /**
   * Whether a fresh `openwiki/INSTRUCTIONS.md` wiki goal should be seeded when
   * the file does not exist yet. Existing files are never overwritten.
   */
  seedInstructions?: boolean
}

/**
 * Ensures the repo is set up for wiki authoring: refresh the managed
 * agent-instruction snippets so agents load the generated wiki as context.
 */
export async function ensureCodeModeRepoSetup(
  cwd: string,
  options: CodeModeRepoSetupOptions = {},
): Promise<void> {
  if (!path.isAbsolute(cwd)) {
    throw new Error('Repository OpenWiki setup requires an absolute root.')
  }
  await writeCodeModeAgentSnippets(cwd)
  if (options.seedInstructions !== false) {
    await seedRepositoryWikiInstructions(cwd)
  }
}

/**
 * Resolve what `filePath` actually writes to: its real target when the file
 * exists, or — for a dangling symlink — its link destination. Used so two
 * managed agent files that are the same inode (e.g. a `CLAUDE.md` that
 * symlinks `AGENTS.md`) are written exactly once instead of racing.
 */
async function resolveAgentFileTarget(filePath: string): Promise<string> {
  try {
    return await realpath(filePath)
  } catch (error) {
    if (isFileNotFoundError(error)) {
      try {
        const link = await readlink(filePath)
        if (link.length > 0) {
          return path.resolve(path.dirname(filePath), link)
        }
      } catch {
        // Not a symlink (or already gone entirely): fall through and treat
        // the path itself as the write target.
      }
      return path.resolve(filePath)
    }
    throw error
  }
}

async function writeCodeModeAgentSnippets(cwd: string): Promise<void> {
  const agentsSnippet = createCodeModeAgentsSnippet()
  const claudeSnippet = createCodeModeClaudeSnippet()
  const snippetByFile: Record<string, string> = {
    'AGENTS.md': agentsSnippet,
    'CLAUDE.md': claudeSnippet,
  }
  // Prepare and validate the files before writing either one, skipping a
  // symlinked entry whose real target is already handled (the repo's root
  // `CLAUDE.md` symlinks `AGENTS.md`).
  const updates: Array<{ agentsPath: string; nextContent: string }> = []
  const seenTargets = new Set<string>()
  for (const fileName of CODE_MODE_AGENT_FILES) {
    const agentsPath = path.join(cwd, fileName)
    const target = await resolveAgentFileTarget(agentsPath)
    if (seenTargets.has(target)) continue
    seenTargets.add(target)
    updates.push(
      await prepareCodeModeAgentSnippet(
        agentsPath,
        snippetByFile[fileName] ?? agentsSnippet,
      ),
    )
  }

  // Write sequentially: concurrent writers over the same inode (two managed
  // files that are hard links, or a file reached through a symlink) would
  // truncate each other and tear the managed snippet.
  for (const { agentsPath, nextContent } of updates) {
    await writeFile(agentsPath, nextContent, 'utf8')
  }
}

async function prepareCodeModeAgentSnippet(
  agentsPath: string,
  snippet: string,
): Promise<{ agentsPath: string; nextContent: string }> {
  let currentContent = ''

  try {
    currentContent = await readFile(agentsPath, 'utf8')
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error
    }
  }

  const startIndex = currentContent.indexOf(OPENWIKI_AGENTS_SNIPPET_START)
  const endIndex = currentContent.indexOf(OPENWIKI_AGENTS_SNIPPET_END)
  const hasNoMarkers = startIndex === -1 && endIndex === -1

  if (hasNoMarkers) {
    return {
      agentsPath,
      nextContent: `${currentContent.trimEnd()}${currentContent.trim().length > 0 ? '\n\n' : ''}${snippet}\n`,
    }
  }

  const hasOneOrderedPair =
    startIndex !== -1 &&
    endIndex > startIndex &&
    startIndex === currentContent.lastIndexOf(OPENWIKI_AGENTS_SNIPPET_START) &&
    endIndex === currentContent.lastIndexOf(OPENWIKI_AGENTS_SNIPPET_END)

  if (!hasOneOrderedPair) {
    throw new Error(
      `Cannot update ${path.basename(agentsPath)} because its OpenWiki managed markers are malformed or duplicated. Expected either no markers or exactly one ${OPENWIKI_AGENTS_SNIPPET_START} marker followed by one ${OPENWIKI_AGENTS_SNIPPET_END} marker. Repair or remove the markers and retry; the file was left unchanged.`,
    )
  }

  return {
    agentsPath,
    nextContent: `${currentContent.slice(0, startIndex)}${snippet}${currentContent.slice(endIndex + OPENWIKI_AGENTS_SNIPPET_END.length)}`,
  }
}

async function seedRepositoryWikiInstructions(cwd: string): Promise<void> {
  const instructionsPath = path.join(
    cwd,
    OPEN_WIKI_DIR,
    REPOSITORY_INSTRUCTIONS_FILE,
  )
  try {
    const existing = await readFile(instructionsPath, 'utf8')
    if (existing.trim().length > 0) return
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error
    }
  }

  await mkdir(path.dirname(instructionsPath), { recursive: true })
  await writeFile(
    instructionsPath,
    `${DEFAULT_WIKI_GOAL}\n`,
    { encoding: 'utf8', mode: 0o644 },
  )
}

const DEFAULT_WIKI_GOAL = `# OpenWiki Instructions

This repository maintains a generated \`openwiki/\` evidence wiki: factual pages that
ground every material claim in repository resources, with OKF v0.2 front matter and
a Claims sidecar per page.

When maintaining this wiki:

- Treat source code and tests as authoritative. A question's unknowns are
  verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the described behavior.
- Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer
  updating source code and documentation, then regenerating.
`

function createCodeModeAgentsSnippet(): string {
  return `${OPENWIKI_AGENTS_SNIPPET_START}

## OpenWiki

This repository has a generated \`openwiki/\` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The OpenWiki engine refreshes the repository wiki in-process through its lifecycle tools. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

${OPENWIKI_AGENTS_SNIPPET_END}`
}

function createCodeModeClaudeSnippet(): string {
  return `${OPENWIKI_AGENTS_SNIPPET_START}

## OpenWiki

See [AGENTS.md](AGENTS.md) for OpenWiki agent instructions.

${OPENWIKI_AGENTS_SNIPPET_END}`
}
