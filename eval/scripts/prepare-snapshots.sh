#!/usr/bin/env bash
# eval/scripts/prepare-snapshots.sh
# ───────────────────────────────────
# For each case in cases.jsonl, clone the repo at commit_before using
# sparse-checkout (src/ + lib/ only), then run `npx gitnexus analyze`.
#
# Usage:
#   GITHUB_TOKEN=ghp_... bash eval/scripts/prepare-snapshots.sh \
#       --cases eval/dataset/cases.jsonl \
#       --snapshots-dir eval/snapshots \
#       --gitnexus-bin /path/to/gitnexus/dist/cli/index.js
#
# Requirements: git, node, npx, jq, python3

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────────
CASES_FILE="eval/dataset/cases.jsonl"
SNAPSHOTS_DIR="eval/snapshots"
GITNEXUS_BIN=""   # optional: absolute path to gitnexus CLI, falls back to npx gitnexus
SKIP_ANALYZE=0    # set 1 to skip gitnexus analyze (just clone)
FORCE=0           # set 1 to re-prepare already-existing snapshots

# ─── Arg parsing ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cases)         CASES_FILE="$2";      shift 2 ;;
    --snapshots-dir) SNAPSHOTS_DIR="$2";   shift 2 ;;
    --gitnexus-bin)  GITNEXUS_BIN="$2";    shift 2 ;;
    --skip-analyze)  SKIP_ANALYZE=1;       shift   ;;
    --force)         FORCE=1;              shift   ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ─── Helpers ─────────────────────────────────────────────────────────────────

log()  { echo "[prepare] $*"; }
warn() { echo "[prepare][warn] $*" >&2; }

gitnexus_analyze() {
  local dir="$1"
  if [[ -n "$GITNEXUS_BIN" ]]; then
    node "$GITNEXUS_BIN" analyze --dir "$dir"
  else
    (cd "$dir" && npx gitnexus analyze) 2>&1 | grep -v "^$" || true
  fi
}

# ─── Pre-checks ───────────────────────────────────────────────────────────────
for cmd in git node jq python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: required command not found: $cmd" >&2
    exit 1
  fi
done

if [[ ! -f "$CASES_FILE" ]]; then
  echo "ERROR: cases file not found: $CASES_FILE" >&2
  exit 1
fi

mkdir -p "$SNAPSHOTS_DIR"

# ─── Main loop ────────────────────────────────────────────────────────────────
total=0; done_count=0; skipped=0; failed=0

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  total=$((total + 1))

  case_id=$(echo "$line"       | jq -r '.id')
  full_repo=$(echo "$line"     | jq -r '.repo')
  commit_before=$(echo "$line" | jq -r '.commit_before')

  dest="$SNAPSHOTS_DIR/$case_id"

  # Skip if already prepared (unless --force)
  if [[ -d "$dest/.gitnexus" && "$FORCE" -eq 0 ]]; then
    log "SKIP $case_id (already prepared)"
    skipped=$((skipped + 1))
    continue
  fi

  log "Preparing $case_id  repo=$full_repo  commit=$commit_before"

  # ── Clone ──────────────────────────────────────────────────────────────────
  rm -rf "$dest"
  mkdir -p "$dest"

  clone_url="https://github.com/${full_repo}.git"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    clone_url="https://${GITHUB_TOKEN}@github.com/${full_repo}.git"
  fi

  # Shallow clone at commit_before, sparse-checkout src/ lib/ core/ app/
  if ! git clone \
        --depth 1 \
        --no-single-branch \
        --filter=blob:none \
        --sparse \
        "$clone_url" \
        "$dest" 2>&1 | tail -3; then
    warn "Clone failed for $case_id"
    failed=$((failed + 1))
    rm -rf "$dest"
    continue
  fi

  # Checkout the exact commit
  (
    cd "$dest"
    git sparse-checkout set src lib core app pkg cmd internal
    git fetch --depth 1 origin "$commit_before" 2>/dev/null || true
    git checkout "$commit_before" -- 2>/dev/null || git checkout HEAD -- 2>/dev/null || true
  )

  # ── gitnexus analyze ──────────────────────────────────────────────────────
  if [[ "$SKIP_ANALYZE" -eq 0 ]]; then
    log "  Running gitnexus analyze..."
    if ! gitnexus_analyze "$dest"; then
      warn "  gitnexus analyze failed for $case_id (snapshot kept for manual inspection)"
    fi
  fi

  # Write a metadata file so scripts can correlate snapshot → case
  echo "$line" > "$dest/.eval-case.json"

  # Generate snapshot metadata
  SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  python3 -c "
import json, sys, os
sys.path.insert(0, os.path.dirname('${SCRIPT_PATH}') + '/..')
from eval.lib.meta import generate_snapshot_meta
case = json.loads(open('${dest}/.eval-case.json').read())
meta = generate_snapshot_meta(case, __import__('pathlib').Path('${dest}'))
open('${dest}/snapshot-meta.json', 'w').write(json.dumps(meta, indent=2))
" 2>/dev/null || echo "[prepare][warn] snapshot-meta.json generation failed for ${case_id}"

  done_count=$((done_count + 1))
  log "  ✓ $case_id done"

done < "$CASES_FILE"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "  Snapshots prepared: $done_count / $total"
echo "  Skipped (cached):   $skipped"
echo "  Failed:             $failed"
echo "─────────────────────────────────────────────"
