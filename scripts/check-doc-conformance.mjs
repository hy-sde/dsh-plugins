#!/usr/bin/env node
// Doc-conformance gate for dsh-plugins (docs/PLUGIN-README-TEMPLATE.md).
//
// Static checks per public plugin container README.md:
//   1. README.md exists at the container root
//   2. MIRROR-NOTE header block present
//   3. H1 title names DeepSeek Harness
//   4. "## Why" section (the problem, not the mechanism)
//   5. "## Prerequisites" section (pinned versions)
//   6. A quick-start-family section (Quick start / Use / Mounting / Build / Install)
//   7. A License section AND a THIRD-PARTY-NOTICES.md reference
//   8. LICENSE and THIRD-PARTY-NOTICES.md files exist in the container
// Repo-wide: the "ppnpm" typo must not appear in any markdown file.
//
// Usage:
//   node scripts/check-doc-conformance.mjs <pkg-dir>   # one container (release gate)
//   node scripts/check-doc-conformance.mjs --all       # every public container
//
// <pkg-dir> is the release-script convention (dsh-vcs/packages/vcs or
// dsh-web-search-public); the CONTAINER is its first dsh-* path segment.
// Containers listed in scripts/excluded-plugins.list are skipped.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function excludedContainers() {
  const list = join(root, "scripts", "excluded-plugins.list");
  if (!existsSync(list)) return new Set();
  return new Set(
    readFileSync(list, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l.length > 0),
  );
}

function publicContainers() {
  return readdirSync(root)
    .filter((name) => name.startsWith("dsh-") && statSync(join(root, name)).isDirectory())
    .filter((name) => !excludedContainers().has(name))
    .sort();
}

function containerOf(pkgDir) {
  const parts = isAbsolute(pkgDir) ? pkgDir.split(sep) : pkgDir.split("/");
  const idx = parts.findIndex((p) => p.startsWith("dsh-"));
  if (idx === -1) fail(`check-doc-conformance: cannot derive a dsh-* container from "${pkgDir}"`);
  return parts[idx];
}

function checkContainer(name) {
  const dir = join(root, name);
  const problems = [];
  const readmePath = join(dir, "README.md");
  if (!existsSync(readmePath)) return [`no README.md at container root`];
  const text = readFileSync(readmePath, "utf8");

  if (!text.includes("MIRROR-NOTE:START")) problems.push("missing MIRROR-NOTE header block");
  const h1 = text.match(/^# .+$/m)?.[0] ?? "";
  if (!h1.includes("DeepSeek Harness")) problems.push(`H1 does not name DeepSeek Harness: "${h1}"`);
  if (!/^## Why\b/m.test(text)) problems.push('missing "## Why" section');
  if (!/^## Prerequisites\b/m.test(text)) problems.push('missing "## Prerequisites" section');
  if (!/^## (Quick start|Use|Mounting|Build|Install)\b/m.test(text))
    problems.push('missing a quick-start-family section ("## Quick start" / "## Use" / "## Mounting" / "## Build" / "## Install")');
  if (!/^#{1,3} .*Licen/m.test(text)) problems.push("missing a License section heading");
  if (!text.includes("THIRD-PARTY-NOTICES.md")) problems.push("README does not reference THIRD-PARTY-NOTICES.md");
  if (!existsSync(join(dir, "LICENSE"))) problems.push("LICENSE file missing in container");
  if (!existsSync(join(dir, "THIRD-PARTY-NOTICES.md"))) problems.push("THIRD-PARTY-NOTICES.md missing in container");
  return problems;
}

function repoWideTypoSweep() {
  const problems = [];
  const stack = [root];
  const skip = new Set(["node_modules", ".git", "dist"]);
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".tgz")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!skip.has(entry)) stack.push(full);
        continue;
      }
      if (!/\.(md|mdx)$/.test(entry)) continue;
      const rel = full.slice(root.length + 1);
      // The template doc and this script legitimately spell the typo to ban it.
      if (rel === join("docs", "PLUGIN-README-TEMPLATE.md") || rel === join("scripts", "check-doc-conformance.mjs")) continue;
      if (readFileSync(full, "utf8").includes("ppnpm")) problems.push(`ppnpm typo: ${rel}`);
    }
  }
  return problems;
}

const arg = process.argv[2];
if (arg === "--all") {
  const containers = publicContainers();
  let failed = 0;
  for (const name of containers) {
    const problems = checkContainer(name);
    if (problems.length > 0) {
      failed += 1;
      console.log(`FAIL ${name}`);
      for (const p of problems) console.log(`  - ${p}`);
    } else {
      console.log(`ok   ${name}`);
    }
  }
  for (const p of repoWideTypoSweep()) {
    failed += 1;
    console.log(`FAIL (repo-wide) ${p}`);
  }
  console.log(failed === 0 ? `doc-conformance: ALL PASS (${containers.length} containers)` : `doc-conformance: ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

if (!arg) fail("usage: check-doc-conformance.mjs <pkg-dir> | --all");
const container = containerOf(arg);
if (excludedContainers().has(container)) {
  console.log(`doc-conformance: ${container} is excluded (scripts/excluded-plugins.list) — skipped`);
  process.exit(0);
}
const problems = [checkContainer(container).map((p) => `  - ${p}`), repoWideTypoSweep().map((p) => `  - ${p}`)].flat();
if (problems.length > 0) {
  console.error(`doc-conformance refused: ${container} README does not conform to docs/PLUGIN-README-TEMPLATE.md`);
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`doc-conformance: ${container} conforms`);
