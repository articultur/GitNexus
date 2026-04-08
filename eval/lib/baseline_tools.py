"""Baseline file-system tools with sandbox enforcement.

These tools simulate the file-level search capabilities available to an AI
without GitNexus.  They run against code snapshots stored under
``eval/snapshots/{case_id}/``.  The sandbox ensures the model cannot read
files outside its designated snapshot root.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class ToolResult:
    """Result returned by every baseline tool."""
    content: str
    error: str | None = None


@dataclass
class ToolDef:
    """Descriptor for a single baseline tool."""
    description: str
    function: Callable[[dict, "SandboxPolicy"], ToolResult]
    parameters: dict = field(default_factory=dict)


class SandboxPolicy:
    """Restricts file access to within *snapshot_root*.

    Every baseline tool receives an instance of this class and must call
    :meth:`validate_path` before touching the filesystem.
    """

    def __init__(self, snapshot_root: Path):
        self.snapshot_root = snapshot_root.resolve()

    def validate_path(self, path: str) -> tuple[Path, str | None]:
        """Resolve and validate *path* against the snapshot root.

        Returns ``(resolved_path, error_or_none)``.  Rejects paths that
        escape the snapshot root or do not exist on disk.
        """
        resolved = (self.snapshot_root / path).resolve()
        if not str(resolved).startswith(str(self.snapshot_root)):
            return resolved, f"Path escapes snapshot: {path}"
        if not resolved.exists():
            return resolved, f"Path not found: {path}"
        return resolved, None


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def read_file(params: dict, sandbox: SandboxPolicy) -> ToolResult:
    """Read file contents, optionally limited to a line range.

    Parameters
    ----------
    params["path"] : str
        Relative path inside the snapshot.
    params["start_line"] : int, optional
        1-based start line (inclusive).
    params["end_line"] : int, optional
        1-based end line (inclusive).
    """
    path = params.get("path", "")
    resolved, err = sandbox.validate_path(path)
    if err:
        return ToolResult(content="", error=err)

    if resolved.is_dir():
        return ToolResult(content="", error=f"Path is a directory: {path}")

    start_line = params.get("start_line")
    end_line = params.get("end_line")

    try:
        lines = resolved.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
    except OSError as exc:
        return ToolResult(content="", error=str(exc))

    if start_line is not None or end_line is not None:
        s = (start_line or 1) - 1  # convert to 0-based
        e = end_line or len(lines)
        lines = lines[s:e]

    content = "".join(lines)
    return ToolResult(content=content)


def _grep_with_rg(query: str, root: Path, is_regexp: bool, include_pattern: str | None) -> tuple[str, str | None]:
    """Try ripgrep; returns (output, error)."""
    cmd: list[str] = ["rg", "--no-heading", "--with-filename", "--line-number"]
    if not is_regexp:
        cmd.append("--fixed-strings")
    if include_pattern:
        cmd.extend(["--glob", include_pattern])
    cmd.extend(["--max-count", "200", query, str(root)])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return "", "rg unavailable"
    if proc.returncode == 0:
        return proc.stdout, None
    # rg returns 1 when no matches — not an error for us.
    if proc.returncode == 1:
        return "", None
    return "", proc.stderr.strip()


def _grep_with_re(query: str, root: Path, is_regexp: bool, include_pattern: str | None) -> str:
    """Pure-Python fallback for grep."""
    pattern = query if is_regexp else re.escape(query)
    try:
        regex = re.compile(pattern)
    except re.error as exc:
        return f"[regex error: {exc}]"

    glob_pat: str | None = include_pattern
    # Very simple glob → regex conversion for the common *.ext case.
    file_filter: Callable[[Path], bool] = lambda _p: True
    if glob_pat:
        gp = "^" + re.escape(glob_pat).replace(re.escape("*"), ".*") + "$"
        gf = re.compile(gp)
        file_filter = lambda p: bool(gf.match(p.name))

    results: list[str] = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fname in filenames:
            fp = Path(dirpath) / fname
            if not file_filter(fp):
                continue
            try:
                for i, line in enumerate(fp.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
                    if regex.search(line):
                        rel = fp.relative_to(root)
                        results.append(f"{rel}:{i}:{line}")
            except OSError:
                continue
            if len(results) >= 200:
                break
        if len(results) >= 200:
            break

    return "\n".join(results)


def grep_search(params: dict, sandbox: SandboxPolicy) -> ToolResult:
    """Search by string or regex across files in the snapshot.

    Parameters
    ----------
    params["query"] : str
        Search term or regex pattern.
    params["is_regexp"] : bool, optional
        Treat *query* as a Python regex (default ``False``).
    params["include_pattern"] : str, optional
        Glob to filter file names (e.g. ``"*.py"``).
    """
    query = params.get("query", "")
    if not query:
        return ToolResult(content="", error="query is required")

    is_regexp = params.get("is_regexp", False)
    include_pattern = params.get("include_pattern")

    # Try rg first, fall back to pure Python.
    output, err = _grep_with_rg(query, sandbox.snapshot_root, is_regexp, include_pattern)
    if err and "rg unavailable" in err:
        output = _grep_with_re(query, sandbox.snapshot_root, is_regexp, include_pattern)
    elif err:
        return ToolResult(content="", error=err)

    return ToolResult(content=output)


def file_search(params: dict, sandbox: SandboxPolicy) -> ToolResult:
    """Find files by name/glob inside the snapshot.

    Parameters
    ----------
    params["query"] : str
        Glob pattern (e.g. ``"*.py"``, ``"src/**/*.ts"``).
    """
    query = params.get("query", "")
    if not query:
        return ToolResult(content="", error="query is required")

    matches: list[str] = []
    try:
        for p in sandbox.snapshot_root.rglob(query):
            try:
                rel = p.relative_to(sandbox.snapshot_root)
            except ValueError:
                continue
            matches.append(str(rel))
            if len(matches) >= 200:
                break
    except OSError as exc:
        return ToolResult(content="", error=str(exc))

    return ToolResult(content="\n".join(matches))


def list_dir(params: dict, sandbox: SandboxPolicy) -> ToolResult:
    """List directory contents inside the snapshot.

    Parameters
    ----------
    params["path"] : str
        Relative directory path inside the snapshot.
    """
    path = params.get("path", "")
    resolved, err = sandbox.validate_path(path)
    if err:
        return ToolResult(content="", error=err)

    if not resolved.is_dir():
        return ToolResult(content="", error=f"Path is not a directory: {path}")

    entries: list[str] = []
    try:
        for child in sorted(resolved.iterdir()):
            name = child.name
            if child.is_dir():
                entries.append(f"{name}/")
            else:
                entries.append(name)
    except OSError as exc:
        return ToolResult(content="", error=str(exc))

    return ToolResult(content="\n".join(entries))


# ---------------------------------------------------------------------------
# Tool registries and schema helpers
# ---------------------------------------------------------------------------

BASELINE_TOOLS: dict[str, ToolDef] = {
    "read_file": ToolDef(
        description="Read the contents of a file within the snapshot. "
                    "Optionally specify start_line and end_line (1-based, inclusive) "
                    "to read a subset of lines.",
        function=read_file,
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative file path inside the snapshot.",
                },
                "start_line": {
                    "type": "integer",
                    "description": "1-based start line (inclusive).",
                },
                "end_line": {
                    "type": "integer",
                    "description": "1-based end line (inclusive).",
                },
            },
            "required": ["path"],
        },
    ),
    "grep_search": ToolDef(
        description="Search for a string or regex pattern across files in the snapshot. "
                    "Returns matching lines with file paths and line numbers.",
        function=grep_search,
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search term or regex pattern.",
                },
                "is_regexp": {
                    "type": "boolean",
                    "description": "Treat query as a regex (default false).",
                },
                "include_pattern": {
                    "type": "string",
                    "description": "Glob to filter file names, e.g. '*.py'.",
                },
            },
            "required": ["query"],
        },
    ),
    "file_search": ToolDef(
        description="Find files by name or glob pattern within the snapshot. "
                    "Returns paths relative to the snapshot root.",
        function=file_search,
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Glob pattern, e.g. '*.py' or 'src/**/*.ts'.",
                },
            },
            "required": ["query"],
        },
    ),
    "list_dir": ToolDef(
        description="List the contents of a directory within the snapshot. "
                    "Directories are suffixed with '/'.",
        function=list_dir,
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative directory path inside the snapshot.",
                },
            },
            "required": ["path"],
        },
    ),
}


def get_baseline_tool_definitions() -> list[dict]:
    """Return tool definitions in OpenAI function-calling format."""

    defs: list[dict] = []
    for name, td in BASELINE_TOOLS.items():
        defs.append({
            "type": "function",
            "function": {
                "name": name,
                "description": td.description,
                "parameters": td.parameters,
            },
        })
    return defs


def get_baseline_tool_definitions_anthropic() -> list[dict]:
    """Return tool definitions in Anthropic tool-use format."""

    defs: list[dict] = []
    for name, td in BASELINE_TOOLS.items():
        defs.append({
            "name": name,
            "description": td.description,
            "input_schema": td.parameters,
        })
    return defs
