#!/usr/bin/env bash
# eval/scripts/ci-gate.sh
# CI gate: run eval and check delta threshold
#
# Usage:
#   bash eval/scripts/ci-gate.sh --cases eval/dataset/locked/round-01-curated.jsonl --threshold 0.15 --mode soft
#
# Modes:
#   soft  — output warning, exit 0
#   hard  — exit 1 if threshold not met

set -euo pipefail

CASES_FILE="eval/dataset/locked/round-01-curated.jsonl"
THRESHOLD="0.15"
MODE="soft"
OUTPUT="eval/runs/ci-gate"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cases)     CASES_FILE="$2";  shift 2 ;;
    --threshold) THRESHOLD="$2";   shift 2 ;;
    --mode)      MODE="$2";        shift 2 ;;
    --output)    OUTPUT="$2";      shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

echo "=== GitNexus Eval CI Gate ==="
echo "Dataset: $CASES_FILE"
echo "Threshold: delta File F1 >= $THRESHOLD"
echo "Mode: $MODE"
echo ""

# Run eval
python3 eval/run_eval.py --cases "$CASES_FILE" --group both --output "$OUTPUT/raw" --max-steps 10

# Score
python3 eval/score.py --cases "$CASES_FILE" --raw "$OUTPUT/raw" --output "$OUTPUT"

# Extract delta F1
DELTA_F1=$(python3 -c "
import json
with open('$OUTPUT/summary.json') as f:
    s = json.load(f)
print(s.get('delta', {}).get('file_f1', {}).get('delta', 0))
")

# Judge
echo ""
echo "delta File F1: $DELTA_F1 (threshold: $THRESHOLD)"

if python3 -c "exit(0 if float('$DELTA_F1') >= float('$THRESHOLD') else 1)"; then
    echo "PASS: Gate PASSED"
    exit 0
else
    echo "WARN: Gate FAILED: delta File F1 ($DELTA_F1) < threshold ($THRESHOLD)"
    if [[ "$MODE" == "hard" ]]; then
        exit 1
    fi
    echo "Soft mode -- not blocking."
    exit 0
fi
