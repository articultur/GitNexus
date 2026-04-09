import hashlib
import json
import sys
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from .schema import compute_dataset_hash

def compute_prompt_hashes(templates_dir: Path) -> dict[str, str]:
    """Compute SHA256 hashes for all prompt template files.

    Returns a dict like {"locate-fix-baseline.md": "a1b2c3...", ...}.
    """
    hashes: dict[str, str] = {}
    if not templates_dir.is_dir():
        return hashes
    for p in sorted(templates_dir.iterdir()):
        if p.is_file() and p.suffix == ".md":
            content = p.read_bytes()
            hashes[p.name] = hashlib.sha256(content).hexdigest()[:16]
    return hashes


def generate_run_meta(
    run_id: str,
    dataset_path: Path,
    model: str,
    provider: str,
    prompt_version: str,
    groups: list[str],
    started_at: str,
    finished_at: str,
    max_steps: int,
    token_budget: int,
    parallelism: int = 1,
    retry_count: int = 0,
    prompt_hashes: dict[str, str] | None = None,
) -> dict:
    """Generate run-meta.json content."""
    git_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True, text=True
    ).stdout.strip()

    cases_count = sum(1 for line in dataset_path.open() if line.strip())
    return {
        "run_id": run_id,
        "dataset_name": dataset_path.name,
        "dataset_hash": compute_dataset_hash(dataset_path),
        "cases_count": cases_count,
        "groups": groups,
        "model_id": model,
        "provider": provider,
        "prompt_version": prompt_version,
        "script_git_commit": git_commit,
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "started_at": started_at,
        "finished_at": finished_at,
        "parallelism": parallelism,
        "retry_policy": f"retry_count={retry_count}",
        "sandbox_policy": "snapshot_root_isolation_v1",
        "max_steps": max_steps,
        "token_budget": token_budget,
        "prompt_hashes": prompt_hashes or {},
    }

def generate_snapshot_meta(case: dict, snapshot_dir: Path) -> dict:
    """Generate snapshot-meta.json for a case snapshot."""
    return {
        "case_id": case["id"],
        "repo": case["repo"],
        "commit_before": case["commit_before"],
        "snapshot_created_at": datetime.now(timezone.utc).isoformat(),
        "snapshot_source": "prepare-snapshots.sh",
        "sparse_paths": ["src", "lib", "core", "app", "pkg", "cmd", "internal"],
        "snapshot_tool_version": "gitnexus-eval-v2",
        "snapshot_hash": _hash_directory(snapshot_dir),
    }

def _hash_directory(directory: Path) -> str:
    """Hash file listing (not contents) for lightweight integrity check."""
    files = sorted(str(p.relative_to(directory)) for p in directory.rglob("*") if p.is_file())
    payload = "\n".join(files)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]