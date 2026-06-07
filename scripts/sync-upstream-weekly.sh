#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TARGET_BRANCH="${1:-main}"
UPSTREAM_REMOTE="${2:-fork}"
UPSTREAM_BRANCH="${3:-main}"
UPSTREAM_URL="${4:-git@github.com:abhigyanpatwari/GitNexus.git}"
AUTO_PUSH="${AUTO_PUSH:-0}"

LOG_FILE="$REPO_ROOT/.git/weekly-upstream-sync.log"
{
  echo "$(date '+%Y-%m-%d %H:%M:%S') starting sync ($TARGET_BRANCH <- $UPSTREAM_REMOTE/$UPSTREAM_BRANCH)"

  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "abort: working tree not clean"
    exit 2
  fi

  if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  fi

  git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]; then
    git checkout "$TARGET_BRANCH"
  fi

  if git merge --no-edit -X ours "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"; then
    echo "merge completed"
  else
    echo "merge conflict or failure, aborting to keep local-first safety"
    git merge --abort
    exit 3
  fi

  if [ "$AUTO_PUSH" = "1" ]; then
    git push origin "$TARGET_BRANCH"
  fi

  echo "finished sync"
} | tee -a "$LOG_FILE"
