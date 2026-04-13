#!/usr/bin/env python3
"""
eval/tool-attribution.py
─────────────────────────
Analyse which GitNexus tools were invoked in successful cases and
correlate tool usage with score improvement.

Reads:  eval/results/raw/*_gitnexus.json
        eval/results/scores.jsonl
Writes: eval/results/tool-attribution.md
        eval/results/tool-attribution.json

Usage:
    python eval/tool-attribution.py \
        --raw    eval/results/raw \
        --scores eval/results/scores.jsonl \
        --output eval/results
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path


GITNEXUS_TOOLS = [
    "gitnexus_query",
    "gitnexus_context",
    "gitnexus_impact",
    "gitnexus_shortest_path",
    "gitnexus_get_code",
    "gitnexus_cypher",
    "gitnexus_detect_changes",
    "gitnexus_route_map",
    "gitnexus_test_impact",
]


def load_scores(path: Path) -> dict[str, dict]:
    """Return {case_id: score_dict} for gitnexus group."""
    scores: dict[str, dict] = {}
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            s = json.loads(line)
            if s.get("group") == "gitnexus":
                scores[s["case_id"]] = s
    return scores


def load_raw_gitnexus(raw_dir: Path) -> dict[str, dict]:
    """Return {case_id: raw_result} for all gitnexus runs."""
    results: dict[str, dict] = {}
    for p in raw_dir.glob("*_gitnexus.json"):
        with p.open(encoding="utf-8") as f:
            r = json.load(f)
        case_id = r.get("case_id") or p.stem.replace("_gitnexus", "")
        results[case_id] = r
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="GitNexus tool attribution analysis")
    parser.add_argument("--raw",    default="eval/results/raw")
    parser.add_argument("--scores", default="eval/results/scores.jsonl")
    parser.add_argument("--output", default="eval/results")
    args = parser.parse_args()

    raw_dir   = Path(args.raw)
    out_dir   = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    scores  = load_scores(Path(args.scores))
    raw_gn  = load_raw_gitnexus(raw_dir)

    if not raw_gn:
        print("No gitnexus raw results found.")
        return

    # ── Compute per-tool stats ────────────────────────────────────────────────
    # tool_name → {n_used, f1_when_used, f1_when_not_used}
    tool_stats: dict[str, dict] = {t: {"n_used": 0, "f1_used": [],
                                        "f1_not_used": []} for t in GITNEXUS_TOOLS}

    tool_cooccurrence: dict[tuple[str, str], int] = defaultdict(int)

    for case_id, raw in raw_gn.items():
        score = scores.get(case_id)
        if not score or score.get("api_error") or not score.get("parse_ok"):
            continue

        f1    = score.get("file_f1", 0.0)
        seq   = raw.get("tool_sequence") or []
        pred  = (raw.get("prediction") or {}).get("gitnexus_tools_used") or []
        used_tools = set(seq + pred) & set(GITNEXUS_TOOLS)

        for tool in GITNEXUS_TOOLS:
            if tool in used_tools:
                tool_stats[tool]["n_used"]    += 1
                tool_stats[tool]["f1_used"].append(f1)
            else:
                tool_stats[tool]["f1_not_used"].append(f1)

        # Co-occurrence
        used_list = sorted(used_tools)
        for i, t1 in enumerate(used_list):
            for t2 in used_list[i+1:]:
                tool_cooccurrence[(t1, t2)] += 1

    def mean(vals: list[float]) -> float:
        return round(sum(vals) / len(vals), 4) if vals else 0.0

    # Sort by n_used desc
    sorted_tools = sorted(
        GITNEXUS_TOOLS,
        key=lambda t: tool_stats[t]["n_used"],
        reverse=True,
    )

    # ── Build Markdown report ─────────────────────────────────────────────────
    lines: list[str] = []
    w = lines.append

    total_cases = len(raw_gn)
    w(f"# GitNexus Tool Attribution")
    w(f"")
    w(f"> Total GitNexus cases analysed: {total_cases}")
    w(f"")

    w(f"## Tool Usage Frequency & Impact on File F1")
    w(f"")
    w(f"| Tool | Used (n) | Usage % | F1 when used | F1 when not used | Δ F1 |")
    w(f"|------|----------|---------|--------------|------------------|------|")

    attribution_rows = []
    for tool in sorted_tools:
        s       = tool_stats[tool]
        n_used  = s["n_used"]
        f1_used = mean(s["f1_used"])
        f1_not  = mean(s["f1_not_used"])
        df1     = round(f1_used - f1_not, 4)
        pct     = round(n_used / total_cases * 100, 1) if total_cases else 0.0
        sign    = "+" if df1 >= 0 else ""
        w(f"| `{tool}` | {n_used} | {pct}% | {f1_used:.4f} | {f1_not:.4f} | {sign}{df1:.4f} |")
        attribution_rows.append({
            "tool": tool, "n_used": n_used, "usage_pct": pct,
            "f1_when_used": f1_used, "f1_when_not_used": f1_not, "delta_f1": df1,
        })
    w(f"")

    # ── Top 3 most valuable tools ─────────────────────────────────────────────
    top3 = sorted(attribution_rows, key=lambda r: r["delta_f1"], reverse=True)[:3]
    w(f"## Most Valuable Tools (by Δ F1)")
    w(f"")
    for rank, row in enumerate(top3, 1):
        sign = "+" if row["delta_f1"] >= 0 else ""
        w(f"{rank}. **`{row['tool']}`** — Δ F1 = {sign}{row['delta_f1']:.4f} (used in {row['n_used']} cases)")
    w(f"")

    # ── Co-occurrence ─────────────────────────────────────────────────────────
    if tool_cooccurrence:
        top_pairs = sorted(tool_cooccurrence.items(), key=lambda x: -x[1])[:8]
        w(f"## Tool Co-occurrence (top pairs)")
        w(f"")
        w(f"| Tool A | Tool B | Cases |")
        w(f"|--------|--------|-------|")
        for (t1, t2), count in top_pairs:
            w(f"| `{t1}` | `{t2}` | {count} |")
        w(f"")

    report = "\n".join(lines)
    md_path = out_dir / "tool-attribution.md"
    md_path.write_text(report, encoding="utf-8")
    print(f"✓ Tool attribution → {md_path}")

    # JSON version
    json_path = out_dir / "tool-attribution.json"
    with json_path.open("w", encoding="utf-8") as f:
        json.dump({
            "total_cases": total_cases,
            "tools": attribution_rows,
            "top_cooccurrence": [
                {"t1": k[0], "t2": k[1], "count": v}
                for k, v in sorted(tool_cooccurrence.items(), key=lambda x: -x[1])[:20]
            ],
        }, f, indent=2, ensure_ascii=False)
    print(f"✓ Tool attribution JSON → {json_path}")


if __name__ == "__main__":
    main()
