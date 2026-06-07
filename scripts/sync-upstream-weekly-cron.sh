#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYNC_SCRIPT="$REPO_ROOT/scripts/sync-upstream-weekly.sh"
CRON_TAG="# gitnexus weekly upstream sync"
CRON_SCHEDULE="0 3 * * 1"
CRON_ENV="PATH=/usr/bin:/bin:/usr/sbin:/sbin"
CRON_CMD="cd \"$REPO_ROOT\" && bash \"$SYNC_SCRIPT\" >> \"$REPO_ROOT/.git/weekly-upstream-sync.log\" 2>&1"
CRON_LINE="$CRON_SCHEDULE $CRON_CMD"

if ! command -v crontab >/dev/null 2>&1; then
  echo "crontab is not available on this system"
  exit 1
fi

TMP_FILE="$(mktemp)"
crontab -l 2>/dev/null | grep -v "$CRON_TAG" > "$TMP_FILE" || true

printf "%s\n%s %s\n" "$CRON_ENV" "$CRON_LINE" "$CRON_TAG" >> "$TMP_FILE"
crontab "$TMP_FILE"
rm -f "$TMP_FILE"

echo "installed weekly merge task: $CRON_LINE"
