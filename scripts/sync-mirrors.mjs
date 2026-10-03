#!/usr/bin/env node
// Syncs dsh-plugins plugin dirs to their per-plugin GitHub mirror repos
// (hy-sde/<dir>), so each plugin stays individually discoverable on GitHub
// (search / topics / stars / issues) while the monorepo stays the source of
// truth. Mirror set: scripts/mirrors.list (one dir per line, repo name = dir).
//
//   node scripts/sync-mirrors.mjs                  # split + push every dir to its mirror
//   node scripts/sync-mirrors.mjs --check          # verify only (banner, gh metadata, drift); exit 1 on any drift — publish gate
//   node scripts/sync-mirrors.mjs --stamp          # idempotent GitHub metadata: create missing repos, unarchive, description, topics
//   node scripts/sync-mirrors.mjs --apply-banner   # idempotently write the mirror-note banner into each plugin README (committed in THIS repo)
//
// Flags: --dry (print the plan, write nothing)   --only d1,d2 (subset)
//        --force (allow a non-fast-forward push — history replacement)
//
// Push mechanics: `git subtree split --prefix=<dir> --branch=refs/heads/split/<dir>`
// then push that ref to hy-sde/<dir>.git main. Subtree splits are deterministic,
// so steady-state pushes are fast-forwards. The FIRST push to a repo that still
// has its old pre-consolidation history is a history replacement and needs
// --force once (subsequent runs are FF). Issues/PRs on the mirror survive.
// Release flow: publish-all.sh runs `sync-mirrors.mjs` after a successful publish
// and `--check` in check mode, so mirrors can never silently drift.

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ORG = 'hy-sde'
const BASE_TOPICS = ['dsh', 'dsh-plugin', 'deepseek-harness', 'deepseek']
const MARK_START = '<!-- MIRROR-NOTE:START -->'
const MARK_END = '<!-- MIRROR-NOTE:END -->'

const argv = process.argv.slice(2)
const mode = argv.includes('--check') ? 'check'
  : argv.includes('--stamp') ? 'stamp'
  : argv.includes('--apply-banner') ? 'banner'
  : 'push'
const dry = argv.includes('--dry')
const force = argv.includes('--force')
const onlyIdx = argv.indexOf('--only')
const only = onlyIdx >= 0 ? argv[onlyIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : null

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })

// GitHub-side hand-written descriptions (<=350 chars). Keep the package.json
// descriptions in sync too — the npm page is the other discovery surface.
const DESCRIPTIONS = {
  'dsh-av': 'Read-only Automic Vault plumbing for DeepSeek Harness: the host ctx.av service (av CLI probe, scan/doctor/detectors/hardeners) backing the read-only av tools — standalone plugin, no upstream changes.',
  'dsh-browser': 'Agentic browser plumbing for DeepSeek Harness: ctx.browser service (stealth launch, CDP-attach, local relay + companion extension driving your own tabs) backing the model-facing browser tool.',
  'dsh-code-runtime-kernels': 'The run_kernel_code tool for DeepSeek Harness: persistent Python and JavaScript kernels (a long-lived python3/node subprocess per session, state that survives across calls).',
  'dsh-fs-archive': 'Pure-TS multi-format archive engine for DeepSeek Harness (zip/tar/tar.gz/rar/7z/iso/deb/rpm/cpio/cab/arj/asar + codecs), ported from @oh-my-pi/pi-utils (MIT).',
  'dsh-git': 'Agentic git plumbing for DeepSeek Harness: the host ctx.git service (diff capture/parsing, hunk staging, commit/push/log over the subprocess seam) + the dsh-tool-git test-parity package.',
  'dsh-graph': 'Agent Graph for DeepSeek Harness (durable supervisor): control plane, operator executor, stream layer, projection, wakes, host assembly and supervisor tools — the dsh-graph-* / dsh-tool-graph packages.',
  'dsh-internal-urls': 'Internal URL schemes for DeepSeek Harness (conflict://, pr://, issue://, …): one registry behind fs-shaped tools plus agent-scope read/write/edit and glob/grep shadows resolving internal resources.',
  'dsh-llm-slots': 'Host-wide model-slot admission control (ctx.modelSlots) for DeepSeek Harness: a shared FIFO budget over every model call at the llm/stream waterfall.',
  'dsh-logseq': 'Logseq for DeepSeek Harness: host-plane wiki-graph service (ctx.wikiGraph) over the Logseq CLI plus model-facing logseq_* tools — a headless alternative to the desktop MCP bridge.',
  'dsh-memory': 'Agent-curated long-horizon memory for DeepSeek Harness: durable project-scoped memory banks (ctx.memory) with a provider registry + model-facing retain/recall/reflect/learn tools.',
  'dsh-memory-extraction': 'Automatic long-term-memory extraction at compaction checkpoints for DeepSeek Harness: evidence projection, proposal/canonicalization pipeline, gated ctx.memory writes.',
  'dsh-omp-native': 'Rust sidecar template for DeepSeek Harness native capabilities (stable channel, pinned JSON CLI contract, magic-byte routing) — the dsh-omp-native pattern.',
  'dsh-openwiki': 'OpenWiki 0.4.3 deterministic engine (MIT) as an in-process library for DeepSeek Harness: resumable page-job lifecycle with durable .run state + model-facing openwiki_* lifecycle tools.',
  'dsh-orchestration-policy': 'Parallelize-by-default orchestration policy for DeepSeek Harness: config-driven fan-out rules, fail-closed task-isolation guard, review-gate posture resolution.',
  'dsh-pi-durable': 'Durable-agent engine for DeepSeek Harness: host-plane cordis service mounting @earendil-works/pi-durable (conversations, exactly-once submits) + model-facing durable_agent_* tools.',
  'dsh-session-intelligence': 'The session_health tool for DeepSeek Harness: per-session health intelligence (outcome classification, tool-health signals, prompt-quality heuristics, context pressure).',
  'dsh-session-url': 'session:// internal-URL scheme handler for DeepSeek Harness: read a session transcript, read one event as JSON, list sessions, and search past history.',
  'dsh-tool-ast': 'The ast_grep (structural code search) and ast_edit (structural rewrite) tools for DeepSeek Harness over the packaged ast-grep native engine.',
  'dsh-tool-codebase-memory': 'Model-facing codebase-memory CLI tools for DeepSeek Harness: index repositories and query definitions, callers, call chains, routes and architecture from a knowledge graph.',
  'dsh-tool-debug': 'The debug tool for DeepSeek Harness: a model-facing Debug Adapter Protocol tool with 28 operations (launch/attach, breakpoints, continue/step, evaluate, memory, terminate) + the dsh-dap capability seam.',
  'dsh-tool-edit': 'The rich edit tool for DeepSeek Harness (replace / patch / apply_patch / hashline modes) with embedded format-on-write and diagnostics — plus dsh-hashline, the pure line-anchored patch engine.',
  'dsh-tool-library-search': 'Model-facing library_search tool for DeepSeek Harness: free cross-ecosystem (npm/crates.io/Maven/Go/PyPI/RubyGems + GitHub) "has this already been built?" search.',
  'dsh-tool-subagent-report': 'The child-scoped report tool for continuable in-process subagents on DeepSeek Harness: installs `report` plus its usage guidance into every subagent.',
  'dsh-vcs': 'Native vcs plumbing for DeepSeek Harness: the host ctx.vcs service (pi-vcs CLI resolution + probe, repo-info / rev-diff / staged-diff / worktree operations).',
  'dsh-web-search-public': 'Credential-free concurrent web search fan-out for DeepSeek Harness (Startpage, DuckDuckGo, Ecosia, Google, Mojeek + consensus merging) — the web_search tool.',
  'dsh-zstd-frame': 'Zstandard frame primitives (scan / compress / decompress / multi-frame decoder) shared by the DeepSeek Harness session persistence backend and its tooling.',
}

// ---- mirror set + npm packages per dir --------------------------------------
const mirrors = readFileSync(new URL('./mirrors.list', import.meta.url), 'utf8')
  .split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
if (only) {
  const unknown = only.filter((d) => !mirrors.includes(d))
  if (unknown.length) { console.error(`unknown --only dirs: ${unknown.join(', ')}`); process.exit(2) }
  mirrors.length = 0
  mirrors.push(...only)
}
for (const dir of mirrors) {
  if (!existsSync(path.join(ROOT, dir))) { console.error(`refused: ${dir}/ does not exist in the monorepo`); process.exit(2) }
}

const pkgsByDir = new Map()
for (const p of JSON.parse(sh('pnpm -r list --depth -1 --json'))) {
  if (!p.path || !p.name?.startsWith('@hy-sde-org/')) continue
  const top = (p.path.startsWith(ROOT) ? p.path.slice(ROOT.length + 1) : p.path).split('/')[0]
  if (!pkgsByDir.has(top)) pkgsByDir.set(top, [])
  pkgsByDir.get(top).push(p.name)
}

// Escape a value for embedding in a double-quoted shell argument — backticks
// and $ would otherwise be command-substituted (bit the `report` description).
const shellDq = (s) => s.replace(/([`$"\\])/g, '\\$1')

const descFor = (dir) => DESCRIPTIONS[dir]
  ?? `${dir} — part of the ${ORG}/dsh-plugins monorepo (DeepSeek Harness plugin).`

// ---- GitHub metadata (one batched call) --------------------------------------
function ghRepoMap() {
  const rows = JSON.parse(sh(`gh repo list ${ORG} --limit 200 --json name,isArchived,description,repositoryTopics`))
  return new Map(rows.map((r) => [r.name, r]))
}

// ---- split + push -------------------------------------------------------------
function splitSha(dir) {
  sh(`git subtree split --prefix=${dir} --branch=refs/heads/split/${dir}`)
  return sh(`git rev-parse refs/heads/split/${dir}`).trim()
}
const remoteUrl = (dir) => `git@github.com:${ORG}/${dir}.git`

function remoteMain(dir) {
  try {
    const out = sh(`git ls-remote ${remoteUrl(dir)} refs/heads/main`).trim()
    return { sha: out.split('\t')[0] || '' }
  } catch {
    return { sha: '', missing: true }
  }
}

// ---- banner -------------------------------------------------------------------
function bannerBlock(dir) {
  const names = pkgsByDir.get(dir) ?? []
  const npm = names.length
    ? '\n> npm: ' + names.map((n) => '[`' + n + '`](https://www.npmjs.com/package/' + n + ')').join(' · ')
    : ''
  return `${MARK_START}
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/${ORG}/dsh-plugins) monorepo — file issues & pull requests there.${npm}
${MARK_END}`
}

function bannerReadme(dir) {
  const f = path.join(ROOT, dir, 'README.md')
  const cur = existsSync(f) ? readFileSync(f, 'utf8') : `# ${dir}\n`
  const block = bannerBlock(dir)
  const re = new RegExp(MARK_START + '[\\s\\S]*?' + MARK_END + '\\n?')
  return { f, next: cur.includes(MARK_START) ? cur.replace(re, block + '\n') : block + '\n\n' + cur, had: cur.includes(MARK_START) }
}

// ---- driver -------------------------------------------------------------------
let problems = 0
const fail = (msg) => { console.error('  ✗ ' + msg); problems++ }

for (const dir of mirrors) {
  const label = `${dir} → ${ORG}/${dir}`
  if (mode === 'banner') {
    const { f, next, had } = bannerReadme(dir)
    if (dry) console.log(`[dry] ${had ? 'refresh' : 'prepend'} banner in ${path.relative(ROOT, f)}`)
    else {
      const cur = existsSync(f) ? readFileSync(f, 'utf8') : ''
      if (cur !== next) { writeFileSync(f, next); console.log(`✓ ${had ? 'refreshed' : 'prepended'} banner in ${path.relative(ROOT, f)}`) }
      else console.log(`· ${path.relative(ROOT, f)} already has the banner`)
    }
    continue
  }

  console.log(`\n== ${label} ==`)

  if (mode === 'stamp') {
    const repos = ghRepoMap()
    const meta = repos.get(dir)
    const desc = descFor(dir)
    if (!meta) {
      console.log(dry ? `  [dry] CREATE repo ${ORG}/${dir} (gh repo create --public)` : `  creating repo ${ORG}/${dir}`)
      if (!dry) sh(`gh repo create ${ORG}/${dir} --public --description "${shellDq(desc)}"`)
      continue
    }
    const haveTopics = (meta.repositoryTopics ?? []).map((t) => t.name)
    const missingTopics = BASE_TOPICS.filter((t) => !haveTopics.includes(t))
    if (meta.isArchived) {
      console.log(dry ? '  [dry] gh repo unarchive' : '  unarchiving')
      if (!dry) sh(`gh repo unarchive ${ORG}/${dir} --yes`)
    }
    if (meta.description !== desc) {
      console.log(dry ? `  [dry] gh repo edit --description "${desc}"` : '  setting description')
      if (!dry) sh(`gh repo edit ${ORG}/${dir} --description "${shellDq(desc)}"`)
    }
    if (missingTopics.length) {
      console.log(dry ? `  [dry] gh repo edit ${missingTopics.map((t) => '--add-topic ' + t).join(' ')}` : `  adding topics: ${missingTopics.join(', ')}`)
      if (!dry) sh(`gh repo edit ${ORG}/${dir} ${missingTopics.map((t) => '--add-topic ' + t).join(' ')}`)
    }
    if (!dry) console.log('  ✓ stamped')
    continue
  }

  // push + check both need: split sha, remote head, gh state
  const repos = ghRepoMap()
  const meta = repos.get(dir)
  const repoMissing = !meta
  const archived = meta?.isArchived ?? false
  if ((repoMissing || archived) && !dry) {
    fail(repoMissing ? `no repo ${ORG}/${dir} — run --stamp first` : 'repo is ARCHIVED — run --stamp first')
    continue
  }
  let sha
  try { sha = splitSha(dir) } catch (e) { fail(`subtree split failed: ${e.message}`); continue }
  if (repoMissing && dry) { console.log(`  [dry] FIRST PUSH ${sha.slice(0, 9)} → main (after --stamp creates the repo)`); continue }
  if (archived && dry) console.log('  (plan assumes --stamp unarchives it)')
  const remote = remoteMain(dir)
  if (remote.missing) { fail(`cannot reach ${remoteUrl(dir)}`); continue }

  if (mode === 'check') {
    const bannerOk = existsSync(path.join(ROOT, dir, 'README.md'))
      && readFileSync(path.join(ROOT, dir, 'README.md'), 'utf8').includes(MARK_START)
    const descOk = (meta.description ?? '') === descFor(dir)
    const haveTopics = (meta.repositoryTopics ?? []).map((t) => t.name)
    const topicsOk = BASE_TOPICS.every((t) => haveTopics.includes(t))
    let drift = 'EMPTY'
    if (remote.sha === sha) drift = 'in-sync'
    else if (remote.sha) {
      try { sh(`git fetch -q ${remoteUrl(dir)} main`) } catch { /* handled below */ }
      try {
        sh(`git merge-base --is-ancestor ${remote.sha} refs/heads/split/${dir}`)
        drift = 'mirror behind'
      } catch { drift = 'DIVERGED (needs --force once)' }
    }
    console.log(`  split=${sha.slice(0, 9)} remote=${remote.sha ? remote.sha.slice(0, 9) : '(none)'} drift=${drift} banner=${bannerOk ? 'ok' : 'MISSING'} desc=${descOk ? 'ok' : 'STALE'} topics=${topicsOk ? 'ok' : 'MISSING'}`)
    if (drift !== 'in-sync') fail(`mirror drift: ${drift}`)
    if (!bannerOk) fail(`no ${MARK_START} banner in ${dir}/README.md — run --apply-banner`)
    if (!descOk || !topicsOk) fail('GitHub metadata stale — run --stamp')
    continue
  }

  // push mode
  if (remote.sha === sha) { console.log('  · already in sync'); continue }
  if (!remote.sha) {
    console.log(dry ? `  [dry] FIRST PUSH ${sha.slice(0, 9)} → main (new/empty mirror)` : '  first push…')
    if (!dry) sh(`git push ${remoteUrl(dir)} refs/heads/split/${dir}:refs/heads/main`)
    console.log(dry ? '' : '  ✓ pushed (first)')
    continue
  }
  let ff = false
  try {
    sh(`git fetch -q ${remoteUrl(dir)} main`)
    sh(`git merge-base --is-ancestor ${remote.sha} refs/heads/split/${dir}`)
    ff = true
  } catch { ff = false }
  if (ff) {
    console.log(dry ? `  [dry] FF push ${remote.sha.slice(0, 9)}..${sha.slice(0, 9)} → main` : `  fast-forward ${remote.sha.slice(0, 9)}..${sha.slice(0, 9)}`)
    if (!dry) sh(`git push ${remoteUrl(dir)} refs/heads/split/${dir}:refs/heads/main`)
    console.log(dry ? '' : '  ✓ pushed')
  } else if (force) {
    console.log(`  REPLACING remote history (old pre-consolidation main → split ${sha.slice(0, 9)}); issues/PRs are kept`)
    if (!dry) sh(`git push --force ${remoteUrl(dir)} refs/heads/split/${dir}:refs/heads/main`)
    console.log(dry ? '  [dry] git push --force …' : '  ✓ pushed (forced)')
  } else {
    fail(`remote main (${remote.sha.slice(0, 9)}) diverged from split — rerun with --force once to replace old history`)
  }
}

if (problems) { console.error(`\n${problems} problem(s) — see ✗ lines above`); process.exit(1) }
console.log(`\n${mode === 'check' ? 'all mirrors OK' : mode + ' done'} (${mirrors.length} dirs${dry ? ', dry run' : ''})`)
