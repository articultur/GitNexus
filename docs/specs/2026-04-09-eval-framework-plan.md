# Eval Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade eval/ from single-turn to multi-turn agent loop with MCP tool execution, extended scoring, statistical testing, and CI gate.

**Architecture:** Modular Python package under `eval/lib/`. MCP client communicates with GitNexus MCP server via stdio JSON-RPC. Baseline tools are pure Python filesystem ops. Executor orchestrates model↔tool loop. Scorer supports GT layering and strict/relaxed modes.

**Tech Stack:** Python 3.10+, asyncio, subprocess (MCP), pytest, SQLite (read-only for verification)

**Spec:** `docs/specs/2026-04-09-eval-framework-design.md`

---

## File Structure

### New files to create:

```
eval/lib/__init__.py              # Package init, version
eval/lib/schema.py                # Case schema definition, validation, migration
eval/lib/baseline_tools.py        # File system tool implementations
eval/lib/mcp_client.py            # MCP stdio JSON-RPC client
eval/lib/executor.py              # Multi-turn tool loop executor
eval/lib/budget.py                # Budget guard and sandbox policy
eval/lib/meta.py                  # run-meta and snapshot-meta generation
eval/lib/scorer.py                # Scoring engine with GT layering
eval/lib/stats.py                 # Statistical tests (bootstrap, Wilcoxon)
eval/schemas/case-schema.json     # JSON Schema for case validation
eval/prompts/templates/locate-fix-baseline.md
eval/prompts/templates/locate-fix-gitnexus.md
eval/prompts/templates/trace-call-chain-baseline.md
eval/prompts/templates/trace-call-chain-gitnexus.md
eval/prompts/templates/impact-analysis-baseline.md
eval/prompts/templates/impact-analysis-gitnexus.md
eval/scripts/ci-gate.sh           # CI gate script
eval/test/__init__.py
eval/test/test_schema.py
eval/test/test_baseline_tools.py
eval/test/test_mcp_client.py
eval/test/test_executor.py
eval/test/test_scorer.py
eval/test/test_stats.py
eval/test/test_budget.py
eval/stats.py                     # Stats CLI entry point
```

### Files to modify:

```
eval/run_eval.py                  # Refactor to delegate to lib/executor
eval/score.py                     # Refactor to delegate to lib/scorer
eval/report.py                    # Add repo breakdown, failure buckets, stats section
eval/scripts/prepare-snapshots.sh # Add snapshot-meta.json generation
eval/scripts/harvest-cases.py     # Add P1 extended fields
```

### Dataset restructuring:

```
eval/dataset/locked/round-01-curated.jsonl     # Frozen copy
eval/dataset/locked/round-01-curated.sha256     # Integrity hash
```

---

## Phase 1: Foundation Modules

### Task 1: Schema module (`eval/lib/schema.py`)

**Files:**
- Create: `eval/lib/__init__.py`
- Create: `eval/lib/schema.py`
- Create: `eval/schemas/case-schema.json`
- Create: `eval/test/__init__.py`
- Create: `eval/test/test_schema.py`

- [ ] **Step 1: Write `eval/lib/__init__.py`**

```python
"""GitNexus Eval Framework — core library."""
__version__ = "2.0.0"
```

- [ ] **Step 2: Write `eval/schemas/case-schema.json`**

JSON Schema with all fields from spec section 3.6. Required fields: `id`, `repo`, `language`, `commit_before`, `commit_fix`, `task_type`, `difficulty`, `issue_text`, `ground_truth`, `gt_source`. All P1 extended fields are optional with defaults.

- [ ] **Step 3: Write test `eval/test/test_schema.py`**

Tests:
- `test_validate_minimal_case` — case with only required fields passes
- `test_validate_full_case` — case with all fields passes
- `test_validate_missing_required` — missing `id` returns error
- `test_validate_invalid_task_type` — `task_type: "C6"` returns error
- `test_validate_invalid_difficulty` — `difficulty: "expert"` returns error
- `test_migrate_old_case` — old-format case gets new fields filled with defaults
- `test_migrate_preserves_existing` — migration doesn't overwrite existing extended fields

- [ ] **Step 4: Run tests, verify they fail**

Run: `cd eval && python -m pytest test/test_schema.py -v`
Expected: FAIL (module not found)

- [ ] **Step 5: Implement `eval/lib/schema.py`**

Key functions:

```python
import json
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).parent.parent / "schemas" / "case-schema.json"

def load_schema() -> dict:
    """Load the JSON Schema for cases."""

def validate_case(case: dict) -> list[str]:
    """Validate a case against schema. Returns list of error strings."""

def validate_cases(path: Path) -> dict[str, list[str]]:
    """Validate all cases in a JSONL file. Returns {case_id: [errors]}."""

def migrate_case(case: dict) -> dict:
    """Migrate old-format case to current schema. Fills defaults for missing fields."""
    # Default values:
    # case_status: "draft"
    # leakage_risk: "medium"
    # task_prompt_style: "locate-fix"
    # dataset_version: ""
    # annotation_version: 1
    # All gt_*_optional / root_cause_gt / supporting_gt: empty lists/dicts

def compute_dataset_hash(path: Path) -> str:
    """SHA256 of concatenated JSONL lines (sorted by id for determinism)."""
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `cd eval && python -m pytest test/test_schema.py -v`
Expected: All 7 tests PASS

- [ ] **Step 7: Commit**

```bash
git add eval/lib/__init__.py eval/lib/schema.py eval/schemas/case-schema.json eval/test/__init__.py eval/test/test_schema.py
git commit -m "feat(eval): add case schema module with validation and migration"
```

---

### Task 2: Baseline tools module (`eval/lib/baseline_tools.py`)

**Files:**
- Create: `eval/lib/baseline_tools.py`
- Create: `eval/test/test_baseline_tools.py`

- [ ] **Step 1: Write test `eval/test/test_baseline_tools.py`**

Tests using a temp directory as snapshot root:

- `test_read_file_success` — read a file, get content back
- `test_read_file_with_lines` — read with start_line/end_line range
- `test_read_file_not_found` — file doesn't exist, get error
- `test_read_file_path_traversal` — `../../etc/passwd` returns sandbox error
- `test_grep_search_literal` — search for literal string, find matches
- `test_grep_search_regexp` — search with regex pattern
- `test_grep_search_with_include` — filter by file pattern
- `test_file_search_glob` — find files by glob pattern
- `test_list_dir` — list directory contents
- `test_sandbox_all_tools` — every tool rejects paths outside snapshot root

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd eval && python -m pytest test/test_baseline_tools.py -v`

- [ ] **Step 3: Implement `eval/lib/baseline_tools.py`**

Key interface:

```python
from dataclasses import dataclass
from pathlib import Path
import os
import subprocess
import re

@dataclass
class ToolResult:
    content: str
    error: str | None = None

class SandboxPolicy:
    """Restricts file access to within snapshot_root."""
    def __init__(self, snapshot_root: Path):
        self.snapshot_root = snapshot_root.resolve()

    def validate_path(self, path: str) -> tuple[Path, str | None]:
        """Resolve and validate path. Returns (resolved_path, error_or_none)."""
        resolved = (self.snapshot_root / path).resolve()
        if not str(resolved).startswith(str(self.snapshot_root)):
            return resolved, f"Path escapes snapshot: {path}"
        return resolved, None

BASELINE_TOOLS = {
    "read_file": {
        "description": "Read file contents. Parameters: path (str), start_line (int, optional), end_line (int, optional)",
        "function": read_file,
    },
    "grep_search": {
        "description": "Search by string or regex. Parameters: query (str), is_regexp (bool, optional), include_pattern (str, optional)",
        "function": grep_search,
    },
    "file_search": {
        "description": "Find files by name/glob. Parameters: query (str)",
        "function": file_search,
    },
    "list_dir": {
        "description": "List directory contents. Parameters: path (str)",
        "function": list_dir,
    },
}

def get_baseline_tool_definitions() -> list[dict]:
    """Return tool definitions in OpenAI function calling format."""
    # Each tool: {"type": "function", "function": {"name": ..., "description": ..., "parameters": {...}}}

def get_baseline_tool_definitions_anthropic() -> list[dict]:
    """Return tool definitions in Anthropic tool format."""
    # Each tool: {"name": ..., "description": ..., "input_schema": {...}}
```

Implementation notes:
- `grep_search`: try `subprocess.run(["rg", ...])` first, fall back to Python `re` if rg not available
- `file_search`: use `Path.glob` with the query as pattern
- All functions accept `(params: dict, sandbox: SandboxPolicy)` and return `ToolResult`

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd eval && python -m pytest test/test_baseline_tools.py -v`

- [ ] **Step 5: Commit**

```bash
git add eval/lib/baseline_tools.py eval/test/test_baseline_tools.py
git commit -m "feat(eval): add baseline file tools with sandbox enforcement"
```

---

### Task 3: Budget module (`eval/lib/budget.py`)

**Files:**
- Create: `eval/lib/budget.py`
- Create: `eval/test/test_budget.py`

- [ ] **Step 1: Write test `eval/test/test_budget.py`**

- `test_case_under_limit` — tokens under per-case limit, check passes
- `test_case_over_limit` — tokens exceed per-case limit, check fails
- `test_total_under_budget` — total tokens under budget, check passes
- `test_total_over_budget` — total tokens exceed budget, check fails
- `test_summary` — summary reports correct usage percentages

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement `eval/lib/budget.py`**

```python
from dataclasses import dataclass, field

@dataclass
class BudgetGuard:
    per_case_token_limit: int = 50000
    total_token_budget: int = 5000000
    _total_used: int = field(default=0, repr=False)

    def check_case(self, tokens_used: int) -> bool:
        return tokens_used <= self.per_case_token_limit

    def check_total(self) -> bool:
        return self._total_used <= self.total_token_budget

    def record_usage(self, tokens: int) -> None:
        self._total_used += tokens

    def summary(self) -> dict:
        return {
            "per_case_limit": self.per_case_token_limit,
            "total_budget": self.total_token_budget,
            "total_used": self._total_used,
            "budget_pct": round(self._total_used / self.total_token_budget * 100, 1),
        }
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```bash
git add eval/lib/budget.py eval/test/test_budget.py
git commit -m "feat(eval): add budget guard for token spending limits"
```

---

### Task 4: Meta module (`eval/lib/meta.py`)

**Files:**
- Create: `eval/lib/meta.py`

- [ ] **Step 1: Implement `eval/lib/meta.py`**

```python
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

def compute_dataset_hash(path: Path) -> str:
    """SHA256 of sorted JSONL lines for dataset integrity."""
    cases = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                cases.append(json.loads(line))
    cases.sort(key=lambda c: c["id"])
    payload = "\n".join(json.dumps(c, sort_keys=True) for c in cases)
    return hashlib.sha256(payload.encode()).hexdigest()

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
) -> dict:
    """Generate run-meta.json content."""
    import subprocess
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
```

- [ ] **Step 2: Commit**

```bash
git add eval/lib/meta.py
git commit -m "feat(eval): add run-meta and snapshot-meta generation"
```

---

## Phase 2: MCP Client

### Task 5: MCP stdio client (`eval/lib/mcp_client.py`)

**Files:**
- Create: `eval/lib/mcp_client.py`
- Create: `eval/test/test_mcp_client.py`

- [ ] **Step 1: Write test `eval/test/test_mcp_client.py`**

Tests using a mock MCP server script (echo server):

- `test_initialize` — start server, initialize, get capabilities
- `test_list_tools` — list tools returns array of tool definitions
- `test_call_tool` — call a tool, get result back
- `test_call_tool_timeout` — tool exceeds timeout, get timeout error
- `test_server_crash` — server crashes during call, get error
- `test_close` — close cleanly terminates server process
- `test_concurrent_calls` — multiple sequential calls on same server

Mock server: a simple Python script that reads JSON-RPC from stdin, writes to stdout.

- [ ] **Step 2: Create mock MCP server for tests**

Create `eval/test/mock_mcp_server.py` — reads JSON-RPC messages from stdin, responds with:
- `initialize` → capabilities
- `tools/list` → list of 2 mock tools
- `tools/call` → echo back the arguments as result

- [ ] **Step 3: Run tests, verify they fail**

- [ ] **Step 4: Implement `eval/lib/mcp_client.py`**

Key interface:

```python
import asyncio
import json
import subprocess
from typing import Any

class MCPToolError(Exception):
    """Error from MCP tool execution."""
    def __init__(self, tool_name: str, error_type: str, message: str):
        self.tool_name = tool_name
        self.error_type = error_type
        self.message = message
        super().__init__(f"MCP tool error [{tool_name}]: [{error_type}] {message}")

class MCPClient:
    """MCP stdio JSON-RPC client for GitNexus tool server."""

    def __init__(self, server_cmd: list[str], cwd: str, timeout: float = 30.0):
        self.server_cmd = server_cmd
        self.cwd = cwd
        self.timeout = timeout
        self._process: subprocess.Popen | None = None
        self._request_id: int = 0
        self._initialized: bool = False

    async def initialize(self) -> dict:
        """Send MCP initialize request, receive capabilities."""

    async def list_tools(self) -> list[dict]:
        """Get available tools from server."""

    async def call_tool(self, name: str, args: dict) -> dict:
        """Call a tool and return result."""

    async def close(self) -> None:
        """Terminate server process."""

    def _send_request(self, method: str, params: dict = None) -> dict:
        """Send JSON-RPC request and read response."""

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def get_tool_definitions_openai(self) -> list[dict]:
        """Convert MCP tools to OpenAI function calling format."""

    def get_tool_definitions_anthropic(self) -> list[dict]:
        """Convert MCP tools to Anthropic tool format."""
```

Implementation notes:
- Use `subprocess.Popen` with `stdin=PIPE, stdout=PIPE, stderr=PIPE`
- JSON-RPC over stdio: each message is a JSON line terminated by `\n`
- Read response by reading until newline
- Handle `Content-Length` header if present (some MCP implementations use it)
- Timeout: use `select` or `threading.Timer` for read timeout

- [ ] **Step 5: Run tests, verify they pass**

- [ ] **Step 6: Commit**

```bash
git add eval/lib/mcp_client.py eval/test/test_mcp_client.py eval/test/mock_mcp_server.py
git commit -m "feat(eval): add MCP stdio JSON-RPC client"
```

---

## Phase 3: Tool Loop Executor

### Task 6: Executor module (`eval/lib/executor.py`)

**Files:**
- Create: `eval/lib/executor.py`
- Create: `eval/test/test_executor.py`

This is the core module. It depends on `mcp_client.py`, `baseline_tools.py`, and `budget.py`.

- [ ] **Step 1: Write test `eval/test/test_executor.py`**

Tests using a mock model that returns predetermined responses:

- `test_single_turn_response` — model returns JSON immediately, no tool calls
- `test_one_tool_call_then_response` — model calls one tool, gets result, then returns JSON
- `test_multi_tool_calls` — model calls tools 3 times then returns JSON
- `test_max_steps_reached` — model keeps calling tools until max_steps, loop terminates
- `test_token_budget_exceeded` — token budget hit, loop terminates
- `test_tool_error_recovery` — tool returns error, model gets error message, can retry
- `test_baseline_group` — only baseline tools available
- `test_gitnexus_group` — baseline + MCP tools available
- `test_mcp_server_failure` — MCP server fails to start, graceful failure
- `test_parse_final_output` — various JSON output formats are correctly parsed

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement `eval/lib/executor.py`**

Key interface:

```python
from __future__ import annotations
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .baseline_tools import BASELINE_TOOLS, SandboxPolicy, ToolResult
from .budget import BudgetGuard
from .mcp_client import MCPClient, MCPToolError

@dataclass
class ToolCallRecord:
    step: int
    tool_name: str
    arguments: dict
    result_preview: str      # first 500 chars
    error: str | None
    duration_s: float

@dataclass
class RawResult:
    case_id: str
    group: str
    model: str
    prompt_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    tool_calls: int = 0
    tool_sequence: list[str] = field(default_factory=list)
    tool_call_records: list[dict] = field(default_factory=list)
    prediction: dict = field(default_factory=dict)
    raw_output: str = ""
    parse_error: str = ""
    error: str = ""
    duration_s: float = 0.0
    timestamp: str = ""
    steps_used: int = 0
    stopped_reason: str = ""  # "final_json" | "max_steps" | "token_budget" | "error"

class ToolLoopExecutor:
    def __init__(
        self,
        model: str,
        max_steps: int = 15,
        token_budget: int = 50000,
        max_tokens_per_turn: int = 2048,
        retry_count: int = 2,
    ):
        ...

    async def run(
        self,
        case: dict,
        group: str,
        snapshots_dir: str,
        prompt_template: str,
    ) -> RawResult:
        """Execute multi-turn tool loop for a single case."""
        # 1. Set up sandbox for snapshot
        # 2. If gitnexus group: start MCP server
        # 3. Build initial messages with prompt
        # 4. Enter tool loop
        # 5. Return RawResult
```

Core loop logic:

```python
async def _tool_loop(self, messages, tools, sandbox, mcp_client=None):
    """Core loop: model → tool_call → execute → result → model → ..."""
    for step in range(self.max_steps):
        # 1. Call model with messages + tool definitions
        response = await self._call_model(messages, tools)

        # 2. Check for tool calls
        tool_calls = self._extract_tool_calls(response)

        if not tool_calls:
            # Model returned text only — extract JSON and stop
            return response, "final_json"

        # 3. Execute each tool call
        for tc in tool_calls:
            result = await self._execute_tool(tc, sandbox, mcp_client)
            # Append tool result to messages
            messages.append(self._format_tool_result(tc, result))

        # 4. Check budget
        if not self.budget.check_total():
            return response, "token_budget"

    return response, "max_steps"
```

Tool execution dispatch:

```python
async def _execute_tool(self, tool_call, sandbox, mcp_client=None):
    """Dispatch tool call to baseline or MCP implementation."""
    name = tool_call["name"]
    args = tool_call["arguments"]

    # Check if it's a baseline tool
    if name in BASELINE_TOOLS:
        return BASELINE_TOOLS[name]["function"](args, sandbox)

    # Otherwise try MCP
    if mcp_client:
        try:
            result = await mcp_client.call_tool(name, args)
            return ToolResult(content=json.dumps(result))
        except MCPToolError as e:
            return ToolResult(content="", error=str(e))

    return ToolResult(content="", error=f"Unknown tool: {name}")
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```bash
git add eval/lib/executor.py eval/test/test_executor.py
git commit -m "feat(eval): add multi-turn tool loop executor with MCP dispatch"
```

---

## Phase 4: CLI Refactor — run_eval.py

### Task 7: Refactor `eval/run_eval.py`

**Files:**
- Modify: `eval/run_eval.py`

- [ ] **Step 1: Refactor run_eval.py to delegate to lib/executor**

Keep the existing CLI interface but replace the single-turn `run_case` logic with calls to `ToolLoopExecutor`. Key changes:

1. Add new CLI args: `--resume`, `--case-ids`, `--shard-index`, `--shard-count`, `--parallelism`, `--retry-count`, `--max-steps`, `--token-budget`
2. Replace `run_case()` with `ToolLoopExecutor.run()`
3. Add `--output` defaulting to `eval/runs/{run_id}/` instead of `eval/results/raw/`
4. Write `run-meta.json` at end of run
5. Use `asyncio` for parallel case execution when `--parallelism > 1`
6. Keep `--dry-run` working

The refactored file should be ~200 lines (CLI arg parsing + orchestration). All logic lives in `lib/`.

- [ ] **Step 2: Test with `--dry-run`**

Run: `cd eval && python run_eval.py --cases dataset/validation-seed-cases.jsonl --group baseline --dry-run`

Expected: prints prompts without calling API.

- [ ] **Step 3: Commit**

```bash
git add eval/run_eval.py
git commit -m "refactor(eval): run_eval.py delegates to lib/executor for multi-turn tool loop"
```

---

## Phase 5: Scoring Engine

### Task 8: Scorer module (`eval/lib/scorer.py`)

**Files:**
- Create: `eval/lib/scorer.py`
- Create: `eval/test/test_scorer.py`

- [ ] **Step 1: Write test `eval/test/test_scorer.py`**

Tests:

- `test_file_prf_perfect` — predicted files match GT exactly → P=1, R=1, F1=1
- `test_file_prf_partial` — some files correct, some missed, some extra
- `test_file_prf_empty_gt` — empty GT → perfect score
- `test_symbol_hit_exact` — exact qualified name match
- `test_symbol_hit_suffix` — suffix match (method matches class.method)
- `test_symbol_hit_no_match` — no matching symbols
- `test_gt_layering_strict` — strict mode only uses must files/symbols
- `test_gt_layering_relaxed` — relaxed mode uses must + optional
- `test_score_case_with_api_error` — API error case gets flagged
- `test_score_case_with_parse_error` — parse error gets flagged
- `test_aggregate_by_language` — aggregation groups by language correctly
- `test_aggregate_by_repo` — aggregation groups by repo correctly
- `test_aggregate_by_task_type` — aggregation groups by task_type
- `test_aggregate_small_n_warning` — n < 5 sets warning flag
- `test_compute_delta` — delta between baseline and gitnexus groups
- `test_classify_failure_bucket_wrong_file` — F1=0 → wrong_file bucket
- `test_classify_failure_bucket_json_error` — parse_error → json_parse_error bucket

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement `eval/lib/scorer.py`**

Key data structures:

```python
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class GTLayer:
    files_must: list[str] = field(default_factory=list)
    files_optional: list[str] = field(default_factory=list)
    symbols_must: list[str] = field(default_factory=list)
    symbols_optional: list[str] = field(default_factory=list)

@dataclass
class GroundTruth:
    edit_gt: GTLayer = field(default_factory=GTLayer)
    root_cause_gt: GTLayer = field(default_factory=GTLayer)
    supporting_gt: GTLayer = field(default_factory=GTLayer)

@dataclass
class CaseScore:
    case_id: str
    group: str
    task_type: str
    difficulty: str
    language: str
    repo: str

    file_precision: float = 0.0
    file_recall: float = 0.0
    file_f1: float = 0.0
    symbol_hit_rate: float = 0.0
    symbol_match_types: dict = field(default_factory=dict)  # {exact: n, suffix: n}

    tool_calls: int = 0
    total_tokens: int = 0
    confidence: float = 0.0
    duration_s: float = 0.0
    steps_used: int = 0

    parse_ok: bool = True
    api_error: bool = False
    failure_bucket: str = ""  # empty = success

@dataclass
class GroupAggregate:
    group: str
    n_cases: int = 0
    n_parse_ok: int = 0
    n_api_error: int = 0
    avg_file_f1: float = 0.0
    avg_symbol_hit: float = 0.0
    avg_tool_calls: float = 0.0
    avg_tokens: float = 0.0
    by_task_type: dict = field(default_factory=dict)
    by_language: dict = field(default_factory=dict)
    by_repo: dict = field(default_factory=dict)
    by_difficulty: dict = field(default_factory=dict)
```

Key functions:

```python
def extract_gt_layers(case: dict) -> GroundTruth:
    """Extract GT layers from case. Supports both old and new schema."""

def file_prf(pred_files: list[str], gt_files: list[str]) -> tuple[float, float, float]:
    """File precision, recall, F1."""

def symbol_hit(pred_symbols: list[str], gt_symbols: list[str]) -> tuple[float, dict]:
    """Symbol hit rate with match type breakdown."""

def classify_failure(score: CaseScore) -> str:
    """Classify failure bucket for a case."""

def score_case(raw: dict, case: dict, group: str, mode: str = "strict") -> CaseScore:
    """Score a single case against ground truth."""

def aggregate(scores: list[CaseScore]) -> GroupAggregate:
    """Aggregate scores with breakdowns by task_type, language, repo, difficulty."""

def compute_delta(base_agg: GroupAggregate, gn_agg: GroupAggregate) -> dict:
    """Compute delta between baseline and gitnexus aggregates."""
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```bash
git add eval/lib/scorer.py eval/test/test_scorer.py
git commit -m "feat(eval): add scoring engine with GT layering, strict/relaxed, failure buckets"
```

---

### Task 9: Refactor `eval/score.py`

**Files:**
- Modify: `eval/score.py`

- [ ] **Step 1: Refactor score.py to delegate to lib/scorer**

Add `--mode` flag (`strict` / `relaxed` / `both`). Default `both`.
Output both `scores.jsonl` and `scores-relaxed.jsonl` when mode is `both`.
Keep existing CLI interface otherwise.

- [ ] **Step 2: Verify with existing data**

Run: `cd eval && python score.py --cases dataset/validation-seed-cases.jsonl`

- [ ] **Step 3: Commit**

```bash
git add eval/score.py
git commit -m "refactor(eval): score.py delegates to lib/scorer with strict/relaxed modes"
```

---

## Phase 6: Statistical Testing

### Task 10: Stats module (`eval/lib/stats.py`)

**Files:**
- Create: `eval/lib/stats.py`
- Create: `eval/test/test_stats.py`
- Create: `eval/stats.py` (CLI entry)

- [ ] **Step 1: Write test `eval/test/test_stats.py`**

Tests with known values:

- `test_paired_deltas` — compute deltas between paired base/gn scores
- `test_bootstrap_ci_known_data` — test with [1,2,3,4,5] deltas, CI contains mean
- `test_bootstrap_ci_width` — CI width is reasonable for n=30
- `test_wilcoxon_all_positive` — all positive deltas → significant
- `test_wilcoxon_mixed` — mixed deltas → check p-value format
- `test_wilcoxon_zero_deltas` — handle zero deltas (tie handling)
- `test_cohen_d_large` — known large effect size
- `test_cohen_d_small` — known small effect size
- `test_compute_stats_by_dimension` — stats computed per language/task_type correctly
- `test_dimension_strength_positive` — Δ>0, symbol positive, n≥5 → strong
- `test_dimension_strength_insufficient_n` — n<5 → "insufficient_samples"

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement `eval/lib/stats.py`**

```python
import random
from typing import Any

def paired_deltas(base_scores: list[float], gn_scores: list[float]) -> list[float]:
    """Compute per-case delta: gn - base."""

def bootstrap_ci(
    deltas: list[float],
    n_resample: int = 10000,
    ci: float = 0.95,
    seed: int = 42,
) -> tuple[float, float]:
    """Bootstrap confidence interval for mean delta."""

def wilcoxon_signed_rank_test(deltas: list[float]) -> dict:
    """Wilcoxon signed-rank test (no scipy dependency).
    Returns: {"statistic": float, "p_value": float, "n": int}
    Uses normal approximation for n > 20, exact for n <= 20."""

def cohen_d(deltas: list[float]) -> float:
    """Cohen's d effect size for paired samples."""

def compute_dimension_stats(
    base_scores: list[dict],
    gn_scores: list[dict],
    dimension: str,  # "language" | "task_type" | "repo" | "difficulty"
) -> dict[str, dict]:
    """Per-dimension statistical analysis.
    Returns: {dimension_value: {delta_mean, ci_low, ci_high, p_value, effect_size, n, strength}}"""

def judge_strength(
    delta_f1: float,
    delta_symbol: float,
    n: int,
    p_value: float,
) -> str:
    """Judge dimension strength.
    Returns: "strong" | "moderate" | "preliminary" | "insufficient_samples" | "no_benefit"
    """
```

- [ ] **Step 4: Implement `eval/stats.py` CLI entry**

```python
#!/usr/bin/env python3
"""Statistical analysis CLI for eval results."""
# Reads scores.jsonl, computes stats, writes stats.json
# Usage: python eval/stats.py --scores eval/runs/{id}/scores.jsonl --output eval/runs/{id}/stats.json
```

- [ ] **Step 5: Run tests, verify they pass**

- [ ] **Step 6: Commit**

```bash
git add eval/lib/stats.py eval/stats.py eval/test/test_stats.py
git commit -m "feat(eval): add statistical testing with bootstrap CI, Wilcoxon, effect size"
```

---

## Phase 7: Report Enhancements

### Task 11: Enhance `eval/report.py`

**Files:**
- Modify: `eval/report.py`

- [ ] **Step 1: Add repo→language mapping table**

Add a Dataset Overview section at the top of the report showing:

```
| Repo | Language | Cases (n) | Difficulty Distribution |
|------|----------|-----------|------------------------|
| pallets/flask | python | 10 | easy:3, medium:4, hard:3 |
```

Data source: `summary.json` → `baseline.by_language` + case repo info.

- [ ] **Step 2: Add by_repo breakdown table**

After by_language, add:

```
| Repo | Language | n | F1 Base | F1 GN | Δ F1 | Sym Hit Base | Sym Hit GN | Δ Sym Hit |
```

- [ ] **Step 3: Add failure buckets section**

Read failure_bucket from scores, produce:

```
## Failure Analysis
| Bucket | Baseline (n) | GitNexus (n) |
|--------|-------------|-------------|
| wrong_file | 5 | 2 |
| json_parse_error | 1 | 0 |
```

- [ ] **Step 4: Add statistics section**

If `stats.json` exists alongside `summary.json`, include:

```
## Statistical Significance
| Metric | Δ Mean | 95% CI | p-value | Effect Size | n |
|--------|--------|--------|---------|-------------|---|
| File F1 | +0.15 | [0.08, 0.22] | 0.003 | 0.65 | 158 |
```

- [ ] **Step 5: Add dimension strength summary**

```
## Dimension Strength Summary
| Dimension | Value | Δ F1 | Strength | Note |
|-----------|-------|------|----------|------|
| language | python | +0.12 | moderate | n=10, single repo |
| task_type | C1 | +0.18 | strong | n=63, p<0.05 |
```

- [ ] **Step 6: Add cost summary**

```
## Cost Summary
| Group | Total Tokens | Avg Tokens/Case | Estimated Cost |
```

- [ ] **Step 7: Add pollution risk section**

If cases have `leakage_risk` field, report distribution.

- [ ] **Step 8: Test report generation**

Run: `cd eval && python report.py --summary results/verification-run/summary.json --output /tmp/test-report.md`

- [ ] **Step 9: Commit**

```bash
git add eval/report.py
git commit -m "feat(eval): enhance report with repo breakdown, failure buckets, stats, strength summary"
```

---

### Task 12: Add per-dimension report files

**Files:**
- Modify: `eval/report.py` (add generation of sub-reports)

- [ ] **Step 1: Add `--output-per-language`, `--output-per-task`, `--output-per-repo` flags**

Each generates a standalone markdown file with detailed breakdown for that dimension.

- [ ] **Step 2: Implement per-dimension report generators**

Each follows same structure: overview table → per-value breakdown → failure analysis → stats.

- [ ] **Step 3: Commit**

```bash
git add eval/report.py
git commit -m "feat(eval): add per-language, per-task, per-repo sub-reports"
```

---

## Phase 8: Dataset & Prompt Restructuring

### Task 13: Freeze dataset and restructure directories

**Files:**
- Create: `eval/dataset/locked/round-01-curated.jsonl` (copy of existing)
- Create: `eval/dataset/locked/round-01-curated.sha256`
- Create: `eval/dataset/candidates/` (empty dir with .gitkeep)
- Create: `eval/dataset/archive/` (empty dir with .gitkeep)

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p eval/dataset/locked eval/dataset/candidates eval/dataset/archive
cp eval/dataset/round-01-curated-cases.jsonl eval/dataset/locked/round-01-curated.jsonl
```

- [ ] **Step 2: Generate SHA256 hash**

```bash
python -c "
from eval.lib.meta import compute_dataset_hash
from pathlib import Path
h = compute_dataset_hash(Path('eval/dataset/locked/round-01-curated.jsonl'))
Path('eval/dataset/locked/round-01-curated.sha256').write_text(h)
print(h)
"
```

- [ ] **Step 3: Create .gitkeep files**

```bash
touch eval/dataset/candidates/.gitkeep
touch eval/dataset/archive/.gitkeep
```

- [ ] **Step 4: Update run_eval.py to use locked dataset path**

Default `--cases` to `eval/dataset/locked/round-01-curated.jsonl`.

- [ ] **Step 5: Commit**

```bash
git add eval/dataset/locked/ eval/dataset/candidates/ eval/dataset/archive/ eval/run_eval.py
git commit -m "feat(eval): freeze round-01-curated dataset, restructure dataset directories"
```

---

### Task 14: Create prompt templates

**Files:**
- Create: `eval/prompts/templates/locate-fix-baseline.md`
- Create: `eval/prompts/templates/locate-fix-gitnexus.md`
- Create: `eval/prompts/templates/trace-call-chain-baseline.md`
- Create: `eval/prompts/templates/trace-call-chain-gitnexus.md`
- Create: `eval/prompts/templates/impact-analysis-baseline.md`
- Create: `eval/prompts/templates/impact-analysis-gitnexus.md`

- [ ] **Step 1: Create locate-fix templates**

Based on existing `task.md` and `task-with-gitnexus.md`, but with prompt version header:
```
<!-- prompt_version: 2.0.0 -->
<!-- prompt_type: locate-fix -->
<!-- prompt_group: baseline -->
```

Key difference from v1: instructions now explicitly say "use the available tools to investigate" instead of implying static analysis.

- [ ] **Step 2: Create trace-call-chain templates**

Focus on "trace the call chain from entry point to root cause". Same structure but task section emphasizes call chain discovery.

- [ ] **Step 3: Create impact-analysis templates**

Focus on "analyze the blast radius of changing this code". Same structure but task section emphasizes impact analysis.

- [ ] **Step 4: Update executor to select template based on `task_prompt_style`**

In `lib/executor.py`, add template selection logic:
```python
def select_template(case: dict, group: str, templates_dir: Path) -> str:
    style = case.get("task_prompt_style", "locate-fix")
    template_name = f"{style}-{group}.md"
    path = templates_dir / template_name
    if not path.exists():
        path = templates_dir / f"locate-fix-{group}.md"
    return path.read_text(encoding="utf-8")
```

- [ ] **Step 5: Commit**

```bash
git add eval/prompts/templates/ eval/lib/executor.py
git commit -m "feat(eval): add task-specific prompt templates for locate-fix, trace-call-chain, impact-analysis"
```

---

### Task 15: Update prepare-snapshots.sh for snapshot-meta

**Files:**
- Modify: `eval/scripts/prepare-snapshots.sh`

- [ ] **Step 1: Add snapshot-meta.json generation**

After the existing `.eval-case.json` write, add:

```bash
# Generate snapshot metadata
python3 -c "
import json, sys
from pathlib import Path
sys.path.insert(0, '$SCRIPT_DIR/..')
from lib.meta import generate_snapshot_meta

case = json.loads(Path('$dest/.eval-case.json').read_text())
meta = generate_snapshot_meta(case, Path('$dest'))
Path('$dest/snapshot-meta.json').write_text(json.dumps(meta, indent=2))
"
```

- [ ] **Step 2: Test with a single case**

Run: `bash eval/scripts/prepare-snapshots.sh --cases eval/dataset/validation-seed-cases.jsonl --skip-analyze --force`

- [ ] **Step 3: Commit**

```bash
git add eval/scripts/prepare-snapshots.sh
git commit -m "feat(eval): generate snapshot-meta.json during snapshot preparation"
```

---

### Task 16: Update harvest-cases.py for extended fields

**Files:**
- Modify: `eval/scripts/harvest-cases.py`

- [ ] **Step 1: Add P1 extended fields to output schema**

When harvesting, auto-fill:
- `case_status: "draft"`
- `leakage_risk`: heuristic based on repo stars + PR popularity
- `task_prompt_style`: map from `task_type` (C1→locate-fix, C3→trace-call-chain, C5→impact-analysis)
- `dataset_version`: from harvest run metadata
- `annotation_version: 1`

- [ ] **Step 2: Commit**

```bash
git add eval/scripts/harvest-cases.py
git commit -m "feat(eval): extend harvest-cases.py with P1 schema fields"
```

---

## Phase 9: CI Integration (P3)

### Task 17: CI gate script (`eval/scripts/ci-gate.sh`)

**Files:**
- Create: `eval/scripts/ci-gate.sh`

- [ ] **Step 1: Implement ci-gate.sh**

```bash
#!/usr/bin/env bash
# eval/scripts/ci-gate.sh
# CI gate: run eval and check delta threshold
#
# Usage:
#   bash eval/scripts/ci-gate.sh \
#       --cases eval/dataset/locked/round-01-curated.jsonl \
#       --threshold 0.15 \
#       --mode soft \
#       --output eval/runs/ci-gate
#
# Modes:
#   soft  — output warning, exit 0
#   hard  — exit 1 if threshold not met

set -euo pipefail

CASES_FILE="eval/dataset/locked/round-01-curated.jsonl"
THRESHOLD="0.15"
MODE="soft"
OUTPUT="eval/runs/ci-gate"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cases)     CASES_FILE="$2";  shift 2 ;;
    --threshold) THRESHOLD="$2";   shift 2 ;;
    --mode)      MODE="$2";        shift 2 ;;
    --output)    OUTPUT="$2";      shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# 1. Run eval
python3 eval/run_eval.py --cases "$CASES_FILE" --group both --output "$OUTPUT/raw"

# 2. Score
python3 eval/score.py --cases "$CASES_FILE" --raw "$OUTPUT/raw" --output "$OUTPUT"

# 3. Extract delta F1
DELTA_F1=$(python3 -c "
import json
with open('$OUTPUT/summary.json') as f:
    s = json.load(f)
print(s['delta']['file_f1']['delta'])
")

# 4. Judge
echo "Δ File F1: $DELTA_F1 (threshold: $THRESHOLD)"

if python3 -c "exit(0 if float('$DELTA_F1') >= float('$THRESHOLD') else 1)"; then
    echo "✅ Gate PASSED"
    exit 0
else
    echo "⚠️ Gate FAILED: Δ File F1 ($DELTA_F1) < threshold ($THRESHOLD)"
    if [[ "$MODE" == "hard" ]]; then
        exit 1
    fi
    echo "Soft mode — not blocking."
    exit 0
fi
```

- [ ] **Step 2: Add JUnit XML output**

Add a Python helper that converts `summary.json` to JUnit XML format for CI consumption. Create `eval/scripts/junit_report.py`.

- [ ] **Step 3: Commit**

```bash
git add eval/scripts/ci-gate.sh eval/scripts/junit_report.py
git commit -m "feat(eval): add CI gate script with soft/hard modes and JUnit XML output"
```

---

## Phase 10: Integration Testing & Polish

### Task 18: End-to-end integration test

**Files:**
- Create: `eval/test/test_e2e.py`

- [ ] **Step 1: Write e2e test**

Test that runs the full pipeline with a mock model and mock MCP server:

1. Prepare a temp directory with 2 test cases and a fake snapshot
2. Run executor with mock model → produces raw results
3. Run scorer → produces scores
4. Run stats → produces stats.json
5. Run report → produces delta-report.md
6. Verify all expected output files exist
7. Verify report contains expected sections

- [ ] **Step 2: Run e2e test**

- [ ] **Step 3: Commit**

```bash
git add eval/test/test_e2e.py
git commit -m "test(eval): add end-to-end integration test"
```

---

### Task 19: Update README.md

**Files:**
- Modify: `eval/README.md`

- [ ] **Step 1: Update README for v2**

Reflect new CLI args, directory structure, scoring modes, prompt templates, stats, CI gate. Keep the quick start section working.

- [ ] **Step 2: Commit**

```bash
git add eval/README.md
git commit -m "docs(eval): update README for v2 multi-turn eval framework"
```

---

## Self-Review

**1. Spec coverage check:**
- P0 ✅: Tasks 5-7 (MCP client, executor, run_eval refactor), Task 4 (meta), Task 3 (budget), Task 13 (dataset freeze)
- P1 ✅: Task 8 (GT layering, strict/relaxed), Task 14 (prompt templates), Task 16 (extended fields)
- P2 ✅: Task 10 (stats), Task 11-12 (report enhancements, per-dim reports), Task 8 (failure buckets)
- P3 ✅: Task 17 (CI gate)

**2. Placeholder scan:** No TBD/TODO found. All tasks have concrete steps.

**3. Type consistency:**
- `RawResult` defined in Task 6 (executor), used in Task 7 (run_eval)
- `CaseScore` defined in Task 8 (scorer), used in Task 9 (score.py), Task 10 (stats)
- `MCPClient` defined in Task 5, used in Task 6 (executor)
- `ToolResult` defined in Task 2, used in Task 6 (executor)
- All consistent.
