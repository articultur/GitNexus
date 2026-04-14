# eval/lib/agent_executor.py
import json
import re
import time
from dataclasses import dataclass, field
from typing import Optional
from pathlib import Path

GITNEXUS_TOOLS = [
    "gitnexus_query", "gitnexus_context", "gitnexus_impact",
    "gitnexus_shortest_path", "gitnexus_get_code", "gitnexus_cypher",
    "gitnexus_detect_changes", "gitnexus_route_map", "gitnexus_test_impact",
    "gitnexus_explain_dataflow",
]

# Failure classification
FAILURE_API_ERROR = "api_error"
FAILURE_PARSE_ERROR = "json_parse_error"
FAILURE_TIMEOUT = "timeout"
FAILURE_WRONG_FILE = "wrong_file"
FAILURE_RIGHT_FILE_MISS_ROOT = "right_file_miss_root"
FAILURE_NO_TOOL_CALL = "no_tool_call"
FAILURE_INCOMPLETE = "incomplete"


@dataclass
class AgentResult:
    prediction: dict
    raw_output: str
    duration_s: float
    tokens: int
    success: bool
    error: Optional[str] = None
    # Tool call tracking
    tool_calls: int = 0
    tool_sequence: list[str] = field(default_factory=list)
    tool_call_records: list[dict] = field(default_factory=list)
    # Failure
    failure_bucket: str = ""


def classify_failure(result: 'AgentResult') -> str:
    """Classify failure bucket. Empty string means success."""
    if result.error:
        if "timeout" in (result.error or "").lower():
            return FAILURE_TIMEOUT
        return FAILURE_API_ERROR
    if not result.success:
        return FAILURE_API_ERROR
    if not result.prediction.get("files"):
        return FAILURE_PARSE_ERROR
    return ""


class AgentExecutor:
    """Claude Code Agent executor with tool call tracking."""

    def __init__(self, timeout: int = 300):
        self.timeout = timeout

    def _build_command(self, prompt: str, group: str) -> list:
        if group == "baseline":
            # Baseline: bare mode, no gitnexus tools
            base = ["claude", "-p", "--bare", "--dangerously-skip-permissions",
                    "--disallowed-tools", ",".join(GITNEXUS_TOOLS),
                    "--disable-slash-commands"]
        else:
            # GitNexus: full system prompt (loads MCP tool descriptions), allow all tools
            base = ["claude", "-p", "--dangerously-skip-permissions"]

        base.append(prompt)
        return base

    def _parse_json_output(self, output: str) -> dict:
        # Try ```json ... ``` block
        json_match = re.search(r'```json\s*(\{.*?\})\s*```', output, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass

        # Try direct parse
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            return {"files": [], "symbols": [], "call_chain": [], "data_flow": {}, "error": "parse_failed"}

    def _parse_tool_calls(self, output: str) -> tuple[int, list[str], list[dict]]:
        """Parse tool calls from raw Claude CLI output.

        Extracts both standard Claude CLI tools (Bash, Grep, Read, Edit, Glob, WebSearch)
        and GitNexus MCP tools with their arguments.
        """
        calls = []
        sequence = []
        records = []

        # Match Claude CLI standard tool invocations: ToolName(args)
        tool_pattern = re.compile(
            r'(Bash|Grep|Read|Edit|Glob|WebSearch)\s*\(\s*([^)]+(?:\n[^)]+)*)\)',
            re.MULTILINE | re.DOTALL
        )
        for match in tool_pattern.finditer(output):
            tool_name = match.group(1)
            args_str = match.group(2)
            args = self._parse_args(args_str)
            records.append({"tool": tool_name, "args": args})
            sequence.append(tool_name)
            calls.append(tool_name)

        # Match GitNexus MCP tool invocations: gitnexus_toolname(args)
        gn_pattern = re.compile(
            r'gitnexus_(query|context|impact|shortest_path|get_code|cypher|detect_changes|route_map|test_impact|explain_dataflow)\s*\(\s*([^)]+(?:\n[^)]+)*)\)',
            re.MULTILINE | re.DOTALL
        )
        for match in gn_pattern.finditer(output):
            tool_name = "gitnexus_" + match.group(1)
            args_str = match.group(2)
            args = self._parse_args(args_str)
            records.append({"tool": tool_name, "args": args})
            sequence.append(tool_name)
            calls.append(tool_name)

        return len(calls), sequence, records

    def _parse_args(self, args_str: str) -> dict:
        """Parse key=value or key="value" args from tool call string."""
        args = {}
        for match in re.finditer(r'(\w+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s,\)]+))', args_str):
            key = match.group(1)
            val = match.group(2) or match.group(3) or match.group(4)
            if val is not None:
                args[key] = val
        return args

    def _extract_tool_calls(self, output: str) -> tuple[int, list[str], list[dict]]:
        """Extract tool call info from Claude CLI output.

        DEPRECATED: Use _parse_tool_calls for comprehensive parsing.
        Kept for backward compatibility.
        """
        return self._parse_tool_calls(output)

    def execute(self, prompt: str, worktree_path: str, group: str) -> AgentResult:
        start = time.time()
        cmd = self._build_command(prompt, group)

        try:
            import subprocess
            result = subprocess.run(
                cmd,
                cwd=worktree_path,
                capture_output=True,
                text=True,
                timeout=self.timeout
            )

            output = result.stdout + result.stderr
            duration = time.time() - start
            tokens = len(output) // 4

            prediction = self._parse_json_output(output)
            tool_calls, tool_sequence, tool_records = self._extract_tool_calls(output)

            agent_result = AgentResult(
                prediction=prediction,
                raw_output=output,
                duration_s=duration,
                tokens=tokens,
                success=True,
                tool_calls=tool_calls,
                tool_sequence=tool_sequence,
                tool_call_records=tool_records,
            )

            agent_result.failure_bucket = classify_failure(agent_result)

            # Check for no_tool_call in gitnexus group
            if group == "gitnexus" and tool_calls == 0:
                agent_result.failure_bucket = FAILURE_NO_TOOL_CALL

            return agent_result

        except subprocess.TimeoutExpired:
            return AgentResult(
                prediction={}, raw_output="", duration_s=self.timeout,
                tokens=0, success=False, error="timeout",
                failure_bucket=FAILURE_TIMEOUT,
            )
        except Exception as e:
            return AgentResult(
                prediction={}, raw_output="", duration_s=time.time() - start,
                tokens=0, success=False, error=str(e),
                failure_bucket=FAILURE_API_ERROR,
            )
