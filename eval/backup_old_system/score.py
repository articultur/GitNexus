#!/usr/bin/env python3
"""
eval/score.py
─────────────
Score baseline vs gitnexus results against ground truth.

For each case, computes:
  - File Precision, Recall, F1
  - Symbol Hit Rate
  - Tool Call count
  - Token Cost
  - Confidence reported by model

Writes per-case scores to eval/results/scores.jsonl
and aggregate summary to eval/results/summary.json.

Usage:
    python eval/score.py \
        --cases  eval/dataset/cases.jsonl \
        --raw    eval/results/raw \
        --output eval/results \
        --mode   both
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Add eval directory to path so we can import lib.scorer
sys.path.insert(0, str(Path(__file__).parent))

from lib.scorer import (
    load_cases,
    load_raw,
    score_case,
    aggregate,
    compute_delta,
    CaseScore,
    GroupAggregate,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Score GitNexus eval results")
    parser.add_argument("--cases",  default="eval/dataset/cases.jsonl")
    parser.add_argument("--raw",    default="eval/results/raw")
    parser.add_argument("--output", default="eval/results")
    parser.add_argument(
        "--mode",
        choices=["strict", "relaxed", "both"],
        default="both",
        help="Scoring mode: strict (must items only), relaxed (must + optional), or both"
    )
    parser.add_argument(
        "--dataset",
        default="",
        help="Dataset name for results subdirectory, e.g. 'round-01-curated'. "
             "If set, results go to eval/results/{dataset}/{timestamp}/"
    )
    args = parser.parse_args()

    cases    = load_cases(Path(args.cases))
    raw_dir  = Path(args.raw)
    out_dir  = Path(args.output)

    # If --dataset is specified, use results/{dataset}/{timestamp}/ structure
    if args.dataset:
        import time
        timestamp = time.strftime("%Y-%m-%d-%H%M")
        out_dir = out_dir / args.dataset / timestamp
    out_dir.mkdir(parents=True, exist_ok=True)

    all_scores: dict[str, list[CaseScore]] = {"strict": [], "relaxed": []}

    for case_id, case in cases.items():
        for group in ["baseline", "gitnexus"]:
            raw = load_raw(raw_dir, case_id, group)
            if raw is None:
                continue

            # Copy raw result to output directory for evaluation framework
            raw_output_path = out_dir / "raw" / f"{case_id}_{group}.json"
            raw_output_path.parent.mkdir(parents=True, exist_ok=True)
            with raw_output_path.open("w", encoding="utf-8") as f:
                json.dump(raw, f, ensure_ascii=False)

            # Score in both modes if requested
            if args.mode in ["strict", "both"]:
                strict_score = score_case(raw, case, group, mode="strict")
                all_scores["strict"].append(strict_score)

            if args.mode in ["relaxed", "both"]:
                relaxed_score = score_case(raw, case, group, mode="relaxed")
                all_scores["relaxed"].append(relaxed_score)

    if not any(all_scores.values()):
        print("No results found. Run run_eval.py first.", file=sys.stderr)
        sys.exit(1)

    # Process each mode
    for mode, scores in all_scores.items():
        if not scores:
            continue

        # Write per-case scores
        suffix = "-relaxed" if mode == "relaxed" else ""
        scores_path = out_dir / f"scores{suffix}.jsonl"
        with scores_path.open("w", encoding="utf-8") as f:
            from dataclasses import asdict
            for s in scores:
                f.write(json.dumps(asdict(s), ensure_ascii=False) + "\n")
        print(f"✓ Per-case scores ({mode}) → {scores_path}  ({len(scores)} rows)")

        # Aggregate per group
        base_scores = [s for s in scores if s.group == "baseline"]
        gn_scores   = [s for s in scores if s.group == "gitnexus"]

        if base_scores and gn_scores:
            base_agg = aggregate(base_scores)
            gn_agg   = aggregate(gn_scores)
            delta    = compute_delta(base_agg, gn_agg)

            # Collect invalid cases (failed + no_tool_call)
            invalid_cases = []
            for s in scores:
                if s.status in ("failed", "no_tool_call"):
                    invalid_cases.append({"case_id": s.case_id, "group": s.group, "reason": s.status})

            summary = {
                "baseline":  asdict(base_agg),
                "gitnexus":  asdict(gn_agg),
                "delta":     delta,
                "invalid_cases": invalid_cases,
            }

            summary_path = out_dir / f"summary{suffix}.json"
            with summary_path.open("w", encoding="utf-8") as f:
                json.dump(summary, f, indent=2, ensure_ascii=False)
            print(f"✓ Aggregate summary ({mode}) → {summary_path}")

    # Quick console overview (show strict mode by default, or both if available)
    print(f"\n{'─'*60}")
    print(f"  {'Metric':<18} {'Baseline':>10} {'GitNexus':>10} {'Δ':>8} {'%':>7}")
    print(f"{'─'*60}")

    # Use strict mode for overview, fallback to relaxed if strict not available
    overview_scores = all_scores["strict"] if all_scores["strict"] else all_scores["relaxed"]
    if overview_scores:
        base_scores = [s for s in overview_scores if s.group == "baseline"]
        gn_scores   = [s for s in overview_scores if s.group == "gitnexus"]

        if base_scores and gn_scores:
            base_agg = aggregate(base_scores)
            gn_agg   = aggregate(gn_scores)
            delta    = compute_delta(base_agg, gn_agg)

            for metric, vals in delta.items():
                sign = "+" if vals["delta"] >= 0 else ""
                print(f"  {metric:<18} {vals['baseline']:>10.4f} {vals['gitnexus']:>10.4f} "
                      f"{sign}{vals['delta']:>7.4f} {sign}{vals['pct']:>5.1f}%")
    print(f"{'─'*60}")


if __name__ == "__main__":
    main()
