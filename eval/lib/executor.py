"""Multi-turn tool loop executor for the GitNexus eval framework.

Orchestrates the model <-> tool loop:
  1. Send prompt + tool definitions to the LLM
  2. If the model requests tool calls, execute them and feed results back
  3. Repeat until the model returns a final text answer or a budget is exhausted

Supports both OpenAI-compatible and Anthropic-style API transports with
tool-calling.
"""

from __future__ import annotations

import copy
import json
import os
import re
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .baseline_tools import BASELINE_TOOLS, SandboxPolicy, ToolResult
from .baseline_tools import get_baseline_tool_definitions, get_baseline_tool_definitions_anthropic
from .budget import BudgetGuard
from .mcp_client import GitNexusClient, MCPToolError


# ---------------------------------------------------------------------------
# Prompt template selection
# ---------------------------------------------------------------------------

def select_template(case: dict, group: str, templates_dir: Path | None = None) -> str | None:
    """Select prompt template based on case task_prompt_style.

    Looks for ``{style}-{group}.md`` in *templates_dir*, falling back to
    ``locate-fix-{group}.md`` when the task-specific template does not exist.
    Returns ``None`` when *templates_dir* is not provided or no template is found.
    """
    if templates_dir is None:
        return None
    style = case.get("task_prompt_style", "locate-fix")
    template_name = f"{style}-{group}.md"
    path = templates_dir / template_name
    if path.exists():
        return path.read_text(encoding="utf-8")
    # Fallback to locate-fix
    fallback = templates_dir / f"locate-fix-{group}.md"
    if fallback.exists():
        return fallback.read_text(encoding="utf-8")
    return None


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class RawResult:
    """Result of executing a single evaluation case through the tool loop."""
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


# ---------------------------------------------------------------------------
# Provider config  (adapted from run_eval.py)
# ---------------------------------------------------------------------------

def _strip_slash(url: str) -> str:
    return url.rstrip("/")


def _provider_config() -> dict[str, str]:
    """Resolve provider config from env vars.

    Returns a dict with keys: source, api_key, base_url, transport.
    """
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "")
    if openrouter_key:
        return {
            "source": "openrouter",
            "api_key": openrouter_key,
            "base_url": _strip_slash(
                os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
            ),
            "transport": "openai_chat",
        }

    minimax_key = os.environ.get("MINIMAX_API_KEY", "")
    if minimax_key:
        return {
            "source": "minimax-openai",
            "api_key": minimax_key,
            "base_url": _strip_slash(
                os.environ.get("MINIMAX_API_BASE", "https://api.minimaxi.com/v1")
            ),
            "transport": "openai_chat",
        }

    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if openai_key:
        return {
            "source": "openai",
            "api_key": openai_key,
            "base_url": _strip_slash(
                os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
            ),
            "transport": "openai_chat",
        }

    anthropic_key = (
        os.environ.get("ANTHROPIC_API_KEY", "")
        or os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
    )
    if anthropic_key:
        return {
            "source": "anthropic",
            "api_key": anthropic_key,
            "base_url": _strip_slash(
                os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
            ),
            "transport": "anthropic_messages",
        }

    raise RuntimeError(
        "No supported API key found. Set one of: OPENROUTER_API_KEY, "
        "MINIMAX_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or "
        "ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_BASE_URL)."
    )


# ---------------------------------------------------------------------------
# Anthropic message helpers
# ---------------------------------------------------------------------------

def _messages_to_anthropic(
    messages: list[dict],
) -> tuple[str, list[dict]]:
    """Convert OpenAI-style messages to Anthropic-style payload parts.

    Returns (system_text, anthropic_messages).
    """
    system_parts: list[str] = []
    anth_messages: list[dict] = []

    for m in messages:
        role = (m.get("role") or "user").strip().lower()
        content = m.get("content") or ""
        if not isinstance(content, str):
            content = str(content)

        if role == "system":
            system_parts.append(content)
            continue
        if role not in {"user", "assistant", "tool"}:
            role = "user"

        # Anthropic uses "tool_result" in user messages; keep role as-is
        # but map "tool" -> "user" for Anthropic
        if role == "tool":
            anth_messages.append({"role": "user", "content": content if isinstance(content, list) else [{"type": "text", "text": content}]})
            continue

        # For assistant messages that might contain tool_use blocks (already in list format)
        if isinstance(content, list):
            anth_messages.append({"role": role, "content": content})
        else:
            anth_messages.append({
                "role": role,
                "content": [{"type": "text", "text": content}],
            })

    return "\n\n".join(system_parts), anth_messages


def _content_blocks_to_text(content: Any) -> str:
    """Extract plain text from Anthropic-style content blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                if isinstance(text, str):
                    texts.append(text)
        return "\n".join(texts)
    return ""


# ---------------------------------------------------------------------------
# JSON prediction parsing  (from run_eval.py)
# ---------------------------------------------------------------------------

_JSON_BLOCK_RE = re.compile(r"```json\s*(.*?)\s*```", re.DOTALL)
_JSON_BARE_RE = re.compile(r"\{.*\}", re.DOTALL)


def _extract_first_balanced_json_object(text: str) -> str:
    """Extract first balanced {...} JSON object respecting quoted strings."""
    start = text.find("{")
    if start == -1:
        return ""

    depth = 0
    in_string = False
    escaped = False

    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]

    return text[start:]


def _repair_json_candidate(raw_json: str) -> list[str]:
    """Return progressively repaired JSON candidates."""
    candidates: list[str] = []
    s = raw_json.strip()
    if not s:
        return candidates

    candidates.append(s)

    # Remove trailing commas
    s1 = re.sub(r",\s*([}\]])", r"\1", s)
    if s1 != s:
        candidates.append(s1)

    # Fix missing closing bracket for array values before next key
    s1a = re.sub(
        r"(:\s*\[[^\]]*?\"\s*),(\s*\"[A-Za-z_][A-Za-z0-9_]*\"\s*:)",
        r"\1],\2",
        s1,
        flags=re.DOTALL,
    )
    if s1a != s1:
        candidates.append(s1a)

    # Insert missing comma between closed value and next key
    s2 = re.sub(
        r"([}\]\"0-9])\s*(\"[A-Za-z_][A-Za-z0-9_]*\"\s*:)",
        r"\1, \2",
        s1a,
    )
    if s2 != s1a:
        candidates.append(s2)

    # Balance braces/brackets if truncated
    open_square = s2.count("[")
    close_square = s2.count("]")
    if open_square > close_square:
        s2 += "]" * (open_square - close_square)
    open_curly = s2.count("{")
    close_curly = s2.count("}")
    if open_curly > close_curly:
        s2 += "}" * (open_curly - close_curly)
    if s2 not in candidates:
        candidates.append(s2)

    # Combination pass
    s3 = re.sub(r",\s*([}\]])", r"\1", s2)
    s3 = re.sub(
        r"([}\]\"0-9])\s*(\"[A-Za-z_][A-Za-z0-9_]*\"\s*:)",
        r"\1, \2",
        s3,
    )
    if s3 not in candidates:
        candidates.append(s3)

    return candidates


def _try_load_json_candidates(candidates: list[str]) -> tuple[dict, str]:
    last_error = ""
    for c in candidates:
        try:
            parsed = json.loads(c)
            if isinstance(parsed, dict):
                return parsed, ""
            last_error = "Top-level JSON is not an object"
        except json.JSONDecodeError as e:
            last_error = f"JSONDecodeError: {e}"
    return {}, last_error or "Failed to parse JSON candidates"


def parse_prediction(raw: str) -> tuple[dict, str]:
    """Try to extract the JSON prediction from model output.

    Returns (prediction_dict, error_message).
    """
    # Fenced code block
    m = _JSON_BLOCK_RE.search(raw)
    if m:
        cand = _repair_json_candidate(m.group(1))
        parsed, err = _try_load_json_candidates(cand)
        if parsed:
            return parsed, ""

    # First balanced JSON object
    balanced = _extract_first_balanced_json_object(raw)
    if balanced:
        cand = _repair_json_candidate(balanced)
        parsed, err = _try_load_json_candidates(cand)
        if parsed:
            return parsed, ""

    # Greedy bare JSON regex
    m = _JSON_BARE_RE.search(raw)
    if m:
        cand = _repair_json_candidate(m.group(0))
        parsed, err = _try_load_json_candidates(cand)
        if parsed:
            return parsed, ""
        return {}, err

    return {}, "No JSON object found in model output"


# ---------------------------------------------------------------------------
# Tool loop executor
# ---------------------------------------------------------------------------

class ToolLoopExecutor:
    """Orchestrates the multi-turn model <-> tool loop for one eval case.

    Parameters
    ----------
    model : str
        Model identifier (e.g. ``"anthropic/claude-sonnet-4-5"``).
    max_steps : int
        Maximum number of round-trips before forcing a stop.
    token_budget : int
        Per-case token budget.
    max_tokens_per_turn : int
        Max completion tokens per model call.
    retry_count : int
        Number of retries on transient API errors.
    """

    def __init__(
        self,
        model: str,
        max_steps: int = 15,
        token_budget: int = 50000,
        max_tokens_per_turn: int = 2048,
        retry_count: int = 2,
    ):
        self.model = model
        self.max_steps = max_steps
        self.token_budget = token_budget
        self.max_tokens_per_turn = max_tokens_per_turn
        self.retry_count = retry_count
        self.budget = BudgetGuard(
            per_case_token_limit=token_budget,
            total_token_budget=token_budget,
        )
        self._transport: str | None = None  # detected from provider config

    # -- public API ----------------------------------------------------------

    async def run(
        self,
        case: dict,
        group: str,
        snapshots_dir: str,
        prompt_template: str,
    ) -> RawResult:
        """Execute multi-turn tool loop for a single case."""
        t0 = time.time()
        result = RawResult(
            case_id=case["id"],
            group=group,
            model=self.model,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

        snapshot_dir = Path(snapshots_dir) / case["id"]
        sandbox = SandboxPolicy(snapshot_root=snapshot_dir)

        # Set up GitNexus client if needed
        gitnexus_client: GitNexusClient | None = None
        if group == "gitnexus":
            gitnexus_client = GitNexusClient(
                transport="http", cwd=str(snapshot_dir),
            )
            try:
                await gitnexus_client.start()
            except Exception as e:
                result.error = f"MCP server start failed: {e}"
                result.duration_s = time.time() - t0
                await gitnexus_client.close()
                return result

        # Build tool definitions for both transports
        tools_openai, tools_anthropic = self._build_tool_defs(
            group, gitnexus_client,
        )

        # Fill prompt template
        prompt = self._fill_prompt(prompt_template, case, snapshots_dir)

        # Build initial messages
        messages: list[dict] = [
            {
                "role": "system",
                "content": (
                    "You are a precise code analysis assistant. Use the available "
                    "tools to investigate the codebase. Always respond with valid "
                    "JSON only when you have your final answer."
                ),
            },
            {"role": "user", "content": prompt},
        ]

        # Enter tool loop
        try:
            stopped_reason = await self._tool_loop(
                messages,
                tools_openai,
                tools_anthropic,
                sandbox,
                gitnexus_client,
                result,
            )
            result.stopped_reason = stopped_reason
        except Exception as e:
            result.error = str(e)
            result.stopped_reason = "error"
        finally:
            if gitnexus_client:
                await gitnexus_client.close()

        result.duration_s = time.time() - t0
        return result

    # -- tool loop -----------------------------------------------------------

    async def _tool_loop(
        self,
        messages: list[dict],
        tools_openai: list[dict],
        tools_anthropic: list[dict],
        sandbox: SandboxPolicy,
        gitnexus_client: GitNexusClient | None,
        result: RawResult,
    ) -> str:
        """Core loop: model -> tool_call -> execute -> result -> model -> ...

        Returns the stop reason string.
        """
        consecutive_errors = 0

        for step in range(self.max_steps):
            result.steps_used = step + 1

            # Call model
            response = self._call_model(messages, tools_openai, tools_anthropic)
            if isinstance(response, str):
                # Error string returned from API
                result.error = response
                return "error"

            # Track token usage
            usage = response.get("usage", {})
            step_tokens = usage.get("total_tokens", 0)
            result.prompt_tokens += usage.get("prompt_tokens", 0)
            result.output_tokens += usage.get("completion_tokens", 0)
            result.total_tokens += step_tokens
            self.budget.record_usage(step_tokens)

            # Check budget
            if not self.budget.check_total():
                return "token_budget"

            # Extract assistant message and check for tool calls
            assistant_msg, tool_calls = self._extract_response(response)
            messages.append(assistant_msg)

            if not tool_calls:
                # Model returned text only -- extract prediction
                text = self._extract_text(assistant_msg)
                result.raw_output = text
                pred, parse_err = parse_prediction(text)
                result.prediction = pred
                result.parse_error = parse_err
                return "final_json"

            # Execute each tool call
            for tc in tool_calls:
                tool_name = tc["name"]
                tool_args = tc["arguments"]
                t_start = time.time()

                try:
                    tool_result = await self._execute_tool(
                        tool_name, tool_args, sandbox, gitnexus_client,
                    )
                    if tool_result.error:
                        consecutive_errors += 1
                    else:
                        consecutive_errors = 0
                except Exception as e:
                    tool_result = ToolResult(content="", error=str(e))
                    consecutive_errors += 1

                duration = time.time() - t_start
                result.tool_calls += 1
                result.tool_sequence.append(tool_name)
                result.tool_call_records.append({
                    "step": step,
                    "tool": tool_name,
                    "args": tool_args,
                    "result_preview": (
                        tool_result.content or tool_result.error or ""
                    )[:500],
                    "error": tool_result.error,
                    "duration_s": round(duration, 3),
                })

                # Add tool result message
                messages.append(
                    self._format_tool_result_message(
                        tc, tool_result, response,
                    )
                )

            # Bail on too many consecutive tool errors
            if consecutive_errors >= 3:
                return "error"

        return "max_steps"

    # -- tool definitions ----------------------------------------------------

    def _build_tool_defs(
        self,
        group: str,
        gitnexus_client: GitNexusClient | None,
    ) -> tuple[list[dict], list[dict]]:
        """Return (openai_tools, anthropic_tools) for the given group."""
        openai_defs = get_baseline_tool_definitions()
        anthropic_defs = get_baseline_tool_definitions_anthropic()

        if group == "gitnexus" and gitnexus_client is not None:
            openai_defs.extend(gitnexus_client.get_tool_definitions_openai())
            anthropic_defs.extend(
                gitnexus_client.get_tool_definitions_anthropic()
            )

        return openai_defs, anthropic_defs

    # -- prompt filling ------------------------------------------------------

    @staticmethod
    def _fill_prompt(
        template: str, case: dict, snapshots_dir: str,
    ) -> str:
        """Replace template variables in the prompt."""
        snapshot_dir = str(Path(snapshots_dir) / case["id"])
        return (
            template
            .replace("{{repo}}", case.get("repo", ""))
            .replace("{{language}}", case.get("language", ""))
            .replace("{{commit_before}}", case.get("commit_before", ""))
            .replace("{{snapshot_dir}}", snapshot_dir)
            .replace("{{issue_text}}", case.get("issue_text", ""))
        )

    # -- model calling -------------------------------------------------------

    def _call_model(
        self,
        messages: list[dict],
        tools_openai: list[dict],
        tools_anthropic: list[dict],
    ) -> dict | str:
        """Call the LLM with tool definitions.

        Returns the normalized response dict, or an error string.
        """
        cfg = _provider_config()
        self._transport = cfg["transport"]

        for attempt in range(self.retry_count + 1):
            try:
                if self._transport == "openai_chat":
                    return self._call_openai(cfg, messages, tools_openai)
                elif self._transport == "anthropic_messages":
                    return self._call_anthropic(
                        cfg, messages, tools_anthropic,
                    )
                else:
                    return f"Unsupported transport: {self._transport}"
            except Exception as e:
                if attempt == self.retry_count:
                    return str(e)
                time.sleep(1.0 * (attempt + 1))

        return "Max retries exceeded"

    def _call_openai(
        self,
        cfg: dict,
        messages: list[dict],
        tools: list[dict],
    ) -> dict:
        """OpenAI-compatible /chat/completions with tool calling."""
        url = f"{cfg['base_url']}/chat/completions"
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens_per_turn,
            "temperature": 0.0,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        body = json.dumps(payload).encode("utf-8")
        headers: dict[str, str] = {
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        }
        if cfg["source"] == "openrouter":
            headers["HTTP-Referer"] = "https://github.com/gitnexus/eval"
            headers["X-Title"] = "GitNexus Eval"

        req = urllib.request.Request(
            url, data=body, method="POST", headers=headers,
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())

    def _call_anthropic(
        self,
        cfg: dict,
        messages: list[dict],
        tools: list[dict],
    ) -> dict:
        """Anthropic-style /v1/messages with tool calling."""
        base = cfg["base_url"]
        if base.endswith("/v1/messages"):
            url = base
        elif base.endswith("/v1"):
            url = f"{base}/messages"
        else:
            url = f"{base}/v1/messages"

        system_text, anth_messages = _messages_to_anthropic(messages)
        payload: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens_per_turn,
            "temperature": 0.0,
            "messages": anth_messages,
        }
        if system_text:
            payload["system"] = system_text
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = {"type": "auto"}

        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "x-api-key": cfg["api_key"],
                "Authorization": f"Bearer {cfg['api_key']}",
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = json.loads(resp.read())

        # Normalize Anthropic response to OpenAI-like schema
        return self._normalize_anthropic_response(raw)

    def _normalize_anthropic_response(self, raw: dict) -> dict:
        """Normalize an Anthropic messages response to OpenAI-like schema.

        Preserves tool_use content blocks in the message so that
        _extract_response can find them.
        """
        content_blocks = raw.get("content", [])
        usage = raw.get("usage") or {}
        in_tok = int(usage.get("input_tokens", 0))
        out_tok = int(usage.get("output_tokens", 0))

        # Build the assistant message with full content blocks
        # so tool_use blocks are preserved for extraction
        assistant_msg: dict[str, Any] = {
            "role": "assistant",
            "content": content_blocks,
        }

        return {
            "choices": [{"message": assistant_msg}],
            "usage": {
                "prompt_tokens": in_tok,
                "completion_tokens": out_tok,
                "total_tokens": in_tok + out_tok,
            },
            # Keep raw stop_reason for reference
            "stop_reason": raw.get("stop_reason"),
        }

    # -- response extraction -------------------------------------------------

    def _extract_response(
        self, response: dict,
    ) -> tuple[dict, list[dict]]:
        """Parse API response into (assistant_message, tool_calls).

        Handles both OpenAI and Anthropic response formats.

        Returns:
            assistant_message: dict suitable for appending to message history
            tool_calls: list of {"id": str, "name": str, "arguments": dict}
        """
        choice = response.get("choices", [{}])[0]
        message = choice.get("message", {})
        tool_calls: list[dict] = []

        # OpenAI format: message.tool_calls
        openai_tcs = message.get("tool_calls")
        if openai_tcs:
            for tc in openai_tcs:
                func = tc.get("function", {})
                args_str = func.get("arguments", "{}")
                try:
                    args = (
                        json.loads(args_str)
                        if isinstance(args_str, str)
                        else args_str
                    )
                except json.JSONDecodeError:
                    args = {}
                tool_calls.append({
                    "id": tc.get("id", ""),
                    "name": func.get("name", ""),
                    "arguments": args,
                })

        # Anthropic format: content blocks with type="tool_use"
        content = message.get("content", [])
        if isinstance(content, list) and not tool_calls:
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_calls.append({
                        "id": block.get("id", ""),
                        "name": block.get("name", ""),
                        "arguments": block.get("input", {}),
                    })

        # Build the assistant message for the message history
        # Keep content in the format it came in (string or list of blocks)
        assistant_msg = {"role": "assistant", "content": content}

        # For OpenAI format with tool_calls, also attach them
        if openai_tcs:
            assistant_msg["tool_calls"] = openai_tcs

        return assistant_msg, tool_calls

    def _extract_text(self, msg: dict) -> str:
        """Extract plain text from an assistant message dict."""
        content = msg.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return _content_blocks_to_text(content)
        return str(content)

    # -- tool execution ------------------------------------------------------

    async def _execute_tool(
        self,
        name: str,
        args: dict,
        sandbox: SandboxPolicy,
        gitnexus_client: GitNexusClient | None,
    ) -> ToolResult:
        """Dispatch a tool call to the appropriate handler."""
        # Baseline tools
        if name in BASELINE_TOOLS:
            return BASELINE_TOOLS[name].function(args, sandbox)

        # GitNexus MCP tools
        if name.startswith("gitnexus_") and gitnexus_client is not None:
            try:
                result_text = await gitnexus_client.call_tool(name, args)
                return ToolResult(content=result_text)
            except MCPToolError as e:
                return ToolResult(content="", error=str(e))

        return ToolResult(content="", error=f"Unknown tool: {name}")

    # -- message formatting --------------------------------------------------

    def _format_tool_result_message(
        self,
        tool_call: dict,
        result: ToolResult,
        response: dict,
    ) -> dict:
        """Format a tool result for the next API call.

        Uses OpenAI or Anthropic format depending on the active transport.
        """
        result_text = result.content or result.error or ""

        if self._transport == "anthropic_messages":
            # Anthropic: user role with tool_result content block
            return {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_call["id"],
                        "content": result_text,
                    },
                ],
            }
        else:
            # OpenAI: role="tool"
            return {
                "role": "tool",
                "tool_call_id": tool_call["id"],
                "content": result_text,
            }
