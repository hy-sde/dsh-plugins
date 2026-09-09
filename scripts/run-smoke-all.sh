#!/usr/bin/env bash
# Run the composition/stock smoke test over every packed rc.1 plugin tarball
# present in any dsh-plugins repo, on both the fork CLI and the upstream stock
# CLI. Repos are auto-discovered (any dir with hy-sde-org-*-0.1.2-rc.1.tgz),
# so newly ported repos join automatically.
set -u
P=/Users/hui/Documents/github/dsh-plugins
SCRIPT=$P/scripts/smoke-plugin.sh
cd "$P"

pass=0; fail=0; skipped=0
for repo in */; do
  repo="${repo%/}"
  [[ "$repo" == scripts ]] && continue
  tarballs=( "$P/$repo"/hy-sde-org-*-0.1.2-rc.1.tgz )
  if [[ ! -e "${tarballs[0]:-}" ]]; then
    echo "SKIP $repo (no rc.1 tarball yet)"
    skipped=$((skipped+1))
    continue
  fi
  for dc in fork upstream; do
    if bash "$SCRIPT" "$dc" "${tarballs[@]}" >/tmp/smoke-$repo-$dc.log 2>&1; then
      echo "PASS $repo [$dc]"
      pass=$((pass+1))
    else
      echo "FAIL $repo [$dc] (see /tmp/smoke-$repo-$dc.log)"
      fail=$((fail+1))
    fi
  done
done
echo "== smoke summary: $pass pass, $fail fail, $skipped skip =="
[[ $fail -eq 0 ]]
