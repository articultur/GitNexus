#!/usr/bin/env python3
# eval/claude_eval.py
"""Claude Code CLI based A/B Evaluation

Four scoring dimensions:
1. File Fβ (scope) — weighted must/optional with path normalization
2. Symbol Fβ (precision) — match types (exact/qualified/suffix)
3. Chain similarity (depth) — LCS-based call chain scoring
4. Data flow (propagation) — source/sink/path matching
Composite: 0.30*file + 0.25*symbol + 0.20*chain + 0.25*data_flow
Statistical: Bootstrap CI, Wilcoxon, Cohen's d
"""

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import List, Optional

from eval.lib.agent_executor import AgentExecutor, classify_failure
from eval.lib.difficulty_scorer import DifficultyScorer
from eval.lib.dual_scorer import DualScorer
from eval.lib.stats import bootstrap_ci, cohen_d, wilcoxon_signed_rank_test, compute_dimension_stats
from eval.lib.worktree_manager import WorktreeManager


def parse_args(argv: Optional[List[str]] = None):
    parser = argparse.ArgumentParser(description="Claude Code A/B Evaluation")
    parser.add_argument("--dataset", help="JSONL dataset file")
    parser.add_argument("--case", help="Single case ID")
    parser.add_argument("--repo", help="Repo (e.g., redis/redis)")
    parser.add_argument("--commit", help="Commit SHA")
    parser.add_argument("--issue", help="Issue description")
    parser.add_argument("--run-dir", default="eval/run", help="Intermediate run directory")
    parser.add_argument("--results-dir", default="eval/results", help="Results output directory")
    parser.add_argument("--skip-scoring", action="store_true", help="Only run execution, skip scoring")
    parser.add_argument("--score-only", metavar="RUN_DIR", help="Only run scoring on existing run")
    parser.add_argument("--cleanup", action="store_true", help="Clean up run directory after scoring")
    return parser.parse_args(argv)


def load_cases(dataset_path: str) -> List[dict]:
    """Load cases from JSONL."""
    cases = []
    with open(dataset_path) as f:
        for line in f:
            if line.strip():
                cases.append(json.loads(line))
    return cases


def build_prompt(case: dict, group: str = "baseline") -> str:
    """Build evaluation prompt. GitNexus group gets tool usage instructions."""
    base = f"""You are an expert software engineer analyzing a codebase to locate a bug.

## Repository
Repo: {case['repo']}
Language: {case.get('language', 'unknown')}
Commit: {case.get('commit_before', 'unknown')}

## Issue Description
{case.get('issue_text', '')}

## Task
Find the root cause file, key symbols involved, the call chain that leads to this issue, and trace the data flow.
Output your answer as JSON with the following structure:
{{
  "files": ["list of relevant files in order of relevance"],
  "symbols": ["key function/variable names in order of relevance"],
  "call_chain": ["ordered list of function calls showing the path"],
  "data_flow": {{
    "source": "where the problematic data originates (function or variable)",
    "sinks": ["where it should be consumed/freed/released"],
    "path": ["ordered propagation path from source to sink"]
  }}
}}"""

    if group == "gitnexus":
        base += f"""

## IMPORTANT: Use GitNexus Code Intelligence Tools
You MUST use the available GitNexus MCP tools for your analysis. The repo is registered as "{case['id']}".
Always pass repo="{case['id']}" to every gitnexus tool call.

Follow this workflow:
1. Use `gitnexus_query(query="...", repo="{case['id']}")` to search for code related to the issue
2. Use `gitnexus_context(name="symbolName", repo="{case['id']}")` to get callers, callees, execution flows
3. Use `gitnexus_impact(target="symbolName", direction="upstream", repo="{case['id']}")` to analyze blast radius
4. Use `gitnexus_shortest_path(source_id="...", target_id="...", repo="{case['id']}")` to find call chains

These graph-based tools give you structural understanding that file-reading alone cannot provide.
Start by querying the issue keywords, then drill into the results."""

    elif group == "search_agent":
        base += f"""

## IMPORTANT: Use Standard Code Search Tools
Follow this workflow:
1. Use `Grep` to search for keywords from the issue description
2. Use `Read` to examine relevant function definitions and their callers
3. Use `Glob` to find related files by extension or path pattern
4. Use `Grep` again to trace references to suspected root-cause symbols

These search tools give you keyword-based understanding of the codebase.
Start by grepping for key terms from the issue."""

    base += "\n\nJust analyze the code and output JSON."
    return base


# ─── Phase 1: Execution ───────────────────────────────────────────────────────


def run_execution(dataset_path: str, run_dir: str):
    """Phase 1: Execute all cases and save raw outputs to run_dir."""
    run_path = Path(run_dir)
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    run_id = f"run-{timestamp}"
    current_run_dir = run_path / run_id
    raw_dir = current_run_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    cases = load_cases(dataset_path)
    total = len(cases)
    executed = 0
    errors = 0

    executor = AgentExecutor()
    worktree_mgr = WorktreeManager()

    meta = {
        "run_id": run_id, "dataset": dataset_path,
        "total_cases": total, "timestamp": timestamp,
    }
    (current_run_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    print(f"Starting execution run: {run_id}")
    print(f"Dataset: {dataset_path}, Cases: {total}")
    print("-" * 40)

    for i, case in enumerate(cases, 1):
        case_id = case["id"]
        print(f"[{i}/{total}] Executing: {case_id}")

        worktree = worktree_mgr.create(
            repo=case["repo"], commit=case.get("commit_before", ""), case_id=case_id
        )

        if not worktree.success:
            print(f"  ERROR: worktree failed: {worktree.error}")
            errors += 1
            error_state = {"error": worktree.error, "phase": "worktree"}
            (raw_dir / f"{case_id}_baseline.json").write_text(json.dumps(error_state))
            (raw_dir / f"{case_id}_gitnexus.json").write_text(json.dumps(error_state))
            continue

        for group in ("baseline", "gitnexus"):
            print(f"  {group}...")
            prompt = build_prompt(case, group)
            result = executor.execute(prompt, worktree.path, group)
            (raw_dir / f"{case_id}_{group}.json").write_text(json.dumps({
                "prediction": result.prediction,
                "raw_output": result.raw_output,
                "duration_s": result.duration_s,
                "tokens": result.tokens,
                "success": result.success,
                "error": result.error,
                "tool_calls": result.tool_calls,
                "tool_sequence": result.tool_sequence,
                "failure_bucket": result.failure_bucket,
            }, indent=2))

        worktree_mgr.cleanup(case_id)

        if result.success:
            executed += 1
            print(f"  Done ({result.duration_s:.1f}s)")
        else:
            errors += 1
            print(f"  Done with errors")

    print("-" * 40)
    print(f"Execution complete: {executed}/{total} success, {errors} errors")

    meta["executed"] = executed
    meta["errors"] = errors
    (current_run_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    return str(current_run_dir)


# ─── Phase 2: Scoring ─────────────────────────────────────────────────────────


def _serialize_prf(prf) -> dict:
    return {"precision": prf.precision, "recall": prf.recall, "f_beta": prf.f_beta,
            "tp": prf.tp_count, "fp": prf.fp_count, "fn": prf.fn_count}


def _serialize_df(df) -> dict:
    return {"source_match": df.source_match, "sink_recall": df.sink_recall,
            "path_similarity": df.path_similarity, "composite": df.composite}


def run_scoring(run_dir: str, results_dir: str, cleanup: bool = False):
    """Phase 2: Score all cases and produce report with statistics."""
    run_path = Path(run_dir)
    if not run_path.exists():
        print(f"ERROR: run directory not found: {run_dir}")
        sys.exit(1)

    meta_path = run_path / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {"run_id": run_path.name}

    dataset_path = meta.get("dataset", "")
    cases = {c["id"]: c for c in load_cases(dataset_path)} if dataset_path and Path(dataset_path).exists() else {}

    raw_dir = run_path / "raw"
    if not raw_dir.exists():
        print(f"ERROR: raw directory not found: {raw_dir}")
        sys.exit(1)

    baseline_files = sorted(raw_dir.glob("*_baseline.json"))
    case_ids = sorted(set(f.stem.replace("_baseline", "") for f in baseline_files))

    results_path = Path(results_dir)
    results_path.mkdir(parents=True, exist_ok=True)
    results_file = results_path / f"results-{meta.get('run_id', time.strftime('%Y%m%d-%H%M%S'))}.json"

    difficulty_scorer = DifficultyScorer()
    dual_scorer = DualScorer()

    results = []
    summary = {"total": len(case_ids), "scored": 0, "errors": 0}

    print(f"Scoring run: {run_path.name}")
    print(f"Cases: {len(case_ids)}")
    print("-" * 40)

    for i, case_id in enumerate(case_ids, 1):
        print(f"[{i}/{len(case_ids)}] Scoring: {case_id}")

        b_path = raw_dir / f"{case_id}_baseline.json"
        g_path = raw_dir / f"{case_id}_gitnexus.json"

        if not b_path.exists() or not g_path.exists():
            summary["errors"] += 1
            continue

        b_data = json.loads(b_path.read_text())
        g_data = json.loads(g_path.read_text())

        if not b_data.get("success") or not g_data.get("success"):
            summary["errors"] += 1
            results.append({"case_id": case_id, "error": "execution_failed",
                          "baseline_error": b_data.get("error"), "gitnexus_error": g_data.get("error")})
            continue

        case = cases.get(case_id, {})
        ground_truth = case.get("ground_truth", {})
        diff = difficulty_scorer.score(case)

        dr = dual_scorer.compare(
            b_data.get("prediction", {}), g_data.get("prediction", {}),
            ground_truth, diff.level, case=case,
        )

        results.append({
            "case_id": case_id,
            "difficulty": dr.difficulty.value,
            "language": case.get("language", ""),
            "task_type": case.get("task_type", ""),
            "repo": case.get("repo", ""),
            "is_significant": dr.is_significant,
            # Composite
            "baseline_impact": dr.baseline_impact,
            "gitnexus_impact": dr.gitnexus_impact,
            "delta_impact": dr.delta_impact,
            # Per-dimension
            "baseline_file": _serialize_prf(dr.baseline_file_prf),
            "gitnexus_file": _serialize_prf(dr.gitnexus_file_prf),
            "baseline_symbol": _serialize_prf(dr.baseline_symbol_prf),
            "gitnexus_symbol": _serialize_prf(dr.gitnexus_symbol_prf),
            "baseline_chain": dr.baseline_chain_score,
            "gitnexus_chain": dr.gitnexus_chain_score,
            "baseline_data_flow": _serialize_df(dr.baseline_data_flow),
            "gitnexus_data_flow": _serialize_df(dr.gitnexus_data_flow),
            # MRR
            "baseline_mrr": dr.baseline_mrr,
            "gitnexus_mrr": dr.gitnexus_mrr,
            # Symbol match types
            "baseline_symbol_types": dr.baseline_symbol_match_types,
            "gitnexus_symbol_types": dr.gitnexus_symbol_match_types,
            # FN/FP
            "baseline_fn_files": dr.baseline_file_prf.fn_count,
            "gitnexus_fn_files": dr.gitnexus_file_prf.fn_count,
            "baseline_fp_files": dr.baseline_file_prf.fp_count,
            "gitnexus_fp_files": dr.gitnexus_file_prf.fp_count,
            # Timing
            "baseline_duration_s": b_data.get("duration_s", 0),
            "gitnexus_duration_s": g_data.get("duration_s", 0),
            "baseline_tool_calls": b_data.get("tool_calls", 0),
            "gitnexus_tool_calls": g_data.get("tool_calls", 0),
            # Legacy
            "baseline_f1": dr.baseline_f1,
            "gitnexus_f1": dr.gitnexus_f1,
            "delta_f1": dr.delta_f1,
        })
        summary["scored"] += 1
        print(f"  Done: impact={dr.baseline_impact:.2f} vs {dr.gitnexus_impact:.2f} (delta={dr.delta_impact:+.2f})")

    # Summary stats
    scored = [r for r in results if "error" not in r]
    if scored:
        n = len(scored)
        summary["avg_baseline_impact"] = sum(r["baseline_impact"] for r in scored) / n
        summary["avg_gitnexus_impact"] = sum(r["gitnexus_impact"] for r in scored) / n
        summary["avg_delta_impact"] = sum(r["delta_impact"] for r in scored) / n
        summary["avg_baseline_mrr"] = sum(r["baseline_mrr"] for r in scored) / n
        summary["avg_gitnexus_mrr"] = sum(r["gitnexus_mrr"] for r in scored) / n
        summary["total_baseline_fn"] = sum(r["baseline_fn_files"] for r in scored)
        summary["total_gitnexus_fn"] = sum(r["gitnexus_fn_files"] for r in scored)
        summary["total_baseline_fp"] = sum(r["baseline_fp_files"] for r in scored)
        summary["total_gitnexus_fp"] = sum(r["gitnexus_fp_files"] for r in scored)
        summary["gitnexus_win_rate"] = sum(1 for r in scored if r["delta_impact"] > 0) / n
        summary["baseline_win_rate"] = sum(1 for r in scored if r["delta_impact"] < 0) / n
        summary["tie_rate"] = sum(1 for r in scored if r["delta_impact"] == 0) / n
        # File recall averages
        summary["avg_baseline_file_recall"] = sum(r["baseline_file"]["recall"] for r in scored) / n
        summary["avg_gitnexus_file_recall"] = sum(r["gitnexus_file"]["recall"] for r in scored) / n
        # Legacy
        summary["avg_baseline_f1"] = sum(r["baseline_f1"] for r in scored) / n
        summary["avg_gitnexus_f1"] = sum(r["gitnexus_f1"] for r in scored) / n

        # Statistical significance
        if n >= 3:
            deltas = [r["delta_impact"] for r in scored]
            ci_low, ci_high = bootstrap_ci(deltas)
            wilcoxon = wilcoxon_signed_rank_test(deltas)
            effect = cohen_d(deltas)
            summary["statistics"] = {
                "bootstrap_ci": [round(ci_low, 4), round(ci_high, 4)],
                "wilcoxon_p": round(wilcoxon["p_value"], 4),
                "cohen_d": round(effect, 4),
                "n": n,
            }

        # Per-dimension breakdowns
        for dim in ("language", "task_type", "difficulty", "repo"):
            base_list = [{"impact": r["baseline_impact"], dim: r.get(dim, "")} for r in scored]
            gn_list = [{"impact": r["gitnexus_impact"], dim: r.get(dim, "")} for r in scored]
            dim_stats = compute_dimension_stats(base_list, gn_list, dim, "impact")
            if dim_stats:
                summary[f"by_{dim}"] = dim_stats

    output = {"meta": meta, "summary": summary, "results": results}
    results_file.write_text(json.dumps(output, indent=2))

    print("-" * 40)
    print(f"Scoring complete: {summary['scored']}/{summary['total']} scored, {summary['errors']} errors")
    print(f"Results saved to: {results_file}")

    if cleanup:
        shutil.rmtree(run_path)
        print(f"Cleaned up run directory: {run_path}")

    return results_file


# ─── Main ──────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()

    if args.score_only:
        run_scoring(args.score_only, args.results_dir, args.cleanup)
    elif args.skip_scoring:
        if not args.dataset:
            print("ERROR: --dataset required for execution")
            sys.exit(1)
        run_execution(args.dataset, args.run_dir)
    else:
        if not args.dataset:
            print("ERROR: --dataset required")
            sys.exit(1)
        run_dir = run_execution(args.dataset, args.run_dir)
        print("\n" + "=" * 40)
        print("Starting scoring phase...")
        print("=" * 40 + "\n")
        run_scoring(run_dir, args.results_dir, args.cleanup)


if __name__ == "__main__":
    main()
