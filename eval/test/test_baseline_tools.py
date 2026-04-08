"""Tests for eval.lib.baseline_tools."""

import os
from pathlib import Path

import pytest

from eval.lib.baseline_tools import (
    BASELINE_TOOLS,
    SandboxPolicy,
    ToolResult,
    get_baseline_tool_definitions,
    get_baseline_tool_definitions_anthropic,
    grep_search,
    list_dir,
    file_search,
    read_file,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def snapshot(tmp_path: Path) -> Path:
    """Create a minimal snapshot directory tree for testing."""
    # Files
    (tmp_path / "hello.py").write_text("print('hello world')\n")
    (tmp_path / "data.txt").write_text("line1\nline2\nline3\nline4\nline5\n")

    # Nested structure
    sub = tmp_path / "src"
    sub.mkdir()
    (sub / "app.py").write_text("def main():\n    print('app')\n    return 0\n")
    (sub / "util.py").write_text("def helper():\n    pass\n")

    nested = sub / "deep"
    nested.mkdir()
    (nested / "secret.py").write_text("SECRET = 'hunter2'\n")

    return tmp_path


@pytest.fixture
def sandbox(snapshot: Path) -> SandboxPolicy:
    return SandboxPolicy(snapshot)


# ---------------------------------------------------------------------------
# read_file
# ---------------------------------------------------------------------------

class TestReadFile:

    def test_read_file_success(self, sandbox: SandboxPolicy):
        result = read_file({"path": "hello.py"}, sandbox)
        assert result.error is None
        assert "hello world" in result.content

    def test_read_file_with_lines(self, sandbox: SandboxPolicy):
        result = read_file({"path": "data.txt", "start_line": 2, "end_line": 4}, sandbox)
        assert result.error is None
        lines = result.content.strip().splitlines()
        assert lines == ["line2", "line3", "line4"]

    def test_read_file_not_found(self, sandbox: SandboxPolicy):
        result = read_file({"path": "nonexistent.txt"}, sandbox)
        assert result.error is not None
        assert "not found" in result.error

    def test_read_file_path_traversal(self, sandbox: SandboxPolicy):
        result = read_file({"path": "../../etc/passwd"}, sandbox)
        assert result.error is not None
        assert "escapes snapshot" in result.error

    def test_read_file_directory(self, sandbox: SandboxPolicy):
        result = read_file({"path": "src"}, sandbox)
        assert result.error is not None
        assert "directory" in result.error


# ---------------------------------------------------------------------------
# grep_search
# ---------------------------------------------------------------------------

class TestGrepSearch:

    def test_grep_search_literal(self, sandbox: SandboxPolicy):
        result = grep_search({"query": "print"}, sandbox)
        assert result.error is None
        # Should find print statements in hello.py and src/app.py
        assert "hello.py" in result.content
        assert "app.py" in result.content

    def test_grep_search_regexp(self, sandbox: SandboxPolicy):
        result = grep_search({"query": r"def \w+\(\)", "is_regexp": True}, sandbox)
        assert result.error is None
        assert "main" in result.content
        assert "helper" in result.content

    def test_grep_search_with_include(self, sandbox: SandboxPolicy):
        result = grep_search({"query": "print", "include_pattern": "*.py"}, sandbox)
        assert result.error is None
        # data.txt should not appear
        assert "data.txt" not in result.content

    def test_grep_search_empty_query(self, sandbox: SandboxPolicy):
        result = grep_search({"query": ""}, sandbox)
        assert result.error is not None


# ---------------------------------------------------------------------------
# file_search
# ---------------------------------------------------------------------------

class TestFileSearch:

    def test_file_search_glob(self, sandbox: SandboxPolicy, snapshot: Path):
        result = file_search({"query": "*.py"}, sandbox)
        assert result.error is None
        paths = result.content.strip().splitlines()
        # Should find hello.py, src/app.py, src/util.py, src/deep/secret.py
        assert len(paths) >= 4
        assert "hello.py" in paths
        assert str(Path("src") / "app.py") in paths

    def test_file_search_nested(self, sandbox: SandboxPolicy):
        result = file_search({"query": "secret.py"}, sandbox)
        assert result.error is None
        assert "secret" in result.content

    def test_file_search_empty_query(self, sandbox: SandboxPolicy):
        result = file_search({"query": ""}, sandbox)
        assert result.error is not None


# ---------------------------------------------------------------------------
# list_dir
# ---------------------------------------------------------------------------

class TestListDir:

    def test_list_dir(self, sandbox: SandboxPolicy):
        result = list_dir({"path": ""}, sandbox)
        assert result.error is None
        entries = result.content.strip().splitlines()
        assert "hello.py" in entries
        assert "data.txt" in entries
        assert "src/" in entries

    def test_list_dir_nested(self, sandbox: SandboxPolicy):
        result = list_dir({"path": "src"}, sandbox)
        assert result.error is None
        entries = result.content.strip().splitlines()
        assert "app.py" in entries
        assert "util.py" in entries
        assert "deep/" in entries

    def test_list_dir_not_found(self, sandbox: SandboxPolicy):
        result = list_dir({"path": "nope"}, sandbox)
        assert result.error is not None

    def test_list_dir_file_path(self, sandbox: SandboxPolicy):
        result = list_dir({"path": "hello.py"}, sandbox)
        assert result.error is not None
        assert "not a directory" in result.error


# ---------------------------------------------------------------------------
# Sandbox enforcement across all tools
# ---------------------------------------------------------------------------

class TestSandboxAllTools:

    TRAVERSAL_PATHS = [
        "../../etc/passwd",
        "../../../tmp/evil",
        "/etc/passwd",
    ]

    @pytest.mark.parametrize("path", TRAVERSAL_PATHS)
    def test_read_file_rejects_traversal(self, sandbox: SandboxPolicy, path: str):
        result = read_file({"path": path}, sandbox)
        assert result.error is not None

    @pytest.mark.parametrize("path", TRAVERSAL_PATHS)
    def test_list_dir_rejects_traversal(self, sandbox: SandboxPolicy, path: str):
        result = list_dir({"path": path}, sandbox)
        assert result.error is not None


# ---------------------------------------------------------------------------
# Tool definition helpers
# ---------------------------------------------------------------------------

class TestToolDefinitions:

    def test_openai_format(self):
        defs = get_baseline_tool_definitions()
        assert len(defs) == 4
        for d in defs:
            assert d["type"] == "function"
            assert "name" in d["function"]
            assert "description" in d["function"]
            assert "parameters" in d["function"]

    def test_anthropic_format(self):
        defs = get_baseline_tool_definitions_anthropic()
        assert len(defs) == 4
        for d in defs:
            assert "name" in d
            assert "description" in d
            assert "input_schema" in d

    def test_baseline_tools_registry(self):
        assert set(BASELINE_TOOLS.keys()) == {
            "read_file",
            "grep_search",
            "file_search",
            "list_dir",
        }
