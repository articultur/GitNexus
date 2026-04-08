#!/usr/bin/env python3
"""
Run Stage-A bug-detection baseline repeatedly and check stability.

Usage:
  python scripts/run_bug_detection_baseline.py
  python scripts/run_bug_detection_baseline.py --dry-run
  python scripts/run_bug_detection_baseline.py --config configs/bug_detection/baseline_2026q2.yaml
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import yaml


def load_yaml(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def run_once(eval_dir: Path, cfg: dict, run_id: str, dry_run: bool) -> int:
    output_root = Path(cfg.get("output", {}).get("root_dir", "results"))
    output_dir = output_root / run_id
    cmd = [
        sys.executable,
        "run_eval.py",
        "single",
        "-m",
        str(cfg["model"]),
        "--mode",
        str(cfg["mode"]),
        "--subset",
        str(cfg["subset"]),
        "--split",
        str(cfg.get("split", "dev")),
        "--slice",
        str(cfg["slice"]),
        "--output",
        str(output_dir),
        "-w",
        str(cfg.get("workers", 1)),
    ]

    print(f"[baseline] run_id={run_id}")
    print("[baseline] cmd=", " ".join(cmd))
    if dry_run:
        return 0
    proc = subprocess.run(cmd, cwd=eval_dir)
    return proc.returncode


def load_summary(eval_dir: Path, cfg: dict, run_id: str) -> dict:
    model = str(cfg.get("model", ""))
    mode = str(cfg.get("mode", "native_augment"))
    run_name = f"{model}_{mode}"
    summary_path = (
        eval_dir
        / cfg.get("output", {}).get("root_dir", "results")
        / run_id
        / run_name
        / "summary.json"
    )
    if not summary_path.exists():
        raise FileNotFoundError(f"summary not found: {summary_path}")
    with open(summary_path, "r", encoding="utf-8") as f:
        return json.load(f)


def summarize_run(summary: dict) -> tuple[float, float]:
    results = summary.get("results", [])
    n = len(results)
    if n == 0:
        return 0.0, 0.0
    n_with_patch = sum(1 for r in results if (r.get("submission") or "").strip())
    total_cost = sum(float(r.get("cost", 0.0) or 0.0) for r in results)
    patch_rate = n_with_patch / n
    avg_cost = total_cost / n
    return patch_rate, avg_cost


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        default="configs/bug_detection/baseline_2026q2.yaml",
        help="Path to yaml config under eval/",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    eval_dir = Path(__file__).resolve().parent.parent
    cfg = load_yaml(eval_dir / args.config)

    repeats = int(cfg.get("repeats", 3))
    prefix = str(cfg.get("output", {}).get("run_prefix", "bugdet_2026q2"))
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    run_ids: list[str] = []
    for i in range(1, repeats + 1):
        run_id = f"{prefix}_{stamp}_r{i}"
        run_ids.append(run_id)
        rc = run_once(eval_dir, cfg, run_id, args.dry_run)
        if rc != 0:
            print(f"[baseline] run failed: {run_id}, exit={rc}")
            return rc

    if args.dry_run:
        print("[baseline] dry-run completed")
        return 0

    patch_rates: list[float] = []
    avg_costs: list[float] = []
    for run_id in run_ids:
        summary = load_summary(eval_dir, cfg, run_id)
        patch_rate, avg_cost = summarize_run(summary)
        patch_rates.append(patch_rate)
        avg_costs.append(avg_cost)

    patch_std = statistics.pstdev(patch_rates) if len(patch_rates) > 1 else 0.0
    cost_std = statistics.pstdev(avg_costs) if len(avg_costs) > 1 else 0.0

    max_patch_std = float(cfg.get("thresholds", {}).get("max_patch_rate_std", 0.05))
    max_cost_std = float(cfg.get("thresholds", {}).get("max_avg_cost_std", 0.05))

    print("\n=== Stage-A Stability Summary ===")
    print("run_ids:", ", ".join(run_ids))
    print(f"patch_rate mean={statistics.mean(patch_rates):.4f} std={patch_std:.4f} threshold={max_patch_std:.4f}")
    print(f"avg_cost   mean={statistics.mean(avg_costs):.4f} std={cost_std:.4f} threshold={max_cost_std:.4f}")

    ok = patch_std <= max_patch_std and cost_std <= max_cost_std
    print("status:", "PASS" if ok else "FAIL")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
