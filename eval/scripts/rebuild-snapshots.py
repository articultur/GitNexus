#!/usr/bin/env python3
"""
eval/scripts/rebuild-snapshots.py
─────────────────────────────────
Rebuild snapshots using reference repos + git worktrees + gitnexus analyze.

Architecture:
  - One bare reference repo per unique repo in eval/.cache/refs/{repo}.git
  - One bare snapshot repo per unique repo in eval/snapshots/{repo}.git
  - Each case gets a git worktree from the bare snapshot repo
  - gitnexus analyze runs in each worktree to build the index

Usage:
  python eval/scripts/rebuild-snapshots.py \
      --cases eval/dataset/fast.jsonl \
      --snapshots-dir eval/snapshots \
      --cache-dir eval/.cache/refs \
      --force
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


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


def clone_snapshot(
    bare_repo: Path,
    case_id: str,
    commit: str,
    worktree_path: Path,
    force: bool = False,
) -> bool:
    """
    Create a worktree from an existing bare repo at a specific commit.

    Uses `git worktree add` so objects are shared with the bare repo.
    Returns True if worktree was created (even if checkout failed).
    """
    try:
        # Check if worktree already exists and is valid
        if worktree_path.exists():
            result = subprocess.run(
                ["git", "-C", str(worktree_path), "rev-parse", "--is-inside-work-tree"],
                capture_output=True, text=True, timeout=10
            )
            if result.stdout.strip() == "true" and not force:
                log(f"  SKIP {case_id} (worktree exists)")
                return True

        # Ensure parent dir exists
        worktree_path.parent.mkdir(parents=True, exist_ok=True)

        # Remove existing if force
        if worktree_path.exists():
            # Remove worktree from bare repo first
            subprocess.run(
                ["git", "-C", str(bare_repo), "worktree", "remove", "--force", str(worktree_path)],
                capture_output=True, text=True, timeout=30, check=False
            )
            shutil.rmtree(worktree_path, ignore_errors=True)

        # Clean up any orphaned branch for this case
        branch_name = f"eval-{case_id}"
        subprocess.run(
            ["git", "-C", str(bare_repo), "branch", "-D", branch_name],
            capture_output=True, text=True, timeout=10, check=False
        )

        # Prune stale worktree entries
        subprocess.run(
            ["git", "-C", str(bare_repo), "worktree", "prune"],
            capture_output=True, text=True, timeout=10, check=False
        )

        # Create worktree (no checkout yet)
        result = subprocess.run(
            [
                "git", "-C", str(bare_repo), "worktree", "add",
                "--no-checkout", "-b", branch_name, str(worktree_path)
            ],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            # Fallback: try without -b (existing branch)
            result = subprocess.run(
                [
                    "git", "-C", str(bare_repo), "worktree", "add",
                    "--force", "--no-checkout", str(worktree_path)
                ],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode != 0:
                warn(f"  worktree add failed for {case_id}: {result.stderr[:100]}")
                return False

        # Checkout the specific commit
        checkout = subprocess.run(
            ["git", "-C", str(worktree_path), "checkout", commit],
            capture_output=True, text=True, timeout=30
        )
        if checkout.returncode != 0:
            warn(f"  checkout failed for {case_id} @ {commit[:8]}: {checkout.stderr[:80]}")
            # Return True anyway — worktree was created, checkout is a secondary concern
            return True

        log(f"  OK {case_id} @ {commit[:8]}")
        return True

    except subprocess.TimeoutExpired:
        warn(f"  timeout for {case_id}")
        return False
    except Exception as e:
        warn(f"  error for {case_id}: {e}")
        return False


# ─── New helpers for worktree architecture ─────────────────────────────────────


def run_gitnexus_analyze(worktree_path: Path, gitnexus_bin: str = "gitnexus") -> bool:
    """Run gitnexus analyze in the worktree."""
    try:
        env = os.environ.copy()
        env["NODE_OPTIONS"] = "--max-old-space-size=8192"
        result = subprocess.run(
            [gitnexus_bin, "analyze", "."],
            cwd=str(worktree_path),
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode == 0:
            log(f"    indexed")
            return True
        else:
            warn(f"    analyze failed: {result.stderr[:80]}")
            return False
    except subprocess.TimeoutExpired:
        warn(f"    analyze timeout for {worktree_path.name}")
        return False
    except FileNotFoundError:
        warn(f"    gitnexus not found at '{gitnexus_bin}'")
        return False
    except Exception as e:
        warn(f"    analyze error: {e}")
        return False


def prepare_case(
    case: dict,
    snapshots_dir: Path,
    force: bool,
    skip_analyze: bool,
    gitnexus_bin: str,
) -> tuple[str, str, str]:
    """
    Prepare a single case: create worktree + run gitnexus analyze.
    Returns (case_id, status, message).
    """
    case_id = case["id"]
    repo = case["repo"]
    commit = case["commit_before"]

    bare_repo = repo_to_bare_path(repo, snapshots_dir)
    worktree_path = case_to_worktree_path(repo, case_id, snapshots_dir)

    if not bare_repo.exists():
        return case_id, "bare_missing", f"bare repo not found: {bare_repo}"

    # Create worktree
    ok = clone_snapshot(bare_repo, case_id, commit, worktree_path, force=force)
    if not ok:
        return case_id, "failed", "worktree creation failed"

    # Write .eval-case.json
    try:
        (worktree_path / ".eval-case.json").write_text(
            json.dumps(case, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass  # non-critical

    # Run gitnexus analyze
    if not skip_analyze:
        indexed = run_gitnexus_analyze(worktree_path, gitnexus_bin)
        if not indexed:
            return case_id, "analyze_failed", "gitnexus analyze failed"

    return case_id, "success", ""


# ─── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    from collections import defaultdict
    from concurrent.futures import ThreadPoolExecutor, as_completed

    parser = argparse.ArgumentParser(
        description="Rebuild eval snapshots with reference repos and worktrees"
    )
    parser.add_argument(
        "--cases", required=True,
        help="Path to cases JSONL file"
    )
    parser.add_argument(
        "--snapshots-dir", default="eval/snapshots",
        help="Directory containing bare repo snapshots"
    )
    parser.add_argument(
        "--cache-dir", default="eval/.cache/refs",
        help="Directory for reference bare clones"
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Re-create even if worktree already exists"
    )
    parser.add_argument(
        "--skip-analyze", action="store_true",
        help="Skip gitnexus analyze (just create worktrees)"
    )
    parser.add_argument(
        "--threads", type=int, default=4,
        help="Number of parallel workers"
    )
    parser.add_argument(
        "--gitnexus-bin", default="gitnexus",
        help="Path to gitnexus binary"
    )
    args = parser.parse_args()

    snapshots_dir = Path(args.snapshots_dir)
    cache_dir = Path(args.cache_dir)

    if not Path(args.cases).exists():
        warn(f"Cases file not found: {args.cases}")
        sys.exit(1)

    # Load cases
    cases = []
    with open(args.cases, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                cases.append(json.loads(line))

    # Group by repo
    by_repo: dict[str, list[dict]] = defaultdict(list)
    for case in cases:
        by_repo[case["repo"]].append(case)

    log(f"Loaded {len(cases)} cases from {args.cases}")
    log(f"Snapshots dir: {snapshots_dir}")
    log(f"Cache dir: {cache_dir}")
    log(f"Threads: {args.threads}")

    # Step 1: Ensure reference repos exist
    log(f"\nStep 1: Setting up {len(by_repo)} reference repos ...")
    repo_to_ref: dict[str, Path] = {}

    for repo, repo_cases in sorted(by_repo.items()):
        ref_name = repo.replace("/", "__") + ".git"
        ref_dir = cache_dir / ref_name
        repo_to_ref[repo] = ref_dir

        if ref_dir.exists() and not args.force:
            log(f"  {repo}: reference exists (skip)")
            continue

        log(f"  {repo}: fetching reference ({len(repo_cases)} cases) ...")
        clone_url = bare_repo_clone_url(repo)

        if ref_dir.exists():
            subprocess.run(
                ["git", "-C", str(ref_dir), "fetch", "origin", "--prune"],
                capture_output=True, timeout=60
            )
        else:
            cache_dir.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                [
                    "git", "clone", "--bare",
                    "--filter=blob:none",
                    "--no-single-branch",
                    clone_url,
                    str(ref_dir),
                ],
                capture_output=True, timeout=120
            )
        log(f"    done")

    # Step 2: Create/update bare repos in snapshots_dir from references
    log(f"\nStep 2: Ensuring bare repos in snapshots_dir ...")
    for repo in sorted(by_repo.keys()):
        bare_repo = repo_to_bare_path(repo, snapshots_dir)
        ref_dir = repo_to_ref[repo]

        if bare_repo.exists() and not args.force:
            log(f"  {repo}: bare repo exists (skip)")
            continue

        if not bare_repo.exists():
            log(f"  {repo}: creating bare repo ...")
            snapshots_dir.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                [
                    "git", "clone",
                    "--reference", str(ref_dir),
                    "--bare",
                    str(ref_dir),
                    str(bare_repo),
                ],
                capture_output=True, timeout=120
            )
        else:
            log(f"  {repo}: fetching updates ...")
            subprocess.run(
                ["git", "-C", str(bare_repo), "fetch", "origin", "--prune"],
                capture_output=True, timeout=60
            )
        log(f"    done")

    # Step 3: Create worktrees and run gitnexus analyze
    log(f"\nStep 3: Creating worktrees and indexing ...")

    total = len(cases)
    done = 0
    skipped = 0
    failed = 0
    analyze_failed = 0

    futures = {}
    with ThreadPoolExecutor(max_workers=args.threads) as ex:
        for case in cases:
            future = ex.submit(
                prepare_case, case, snapshots_dir,
                args.force, args.skip_analyze, args.gitnexus_bin
            )
            futures[future] = case["id"]

        for future in as_completed(futures):
            case_id, status, msg = future.result()
            if status == "success":
                done += 1
            elif status == "analyze_failed":
                done += 1
                analyze_failed += 1
            elif "exists" in status or "skip" in status:
                skipped += 1
                done += 1
            else:
                failed += 1

            if status != "success":
                log(f"  FAIL {case_id}: {status} {msg}")

            log(f"  progress: {done}/{total} ({failed} failed, {analyze_failed} analyze_failed)")

    log(f"\n{'─'*50}")
    log(f"  Done:           {done}")
    log(f"  Skipped:        {skipped}")
    log(f"  Failed:         {failed}")
    log(f"  Analyze failed: {analyze_failed}")
    log(f"{'─'*50}")


if __name__ == "__main__":
    main()
