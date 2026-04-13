#!/usr/bin/env python3
"""
eval/report.py
──────────────
Generate a human-readable Markdown delta report from score summary.

Reads:  eval/results/summary.json  (aggregate metrics)
        eval/results/scores.jsonl  (per-case scores, optional)
        eval/results/stats.json    (statistical significance, optional)
Writes: eval/results/delta-report.md

Usage:
    python eval/report.py \
        --summary eval/results/summary.json \
        --scores  eval/results/scores.jsonl \
        --stats   eval/results/stats.json \
        --output  eval/results/delta-report.md \
        --output-per-language eval/results/per-language-report.md \
        --output-per-task     eval/results/per-task-report.md \
        --output-per-repo     eval/results/per-repo-report.md
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Allow imports from eval/lib
sys.path.insert(0, str(Path(__file__).parent))


# ─── Expected conclusions to verify ──────────────────────────────────────────

HYPOTHESES = [
    ("C1 (main)", "file_f1",    "delta",  0.20,  ">=", "GitNexus improves File F1 by >=0.20"),
    ("C2",       "tool_calls",  "pct",   -30.0,  "<=", "GitNexus reduces tool calls by >=30%"),
    ("C3",       "tokens",      "pct",   -25.0,  "<=", "GitNexus reduces token cost by >=25%"),
]


def verdict(metric_vals: dict, key: str, threshold: float, op: str) -> str:
    val = metric_vals.get(key, 0)
    ok = (val >= threshold) if op == ">=" else (val <= threshold)
    return "PASS CONFIRMED" if ok else "FAIL NOT CONFIRMED"


# ─── Scores.jsonl loader ────────────────────────────────────────────────────

def load_scores(path: Path) -> list[dict]:
    """Load per-case scores from a JSONL file.

    Each line is a serialised CaseScore dataclass.
    Returns an empty list if the file does not exist.
    """
    if not path.exists():
        return []
    scores: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                scores.append(json.loads(line))
    return scores


# ─── Case metadata loader ───────────────────────────────────────────────────

def load_case_metadata(scores: list[dict]) -> dict[str, dict]:
    """Build a case_id -> {repo, language, difficulty, leakage_risk} map
    from scores (they already carry these fields from the dataset)."""
    meta: dict[str, dict] = {}
    for s in scores:
        cid = s.get("case_id", "")
        if cid and cid not in meta:
            meta[cid] = {
                "repo": s.get("repo", ""),
                "language": s.get("language", ""),
                "difficulty": s.get("difficulty", ""),
                "leakage_risk": s.get("leakage_risk", ""),
                "task_type": s.get("task_type", ""),
                "group": s.get("group", ""),
            }
    return meta


# ─── Helper ──────────────────────────────────────────────────────────────────

def _sign(val: float) -> str:
    return "+" if val >= 0 else ""


def _pct(val: float) -> str:
    s = "+" if val >= 0 else ""
    return f"{s}{val:.1f}%"


def _fmt(val: float, decimals: int = 4) -> str:
    return f"{val:.{decimals}f}"


# ─── Dataset Overview ────────────────────────────────────────────────────────

def build_dataset_overview(scores: list[dict]) -> list[str]:
    """Build a table of repos with language, case count, difficulty distribution."""
    lines: list[str] = []
    if not scores:
        return lines

    # De-duplicate cases: each case_id appears twice (baseline + gitnexus)
    case_map: dict[str, dict] = {}
    for s in scores:
        cid = s.get("case_id", "")
        if cid and cid not in case_map:
            case_map[cid] = s

    # Group by repo
    repo_cases: dict[str, list[dict]] = defaultdict(list)
    for s in case_map.values():
        repo_cases[s.get("repo", "unknown")].append(s)

    lines.append("## Dataset Overview")
    lines.append("")
    lines.append("| Repo | Language | Cases (n) | Difficulty Distribution |")
    lines.append("|------|----------|-----------|------------------------|")

    for repo in sorted(repo_cases):
        cases = repo_cases[repo]
        # Primary language (most common)
        lang_counts = Counter(c.get("language", "unknown") for c in cases)
        lang = lang_counts.most_common(1)[0][0] if lang_counts else "unknown"
        n = len(cases)
        diff_counts = Counter(c.get("difficulty", "unknown") for c in cases)
        diff_parts = [f"{d}: {diff_counts.get(d, 0)}" for d in ["easy", "medium", "hard"] if diff_counts.get(d, 0) > 0]
        diff_str = ", ".join(diff_parts) if diff_parts else "N/A"
        lines.append(f"| {repo} | {lang} | {n} | {diff_str} |")

    lines.append("")
    return lines


# ─── Breakdown by Repository ─────────────────────────────────────────────────

def build_repo_breakdown(summary: dict) -> list[str]:
    """Build a by_repo table from summary baselines/gitnexus aggregates."""
    lines: list[str] = []

    base_repo = summary.get("baseline", {}).get("by_repo", {})
    gn_repo = summary.get("gitnexus", {}).get("by_repo", {})
    all_repos = sorted(set(list(base_repo.keys()) + list(gn_repo.keys())))

    if not all_repos:
        return lines

    # Build repo -> language mapping from scores if available, else from repo name heuristics
    repo_lang: dict[str, str] = {}
    for repo in all_repos:
        b = base_repo.get(repo, {})
        g = gn_repo.get(repo, {})
        # Try to get language from the breakdown data (not available, so leave blank)
        repo_lang[repo] = ""

    lines.append("## Breakdown by Repository")
    lines.append("")
    lines.append("| Repo | Language | n | F1 Base | F1 GN | dF1 | Sym Hit Base | Sym Hit GN | dSym Hit |")
    lines.append("|------|----------|---|---------|-------|-----|--------------|------------|----------|")

    for repo in all_repos:
        b = base_repo.get(repo, {})
        g = gn_repo.get(repo, {})
        n_b = b.get("n", 0)
        n_g = g.get("n", 0)
        f1_b = b.get("file_f1", 0.0)
        f1_g = g.get("file_f1", 0.0)
        df1 = f1_g - f1_b
        sh_b = b.get("symbol_hit", 0.0)
        sh_g = g.get("symbol_hit", 0.0)
        dsh = sh_g - sh_b
        lines.append(
            f"| {repo} |  | {n_b} | {_fmt(f1_b)} | {_fmt(f1_g)} "
            f"| {_sign(df1)}{_fmt(df1)} | {_fmt(sh_b)} | {_fmt(sh_g)} "
            f"| {_sign(dsh)}{_fmt(dsh)} |"
        )

    lines.append("")
    return lines


# ─── Failure Analysis ────────────────────────────────────────────────────────

def build_failure_analysis(scores: list[dict]) -> list[str]:
    """Build failure bucket analysis table from per-case scores."""
    lines: list[str] = []
    if not scores:
        return lines

    # Count failure buckets per group
    base_buckets: Counter = Counter()
    gn_buckets: Counter = Counter()

    for s in scores:
        bucket = s.get("failure_bucket", "")
        if not bucket:
            continue
        group = s.get("group", "")
        if group == "baseline":
            base_buckets[bucket] += 1
        elif group == "gitnexus":
            gn_buckets[bucket] += 1

    all_buckets = sorted(set(list(base_buckets.keys()) + list(gn_buckets.keys())))
    if not all_buckets:
        return lines

    lines.append("## Failure Analysis")
    lines.append("")
    lines.append("| Bucket | Baseline (n) | GitNexus (n) |")
    lines.append("|--------|-------------|-------------|")

    for bucket in all_buckets:
        b_n = base_buckets.get(bucket, 0)
        g_n = gn_buckets.get(bucket, 0)
        lines.append(f"| {bucket} | {b_n} | {g_n} |")

    lines.append("")
    return lines


# ─── Statistical Significance ────────────────────────────────────────────────

def build_stats_section(stats: dict) -> list[str]:
    """Build statistical significance table from stats.json data.

    Expected format: {dimension: {value: {delta_mean, ci_low, ci_high,
    p_value, effect_size, n, symbol_delta_mean, strength}}}
    """
    lines: list[str] = []
    if not stats:
        return lines

    lines.append("## Statistical Significance")
    lines.append("")

    for dim_name, dim_values in stats.items():
        if not isinstance(dim_values, dict):
            continue

        lines.append(f"### Dimension: {dim_name}")
        lines.append("")
        lines.append("| Value | dF1 | 95% CI | p-value | Effect Size | n | Strength |")
        lines.append("|-------|-----|--------|---------|-------------|---|----------|")

        for val_name, val_stats in sorted(dim_values.items()):
            if not isinstance(val_stats, dict):
                continue
            delta_mean = val_stats.get("delta_mean", 0)
            ci_low = val_stats.get("ci_low", 0)
            ci_high = val_stats.get("ci_high", 0)
            p_value = val_stats.get("p_value", 1)
            effect_size = val_stats.get("effect_size", 0)
            n = val_stats.get("n", 0)
            strength = val_stats.get("strength", "")

            p_str = f"{p_value:.4f}" if p_value < 0.001 else f"{p_value:.3f}"
            lines.append(
                f"| {val_name} | {_sign(delta_mean)}{_fmt(delta_mean)} "
                f"| [{_fmt(ci_low)}, {_fmt(ci_high)}] "
                f"| {p_str} | {_fmt(effect_size)} | {n} | {strength} |"
            )

        lines.append("")

    return lines


# ─── Strength Summary ────────────────────────────────────────────────────────

def build_strength_summary(stats: dict) -> list[str]:
    """Build a narrative strength summary paragraph from stats."""
    lines: list[str] = []
    if not stats:
        return lines

    lines.append("### Strength Summary")
    lines.append("")

    strong: list[str] = []
    moderate: list[str] = []
    preliminary: list[str] = []
    insufficient: list[str] = []
    no_benefit: list[str] = []

    for dim_name, dim_values in stats.items():
        if not isinstance(dim_values, dict):
            continue
        for val_name, val_stats in dim_values.items():
            if not isinstance(val_stats, dict):
                continue
            strength = val_stats.get("strength", "")
            delta_mean = val_stats.get("delta_mean", 0)
            p_value = val_stats.get("p_value", 1)
            n = val_stats.get("n", 0)

            entry = f"{val_name} (dF1={_sign(delta_mean)}{_fmt(delta_mean)}"
            if p_value < 0.05:
                entry += f", p<0.05"
            else:
                entry += f", p={p_value:.2f}"
            entry += ")"

            if strength == "strong":
                strong.append(entry)
            elif strength == "moderate":
                moderate.append(entry)
            elif strength == "preliminary":
                preliminary.append(entry)
            elif strength == "insufficient_samples":
                insufficient.append(f"{val_name} (n={n})")
            elif strength == "no_benefit":
                no_benefit.append(entry)

    if strong:
        lines.append(f"**Strong benefit:** {'; '.join(strong)}")
    if moderate:
        lines.append(f"**Moderate benefit:** {'; '.join(moderate)}")
    if preliminary:
        lines.append(f"**Preliminary:** {'; '.join(preliminary)}")
    if insufficient:
        lines.append(f"**Insufficient samples:** {'; '.join(insufficient)}")
    if no_benefit:
        lines.append(f"**No benefit:** {'; '.join(no_benefit)}")

    lines.append("")
    return lines


# ─── Cost Summary ────────────────────────────────────────────────────────────

def build_cost_summary(summary: dict) -> list[str]:
    """Build cost summary table from aggregate data."""
    lines: list[str] = []

    base = summary.get("baseline", {})
    gn = summary.get("gitnexus", {})

    # Aggregate cost data
    base_tokens = base.get("avg_tokens", 0)
    gn_tokens = gn.get("avg_tokens", 0)
    base_n = base.get("n_cases", 0)
    gn_n = gn.get("n_cases", 0)

    base_duration = base.get("avg_duration_s", 0)
    gn_duration = gn.get("avg_duration_s", 0)

    # If averages are populated, show them
    if not base_tokens and not gn_tokens:
        # Try to compute from summary fields
        return lines

    lines.append("## Cost Summary")
    lines.append("")
    lines.append("| Group | Avg Tokens/Case | Avg Duration | Avg Tool Calls |")
    lines.append("|-------|----------------|--------------|----------------|")

    for label, agg in [("Baseline", base), ("GitNexus", gn)]:
        n = agg.get("n_cases", 0)
        avg_tok = agg.get("avg_tokens", 0)
        avg_dur = agg.get("avg_duration_s", 0)
        avg_tc = agg.get("avg_tool_calls", 0)
        lines.append(f"| {label} | {avg_tok:,.0f} | {avg_dur:.1f}s | {avg_tc:.1f} |")

    lines.append("")
    return lines


# ─── Cost Summary from scores ────────────────────────────────────────────────

def build_cost_summary_from_scores(scores: list[dict]) -> list[str]:
    """Build cost summary table from per-case scores when summary lacks the data."""
    lines: list[str] = []
    if not scores:
        return lines

    groups: dict[str, list[dict]] = defaultdict(list)
    for s in scores:
        groups[s.get("group", "")].append(s)

    lines.append("## Cost Summary")
    lines.append("")
    lines.append("| Group | Total Tokens | Avg Tokens/Case | Avg Duration | Avg Tool Calls |")
    lines.append("|-------|-------------|----------------|--------------|----------------|")

    for label in ["baseline", "gitnexus"]:
        grp_scores = groups.get(label, [])
        if not grp_scores:
            lines.append(f"| {label} | - | - | - | - |")
            continue
        total_tok = sum(s.get("total_tokens", 0) for s in grp_scores)
        avg_tok = total_tok / len(grp_scores)
        avg_dur = sum(s.get("duration_s", 0) for s in grp_scores) / len(grp_scores)
        avg_tc = sum(s.get("tool_calls", 0) for s in grp_scores) / len(grp_scores)
        lines.append(f"| {label.capitalize()} | {total_tok:,} | {avg_tok:,.0f} | {avg_dur:.1f}s | {avg_tc:.1f} |")

    lines.append("")
    return lines


# ─── Pollution Risk / Data Quality Notes ─────────────────────────────────────

def build_pollution_risk(scores: list[dict]) -> list[str]:
    """Build pollution risk distribution from per-case data."""
    lines: list[str] = []
    if not scores:
        return lines

    # De-duplicate cases
    seen: set[str] = set()
    risk_counts: Counter = Counter()
    total = 0

    for s in scores:
        cid = s.get("case_id", "")
        risk = s.get("leakage_risk", "")
        if not risk or cid in seen:
            continue
        seen.add(cid)
        risk_counts[risk] += 1
        total += 1

    if not risk_counts:
        return lines

    lines.append("## Data Quality Notes")
    lines.append("")

    parts: list[str] = []
    for level in ["low", "medium", "high"]:
        count = risk_counts.get(level, 0)
        if count:
            pct = count / total * 100 if total else 0
            parts.append(f"{level}: {count} ({pct:.0f}%)")

    lines.append(f"Pollution risk distribution: {', '.join(parts)}")
    lines.append("")
    return lines


# ─── Report generation ────────────────────────────────────────────────────────

def build_report(
    summary: dict,
    scores: list[dict],
    stats: Optional[dict],
) -> str:
    base  = summary["baseline"]
    gn    = summary["gitnexus"]
    delta = summary["delta"]
    now   = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    n_base = base.get("n_cases", 0)
    n_gn   = gn.get("n_cases", 0)

    lines: list[str] = []
    w = lines.append

    w(f"# GitNexus Effectiveness -- Delta Report")
    w(f"")
    w(f"> Generated: {now}")
    w(f"> Baseline cases: {n_base} | GitNexus cases: {n_gn}")
    w(f"")

    # ── Dataset Overview ─────────────────────────────────────────────────────
    overview_lines = build_dataset_overview(scores)
    lines.extend(overview_lines)

    # ── Overall metrics ──────────────────────────────────────────────────────
    w(f"## Overall Metrics")
    w(f"")
    w(f"| Metric | Baseline | GitNexus | d | d% |")
    w(f"|--------|----------|----------|----|----|")

    metric_labels = {
        "file_f1":     "File F1",
        "file_prec":   "File Precision",
        "file_recall": "File Recall",
        "symbol_hit":  "Symbol Hit Rate",
        "tool_calls":  "Avg Tool Calls",
        "tokens":      "Avg Token Cost",
        "confidence":  "Avg Confidence",
    }
    for key, label in metric_labels.items():
        if key not in delta:
            continue
        d = delta[key]
        w(f"| {label} | {d['baseline']:.4f} | {d['gitnexus']:.4f} "
          f"| {_sign(d['delta'])}{d['delta']:.4f} | {_pct(d['pct'])} |")
    w(f"")

    # ── Hypothesis verification ───────────────────────────────────────────────
    w(f"## Hypothesis Verification")
    w(f"")
    for h_id, metric_key, val_key, threshold, op, desc in HYPOTHESES:
        if metric_key not in delta:
            continue
        v = verdict(delta[metric_key], val_key, threshold, op)
        actual = delta[metric_key].get(val_key, 0)
        w(f"- **{h_id}** -- {desc}")
        w(f"  - Actual: {_sign(actual)}{actual:.1f}  |  Threshold: {op} {threshold}  |  {v}")
        w(f"")

    # ── By task type ─────────────────────────────────────────────────────────
    base_tt = base.get("by_task_type", {})
    gn_tt   = gn.get("by_task_type", {})
    all_tt  = sorted(set(list(base_tt.keys()) + list(gn_tt.keys())))

    if all_tt:
        w(f"## Breakdown by Task Type")
        w(f"")
        w(f"| Task | n (base) | F1 Baseline | F1 GitNexus | dF1 | Tool Calls d |")
        w(f"|------|----------|-------------|-------------|-----|--------------|")
        for tt in all_tt:
            b = base_tt.get(tt, {})
            g = gn_tt.get(tt, {})
            n_b = b.get("n", 0)
            f1_b = b.get("file_f1", 0.0)
            f1_g = g.get("file_f1", 0.0)
            df1  = f1_g - f1_b
            tc_b = b.get("tool_calls", 0.0)
            tc_g = g.get("tool_calls", 0.0)
            dtc  = tc_g - tc_b
            w(f"| {tt} | {n_b} | {f1_b:.4f} | {f1_g:.4f} "
              f"| {_sign(df1)}{df1:.4f} | {_sign(dtc)}{dtc:.1f} |")
        w(f"")

    # ── By language ───────────────────────────────────────────────────────────
    base_lang = base.get("by_language", {})
    gn_lang   = gn.get("by_language", {})
    all_lang  = sorted(set(list(base_lang.keys()) + list(gn_lang.keys())))

    if all_lang:
        w(f"## Breakdown by Language")
        w(f"")
        w(f"| Language | F1 Baseline | F1 GitNexus | dF1 | Symbol Hit d |")
        w(f"|----------|-------------|-------------|-----|--------------|")
        for lang in all_lang:
            b = base_lang.get(lang, {})
            g = gn_lang.get(lang, {})
            f1_b  = b.get("file_f1", 0.0)
            f1_g  = g.get("file_f1", 0.0)
            df1   = f1_g - f1_b
            sh_b  = b.get("symbol_hit", 0.0)
            sh_g  = g.get("symbol_hit", 0.0)
            dsh   = sh_g - sh_b
            w(f"| {lang} | {f1_b:.4f} | {f1_g:.4f} "
              f"| {_sign(df1)}{df1:.4f} | {_sign(dsh)}{dsh:.4f} |")
        w(f"")

    # ── By repository ─────────────────────────────────────────────────────────
    repo_lines = build_repo_breakdown(summary)
    lines.extend(repo_lines)

    # ── By difficulty ────────────────────────────────────────────────────────
    base_diff = base.get("by_difficulty", {})
    gn_diff   = gn.get("by_difficulty", {})
    all_diff  = [d for d in ["easy", "medium", "hard"]
                 if d in base_diff or d in gn_diff]

    if all_diff:
        w(f"## Breakdown by Difficulty")
        w(f"")
        w(f"| Difficulty | n | F1 Baseline | F1 GitNexus | dF1 |")
        w(f"|------------|---|-------------|-------------|-----|")
        for diff in all_diff:
            b = base_diff.get(diff, {})
            g = gn_diff.get(diff, {})
            nb   = b.get("n", 0)
            f1_b = b.get("file_f1", 0.0)
            f1_g = g.get("file_f1", 0.0)
            df1  = f1_g - f1_b
            w(f"| {diff} | {nb} | {f1_b:.4f} | {f1_g:.4f} | {_sign(df1)}{df1:.4f} |")
        w(f"")

    # ── Failure Analysis ──────────────────────────────────────────────────────
    failure_lines = build_failure_analysis(scores)
    lines.extend(failure_lines)

    # ── Statistical Significance ─────────────────────────────────────────────
    if stats:
        stats_lines = build_stats_section(stats)
        lines.extend(stats_lines)

        strength_lines = build_strength_summary(stats)
        lines.extend(strength_lines)

    # ── Cost Summary ──────────────────────────────────────────────────────────
    # Try summary first, fall back to scores
    cost_lines = build_cost_summary(summary)
    if not cost_lines:
        cost_lines = build_cost_summary_from_scores(scores)
    lines.extend(cost_lines)

    # ── Pollution Risk ────────────────────────────────────────────────────────
    pollution_lines = build_pollution_risk(scores)
    lines.extend(pollution_lines)

    # ── Parse / error rates ───────────────────────────────────────────────────
    w(f"## Data Quality")
    w(f"")
    w(f"| Group | Cases | Parse OK | API Errors |")
    w(f"|-------|-------|----------|------------|")
    for label, agg in [("Baseline", base), ("GitNexus", gn)]:
        n   = agg.get("n_cases", 0)
        ok  = agg.get("n_parse_ok", 0)
        err = agg.get("n_api_error", 0)
        w(f"| {label} | {n} | {ok} | {err} |")
    w(f"")

    w(f"---")
    w(f"")
    w(f"*See `eval/results/tool-attribution.md` for per-tool GitNexus usage breakdown.*")

    return "\n".join(lines)


# ─── Per-dimension sub-report ────────────────────────────────────────────────

def build_dimension_subreport(
    dimension: str,
    summary: dict,
    scores: list[dict],
    stats: Optional[dict],
) -> str:
    """Build a standalone sub-report for a single dimension.

    Args:
        dimension: One of 'language', 'task_type', 'repo'.
        summary: The full summary dict.
        scores: Per-case scores list.
        stats: Optional stats dict with dimension data.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines: list[str] = []
    w = lines.append

    dim_title = {"language": "Language", "task_type": "Task Type", "repo": "Repository"}.get(dimension, dimension)
    dim_key = f"by_{dimension}"

    w(f"# GitNexus -- Per-{dim_title} Breakdown")
    w(f"")
    w(f"> Generated: {now}")
    w(f"")

    base = summary.get("baseline", {})
    gn = summary.get("gitnexus", {})

    base_dim = base.get(dim_key, {})
    gn_dim = gn.get(dim_key, {})
    all_vals = sorted(set(list(base_dim.keys()) + list(gn_dim.keys())))

    # ── Overview ─────────────────────────────────────────────────────────────
    w(f"## Overview")
    w(f"")
    w(f"| {dim_title} | n | F1 Base | F1 GN | dF1 | Sym Hit Base | Sym Hit GN | dSym Hit | Tool Calls d |")
    w(f"|{'-' * (len(dim_title) + 2)}|---|---------|-------|-----|--------------|------------|----------|--------------|")

    for val in all_vals:
        b = base_dim.get(val, {})
        g = gn_dim.get(val, {})
        n_b = b.get("n", 0)
        f1_b = b.get("file_f1", 0.0)
        f1_g = g.get("file_f1", 0.0)
        df1 = f1_g - f1_b
        sh_b = b.get("symbol_hit", 0.0)
        sh_g = g.get("symbol_hit", 0.0)
        dsh = sh_g - sh_b
        tc_b = b.get("tool_calls", 0.0)
        tc_g = g.get("tool_calls", 0.0)
        dtc = tc_g - tc_b
        w(
            f"| {val} | {n_b} | {_fmt(f1_b)} | {_fmt(f1_g)} "
            f"| {_sign(df1)}{_fmt(df1)} | {_fmt(sh_b)} | {_fmt(sh_g)} "
            f"| {_sign(dsh)}{_fmt(dsh)} | {_sign(dtc)}{dtc:.1f} |"
        )
    w(f"")

    # ── Failure buckets per dimension value ──────────────────────────────────
    if scores:
        # Group scores by dimension
        dim_scores: dict[str, list[dict]] = defaultdict(list)
        for s in scores:
            key = s.get(dimension, "unknown")
            dim_scores[key].append(s)

        w(f"## Failure Buckets by {dim_title}")
        w(f"")

        all_buckets: set[str] = set()
        bucket_data: dict[str, dict[str, Counter]] = {}
        for val in all_vals:
            val_scores = dim_scores.get(val, [])
            base_bk: Counter = Counter()
            gn_bk: Counter = Counter()
            for s in val_scores:
                bucket = s.get("failure_bucket", "")
                if not bucket:
                    continue
                if s.get("group") == "baseline":
                    base_bk[bucket] += 1
                else:
                    gn_bk[bucket] += 1
            all_buckets.update(base_bk.keys())
            all_buckets.update(gn_bk.keys())
            bucket_data[val] = {"baseline": base_bk, "gitnexus": gn_bk}

        if all_buckets:
            sorted_buckets = sorted(all_buckets)
            header = f"| {dim_title} |"
            sep = f"|{'-' * (len(dim_title) + 2)}|"
            for bucket in sorted_buckets:
                header += f" {bucket} (B) | {bucket} (GN) |"
                sep += "---------|---------|"
            w(header)
            w(sep)

            for val in all_vals:
                row = f"| {val} |"
                bd = bucket_data.get(val, {"baseline": Counter(), "gitnexus": Counter()})
                for bucket in sorted_buckets:
                    row += f" {bd['baseline'].get(bucket, 0)} | {bd['gitnexus'].get(bucket, 0)} |"
                w(row)
            w(f"")

    # ── Stats for this dimension ─────────────────────────────────────────────
    if stats and dimension in stats:
        dim_stats = {dimension: stats[dimension]}
        stats_lines = build_stats_section(dim_stats)
        lines.extend(stats_lines)
        strength_lines = build_strength_summary(dim_stats)
        lines.extend(strength_lines)

    return "\n".join(lines)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Generate GitNexus delta report")
    parser.add_argument("--summary", default="eval/results/summary.json",
                        help="Path to summary.json")
    parser.add_argument("--scores", default="eval/results/scores.jsonl",
                        help="Path to scores.jsonl (optional, enables repo breakdown & failure analysis)")
    parser.add_argument("--stats", default="",
                        help="Path to stats.json (optional, enables statistical significance)")
    parser.add_argument("--output",  default="eval/results/delta-report.md",
                        help="Path for the main delta report")
    parser.add_argument("--output-per-language", default="",
                        help="Path for per-language sub-report (optional)")
    parser.add_argument("--output-per-task", default="",
                        help="Path for per-task sub-report (optional)")
    parser.add_argument("--output-per-repo", default="",
                        help="Path for per-repo sub-report (optional)")
    args = parser.parse_args()

    # ── Load summary ─────────────────────────────────────────────────────────
    summary_path = Path(args.summary)
    if not summary_path.exists():
        print(f"ERROR: summary not found: {summary_path}. Run score.py first.",
              file=sys.stderr)
        raise SystemExit(1)

    with summary_path.open(encoding="utf-8") as f:
        summary = json.load(f)

    # ── Load scores (optional) ───────────────────────────────────────────────
    scores_path = Path(args.scores) if args.scores else None
    scores: list[dict] = load_scores(scores_path) if scores_path else []
    if scores:
        print(f"  Loaded {len(scores)} score records from {scores_path}")

    # ── Load stats (optional) ────────────────────────────────────────────────
    stats: Optional[dict] = None
    if args.stats:
        stats_path = Path(args.stats)
        if stats_path.exists():
            with stats_path.open(encoding="utf-8") as f:
                stats = json.load(f)
            print(f"  Loaded stats from {stats_path}")
        else:
            print(f"  WARNING: stats not found: {stats_path}", file=sys.stderr)

    # ── Generate main report ─────────────────────────────────────────────────
    report = build_report(summary, scores, stats)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(report, encoding="utf-8")
    print(f"  Delta report -> {out_path}")

    # ── Generate per-dimension sub-reports ────────────────────────────────────
    dim_outputs = [
        ("language", args.output_per_language),
        ("task_type", args.output_per_task),
        ("repo", args.output_per_repo),
    ]

    for dimension, output_path in dim_outputs:
        if not output_path:
            continue
        sub_report = build_dimension_subreport(dimension, summary, scores, stats)
        sub_path = Path(output_path)
        sub_path.parent.mkdir(parents=True, exist_ok=True)
        sub_path.write_text(sub_report, encoding="utf-8")
        print(f"  Per-{dimension} report -> {sub_path}")


if __name__ == "__main__":
    main()
