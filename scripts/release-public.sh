#!/usr/bin/env bash
# Shared release guard for the dsh-plugins monorepo.
# Validates ONE package (git clean, name, checks, tests, build, pack, absence on
# npm), then --publish pushes it after a confirmation prompt.
#
# Usage (from the monorepo root):
#   bash scripts/release-public.sh <pkg-dir>                # check mode
#   bash scripts/release-public.sh --publish <pkg-dir>      # publish mode
#
# <pkg-dir> is relative to the monorepo root, e.g. dsh-vcs/packages/vcs
# or dsh-web-search-public (flat-package repos). For ordering across packages
# use scripts/publish-all.sh instead.

set -euo pipefail

mode="${1:---check}"
if [[ "$mode" != "--check" && "$mode" != "--publish" ]]; then
  echo "usage: release-public.sh [--check|--publish] <pkg-dir>" >&2
  exit 2
fi
shift || true
dir="${1:-}"
if [[ -z "$dir" ]]; then
  echo "release refused: <pkg-dir> is required (e.g. dsh-vcs/packages/vcs)" >&2
  exit 2
fi

registry="https://registry.npmjs.org/"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "release refused: not inside a git worktree" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "release refused: git worktree is not clean" >&2
  exit 1
fi

if [[ ! -f "$dir/package.json" || ! -f "$dir/LICENSE" ]]; then
  echo "release refused: $dir/package.json and $dir/LICENSE are required" >&2
  exit 1
fi
package_name="$(node -p "require('./$dir/package.json').name")"
if [[ "$package_name" != @hy-sde-org/* ]]; then
  echo "release refused: unexpected package name $package_name (expected @hy-sde-org/*)" >&2
  exit 1
fi

echo "Validating $package_name from commit $(git rev-parse HEAD)"

pnpm install --frozen-lockfile
pnpm --filter "$package_name" check
pnpm --filter "$package_name" test
pnpm --filter "$package_name" build

package_ref="$package_name@$(node -p "require('./$dir/package.json').version")"
mkdir -p .pack
(cd "$dir" && pnpm pack --pack-destination "$root/.pack")
echo "packed $package_ref"

if [[ "$mode" == "--check" ]]; then
  echo "$package_ref is ready for a public npm publish"
  exit 0
fi

if ! npm whoami --registry "$registry" >/dev/null 2>&1; then
  echo "release refused: run npm login for $registry first" >&2
  exit 1
fi
if ! npm org ls hy-sde-org --json --registry "$registry" >/dev/null 2>&1; then
  echo "release refused: the npm user is not a member of the hy-sde organization" >&2
  exit 1
fi

set +e
view_output="$(npm view "$package_ref" version --json --registry "$registry" 2>&1)"
view_status=$?
set -e
if [[ "$view_status" -eq 0 ]]; then
  echo "release refused: $package_ref already exists on npm" >&2
  exit 1
fi
if [[ "$view_output" != *"E404"* ]]; then
  echo "release refused: could not prove $package_ref is absent from npm" >&2
  echo "$view_output" >&2
  exit 1
fi

printf 'Publish %s to %s? [y/N] ' "$package_ref" "$registry"
read -r answer
if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
  echo "publish cancelled"
  exit 1
fi

# publish via pnpm, NOT npm: pnpm rewrites workspace:* dependency specs to
# their published ranges; raw `npm publish` leaks `workspace:^` into the tarball
(cd "$dir" && pnpm publish --access public --registry "$registry" --no-git-checks)
echo "published $package_ref"
