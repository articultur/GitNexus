"""Tests for eval.lib.executor — ToolLoopExecutor and helpers."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eval.lib.executor import (
    RawResult,
    ToolLoopExecutor,
    parse_prediction,
    _extract_first_balanced_json_object,
    _repair_json_candidate,
)
from eval.lib.baseline_tools import ToolResult, SandboxPolicy


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def executor() -> ToolLoopExecutor:
    """Create an executor with small limits for testing."""
    return ToolLoopExecutor(
        model="test-model",
        max_steps=5,
        token_budget=5000,
        max_tokens_per_turn=512,
    )


@pytest.fixture
def sample_case() -> dict:
    """Minimal evaluation case."""
    return {
        "id": "test-001",
        "repo": "example/repo",
        "language": "python",
        "commit_before": "abc123",
        "commit_fix": "def456",
        "issue_text": "Bug in auth module",
    }


@pytest.fixture
def snapshot(tmp_path: Path) -> Path:
    """Create a minimal snapshot for the test case."""
    case_dir = tmp_path / "test-001"
    case_dir.mkdir()
    (case_dir / "main.py").write_text("def main():\n    pass\n")
    return tmp_path


# ---------------------------------------------------------------------------
# parse_prediction tests
# ---------------------------------------------------------------------------

class TestParsePrediction:

    def test_json_block(self):
        text = 'Here is my answer:\n```json\n{"files": ["a.py"], "confidence": 0.9}\n```'
        pred, err = parse_prediction(text)
        assert err == ""
        assert pred["files"] == ["a.py"]
        assert pred["confidence"] == 0.9

    def test_bare_json(self):
        text = 'The result is {"files": ["b.py"], "symbols": ["foo"], "confidence": 0.7} done.'
        pred, err = parse_prediction(text)
        assert err == ""
        assert pred["files"] == ["b.py"]

    def test_trailing_commas_repaired(self):
        text = '```json\n{"files": ["a.py"], "confidence": 0.9,}\n```'
        pred, err = parse_prediction(text)
        assert err == ""
        assert pred["confidence"] == 0.9

    def test_no_json(self):
        text = "I couldn't determine the answer."
        pred, err = parse_prediction(text)
        assert pred == {}
        assert err != ""

    def test_nested_json(self):
        text = '```json\n{"root_cause": {"files": ["a.py"], "symbols": ["Auth"]}, "confidence": 1.0}\n```'
        pred, err = parse_prediction(text)
        assert err == ""
        assert pred["root_cause"]["files"] == ["a.py"]

    def test_truncated_json_repaired(self):
        text = '```json\n{"files": ["a.py", "b.py"\n```'
        pred, err = parse_prediction(text)
        # Should repair by balancing brackets
        assert "files" in pred

    def test_multiple_json_blocks_takes_first(self):
        text = '```json\n{"first": true}\n```\nSome text\n```json\n{"second": true}\n```'
        pred, err = parse_prediction(text)
        assert err == ""
        assert pred["first"] is True
        assert "second" not in pred


# ---------------------------------------------------------------------------
# _fill_prompt tests
# ---------------------------------------------------------------------------

class TestFillPrompt:

    def test_all_variables_replaced(self, executor, sample_case, snapshot):
        template = (
            "Analyze {{repo}} ({{language}}). "
            "Commit: {{commit_before}}. "
            "Snapshot: {{snapshot_dir}}. "
            "Issue: {{issue_text}}."
        )
        result = executor._fill_prompt(template, sample_case, str(snapshot))
        assert "{{repo}}" not in result
        assert "{{language}}" not in result
        assert "{{commit_before}}" not in result
        assert "{{snapshot_dir}}" not in result
        assert "{{issue_text}}" not in result
        assert "example/repo" in result
        assert "python" in result
        assert "abc123" in result
        assert "test-001" in result
        assert "Bug in auth module" in result

    def test_missing_case_fields_default_empty(self, executor, snapshot):
        case = {"id": "x", "repo": "r", "language": "js", "commit_before": "c1"}
        template = "{{repo}} {{language}} {{issue_text}}"
        result = executor._fill_prompt(template, case, str(snapshot))
        assert result == "r js "


# ---------------------------------------------------------------------------
# _extract_response tests
# ---------------------------------------------------------------------------

class TestExtractResponse:

    def test_openai_text_only(self, executor):
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "Here is my analysis.",
                },
            }],
            "usage": {"total_tokens": 100},
        }
        msg, tcs = executor._extract_response(response)
        assert msg["content"] == "Here is my analysis."
        assert tcs == []

    def test_openai_tool_calls(self, executor):
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_123",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": '{"path": "main.py"}',
                        },
                    }],
                },
            }],
            "usage": {"total_tokens": 150},
        }
        msg, tcs = executor._extract_response(response)
        assert len(tcs) == 1
        assert tcs[0]["name"] == "read_file"
        assert tcs[0]["arguments"] == {"path": "main.py"}
        assert tcs[0]["id"] == "call_123"
        # Message should have tool_calls attached for OpenAI format
        assert "tool_calls" in msg

    def test_openai_multiple_tool_calls(self, executor):
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "read_file",
                                "arguments": '{"path": "a.py"}',
                            },
                        },
                        {
                            "id": "call_2",
                            "type": "function",
                            "function": {
                                "name": "grep_search",
                                "arguments": '{"query": "TODO"}',
                            },
                        },
                    ],
                },
            }],
            "usage": {"total_tokens": 200},
        }
        msg, tcs = executor._extract_response(response)
        assert len(tcs) == 2
        assert tcs[0]["name"] == "read_file"
        assert tcs[1]["name"] == "grep_search"

    def test_anthropic_tool_use(self, executor):
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Let me look at that."},
                        {
                            "type": "tool_use",
                            "id": "tu_456",
                            "name": "read_file",
                            "input": {"path": "main.py"},
                        },
                    ],
                },
            }],
            "usage": {"total_tokens": 180},
        }
        msg, tcs = executor._extract_response(response)
        assert len(tcs) == 1
        assert tcs[0]["name"] == "read_file"
        assert tcs[0]["arguments"] == {"path": "main.py"}
        assert tcs[0]["id"] == "tu_456"

    def test_anthropic_text_only(self, executor):
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": '{"files": ["a.py"]}'},
                    ],
                },
            }],
            "usage": {"total_tokens": 50},
        }
        msg, tcs = executor._extract_response(response)
        assert tcs == []
        text = executor._extract_text(msg)
        assert "a.py" in text

    def test_openai_malformed_arguments_handled(self, executor):
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_bad",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "not valid json{",
                        },
                    }],
                },
            }],
            "usage": {"total_tokens": 100},
        }
        msg, tcs = executor._extract_response(response)
        assert len(tcs) == 1
        assert tcs[0]["arguments"] == {}  # Falls back to empty dict


# ---------------------------------------------------------------------------
# _extract_text tests
# ---------------------------------------------------------------------------

class TestExtractText:

    def test_string_content(self, executor):
        msg = {"role": "assistant", "content": "hello"}
        assert executor._extract_text(msg) == "hello"

    def test_list_content(self, executor):
        msg = {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "line 1"},
                {"type": "text", "text": "line 2"},
            ],
        }
        text = executor._extract_text(msg)
        assert "line 1" in text
        assert "line 2" in text

    def test_list_with_tool_use_blocks_skipped(self, executor):
        msg = {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "thinking..."},
                {"type": "tool_use", "id": "x", "name": "foo", "input": {}},
                {"type": "text", "text": "done"},
            ],
        }
        text = executor._extract_text(msg)
        assert "thinking" in text
        assert "done" in text


# ---------------------------------------------------------------------------
# Tool loop integration tests (mocked _call_model)
# ---------------------------------------------------------------------------

class TestToolLoop:

    @pytest.mark.asyncio
    async def test_single_turn_json_response(
        self, executor, sample_case, snapshot,
    ):
        """Model returns JSON immediately with no tool calls."""
        prompt = "Analyze {{repo}} and return JSON."

        json_response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": '{"files": ["main.py"], "confidence": 0.9}',
                },
            }],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
        }

        async def mock_run(*args, **kwargs):
            result = await executor._original_run(*args, **kwargs)
            return result

        executor._original_run = executor.run

        # Patch _call_model to return our canned response
        with patch.object(executor, "_call_model", return_value=json_response):
            result = await executor.run(
                sample_case, "baseline", str(snapshot), prompt,
            )

        assert result.error == ""
        assert result.stopped_reason == "final_json"
        assert result.steps_used == 1
        assert result.prediction["files"] == ["main.py"]
        assert result.raw_output != ""

    @pytest.mark.asyncio
    async def test_one_tool_call_then_response(
        self, executor, sample_case, snapshot,
    ):
        """Model: first call returns a tool_call, second call returns JSON."""
        prompt = "Find the issue in {{repo}}."

        # First response: tool call
        tool_response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": '{"path": "main.py"}',
                        },
                    }],
                },
            }],
            "usage": {"prompt_tokens": 100, "completion_tokens": 30, "total_tokens": 130},
        }

        # Second response: JSON
        json_response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": '{"files": ["main.py"], "confidence": 0.8}',
                },
            }],
            "usage": {"prompt_tokens": 200, "completion_tokens": 20, "total_tokens": 220},
        }

        call_count = 0

        def mock_call_model(messages, tools_o, tools_a):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return tool_response
            return json_response

        with patch.object(executor, "_call_model", side_effect=mock_call_model):
            result = await executor.run(
                sample_case, "baseline", str(snapshot), prompt,
            )

        assert result.stopped_reason == "final_json"
        assert result.steps_used == 2
        assert result.tool_calls == 1
        assert result.tool_sequence == ["read_file"]
        assert result.prediction["files"] == ["main.py"]

    @pytest.mark.asyncio
    async def test_max_steps_reached(
        self, executor, sample_case, snapshot,
    ):
        """Model always returns tool calls -> executor stops at max_steps."""
        prompt = "Keep going {{repo}}."
        executor.max_steps = 3

        tool_response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_loop",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": '{"path": "main.py"}',
                        },
                    }],
                },
            }],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
        }

        with patch.object(executor, "_call_model", return_value=tool_response):
            result = await executor.run(
                sample_case, "baseline", str(snapshot), prompt,
            )

        assert result.stopped_reason == "max_steps"
        assert result.steps_used == 3
        assert result.tool_calls == 3  # one per step

    @pytest.mark.asyncio
    async def test_tool_error_recovery(
        self, executor, sample_case, snapshot,
    ):
        """Tool fails, model gets error, then returns JSON."""
        prompt = "Investigate {{repo}}."

        # First response: tool call to unknown tool
        tool_response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_err",
                        "type": "function",
                        "function": {
                            "name": "nonexistent_tool",
                            "arguments": "{}",
                        },
                    }],
                },
            }],
            "usage": {"prompt_tokens": 80, "completion_tokens": 15, "total_tokens": 95},
        }

        # Second response: JSON after seeing the error
        json_response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": '{"files": [], "confidence": 0.3}',
                },
            }],
            "usage": {"prompt_tokens": 150, "completion_tokens": 15, "total_tokens": 165},
        }

        call_count = 0

        def mock_call_model(messages, tools_o, tools_a):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return tool_response
            return json_response

        with patch.object(executor, "_call_model", side_effect=mock_call_model):
            result = await executor.run(
                sample_case, "baseline", str(snapshot), prompt,
            )

        assert result.stopped_reason == "final_json"
        assert result.steps_used == 2
        assert result.tool_calls == 1
        assert result.tool_call_records[0]["error"] is not None
        assert "Unknown tool" in result.tool_call_records[0]["error"]

    @pytest.mark.asyncio
    async def test_consecutive_errors_stop(
        self, executor, sample_case, snapshot,
    ):
        """Three consecutive tool errors stops the loop."""
        prompt = "Investigate {{repo}}."
        executor.max_steps = 10

        tool_response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_fail",
                        "type": "function",
                        "function": {
                            "name": "nonexistent_tool",
                            "arguments": "{}",
                        },
                    }],
                },
            }],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
        }

        with patch.object(executor, "_call_model", return_value=tool_response):
            result = await executor.run(
                sample_case, "baseline", str(snapshot), prompt,
            )

        assert result.stopped_reason == "error"
        assert result.steps_used == 3  # stopped at 3 consecutive errors
        assert result.tool_calls == 3

    @pytest.mark.asyncio
    async def test_api_error(
        self, executor, sample_case, snapshot,
    ):
        """API returns error string -> executor stops with error."""
        prompt = "Analyze {{repo}}."

        with patch.object(executor, "_call_model", return_value="HTTP 429: rate limited"):
            result = await executor.run(
                sample_case, "baseline", str(snapshot), prompt,
            )

        assert result.stopped_reason == "error"
        assert "429" in result.error
        assert result.steps_used == 1

    @pytest.mark.asyncio
    async def test_token_budget_exceeded(
        self, executor, sample_case, snapshot,
    ):
        """Token budget exceeded -> executor stops."""
        prompt = "Analyze {{repo}}."
        executor.token_budget = 100  # Very small budget

        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": '{"path": "main.py"}',
                        },
                    }],
                },
            }],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 500, "total_tokens": 1500},
        }

        with patch.object(executor, "_call_model", return_value=response):
            result = await executor.run(
                sample_case, "baseline", str(snapshot), prompt,
            )

        assert result.stopped_reason == "token_budget"
        assert result.total_tokens > 0


# ---------------------------------------------------------------------------
# _build_tool_defs tests
# ---------------------------------------------------------------------------

class TestBuildToolDefs:

    def test_baseline_group(self, executor):
        openai_defs, anthropic_defs = executor._build_tool_defs("baseline", None)
        # Should have 4 baseline tools
        assert len(openai_defs) == 4
        assert len(anthropic_defs) == 4
        names = [d["function"]["name"] for d in openai_defs]
        assert "read_file" in names
        assert "grep_search" in names

    def test_gitnexus_group_without_client(self, executor):
        # Without a real client, should still get baseline tools only
        openai_defs, anthropic_defs = executor._build_tool_defs(
            "gitnexus", None,
        )
        assert len(openai_defs) == 4

    def test_gitnexus_group_with_mock_client(self, executor):
        mock_client = MagicMock()
        mock_client.get_tool_definitions_openai.return_value = [
            {"type": "function", "function": {"name": "gitnexus_query", "parameters": {}}},
        ]
        mock_client.get_tool_definitions_anthropic.return_value = [
            {"name": "gitnexus_query", "input_schema": {}},
        ]
        openai_defs, anthropic_defs = executor._build_tool_defs(
            "gitnexus", mock_client,
        )
        # 4 baseline + 1 mock gitnexus
        assert len(openai_defs) == 5
        assert len(anthropic_defs) == 5


# ---------------------------------------------------------------------------
# _format_tool_result_message tests
# ---------------------------------------------------------------------------

class TestFormatToolResultMessage:

    def test_openai_format(self, executor):
        executor._transport = "openai_chat"
        tc = {"id": "call_1", "name": "read_file", "arguments": {"path": "a.py"}}
        result = ToolResult(content="file contents here")

        msg = executor._format_tool_result_message(tc, result, {})
        assert msg["role"] == "tool"
        assert msg["tool_call_id"] == "call_1"
        assert msg["content"] == "file contents here"

    def test_anthropic_format(self, executor):
        executor._transport = "anthropic_messages"
        tc = {"id": "tu_1", "name": "read_file", "arguments": {"path": "a.py"}}
        result = ToolResult(content="file contents here")

        msg = executor._format_tool_result_message(tc, result, {})
        assert msg["role"] == "user"
        assert isinstance(msg["content"], list)
        assert msg["content"][0]["type"] == "tool_result"
        assert msg["content"][0]["tool_use_id"] == "tu_1"
        assert msg["content"][0]["content"] == "file contents here"

    def test_error_result_uses_error_text(self, executor):
        executor._transport = "openai_chat"
        tc = {"id": "call_err", "name": "bad", "arguments": {}}
        result = ToolResult(content="", error="File not found")

        msg = executor._format_tool_result_message(tc, result, {})
        assert msg["content"] == "File not found"


# ---------------------------------------------------------------------------
# RawResult dataclass tests
# ---------------------------------------------------------------------------

class TestRawResult:

    def test_default_values(self):
        r = RawResult(case_id="c1", group="baseline", model="m1")
        assert r.prompt_tokens == 0
        assert r.tool_calls == 0
        assert r.tool_sequence == []
        assert r.tool_call_records == []
        assert r.prediction == {}
        assert r.raw_output == ""
        assert r.parse_error == ""
        assert r.error == ""
        assert r.duration_s == 0.0
        assert r.steps_used == 0
        assert r.stopped_reason == ""

    def test_custom_values(self):
        r = RawResult(
            case_id="c1",
            group="gitnexus",
            model="m1",
            tool_calls=3,
            tool_sequence=["read_file", "grep_search", "read_file"],
            steps_used=3,
            stopped_reason="final_json",
        )
        assert r.tool_calls == 3
        assert len(r.tool_sequence) == 3
        assert r.stopped_reason == "final_json"


# ---------------------------------------------------------------------------
# JSON helper tests
# ---------------------------------------------------------------------------

class TestJsonHelpers:

    def test_extract_first_balanced_json_object(self):
        text = 'prefix {"a": 1, "b": {"c": 2}} suffix'
        result = _extract_first_balanced_json_object(text)
        parsed = json.loads(result)
        assert parsed == {"a": 1, "b": {"c": 2}}

    def test_extract_first_balanced_json_with_string_braces(self):
        text = '{"key": "value with { and } inside"}'
        result = _extract_first_balanced_json_object(text)
        parsed = json.loads(result)
        assert parsed["key"] == "value with { and } inside"

    def test_extract_first_balanced_json_no_json(self):
        assert _extract_first_balanced_json_object("no json here") == ""

    def test_repair_json_candidate_trailing_comma(self):
        candidates = _repair_json_candidate('{"a": 1,}')
        # First candidate is raw, second has comma removed
        assert len(candidates) >= 2
        parsed = json.loads(candidates[-1])
        assert parsed == {"a": 1}

    def test_repair_json_candidate_balancing(self):
        candidates = _repair_json_candidate('{"a": [1, 2')
        # Should eventually get a balanced version
        balanced = candidates[-1]
        assert balanced.endswith("]}")
