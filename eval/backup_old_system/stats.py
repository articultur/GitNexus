#!/usr/bin/env python3
"""Statistical analysis for eval results."""
import argparse
import json
import sys
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from eval.lib.stats import compute_dimension_stats


def main():
    parser = argparse.ArgumentParser(
        description="Compute statistical analysis on eval scores"
    )
    parser.add_argument(
        "--scores",
        default="eval/runs/latest/scores.jsonl",
        help="Path to scored results JSONL file",
    )
    parser.add_argument(
        "--output",
        default="eval/runs/latest/stats.json",
        help="Path to write stats output JSON",
    )
    args = parser.parse_args()

    scores_path = Path(args.scores)
    if not scores_path.exists():
        print(f"Error: scores file not found: {scores_path}", file=sys.stderr)
        sys.exit(1)

    # Load scores from JSONL
    base_scores: list[dict] = []
    gn_scores: list[dict] = []

    with scores_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            group = entry.get("group", "")
            if group == "baseline":
                base_scores.append(entry)
            elif group == "gitnexus":
                gn_scores.append(entry)

    # Pair by case_id
    base_by_id = {s.get("case_id", ""): s for s in base_scores}
    gn_by_id = {s.get("case_id", ""): s for s in gn_scores}
    common_ids = sorted(set(base_by_id) & set(gn_by_id))

    if not common_ids:
        print("Error: no matching case_ids between baseline and gitnexus", file=sys.stderr)
        sys.exit(1)

    paired_base = [base_by_id[cid] for cid in common_ids]
    paired_gn = [gn_by_id[cid] for cid in common_ids]

    # Compute stats for each dimension
    dimensions = ["language", "task_type", "repo", "difficulty"]
    stats: dict[str, dict] = {
        "n_total": len(common_ids),
        "dimensions": {},
    }

    for dim in dimensions:
        stats["dimensions"][dim] = compute_dimension_stats(
            paired_base, paired_gn, dim
        )

    # Write output
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)

    print(f"Stats written to {output_path}")


if __name__ == "__main__":
    main()
