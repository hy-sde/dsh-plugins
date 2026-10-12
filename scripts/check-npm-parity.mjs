#!/usr/bin/env node
/**
 * npm-parity gate: what the registry PAGE shows must match the repo.
 *
 * For every publishable package (per scripts/lib/ordered-packages.mjs):
 *   1. README.md exists in the publish dir and is non-trivial — npmjs.com
 *      renders the tarball's package/README.md; a missing one shows the
 *      "This package does not have a README" banner (the 2026-10-12 audit
 *      found all 0.2.0-rc.2 tarballs shipped without one).
 *   2. description is non-empty and ≤ 255 chars — the registry hard-truncates
 *      descriptions at 255, so anything longer shows a mid-word cut on the
 *      package page and in search results.
 *
 * Run before any release; scripts/release-public.sh --check runs it too.
 *
 * Usage: node scripts/check-npm-parity.mjs [pkg-dir ...]   (default: all)
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_DESCRIPTION = 255
const MIN_README_BYTES = 100

const args = process.argv.slice(2)
const dirs = args.length > 0
  ? args
  : execFileSync('node', [path.join(root, 'scripts/lib/ordered-packages.mjs')], { cwd: root, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)

const failures = []
const rows = []
for (const dir of dirs) {
  const abs = path.isAbsolute(dir) ? dir : path.join(root, dir)
  const pkg = JSON.parse(readFileSync(path.join(abs, 'package.json'), 'utf8'))
  const name = pkg.name ?? dir
  const readmePath = path.join(abs, 'README.md')
  const problems = []

  if (!existsSync(readmePath)) {
    problems.push('no README.md (npm page would show "does not have a README")')
  } else {
    const size = statSync(readmePath).size
    if (size < MIN_README_BYTES) problems.push(`README.md too small (${size} bytes)`)
  }

  const desc = pkg.description ?? ''
  if (desc.trim().length === 0) {
    problems.push('empty description')
  } else if (desc.length > MAX_DESCRIPTION) {
    problems.push(`description ${desc.length} chars > ${MAX_DESCRIPTION} (registry truncates mid-word)`)
  }

  rows.push(`${problems.length === 0 ? 'ok ' : 'BAD'} ${name} [desc ${desc.length}]`)
  if (problems.length > 0) failures.push(`${name} (${dir}): ${problems.join('; ')}`)
}

console.log(rows.join('\n'))
if (failures.length > 0) {
  console.error(`\nnpm-parity FAIL — ${failures.length} package(s):\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`\nnpm-parity PASS — ${rows.length} package(s)`)
