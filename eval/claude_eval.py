#!/usr/bin/env python3
# eval/claude_eval.py
"""Claude Code CLI based A/B Evaluation"""

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

from eval.lib.agent_executor import AgentExecutor
from eval.lib.difficulty_scorer import DifficultyScorer
from eval.lib.dual_scorer import DualScorer
from eval.lib.worktree_manager import WorktreeManager


def parse_args(argv: Optional[List[str]] = None):
    parser = argparse.ArgumentParser(description="Claude Code A/B Evaluation")
    parser.add_argument("--dataset", help="JSONL dataset file")
    parser.add_argument("--case", help="Single case ID")
    parser.add_argument("--repo", help="Repo (e.g., redis/redis)")
    parser.add_argument("--commit", help="Commit SHA")
    parser.add_argument("--issue", help="Issue description")
    parser.add_argument("--output", default="eval/claude-runs", help="Output directory")
    parser.add_argument("--report", choices=["simple", "full", "both"], default="simple")
    parser.add_argument("--parallelism", type=int, default=1)
    return parser.parse_args(argv)


def load_cases(dataset_path: str) -> List[dict]:
    """Load cases from JSONL."""
    cases = []
    with open(dataset_path) as f:
        for line in f:
            if line.strip():
                cases.append(json.loads(line))
    return cases


def build_prompt(case: dict) -> str:
    """Build evaluation prompt."""
    return f"""You are an expert software engineer analyzing a codebase to locate a bug.

## Repository
Repo: {case['repo']}
Language: {case.get('language', 'unknown')}
Commit: {case.get('commit_before', 'unknown')}

## Issue Description
{case.get('issue_text', '')}

## Task
Find the root cause file, key symbols involved, and the call chain that leads to this issue.
Output your answer as JSON with the following structure:
{{
  "files": ["list of relevant files"],
  "symbols": ["key function/variable names"],
  "call_chain": ["ordered list of function calls showing the path"]
}}

Just analyze the code and output JSON."""


def run_single_case(case: dict, executor: AgentExecutor, worktree_mgr: WorktreeManager) -> Optional[dict]:
    """Run a single case."""
    worktree = worktree_mgr.create(
        repo=case["repo"],
        commit=case.get("commit_before", ""),
        case_id=case["id"]
    )

    if not worktree.success:
        print(f"Failed to create worktree: {worktree.error}")
        return None

    prompt = build_prompt(case)

    baseline_result = executor.execute(prompt, worktree.path, "baseline")
    gitnexus_result = executor.execute(prompt, worktree.path, "gitnexus")

    worktree_mgr.cleanup(case["id"])

    if not baseline_result.success or not gitnexus_result.success:
        return None

    scorer = DifficultyScorer()
    difficulty = scorer.score(case)

    dual_scorer = DualScorer()
    return dual_scorer.compare(
        baseline_result.prediction,
        gitnexus_result.prediction,
        case.get("ground_truth", {}),
        difficulty.level
    )


def main():
    args = parse_args()

    executor = AgentExecutor()
    worktree_mgr = WorktreeManager()
    scorer = DifficultyScorer()

    Path(args.output).mkdir(parents=True, exist_ok=True)

    if args.dataset:
        cases = load_cases(args.dataset)
    elif args.case and args.repo and args.commit:
        cases = [{
            "id": args.case,
            "repo": args.repo,
            "commit_before": args.commit,
            "issue_text": args.issue or "",
            "language": "unknown",
            "ground_truth": {"files": [], "symbols": []}
        }]
    else:
        print("Error: must specify --dataset or --case/--repo/--commit")
        sys.exit(1)

    results = []
    for case in cases:
        print(f"Running: {case['id']}")
        result = run_single_case(case, executor, worktree_mgr)
        if result:
            results.append(result)

    if args.report in ("simple", "both"):
        from eval.report_simple import SimpleReporter
        reporter = SimpleReporter()
        print("\n" + "=" * 40)
        print(reporter.generate(results))

    output_path = Path(args.output) / "results.json"
    with open(output_path, "w") as f:
        json.dump([
            {
                "difficulty": r.difficulty.value,
                "baseline_f1": r.baseline_f1,
                "gitnexus_f1": r.gitnexus_f1,
                "delta_f1": r.delta_f1
            }
            for r in results
        ], f, indent=2)

    print(f"\nResults saved to {output_path}")


if __name__ == "__main__":
    main()
