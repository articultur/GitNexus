#!/usr/bin/env python3
"""
eval/scripts/rebuild-snapshots.py
─────────────────────────────────
Rebuild snapshots using reference repos to minimize bandwidth and disk usage.

Architecture:
  - One bare reference repo per unique repo in eval/.cache/refs/{repo}.git
  - Each snapshot clones from its reference with --filter=blob:none --sparse
  - Snapshots share .git objects via the reference, only downloading delta blobs

Usage:
  python eval/scripts/rebuild-snapshots.py \
      --cases eval/dataset/locked/round-01-curated.jsonl \
      --snapshots-dir eval/snapshots \
      --cache-dir eval/.cache/refs \
      --force
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from threading import Thread
import time

SCRIPT_DIR = Path(__file__).parent.parent
CACHE_DIR = SCRIPT_DIR / ".cache" / "refs"
SNAPSHOTS_DIR = SCRIPT_DIR / "snapshots"


# ─── Path Mapping ───────────────────────────────────────────────────────────────


def repo_to_bare_name(repo: str) -> str:
    """'owner/repo' -> 'owner__repo.git'"""
    return f"{repo.replace('/', '__')}.git"


def repo_to_bare_path(repo: str, snapshots_dir: Path) -> Path:
    """Return bare repo path for a given repo."""
    return snapshots_dir / repo_to_bare_name(repo)


def case_to_worktree_path(repo: str, case_id: str, snapshots_dir: Path) -> Path:
    """Return worktree path for a given case."""
    return snapshots_dir / repo_to_bare_name(repo) / "worktrees" / case_id


def bare_repo_clone_url(repo: str) -> str:
    """Build GitHub clone URL with optional token."""
    clone_url = f"https://github.com/{repo}.git"
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        clone_url = f"https://{token}@github.com/{repo}.git"
    return clone_url


# ─── Helpers ───────────────────────────────────────────────────────────────────


def log(msg: str) -> None:
    print(f"[rebuild] {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"[rebuild][WARN] {msg}", file=sys.stderr, flush=True)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    kwargs.setdefault("check", True)
    kwargs.setdefault("capture_output", True)
    return subprocess.run(cmd, **kwargs)


def ensure_reference(repo: str, clone_url: str) -> Path:
    """Create or update a bare reference clone for a repo."""
    ref_dir = CACHE_DIR / f"{repo.replace('/', '__')}.git"
    if ref_dir.exists():
        log(f"  Reference exists for {repo}, skipping fetch")
        return ref_dir

    ref_dir.parent.mkdir(parents=True, exist_ok=True)
    log(f"  Fetching reference for {repo} ...")
    # Bare clone with blob:none - downloads only refs and necessary objects
    run([
        "git", "clone", "--bare",
        "--filter=blob:none",
        clone_url,
        str(ref_dir),
    ])
    return ref_dir


def clone_snapshot(
    ref_dir: Path,
    case_id: str,
    repo: str,
    commit: str,
    snapshot_dir: Path,
    sparse_dirs: list[str],
) -> bool:
    """Clone a single snapshot from the reference repo."""
    try:
        snapshot_dir.mkdir(parents=True, exist_ok=True)

        # Clone from reference with sparse checkout
        run([
            "git", "clone",
            "--reference", str(ref_dir),
            "--filter=blob:none",
            "--sparse",
            str(ref_dir),
            str(snapshot_dir),
        ])

        # Sparse checkout only needed dirs
        run(["git", "-C", str(snapshot_dir), "sparse-checkout", "set"] + sparse_dirs)

        # Fetch and checkout the specific commit
        run([
            "git", "-C", str(snapshot_dir), "fetch", "--depth=1",
            "origin", commit
        ], check=False)  # may fail if commit not reachable from origin HEAD

        run([
            "git", "-C", str(snapshot_dir), "checkout", commit
        ], check=False)  # fallback: use whatever is checked out

        return True
    except subprocess.CalledProcessError as e:
        warn(f"Failed to clone {case_id}: {e}")
        return False


def get_commit_from_ondisk_snapshot(case_id: str, snapshot_dir: Path) -> str | None:
    """Try to read commit from existing snapshot."""
    try:
        result = run(
            ["git", "-C", str(snapshot_dir), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True
        )
        return result.stdout.strip()
    except Exception:
        return None


# ─── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild snapshots with reference repos")
    parser.add_argument("--cases", required=True, help="Path to cases JSONL")
    parser.add_argument("--snapshots-dir", default="eval/snapshots", help="Snapshots root")
    parser.add_argument("--cache-dir", default="eval/.cache/refs", help="Reference repos cache")
    parser.add_argument("--force", action="store_true", help="Re-clone even if snapshot exists")
    parser.add_argument("--skip-analyze", action="store_true", help="Skip gitnexus analyze")
    parser.add_argument("--threads", type=int, default=4, help="Parallel clones")
    args = parser.parse_args()

    cases_path = Path(args.cases)
    snapshots_dir = Path(args.snapshots_dir)
    cache_dir = Path(args.cache_dir)

    if not cases_path.exists():
        warn(f"Cases file not found: {cases_path}")
        sys.exit(1)

    # Load cases
    cases = []
    with cases_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                cases.append(json.loads(line))

    # Group by repo to batch reference repo creation
    by_repo: dict[str, list[dict]] = defaultdict(list)
    for case in cases:
        by_repo[case["repo"]].append(case)

    # Ensure .cache/refs dir exists
    cache_dir.mkdir(parents=True, exist_ok=True)

    # ── Step 1: Create reference repos ────────────────────────────────────────
    log(f"Step 1: Setting up {len(by_repo)} reference repos ...")
    repo_to_ref: dict[str, Path] = {}

    for repo, repo_cases in sorted(by_repo.items()):
        log(f"  {repo}: {len(repo_cases)} snapshots")

        # Determine clone URL
        clone_url = f"https://github.com/{repo}.git"
        token = os.environ.get("GITHUB_TOKEN", "")
        if token:
            clone_url = f"https://{token}@github.com/{repo}.git"

        ref_dir = cache_dir / f"{repo.replace('/', '__')}.git"
        repo_to_ref[repo] = ref_dir

        if ref_dir.exists() and not args.force:
            log(f"    Reference exists (use --force to re-fetch): {ref_dir.name}")
        else:
            log(f"    Fetching reference repo (full history) ...")
            if ref_dir.exists():
                run(["git", "-C", str(ref_dir), "fetch", "origin", "--prune"], check=False)
            else:
                # Use --no-single-branch to fetch all branches (needed to reach old commits)
                run([
                    "git", "clone", "--bare",
                    "--filter=blob:none",
                    "--no-single-branch",
                    clone_url,
                    str(ref_dir),
                ])

    # ── Step 2: Clone snapshots from reference repos ─────────────────────────
    log(f"\nStep 2: Cloning {len(cases)} snapshots from reference repos ...")

    SPARSE_DIRS = ["src", "lib", "core", "app", "pkg", "cmd", "internal"]

    total = len(cases)
    done = 0
    skipped = 0
    failed = 0

    for case in cases:
        case_id = case["id"]
        repo = case["repo"]
        commit = case["commit_before"]

        dest = snapshots_dir / "full-158" / case_id

        if dest.exists() and (dest / ".gitnexus").exists() and not args.force:
            log(f"  SKIP {case_id} (already prepared)")
            skipped += 1
            done += 1
            continue

        ref_dir = repo_to_ref[repo]

        log(f"  {case_id} <- {repo} @ {commit[:8]}")

        if clone_snapshot(ref_dir, case_id, repo, commit, dest, SPARSE_DIRS):
            # Write .eval-case.json
            (dest / ".eval-case.json").write_text(
                json.dumps(case, ensure_ascii=False), encoding="utf-8"
            )
            done += 1
        else:
            failed += 1

        # Progress
        log(f"  progress: {done}/{total} ({failed} failed)")

    log(f"\n{'─'*50}")
    log(f"  Done:      {done}")
    log(f"  Skipped:   {skipped}")
    log(f"  Failed:    {failed}")
    log(f"{'─'*50}")


if __name__ == "__main__":
    main()
