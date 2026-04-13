import subprocess
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class WorktreeResult:
    case_id: str
    path: str
    success: bool
    error: Optional[str] = None


class WorktreeManager:
    def __init__(self, base_dir: str = "/tmp/claude-eval-worktrees"):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.worktrees: dict[str, str] = {}

    def create(self, repo: str, commit: str, case_id: Optional[str] = None) -> WorktreeResult:
        """创建 worktree"""
        case_id = case_id or f"{repo.replace('/', '-')}-{commit[:7]}"
        worktree_path = self.base_dir / case_id

        if worktree_path.exists():
            shutil.rmtree(worktree_path)

        try:
            # git clone shallow
            result = subprocess.run(
                ["git", "clone", "--depth", "1", f"https://github.com/{repo}.git", str(worktree_path)],
                capture_output=True, text=True, timeout=120
            )
            if result.returncode != 0:
                return WorktreeResult(case_id, str(worktree_path), False, result.stderr)

            # fetch and checkout commit
            subprocess.run(["git", "fetch", "--depth", "1", "origin", commit],
                          cwd=worktree_path, capture_output=True)
            subprocess.run(["git", "checkout", commit],
                          cwd=worktree_path, capture_output=True)

            self.worktrees[case_id] = str(worktree_path)
            return WorktreeResult(case_id, str(worktree_path), True)

        except Exception as e:
            return WorktreeResult(case_id, str(worktree_path), False, str(e))

    def cleanup(self, case_id: str) -> bool:
        """清理 worktree"""
        if case_id in self.worktrees:
            path = Path(self.worktrees.pop(case_id))
            if path.exists():
                shutil.rmtree(path)
            return True
        return False

    def cleanup_all(self):
        """清理所有 worktree"""
        for case_id in list(self.worktrees.keys()):
            self.cleanup(case_id)
