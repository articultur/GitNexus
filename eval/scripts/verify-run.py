#!/usr/bin/env python3
"""Verify that a completed eval run has consistent and complete artifacts.

Checks:
  1. run-meta.json exists and has required fields
  2. Every case × group pair has a raw result file
  3. No raw result files have errors (optional: warn-only)
  4. Dataset hash matches the frozen dataset
  5. Prompt hashes in run-meta match current template files

Usage:
    python eval/scripts/verify-run.py --run-dir eval/runs/run-20260409-120000
    python eval/scripts/verify-run.py --run-dir eval/runs/run-20260409-120000 --strict
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

_REPO_ROOT = str(Path(__file__).resolve().parent.parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from eval.lib.schema import compute_dataset_hash

REQUIRED_META_FIELDS = [
    "run_id", "dataset_name", "dataset_hash", "cases_count",
    "groups", "model_id", "provider", "prompt_version",
    "started_at", "finished_at", "max_steps", "token_budget",
]


def _hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def verify(run_dir: Path, *, dataset_dir: Path, templates_dir: Path, strict: bool) -> list[str]:
    """Return list of issues. Empty = all good."""
    issues: list[str] = []

    # ── 1. run-meta.json ─────────────────────────────────────────────────────
    meta_path = run_dir / "run-meta.json"
    if not meta_path.exists():
        issues.append("CRITICAL: run-meta.json not found")
        return issues  # can't continue without meta

    with meta_path.open(encoding="utf-8") as f:
        meta = json.load(f)

    for field in REQUIRED_META_FIELDS:
        if field not in meta:
            issues.append(f"ERROR: run-meta.json missing field: {field}")

    # ── 2. Raw result completeness ───────────────────────────────────────────
    raw_dir = run_dir / "raw"
    if not raw_dir.is_dir():
        issues.append("CRITICAL: raw/ directory not found")
        return issues

    groups = meta.get("groups", [])
    cases_count = meta.get("cases_count", 0)
    raw_files = list(raw_dir.glob("*.json"))
    expected_count = cases_count * len(groups)

    if len(raw_files) != expected_count:
        issues.append(
            f"WARNING: expected {expected_count} raw files "
            f"({cases_count} cases × {len(groups)} groups), "
            f"found {len(raw_files)}"
        )

    # ── 3. Check for errors in raw results ───────────────────────────────────
    error_cases: list[str] = []
    for rf in sorted(raw_files):
        with rf.open(encoding="utf-8") as f:
            result = json.load(f)
        if result.get("error"):
            error_cases.append(rf.stem)

    if error_cases:
        level = "ERROR" if strict else "WARNING"
        issues.append(
            f"{level}: {len(error_cases)} raw results have errors: "
            f"{', '.join(error_cases[:5])}"
            f"{'...' if len(error_cases) > 5 else ''}"
        )

    # ── 4. Dataset hash verification ─────────────────────────────────────────
    dataset_name = meta.get("dataset_name", "")
    expected_hash = meta.get("dataset_hash", "")
    if dataset_name and expected_hash:
        dataset_path = dataset_dir / dataset_name
        if dataset_path.exists():
            actual_hash = compute_dataset_hash(dataset_path)
            if actual_hash != expected_hash:
                issues.append(
                    f"ERROR: dataset hash mismatch for {dataset_name}: "
                    f"meta={expected_hash[:16]}... actual={actual_hash[:16]}..."
                )
        else:
            issues.append(f"WARNING: dataset file not found: {dataset_path}")

    # ── 5. Prompt hash verification ──────────────────────────────────────────
    prompt_hashes = meta.get("prompt_hashes", {})
    if prompt_hashes and templates_dir.is_dir():
        for filename, recorded_hash in prompt_hashes.items():
            tpl_path = templates_dir / filename
            if not tpl_path.exists():
                issues.append(f"WARNING: template {filename} recorded in meta but not found on disk")
                continue
            actual = _hash_file(tpl_path)
            if actual != recorded_hash:
                issues.append(
                    f"WARNING: prompt hash mismatch for {filename}: "
                    f"meta={recorded_hash} actual={actual}"
                )
    elif not prompt_hashes:
        issues.append("INFO: no prompt_hashes in run-meta (older run format)")

    return issues


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify eval run artifacts")
    parser.add_argument("--run-dir", required=True, help="Path to run directory")
    parser.add_argument("--dataset-dir", default="eval/dataset/locked",
                        help="Directory containing frozen datasets")
    parser.add_argument("--templates-dir", default="eval/prompts/templates",
                        help="Directory containing prompt templates")
    parser.add_argument("--strict", action="store_true",
                        help="Treat warnings as errors (non-zero exit)")
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    if not run_dir.is_dir():
        print(f"ERROR: run directory not found: {run_dir}", file=sys.stderr)
        sys.exit(1)

    issues = verify(
        run_dir,
        dataset_dir=Path(args.dataset_dir),
        templates_dir=Path(args.templates_dir),
        strict=args.strict,
    )

    if not issues:
        print(f"✓ Run {run_dir.name}: all checks passed")
        sys.exit(0)

    has_critical = any(i.startswith("CRITICAL") for i in issues)
    has_error = any(i.startswith("ERROR") for i in issues)

    print(f"Run {run_dir.name}: {len(issues)} issue(s) found\n")
    for issue in issues:
        print(f"  {issue}")

    if has_critical or has_error:
        sys.exit(1)
    if args.strict and any(i.startswith("WARNING") for i in issues):
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
