// Drives the @hy-sde-org/dsh-openwiki HostSessionManager lifecycle over a real
// repository — the same five-tool flow that @hy-sde-org/dsh-tool-openwiki
// exposes to the model (openwiki_begin → openwiki_submit_plan → loop
// openwiki_next_page + write the page below /openwiki + openwiki_submit_page →
// openwiki_finish) — and leaves the generated wiki in <root>/openwiki.
//
// This script generated the wiki committed as openwiki/ in dsh-plugins.
//
// Usage (from the openwiki package dir):
//   node examples/gen-repo-wiki.mjs /Users/hui/Documents/github/dsh-plugins

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HostSessionManager } from '../dist/index.js'

const root = process.argv[2] ?? process.cwd()
const manager = HostSessionManager.create({ host: 'dsh-plugins', producerActor: 'pipeline' })

const PLAN = [
  {
    path: '/openwiki/plugin-catalog.md',
    title: 'Plugin catalog',
    purpose: 'Survey the capability groups and atomic engine+tool pairs published by this monorepo.',
    seedPaths: ['README.md'],
  },
  {
    path: '/openwiki/workflow.md',
    title: 'Plugin workflow',
    purpose: 'When to build standalone-first vs fork-only, and what private plugins are.',
    seedPaths: ['WORKFLOW.md'],
  },
  {
    path: '/openwiki/publishing.md',
    title: 'Publishing and release',
    purpose: 'How a package is validated and published, and what the release guard enforces.',
    seedPaths: ['scripts/publish-all.sh', 'scripts/release-public.sh', 'plugin-list.txt'],
  },
  {
    path: '/openwiki/private-plugins.md',
    title: 'Private plugins',
    purpose: 'The fail-closed exclusion mechanism and where never-publish plugins live.',
    seedPaths: ['scripts/excluded-plugins.list', 'scripts/publish-all.sh'],
  },
  {
    path: '/openwiki/quickstart.md',
    title: 'Quickstart',
    purpose: 'Entry point: what this monorepo is and the typical commands.',
    seedPaths: ['README.md', 'pnpm-workspace.yaml'],
  },
]

// One claim set per page. Every claim must carry at least one repository
// evidence resource (repo://path#Lstart-Lend), resolved by the engine against
// the actual bytes of that range.
const CLAIMS = {
  '/openwiki/plugin-catalog.md': [
    {
      statement: 'The monorepo organizes every plugin into capability groups in a catalog table.',
      evidence: [{ resource: 'repo://README.md#L22-L54' }],
    },
    {
      statement: 'A group row is atomic: packages from one port or engine+tool pair are documented together.',
      evidence: [{ resource: 'repo://README.md#L23-L27' }],
    },
  ],
  '/openwiki/workflow.md': [
    {
      statement: 'Standalone-first is the default when a capability has a life outside the harness.',
      evidence: [{ resource: 'repo://WORKFLOW.md#L23-L25' }],
    },
    {
      statement: 'Fork-only covers capabilities with no outside life.',
      evidence: [{ resource: 'repo://WORKFLOW.md#L26-L28' }],
    },
    {
      statement: 'Private plugins live outside this repo and are blocked from the publish flow.',
      evidence: [{ resource: 'repo://WORKFLOW.md#L49-L56' }],
    },
  ],
  '/openwiki/publishing.md': [
    {
      statement: 'The release guard requires a clean git worktree, a @hy-sde-org package name and a LICENSE.',
      evidence: [{ resource: 'repo://scripts/release-public.sh#L36-L49' }],
    },
    {
      statement: 'Publishing uses pnpm, not npm, so workspace:^ is rewritten to published ranges.',
      evidence: [{ resource: 'repo://scripts/release-public.sh#L98-L101' }],
    },
    {
      statement: 'publish-all.sh gates the full workspace and processes packages in dependency order.',
      evidence: [{ resource: 'repo://scripts/publish-all.sh#L21-L30' }],
    },
  ],
  '/openwiki/private-plugins.md': [
    {
      statement: 'Private plugins are excluded via scripts/excluded-plugins.list.',
      evidence: [{ resource: 'repo://scripts/excluded-plugins.list#L1-L18' }],
    },
    {
      statement: 'A guard failure in the publish order aborts publish-all instead of silently continuing.',
      evidence: [{ resource: 'repo://scripts/publish-all.sh#L28-L31' }],
    },
    {
      statement: 'Never-publish plugins live in the separate dsh-plugins-private repo.',
      evidence: [{ resource: 'repo://README.md#L13-L17' }],
    },
  ],
  '/openwiki/quickstart.md': [
    {
      statement: 'The repository is one pnpm workspace.',
      evidence: [{ resource: 'repo://pnpm-workspace.yaml#L1-L6' }],
    },
    {
      statement: 'The whole workspace is installed and verified with pnpm install and pnpm -r check.',
      evidence: [{ resource: 'repo://README.md#L69-L80' }],
    },
  ],
}

function pageMarkdown(title, purpose, body) {
  return [
    '---',
    `title: ${title}`,
    'tags:',
    '  - topic',
    '---',
    '',
    `# ${title}`,
    '',
    body.trim(),
    '',
  ].join('\n')
}

const BODY = {
  '/openwiki/plugin-catalog.md': `The catalog in README.md describes every capability as one user story.
Grouped rows are atomic: engine + model-facing tool pairs (git, memory, edit,
internal URLs, debug, browser, av, openwiki, logseq) and same-port clusters such
as the firstmate orchestration trio are mounted together or not at all.

Every row carries its port origin — oh-my-pi, firstmate, openwiki, Logseq,
agentsview or DSH-native — so a capability's lineage is visible at a glance.`,
  '/openwiki/workflow.md': `The decision rule is: does the capability have a life outside the harness?
Yes → standalone-first: build it here, wire it into the fork via file:, verify,
publish, then switch the fork to pkg:version. No → fork-only. Private or
client-bound capabilities are the A case taken further: they never enter this
repo or the publish flow and live in dsh-plugins-private instead.`,
  '/openwiki/publishing.md': `Each package is validated by scripts/release-public.sh (clean worktree,
@hy-sde-org name, LICENSE, check/test/build, pack) and published with pnpm so
workspace:^ dependencies are rewritten to real published ranges. publish-all.sh
runs the full workspace gates first and then walks every package in
dependency order; --check dry-runs the whole pipeline without publishing.`,
  '/openwiki/private-plugins.md': `scripts/excluded-plugins.list is the single exclusion source. The publish
order refuses (fail-closed) if an excluded plugin is still a workspace member,
and publish-all.sh aborts on that refusal instead of silently publishing
nothing. The excluded plugins themselves moved to the separate
dsh-plugins-private repository with their per-plugin git histories archived.`,
  '/openwiki/quickstart.md': `This monorepo holds the standalone @hy-sde-org/dsh-* plugins for DeepSeek
Harness as one git repo and one pnpm workspace.

From the root: pnpm install, pnpm -r check, pnpm -r test, pnpm -r build, and
bash scripts/publish-all.sh --check as the release dry-run.`,
}

async function main() {
  const begun = await manager.begin({ root, mode: 'init' })
  console.log(`begin: ${begun.status} run=${begun.runId} mode=${begun.mode}`)
  const runId = begun.runId

  const planned = await manager.submitPlan({ runId, pages: PLAN })
  console.log(`submit_plan: ${planned.status} totalPages=${planned.totalPages}`)

  let done = 0
  for (;;) {
    const next = await manager.nextPage({ runId })
    if (next.status !== 'pending' || !next.job) {
      console.log(`next_page: ${next.status} — queue empty`)
      break
    }
    const { id, path } = next.job
    const plan = PLAN.find((p) => p.path === path) ?? { title: 'Untitled', purpose: '' }
    await mkdir(join(root, 'openwiki'), { recursive: true })
    await writeFile(
      join(root, path.slice(1)),
      pageMarkdown(plan.title, plan.purpose, BODY[path] ?? ''),
      'utf8',
    )
    const submitted = await manager.submitPage({ runId, jobId: id, claims: CLAIMS[path] ?? [] })
    done += 1
    console.log(`submit_page: ${submitted.status} ${path} remaining=${submitted.remaining}`)
    if (submitted.remaining === 0) break
  }

  const finished = await manager.finish({ runId })
  console.log(`finish: ${finished.status} — ${done} page(s) generated under openwiki/`)
}

await main()
