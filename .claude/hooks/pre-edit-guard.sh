#!/usr/bin/env bash
# GitNexus pre-edit guard — reminds to run gitnexus_impact before editing.
# Fires once per session, only in gitnexus-indexed projects.
# Exit code 0 always (advisory, not blocking edits).

GUARD_FILE="/tmp/gitnexus-impact-guard-$(echo "$PWD" | md5 | head -c 16)"

if [ -f "$GUARD_FILE" ]; then
  exit 0
fi

if [ ! -d ".gitnexus" ]; then
  exit 0
fi

touch "$GUARD_FILE"

echo "[GitNexus Guard] 即将编辑代码。必须先对目标符号运行 gitnexus_impact 评估影响范围。如已评估过或为小改动（测试、注释），可继续。"

exit 0
