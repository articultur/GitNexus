"""eval/test/conftest.py — Shared fixtures for eval test suite."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import pytest

# Ensure eval.lib.* imports work
sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture
def tmp_env(tmp_path: Path) -> dict:
    """Build a complete temporary eval environment.

    Creates:
      - cases.jsonl with 2 minimal cases (one Python, one TypeScript)
      - snapshot dirs for each case
      - prompt template
    Returns dict with keys: tmp, cases_path, snapshots_dir, prompt, cases
    """
    # ── Cases ─────────────────────────────────────────────────────────────────
    cases = [
        {
            "id": "e2e-001",
            "repo": "example/project-a",
            "language": "python",
            "commit_before": "aaa111",
            "commit_fix": "bbb222",
            "task_type": "C1",
            "difficulty": "easy",
            "issue_text": "Auth bug in login handler",
            "ground_truth": {
                "files": ["src/auth.py"],
                "symbols": ["validate_password"],
            },
            "gt_source": "pr_diff",
        },
        {
            "id": "e2e-002",
            "repo": "example/project-b",
            "language": "typescript",
            "commit_before": "ccc333",
            "commit_fix": "ddd444",
            "task_type": "C3",
            "difficulty": "medium",
            "issue_text": "Race condition in concurrent request handler",
            "ground_truth": {
                "files": ["src/handler.ts"],
                "symbols": ["processRequest"],
            },
            "gt_source": "pr_diff",
        },
    ]
    cases_path = tmp_path / "cases.jsonl"
    cases_path.write_text(
        "\n".join(json.dumps(c) for c in cases) + "\n",
        encoding="utf-8",
    )

    # ── Snapshot directories ───────────────────────────────────────────────────
    for case in cases:
        snap = tmp_path / "snapshots" / case["id"]
        snap.mkdir(parents=True)
        ext = "py" if case["language"] == "python" else "ts"
        (snap / f"main.{ext}").write_text(
            f"# placeholder for {case['id']}\n", encoding="utf-8"
        )

    # ── Prompt template ────────────────────────────────────────────────────────
    prompt_path = tmp_path / "prompt.md"
    prompt_path.write_text(
        "Analyze {{repo}} ({{language}}). Issue: {{issue_text}}",
        encoding="utf-8",
    )

    return {
        "tmp": tmp_path,
        "cases_path": cases_path,
        "snapshots_dir": str(tmp_path / "snapshots"),
        "prompt": prompt_path.read_text(encoding="utf-8"),
        "cases": cases,
    }
