"""GitNexus MCP client for the eval framework.

Supports two transports:
  - ``http``:  GitNexus eval-server HTTP API  (POST /tool/:name)
  - ``stdio``: MCP stdio JSON-RPC

Usage::

    client = GitNexusClient(transport="http", port=4848)
    await client.start()
    result = await client.call_tool("gitnexus_query", {"query": "auth"})
    await client.close()
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class MCPToolError(Exception):
    """Error from GitNexus tool execution."""

    def __init__(self, tool_name: str, error_type: str, message: str):
        self.tool_name = tool_name
        self.error_type = error_type
        self.message = message
        super().__init__(f"MCP tool error [{tool_name}]: [{error_type}] {message}")


# ---------------------------------------------------------------------------
# Call record (for audit / debugging)
# ---------------------------------------------------------------------------

@dataclass
class ToolCallRecord:
    tool_name: str
    arguments: dict
    result_preview: str  # first 500 chars
    error: str | None
    duration_s: float


# ---------------------------------------------------------------------------
# Tool definitions (static — matches the tools registered in local-backend.ts)
# ---------------------------------------------------------------------------

_GITNEXUS_TOOLS: list[dict[str, Any]] = [
    {
        "name": "gitnexus_query",
        "description": (
            "Search the code knowledge graph by concept. Returns process-grouped "
            "results ranked by relevance."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural language or keyword search.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "gitnexus_context",
        "description": (
            "360-degree view of a symbol: callers, callees, process participation, "
            "source code snippet."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Symbol name to look up.",
                },
                "file_path": {
                    "type": "string",
                    "description": "Optional file path filter.",
                },
            },
            "required": ["name"],
        },
    },
    {
        "name": "gitnexus_impact",
        "description": (
            "Blast radius of changing a symbol. Reports upstream (callers) or "
            "downstream (callees) impact with risk levels."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": "Symbol name to analyze.",
                },
                "direction": {
                    "type": "string",
                    "enum": ["upstream", "downstream"],
                    "description": "Impact direction (default: upstream).",
                },
                "maxDepth": {
                    "type": "integer",
                    "description": "Maximum graph traversal depth (default: 3).",
                },
            },
            "required": ["target"],
        },
    },
    {
        "name": "gitnexus_shortest_path",
        "description": (
            "Shortest dependency path between two symbols via BFS."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "source_id": {
                    "type": "string",
                    "description": "UID of the source node.",
                },
                "target_id": {
                    "type": "string",
                    "description": "UID of the target node.",
                },
                "max_hops": {
                    "type": "integer",
                    "description": "Maximum BFS depth (default: 5).",
                },
            },
            "required": ["source_id", "target_id"],
        },
    },
    {
        "name": "gitnexus_get_code",
        "description": "Retrieve source code for a symbol by UID or name.",
        "parameters": {
            "type": "object",
            "properties": {
                "uid": {
                    "type": "string",
                    "description": "Node UID (e.g. 'Function:myFunc').",
                },
                "name": {
                    "type": "string",
                    "description": "Symbol name to look up.",
                },
                "file_path": {
                    "type": "string",
                    "description": "Optional file path filter.",
                },
            },
        },
    },
    {
        "name": "gitnexus_cypher",
        "description": "Execute a read-only Cypher query on the knowledge graph.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Cypher query string.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "gitnexus_detect_changes",
        "description": (
            "Map a git diff to affected symbols and execution flows."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["staged", "unstaged", "all", "compare"],
                    "description": "Diff scope (default: staged).",
                },
                "base_ref": {
                    "type": "string",
                    "description": "Base ref for 'compare' scope.",
                },
            },
        },
    },
    {
        "name": "gitnexus_route_map",
        "description": (
            "List API route-to-handler mappings with middleware chains."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "filter": {
                    "type": "string",
                    "description": "Optional substring filter for route paths.",
                },
            },
        },
    },
    {
        "name": "gitnexus_test_impact",
        "description": (
            "Find test files that cover changed symbols."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": "Symbol name to check test coverage for.",
                },
                "direction": {
                    "type": "string",
                    "enum": ["upstream", "downstream"],
                    "description": "Impact direction (default: upstream).",
                },
            },
            "required": ["target"],
        },
    },
]


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class GitNexusClient:
    """Unified client for calling GitNexus tools.

    Parameters
    ----------
    transport : str
        ``"http"`` for eval-server HTTP API, ``"stdio"`` for MCP JSON-RPC.
    cwd : str | None
        Working directory for the server subprocess.
    timeout : float
        Request timeout in seconds.
    port : int
        Port for the HTTP transport.
    host : str
        Host for the HTTP transport.
    server_cmd : list[str] | None
        Custom server command (defaults to ``npx gitnexus eval-server``).
    """

    def __init__(
        self,
        transport: str = "http",
        cwd: str | None = None,
        timeout: float = 30.0,
        # HTTP transport options
        port: int = 4848,
        host: str = "127.0.0.1",
        # Stdio transport options
        server_cmd: list[str] | None = None,
    ):
        if transport not in ("http", "stdio"):
            raise ValueError(f"Unknown transport: {transport!r} (must be 'http' or 'stdio')")
        self.transport = transport
        self.cwd = cwd
        self.timeout = timeout
        self.port = port
        self.host = host
        self.server_cmd = server_cmd or [
            "npx", "gitnexus", "eval-server", "--port", str(port),
        ]
        self._process: subprocess.Popen | None = None
        self._started: bool = False
        self._tools_cache: list[dict] | None = None
        self._jsonrpc_id: int = 0

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        """Start the GitNexus server process."""
        if self.transport == "http":
            await self._start_http_server()
        elif self.transport == "stdio":
            await self._start_stdio_server()

    async def close(self) -> None:
        """Shut down the server process."""
        if self.transport == "http" and self._started:
            try:
                req = urllib.request.Request(
                    f"http://{self.host}:{self.port}/shutdown",
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=5)
            except Exception:
                pass
            self._terminate_process()
        elif self.transport == "stdio" and self._process:
            self._terminate_process()
        self._started = False
        self._process = None

    # -- tool calling --------------------------------------------------------

    async def call_tool(self, name: str, args: dict) -> str:
        """Call a GitNexus tool and return the result as text."""
        if not self._started:
            raise RuntimeError("Client not started — call start() first")
        if self.transport == "http":
            return await self._call_http(name, args)
        return await self._call_stdio(name, args)

    async def list_tools(self) -> list[dict]:
        """Get available GitNexus tool descriptors."""
        if self._tools_cache is None:
            self._tools_cache = list(_GITNEXUS_TOOLS)
        return self._tools_cache

    # -- format helpers ------------------------------------------------------

    def get_tool_definitions_openai(self) -> list[dict]:
        """Return tool definitions in OpenAI function-calling format."""
        defs: list[dict] = []
        for t in _GITNEXUS_TOOLS:
            defs.append({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["parameters"],
                },
            })
        return defs

    def get_tool_definitions_anthropic(self) -> list[dict]:
        """Return tool definitions in Anthropic tool-use format."""
        defs: list[dict] = []
        for t in _GITNEXUS_TOOLS:
            defs.append({
                "name": t["name"],
                "description": t["description"],
                "input_schema": t["parameters"],
            })
        return defs

    # -- HTTP transport ------------------------------------------------------

    async def _start_http_server(self) -> None:
        """Start eval-server HTTP process and wait for /health to respond."""
        self._process = subprocess.Popen(
            self.server_cmd,
            cwd=self.cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "GITNEXUS_EVAL_PORT": str(self.port)},
        )
        # Poll /health for up to self.timeout seconds
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            try:
                resp = urllib.request.urlopen(
                    f"http://{self.host}:{self.port}/health", timeout=2,
                )
                if resp.status == 200:
                    self._started = True
                    return
            except (urllib.error.URLError, ConnectionRefusedError, OSError):
                pass
            if self._process.poll() is not None:
                stderr = (
                    self._process.stderr.read().decode(errors="replace")
                    if self._process.stderr
                    else ""
                )
                raise RuntimeError(
                    f"GitNexus eval-server exited prematurely (rc={self._process.returncode}): {stderr[:500]}"
                )
            time.sleep(0.5)
        raise RuntimeError(
            f"GitNexus eval-server failed to start within {self.timeout}s"
        )

    async def _call_http(self, tool_name: str, args: dict) -> str:
        """Call tool via HTTP POST /tool/:name."""
        url = f"http://{self.host}:{self.port}/tool/{tool_name}"
        body = json.dumps(args).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            error_body = e.read().decode(errors="replace")
            raise MCPToolError(tool_name, f"http_{e.code}", error_body)
        except urllib.error.URLError as e:
            raise MCPToolError(tool_name, "connection_error", str(e))

    # -- Stdio transport -----------------------------------------------------

    async def _start_stdio_server(self) -> None:
        """Start MCP server via stdio and send initialize handshake."""
        self._process = subprocess.Popen(
            self.server_cmd,
            cwd=self.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._send_jsonrpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "gitnexus-eval", "version": "2.0.0"},
        })
        self._started = True

    async def _call_stdio(self, tool_name: str, args: dict) -> str:
        """Call tool via MCP JSON-RPC."""
        result = self._send_jsonrpc("tools/call", {
            "name": tool_name,
            "arguments": args,
        })
        if "error" in result:
            err = result["error"]
            raise MCPToolError(
                tool_name,
                err.get("code", "jsonrpc_error"),
                err.get("message", str(err)),
            )
        content = result.get("result", {}).get("content", [])
        texts = [
            c.get("text", "") for c in content if c.get("type") == "text"
        ]
        return "\n".join(texts)

    def _send_jsonrpc(self, method: str, params: dict | None = None) -> dict:
        """Send a JSON-RPC request over stdin and read one response line."""
        if (
            not self._process
            or self._process.stdin is None
            or self._process.stdout is None
        ):
            raise RuntimeError("MCP server not started")

        self._jsonrpc_id += 1
        request: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": self._jsonrpc_id,
            "method": method,
        }
        if params:
            request["params"] = params

        self._process.stdin.write((json.dumps(request) + "\n").encode())
        self._process.stdin.flush()

        response_line = self._process.stdout.readline()
        if not response_line:
            raise MCPToolError(method, "empty_response", "Server returned empty response")
        return json.loads(response_line.decode())

    # -- internal helpers ----------------------------------------------------

    def _terminate_process(self) -> None:
        if self._process is None:
            return
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
