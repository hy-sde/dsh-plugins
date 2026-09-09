#!/usr/bin/env bash
# Publish every @hy-sde-org/* package in dependency order.
#
#   bash scripts/publish-all.sh                # check all (no publishing)
#   bash scripts/publish-all.sh --publish      # check all, then publish each (prompts per package)
#
# Order: intra-monorepo dependencies come first (e.g. dsh-vcs before dsh-git,
# dsh-zstd-frame before dsh-memory/dsh-fs-archive).

set -euo pipefail

mode="${1:---check}"
if [[ "$mode" != "--check" && "$mode" != "--publish" ]]; then
  echo "usage: publish-all.sh [--check|--publish]" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "== full workspace gates =="
pnpm install --frozen-lockfile
pnpm -r check
pnpm -r test
pnpm -r build

dirs=()
# capture the order via a file so a guard failure in ordered-packages.mjs
# (e.g. an excluded plugin still a workspace member) aborts this script
node scripts/lib/ordered-packages.mjs > .ordered.tmp || { rm -f .ordered.tmp; exit 1; }
while IFS= read -r d; do dirs+=("$d"); done < .ordered.tmp
rm -f .ordered.tmp
echo "== will process ${#dirs[@]} packages in dependency order =="
if [[ "$mode" == "--check" ]]; then
  for d in "${dirs[@]}"; do
    bash scripts/release-public.sh --check "$d"
  done
  echo "all packages checked OK"
  exit 0
fi

for d in "${dirs[@]}"; do
  echo
  echo ">> publishing $d"
  bash scripts/release-public.sh --publish "$d"
done
echo "all packages published"
