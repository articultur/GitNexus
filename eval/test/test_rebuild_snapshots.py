#!/usr/bin/env python3
"""eval/test/test_rebuild_snapshots.py"""
import pytest
import sys
from pathlib import Path

# Add scripts/ to path so we can import the module
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

class TestSnapshotPathMapping:
    """Verify repo -> bare repo -> worktree path mapping"""

    def test_repo_to_bare_name(self):
        from rebuild_snapshots import repo_to_bare_name
        assert repo_to_bare_name("cli/cli") == "cli__cli.git"
        assert repo_to_bare_name("JetBrains/kotlin-wrappers") == "JetBrains__kotlin-wrappers.git"
        assert repo_to_bare_name("anuraghazra/github-readme-stats") == "anuraghazra__github-readme-stats.git"

    def test_repo_to_bare_path(self):
        from rebuild_snapshots import repo_to_bare_path
        base = Path("eval/snapshots")
        result = repo_to_bare_path("cli/cli", base)
        assert result == base / "cli__cli.git"
        assert isinstance(result, Path)

    def test_case_to_worktree_path(self):
        from rebuild_snapshots import case_to_worktree_path
        base = Path("eval/snapshots")
        result = case_to_worktree_path("cli/cli", "cli__cli-10158", base)
        assert result == base / "cli__cli.git" / "worktrees" / "cli__cli-10158"
        assert isinstance(result, Path)

    def test_case_to_worktree_path_complex_repo(self):
        from rebuild_snapshots import case_to_worktree_path
        base = Path("eval/snapshots")
        result = case_to_worktree_path("anuraghazra/github-readme-stats", "anuraghazra__github-readme-stats-721", base)
        assert result == base / "anuraghazra__github-readme-stats.git" / "worktrees" / "anuraghazra__github-readme-stats-721"