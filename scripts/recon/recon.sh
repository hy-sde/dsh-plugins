#!/usr/bin/env bash
# Recon harness: turn a list of candidate repos into explored, indexed, documented candidates.
#
# For each repo in the registry this:
#   1. shallow-clones it under $HSR_HOME/repos/<name> (or updates an existing clone)
#   2. indexes it into codebase-memory as project "harvest-<name>" (full mode by default)
#   3. scaffolds $HSR_HOME/analysis/<name>.md from ANALYSIS_TEMPLATE.md
#   4. rebuilds $HSR_HOME/inventory.md (status/verdict table parsed from the notes)
#
# Usage:
#   bash scripts/recon/recon.sh                  # clone/update + index + scaffold
#   bash scripts/recon/recon.sh --dry-run        # print the plan, change nothing
#   bash scripts/recon/recon.sh --no-index       # clone/update + scaffold only
#   bash scripts/recon/recon.sh --list other.txt # use a different registry (one-off batch)
#   bash scripts/recon/recon.sh --mode fast      # codebase-memory index mode (default full)
#
# Env:
#   HSR_HOME  scratch root (default $HOME/Documents/github/harvest)
#   HSR_MODE  full | moderate | fast (default full)
#
# NOTE: harvest clones are scratch — local edits are discarded on re-run (fetch + hard reset).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HSR_HOME="${HSR_HOME:-$HOME/Documents/github/harvest}"
HSR_LIST="${HSR_LIST:-$SCRIPT_DIR/repos.list}"
HSR_MODE="${HSR_MODE:-full}"
DRY=0
NO_INDEX=0

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}
# Reuse the file's own header as usage text (lines above), fallback to short text.
usage_short() { cat <<'EOF'
usage: recon.sh [--dry-run] [--no-index] [--list FILE] [--mode full|moderate|fast]
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-index) NO_INDEX=1 ;;
    --list) shift; HSR_LIST="${1:?--list needs a file}";;
    --mode) shift; HSR_MODE="${1:?--mode needs a value}";;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage_short >&2; exit 2 ;;
  esac
  shift
done

case "$HSR_MODE" in full|moderate|fast) ;; *) echo "bad --mode: $HSR_MODE" >&2; exit 2 ;; esac

if [[ ! -f "$HSR_LIST" ]]; then
  echo "registry not found: $HSR_LIST" >&2
  exit 1
fi

INDEXER="$(command -v codebase-memory-mcp || true)"
if [[ -z "$INDEXER" && "$DRY" -eq 0 ]]; then
  echo "codebase-memory-mcp not found on PATH (needed for indexing)" >&2
  echo "install: https://github.com/<codebase-memory> or skip indexing with --no-index" >&2
  exit 1
fi

REPOS_DIR="$HSR_HOME/repos"
ANALYSIS_DIR="$HSR_HOME/analysis"
LOG_DIR="$HSR_HOME/logs"
mkdir -p "$REPOS_DIR" "$ANALYSIS_DIR" "$LOG_DIR"

# --- parse registry -----------------------------------------------------------
declare -a URLS NAMES
while IFS= read -r line; do
  [[ -z "${line// /}" ]] && continue
  [[ "$line" == \#* ]] && continue
  read -r url name <<<"$line"
  [[ -z "${url// }" ]] && continue
  if [[ -z "$name" ]]; then
    seg="${url##*[:/]}"; seg="${seg%.git}"; seg="${seg%/}"
    name="$seg"
  fi
  URLS+=("$url"); NAMES+=("$name")
done <"$HSR_LIST"

if [[ "${#URLS[@]}" -eq 0 ]]; then
  echo "no entries in $HSR_LIST (add one '<url> [name]' per line, # comments ok)"
  exit 0
fi

LOG_FILE="$LOG_DIR/recon-$(date +%Y%m%d-%H%M%S).log"
echo "recon: home=$HSR_HOME mode=$HSR_MODE registry=$HSR_LIST entries=${#URLS[@]}"

# --- main loop ----------------------------------------------------------------
pin_meta() { # $1 file $2 url $3 name $4 index
  sed -e "s|{{REPO_URL}}|$2|g" \
      -e "s|{{REPO_NAME}}|$3|g" \
      -e "s|{{INDEX_NAME}}|$4|g" \
      -e "s|{{DATE}}|$(date +%Y-%m-%d)|g" \
      "$SCRIPT_DIR/ANALYSIS_TEMPLATE.md" >"$1"
}

for i in "${!URLS[@]}"; do
  url="${URLS[$i]}"; name="${NAMES[$i]}"
  dir="$REPOS_DIR/$name"
  idx="harvest-$name"
  analysis="$ANALYSIS_DIR/$name.md"
  echo
  echo "== $name =="
  echo "   url:   $url"
  echo "   clone: $dir"
  echo "   index: $idx"

  if [[ "$DRY" -eq 1 ]]; then
    if [[ -d "$dir/.git" ]]; then
      echo "   (dry) would update clone + index ($idx) + scaffold note"
    else
      echo "   (dry) would clone + index ($idx) + scaffold note"
    fi
    continue
  fi

  # clone / update (scratch: local edits are discarded)
  if [[ ! -d "$dir/.git" ]]; then
    GIT_TERMINAL_PROMPT=0 git clone --depth 1 --quiet -- "$url" "$dir"
    echo "   cloned"
  else
    git -C "$dir" fetch --quiet origin
    git -C "$dir" reset --hard --quiet FETCH_HEAD
    git -C "$dir" clean -fdq >/dev/null 2>&1 || true
    echo "   updated"
  fi

  # index
  if [[ "$NO_INDEX" -eq 1 ]]; then
    echo "   index: skipped (--no-index)"
  else
    if "$INDEXER" cli index_repository --repo-path "$dir" --name "$idx" --mode "$HSR_MODE" >>"$LOG_FILE" 2>&1; then
      echo "   index: ok (project $idx, mode $HSR_MODE)"
    else
      echo "   index: FAILED — see $LOG_FILE" >&2
    fi
  fi

  # scaffold analysis note
  if [[ ! -f "$analysis" ]]; then
    pin_meta "$analysis" "$url" "$name" "$idx"
    echo "   note:  $analysis (scaffolded)"
  else
    echo "   note:  $analysis (exists, kept)"
  fi
done

# --- inventory ----------------------------------------------------------------
INV="$HSR_HOME/inventory.md"
{
  echo "# Harvest inventory"
  echo
  echo "Regenerated $(date '+%Y-%m-%d %H:%M') by scripts/recon/recon.sh"
  echo
  echo "| repo | status | verdict | url |"
  echo "|---|---|---|---|"
  shopt -s nullglob
  for f in "$ANALYSIS_DIR"/*.md; do
    n="$(basename "$f" .md)"
    st="$(awk '/^status:/{print $2; exit}' "$f")"
    vd="$(awk '/^verdict:/{print $2; exit}' "$f")"
    u="$(awk '/^url:/{print $2; exit}' "$f")"
    [[ -z "$st" ]] && st="?"
    [[ -z "$vd" ]] && vd="TBD"
    echo "| $n | $st | $vd | $u |"
  done
} >"$INV"
echo
echo "inventory: $INV"
echo "notes:     $ANALYSIS_DIR/*.md"
echo "next:      fill each analysis note (status: in-progress → explore → verdict), see scripts/recon/README.md"
