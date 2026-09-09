#!/usr/bin/env bash
# smoke-plugin.sh — install packed standalone dsh plugins into a fresh temp
# profile and verify the composed profile tree mounts them, using either the
# hy-sde fork CLI (composition environment) or the upstream stock CLI.
#
# usage: smoke-plugin.sh <fork|upstream> <tarball-or-pkgdir>...
#   fork      run the fork CLI (apps/cli/src/bin.ts in the fork checkout)
#   upstream  run the upstream stock CLI (apps/cli/src/bin.ts in the upstream checkout)
#
# The profile is pre-initialized (mirroring app-boot's initProfile) with
# pnpm.overrides mapping each tarball's package name to its local file:, so
# repo-internal peer chains (@hy-sde-org/dsh-browser <-> .../tool-browser)
# resolve against the not-yet-published rc.1 tarballs; after the user
# publishes, plain `dsh plugin add <pkg>` works the same way.
# --config.dangerouslyAllowAllBuilds=true lets transitive build scripts run in
# this throwaway profile (a real user runs `pnpm approve-builds`).
# Exit 0 only if add and `dsh --profile <name> --dump-config` both succeed.
set -euo pipefail

DC="${1:?usage: smoke-plugin.sh <fork|upstream> <tarball...>}"
shift || true

case "$DC" in
  fork) ROOT="/Users/hui/Documents/github/deepseek-harness" ;;
  upstream) ROOT="/Users/hui/Documents/github_upstream/deepseek-harness" ;;
  *) echo "unknown dc '$DC'" >&2; exit 2 ;;
esac
CLI="$ROOT/apps/cli/src/bin.ts"
TSX="$ROOT/node_modules/.bin/tsx"

PROFILE="smoke"
if [[ ${#@} -eq 0 ]]; then
  echo "usage: smoke-plugin.sh <fork|upstream> <tarball...>" >&2
  exit 2
fi
if [[ ! -f "$CLI" || ! -x "$TSX" ]]; then
  echo "error: tsx/bin.ts not found in $ROOT (need node_modules with tsx)" >&2
  exit 3
fi

DSH_HOME="$(mktemp -d)"
export DSH_HOME
PROF="$DSH_HOME/profiles/$PROFILE"
mkdir -p "$PROF"
echo "DSH_HOME=$DSH_HOME  profile=$PROFILE  dc=$DC"

specs=()
for spec in "$@"; do
  abs="$(cd "$(dirname "$spec")" && pwd)/$(basename "$spec")"
  specs+=("$abs")
done

# Pre-initialize the profile (mirrors @deepseek-ai/dsh-app-boot initProfile,
# including DEFAULT_PROFILE_BUNDLES so the composed tree includes the standard
# base on top of which the plugin row mounts). Overrides go in pnpm-workspace.yaml
# (pnpm 11 reads them from there, not package.json); see smoke-init-profile.mjs.
node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-init-profile.mjs" "$PROF" "${specs[@]}"
cat > "$PROF/cordis.patch.yml" <<'YAML'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
YAML

echo "--- add ${#specs[@]} tarball(s)"
# Run from the harness root so tsx picks up the checkout's tsconfig paths
# (e.g. @deepseek-ai/cordis -> vendor/cordis/src).
if ! (cd "$ROOT" && "$TSX" "$CLI" plugin --profile "$PROFILE" add --config.dangerouslyAllowAllBuilds=true "${specs[@]}") >/tmp/smoke-add.log 2>&1; then
  echo "FAIL add (see /tmp/smoke-add.log)"
  tail -30 /tmp/smoke-add.log >&2
  exit 1
fi

echo "--- dump-config $PROFILE"
if ! (cd "$ROOT" && "$TSX" "$CLI" --profile "$PROFILE" --dump-config) >/tmp/smoke-dump.log 2>&1; then
  echo "FAIL dump-config (see /tmp/smoke-dump.log)"
  tail -30 /tmp/smoke-dump.log >&2
  exit 1
fi
lines=$(wc -l </tmp/smoke-dump.log | tr -d ' ')
echo "OK   ${specs[*]} ($lines composed rows)"
echo "SMOKE PASS ($DC/$PROFILE)"
