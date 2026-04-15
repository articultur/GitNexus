#!/usr/bin/env bash
# GitNexus pre-edit guard — reminds to run gitnexus_impact before editing
# Fires once per session, only in gitnexus-indexed projects

GUARD_FILE="/tmp/gitnexus-impact-guard-$(echo "$PWD" | md5 | head -c 16)"

# Already reminded this session
if [ -f "$GUARD_FILE" ]; then
  exit 0
fi

# Not a gitnexus project
if [ ! -d ".gitnexus" ]; then
  exit 0
fi

# Mark as reminded
touch "$GUARD_FILE"

# Inject reminder
echo "<system-reminder>"
echo "[GitNexus Guard] 即将编辑代码。建议先对目标符号运行 gitnexus_impact 评估影响范围。"
echo "如已评估过或为小改动（测试、注释），可继续。"
echo "</system-reminder>"