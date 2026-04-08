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
    args = parser.parse_args()

    cases    = load_cases(Path(args.cases))
    raw_dir  = Path(args.raw)
    out_dir  = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Create raw results directory if it doesn't exist
    raw_results_dir = out_dir / "raw"
    raw_results_dir.mkdir(parents=True, exist_ok=True)

    all_scores: dict[str, list[CaseScore]] = {"strict": [], "relaxed": []}

    for case_id, case in cases.items():
        for group in ["baseline", "gitnexus"]:
            raw = load_raw(raw_dir, case_id, group)
            if raw is None:
                continue

            # Copy raw result to output directory for evaluation framework
            raw_output_path = raw_results_dir / f"{case_id}_{group}.json"
            import json
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
            import json
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

            summary = {
                "baseline":  asdict(base_agg),
                "gitnexus":  asdict(gn_agg),
                "delta":     delta,
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
