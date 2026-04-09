#!/usr/bin/env python3
"""eval/run_eval.py — CLI entry point for GitNexus A/B evaluation.

Delegates the multi-turn tool loop to eval.lib.executor.ToolLoopExecutor.
Uses eval.lib.schema for case loading and eval.lib.meta for run metadata.

Usage:
    python eval/run_eval.py \\
        --cases  eval/dataset/validation-seed-cases.jsonl \\
        --group  baseline \\
        --model  anthropic/claude-sonnet-4-5

Environment (any one profile is enough):
     1) OpenRouter:
         OPENROUTER_API_KEY
         OPENROUTER_BASE_URL (optional, default: https://openrouter.ai/api/v1)

     2) MiniMax OpenAI-compatible:
         MINIMAX_API_KEY
         MINIMAX_API_BASE   (optional, default: https://api.minimaxi.com/v1)

     3) Generic OpenAI-compatible:
         OPENAI_API_KEY
         OPENAI_BASE_URL    (optional, default: https://api.openai.com/v1)

     4) Anthropic-style:
         ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import asdict
from pathlib import Path

# Ensure the repo root is on sys.path so `eval.lib.*` imports work
# when running as `python eval/run_eval.py` from the repo root.
_REPO_ROOT = str(Path(__file__).resolve().parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# ─── Load .env ────────────────────────────────────────────────────────────────

try:
    from dotenv import load_dotenv
    _ = load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    _env_path = Path(__file__).parent / ".env"
    if _env_path.exists():
        for _line in _env_path.read_text(encoding="utf-8").splitlines():
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _, _val = _line.partition("=")
                _key = _key.strip()
                _val = _val.strip()
                if _key and _key not in os.environ:
                    os.environ[_key] = _val

# ─── Imports from eval.lib ────────────────────────────────────────────────────

from eval.lib.executor import ToolLoopExecutor, RawResult
from eval.lib.schema import load_cases, compute_dataset_hash
from eval.lib.meta import generate_run_meta, compute_prompt_hashes

# ─── Prompt loading ──────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
PROMPT_BASELINE = (SCRIPT_DIR / "prompts" / "task.md").read_text(encoding="utf-8")
PROMPT_GITNEXUS = (SCRIPT_DIR / "prompts" / "task-with-gitnexus.md").read_text(encoding="utf-8")

# ─── Helpers ──────────────────────────────────────────────────────────────────


def _get_provider_name() -> str:
    """Detect which LLM provider is configured from environment variables."""
    if os.environ.get("OPENROUTER_API_KEY"):
        return "openrouter"
    if os.environ.get("MINIMAX_API_KEY"):
        return "minimax"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "anthropic"
    return "unknown"


# ─── CLI ──────────────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run A/B evaluation for GitNexus effectiveness",
    )

    # Backward-compatible args
    parser.add_argument(
        "--cases", default="eval/dataset/validation-seed-cases.jsonl",
        help="Path to JSONL cases file (default: eval/dataset/validation-seed-cases.jsonl)",
    )
    parser.add_argument(
        "--group", default="both",
        choices=["baseline", "gitnexus", "both"],
        help="Which group(s) to run (default: both)",
    )
    parser.add_argument(
        "--model", default="anthropic/claude-sonnet-4-5",
        help="LLM model identifier (default: anthropic/claude-sonnet-4-5)",
    )
    parser.add_argument(
        "--output", default="eval/runs",
        help="Root output directory (default: eval/runs). Run data goes into {output}/{run_id}/",
    )
    parser.add_argument(
        "--snapshots-dir", default="eval/snapshots",
        help="Directory containing per-case snapshots (default: eval/snapshots)",
    )
    parser.add_argument(
        "--max-tokens", type=int, default=2048,
        help="Max completion tokens per model turn (default: 2048)",
    )
    parser.add_argument(
        "--case-filter", default="",
        help="Only run cases whose id starts with this prefix",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print prompts without calling the API",
    )

    # New args
    parser.add_argument(
        "--resume", action="store_true",
        help="Skip cases whose output file already exists",
    )
    parser.add_argument(
        "--case-ids", default="",
        help="Comma-separated list of case IDs to run (overrides --case-filter)",
    )
    parser.add_argument(
        "--shard-index", type=int, default=0,
        help="Shard index for distributed runs (0-based, default: 0)",
    )
    parser.add_argument(
        "--shard-count", type=int, default=1,
        help="Total number of shards (default: 1, i.e. no sharding)",
    )
    parser.add_argument(
        "--parallelism", type=int, default=1,
        help="Number of cases to run concurrently (default: 1, sequential)",
    )
    parser.add_argument(
        "--retry-count", type=int, default=2,
        help="Retries on transient API errors per model call (default: 2)",
    )
    parser.add_argument(
        "--max-steps", type=int, default=15,
        help="Max tool-loop round-trips per case (default: 15)",
    )
    parser.add_argument(
        "--token-budget", type=int, default=50000,
        help="Per-case token budget (default: 50000)",
    )
    parser.add_argument(
        "--run-id", default="",
        help="Explicit run ID (default: auto-generated timestamp)",
    )
    parser.add_argument(
        "--allow-draft", action="store_true",
        help="Include all case statuses. Without this flag only case_status=locked cases are used.",
    )

    return parser


# ─── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    # Generate run ID and output directories
    run_id = args.run_id or f"run-{time.strftime('%Y%m%d-%H%M%S')}"
    run_dir = Path(args.output) / run_id
    raw_dir = run_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    # Load cases using schema module
    cases_path = Path(args.cases)
    if not cases_path.exists():
        print(f"ERROR: cases file not found: {cases_path}", file=sys.stderr)
        sys.exit(1)

    cases = load_cases(cases_path, status_filter="" if args.allow_draft else "locked")

    # Filter by --case-ids (takes precedence over --case-filter)
    if args.case_ids:
        allowed = set(args.case_ids.split(","))
        cases = [c for c in cases if c["id"] in allowed]
    elif args.case_filter:
        cases = [c for c in cases if c["id"].startswith(args.case_filter)]

    # Shard: select every Nth case for this shard index
    if args.shard_count > 1:
        cases = [c for i, c in enumerate(cases) if i % args.shard_count == args.shard_index]

    if not cases:
        print("No cases to run after filtering/sharding.", file=sys.stderr)
        sys.exit(0)

    # Determine groups
    groups = ["baseline", "gitnexus"] if args.group == "both" else [args.group]
    total_runs = len(cases) * len(groups)
    print(f"Run {run_id}: {len(cases)} cases x {len(groups)} groups = {total_runs} runs")

    # Create executor
    executor = ToolLoopExecutor(
        model=args.model,
        max_steps=args.max_steps,
        token_budget=args.token_budget,
        max_tokens_per_turn=args.max_tokens,
        retry_count=args.retry_count,
    )

    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # ── Async run loop ────────────────────────────────────────────────────────

    async def _run_one(case: dict, group: str) -> tuple[int, int]:
        """Run a single case/group pair. Returns (1, error_count)."""
        out_file = raw_dir / f"{case['id']}_{group}.json"

        # Resume: skip existing results
        if args.resume and out_file.exists():
            print(f"  SKIP {case['id']}/{group} (exists)")
            return 1, 0

        # Dry run: print prompt info without calling API
        if args.dry_run:
            template = PROMPT_GITNEXUS if group == "gitnexus" else PROMPT_BASELINE
            filled = executor._fill_prompt(template, case, args.snapshots_dir)
            print(f"  DRY  {case['id']}/{group}")
            print(f"  {'─' * 58}")
            print(f"  {filled[:300]}...")
            print(f"  {'─' * 58}")
            return 1, 0

        print(f"  RUN  {case['id']}/{group} ...", end="", flush=True)
        template = PROMPT_GITNEXUS if group == "gitnexus" else PROMPT_BASELINE

        result = await executor.run(case, group, args.snapshots_dir, template)

        # Persist result
        with out_file.open("w", encoding="utf-8") as f:
            json.dump(asdict(result), f, indent=2, ensure_ascii=False)

        status = "OK" if not result.error else "ERR"
        print(
            f" {status}  steps={result.steps_used}  "
            f"tokens={result.total_tokens}  {result.duration_s:.1f}s"
        )

        errors = 1 if result.error else 0
        return 1, errors

    async def _run_all() -> tuple[int, int]:
        total = errors = 0

        if args.parallelism <= 1:
            # Sequential execution
            for case in cases:
                for group in groups:
                    t, e = await _run_one(case, group)
                    total += t
                    errors += e
                    # Rate-limit pause
                    await asyncio.sleep(1.0)
        else:
            # Parallel execution with semaphore
            sem = asyncio.Semaphore(args.parallelism)

            async def _guarded(case: dict, group: str) -> tuple[int, int]:
                async with sem:
                    return await _run_one(case, group)

            tasks = []
            for case in cases:
                for group in groups:
                    tasks.append(_guarded(case, group))

            results = await asyncio.gather(*tasks, return_exceptions=True)
            for r in results:
                if isinstance(r, Exception):
                    total += 1
                    errors += 1
                    print(f"  EXCEPTION: {r}")
                else:
                    t, e = r
                    total += t
                    errors += e

        return total, errors

    total, errors = asyncio.run(_run_all())

    # ── Write run-meta.json ───────────────────────────────────────────────────

    finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    run_meta = generate_run_meta(
        run_id=run_id,
        dataset_path=cases_path,
        model=args.model,
        provider=_get_provider_name(),
        prompt_version="2.0.0",
        groups=groups,
        started_at=started_at,
        finished_at=finished_at,
        max_steps=args.max_steps,
        token_budget=args.token_budget,
        parallelism=args.parallelism,
        retry_count=args.retry_count,
        prompt_hashes=compute_prompt_hashes(SCRIPT_DIR / "prompts" / "templates"),
    )
    meta_path = run_dir / "run-meta.json"
    with meta_path.open("w", encoding="utf-8") as f:
        json.dump(run_meta, f, indent=2, ensure_ascii=False)

    print(f"\n{'─' * 40}")
    print(f"Done. {total} runs, {errors} errors.")
    print(f"Run ID: {run_id}")
    print(f"Results: {run_dir}")


if __name__ == "__main__":
    main()
