"""eval/test/test_meta.py — Tests for eval/lib/meta.py."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from eval.lib.meta import (
    compute_prompt_hashes,
    generate_run_meta,
    generate_snapshot_meta,
)


class TestComputePromptHashes:
    def test_empty_dir(self, tmp_path: Path) -> None:
        hashes = compute_prompt_hashes(tmp_path)
        assert hashes == {}

    def test_single_file(self, tmp_path: Path) -> None:
        (tmp_path / "task.md").write_text("hello world", encoding="utf-8")
        hashes = compute_prompt_hashes(tmp_path)
        assert "task.md" in hashes
        assert len(hashes["task.md"]) == 16

    def test_multiple_files(self, tmp_path: Path) -> None:
        (tmp_path / "a.md").write_text("content a", encoding="utf-8")
        (tmp_path / "b.md").write_text("content b", encoding="utf-8")
        (tmp_path / "c.txt").write_text("ignored", encoding="utf-8")
        hashes = compute_prompt_hashes(tmp_path)
        assert "a.md" in hashes
        assert "b.md" in hashes
        assert "c.txt" not in hashes
        # Deterministic
        hashes2 = compute_prompt_hashes(tmp_path)
        assert hashes == hashes2

    def test_different_content_different_hash(self, tmp_path: Path) -> None:
        (tmp_path / "a.md").write_text("content a", encoding="utf-8")
        (tmp_path / "b.md").write_text("content b", encoding="utf-8")
        h_a = compute_prompt_hashes(tmp_path)["a.md"]
        h_b = compute_prompt_hashes(tmp_path)["b.md"]
        assert h_a != h_b


class TestGenerateSnapshotMeta:
    def test_basic(self, tmp_path: Path) -> None:
        snap_dir = tmp_path / "snap" / "case-001"
        snap_dir.mkdir(parents=True)
        (snap_dir / "src").mkdir(parents=True)
        (snap_dir / "src" / "main.py").write_text("print('hello')", encoding="utf-8")

        case = {
            "id": "case-001",
            "repo": "example/repo",
            "commit_before": "abc123",
        }
        meta = generate_snapshot_meta(case, snap_dir)

        assert meta["case_id"] == "case-001"
        assert meta["repo"] == "example/repo"
        assert meta["commit_before"] == "abc123"
        assert "snapshot_created_at" in meta
        assert meta["sparse_paths"] == ["src", "lib", "core", "app", "pkg", "cmd", "internal"]
        assert meta["snapshot_source"] == "prepare-snapshots.sh"
        assert "snapshot_hash" in meta
        assert len(meta["snapshot_hash"]) == 16

    def test_hash_changes_with_file_list(self, tmp_path: Path) -> None:
        snap = tmp_path / "snap"
        snap.mkdir(parents=True)

        (snap / "a.txt").write_text("a", encoding="utf-8")
        meta1 = generate_snapshot_meta({"id": "x", "repo": "r", "commit_before": "c"}, snap)

        (snap / "b.txt").write_text("b", encoding="utf-8")
        meta2 = generate_snapshot_meta({"id": "x", "repo": "r", "commit_before": "c"}, snap)

        assert meta1["snapshot_hash"] != meta2["snapshot_hash"]


class TestGenerateRunMeta:
    def test_basic(self, tmp_path: Path) -> None:
        cases_path = tmp_path / "cases.jsonl"
        cases_path.write_text(
            '{"id":"c1"}\n{"id":"c2"}\n{"id":"c3"}\n',
            encoding="utf-8",
        )

        meta = generate_run_meta(
            run_id="run-001",
            dataset_path=cases_path,
            model="anthropic/claude-sonnet-4-5",
            provider="anthropic",
            prompt_version="2.0.0",
            groups=["baseline", "gitnexus"],
            started_at="2026-04-10T00:00:00Z",
            finished_at="2026-04-10T01:00:00Z",
            max_steps=15,
            token_budget=50000,
        )

        assert meta["run_id"] == "run-001"
        assert meta["cases_count"] == 3
        assert meta["groups"] == ["baseline", "gitnexus"]
        assert meta["model_id"] == "anthropic/claude-sonnet-4-5"
        assert meta["provider"] == "anthropic"
        assert meta["prompt_version"] == "2.0.0"
        assert meta["parallelism"] == 1
        assert meta["max_steps"] == 15
        assert meta["token_budget"] == 50000
        assert "dataset_hash" in meta
        assert "python_version" in meta
        assert "script_git_commit" in meta

    def test_prompt_hashes_passed_through(self, tmp_path: Path) -> None:
        cases_path = tmp_path / "cases.jsonl"
        cases_path.write_text('{"id":"c1"}\n', encoding="utf-8")
        prompt_hashes = {"task.md": "a1b2c3d4e5f6"}

        meta = generate_run_meta(
            run_id="run-002",
            dataset_path=cases_path,
            model="test",
            provider="test",
            prompt_version="1.0",
            groups=["baseline"],
            started_at="2026-04-10T00:00:00Z",
            finished_at="2026-04-10T01:00:00Z",
            max_steps=10,
            token_budget=10000,
            prompt_hashes=prompt_hashes,
        )

        assert meta["prompt_hashes"] == prompt_hashes
