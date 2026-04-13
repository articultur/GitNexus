import pytest
import tempfile
import os
from pathlib import Path

def test_create_worktree():
    """测试 worktree 创建和清理"""
    from eval.lib.worktree_manager import WorktreeManager

    with tempfile.TemporaryDirectory() as tmpdir:
        manager = WorktreeManager(base_dir=tmpdir)

        # 创建 worktree
        result = manager.create("redis/redis", "b3ce4c2")
        assert result.success
        assert Path(result.path).exists()
        assert (Path(result.path) / ".git").exists()

        # 清理
        manager.cleanup(result.case_id)
        assert not Path(result.path).exists()
