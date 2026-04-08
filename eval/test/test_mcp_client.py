"""Tests for eval.lib.mcp_client."""

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from eval.lib.mcp_client import GitNexusClient, MCPToolError, _GITNEXUS_TOOLS


# ---------------------------------------------------------------------------
# Fixture: mock HTTP server
# ---------------------------------------------------------------------------

_MOCK_SERVER_SCRIPT = Path(__file__).parent / "mock_mcp_server.py"
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


@pytest.fixture()
def mock_server():
    """Start the mock eval-server on a high port, yield the port, then shut down."""
    port = 14849
    proc = subprocess.Popen(
        [sys.executable, str(_MOCK_SERVER_SCRIPT), str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(_PROJECT_ROOT),
    )
    try:
        # Wait for READY signal (with timeout)
        line = proc.stdout.readline().decode()
        if not line.startswith("READY:"):
            stderr = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
            proc.kill()
            raise RuntimeError(f"Mock server did not start: {line!r} stderr={stderr[:500]}")
        yield port
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


@pytest.fixture()
def http_client(mock_server):
    """Return a GitNexusClient pointed at the mock server."""
    client = GitNexusClient(transport="http", port=mock_server)
    return client


# ---------------------------------------------------------------------------
# HTTP client — call_tool
# ---------------------------------------------------------------------------

class TestHTTPClientCallTool:

    @pytest.mark.asyncio
    async def test_call_tool(self, http_client):
        client = http_client
        client._started = True
        result = await client.call_tool(
            "gitnexus_query",
            {"query": "auth validation"},
        )
        assert "Mock result for gitnexus_query" in result
        assert "auth validation" in result

    @pytest.mark.asyncio
    async def test_call_tool_with_multiple_args(self, http_client):
        client = http_client
        client._started = True
        result = await client.call_tool(
            "gitnexus_impact",
            {"target": "parseWorker", "direction": "upstream"},
        )
        assert "Mock result for gitnexus_impact" in result
        assert "parseWorker" in result


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

class TestHTTPClientHealthCheck:

    @pytest.mark.asyncio
    async def test_health_check(self, mock_server):
        import urllib.request
        resp = urllib.request.urlopen(
            f"http://127.0.0.1:{mock_server}/health", timeout=5,
        )
        data = json.loads(resp.read())
        assert data["status"] == "ok"
        assert "mock-repo" in data["repos"]


# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------

class TestHTTPClientShutdown:

    @pytest.mark.asyncio
    async def test_shutdown(self, mock_server):
        client = GitNexusClient(transport="http", port=mock_server)
        client._started = True
        await client.close()
        assert client._started is False
        assert client._process is None


# ---------------------------------------------------------------------------
# Tool error handling
# ---------------------------------------------------------------------------

class TestHTTPClientToolError:

    @pytest.mark.asyncio
    async def test_connection_error(self):
        """Calling a tool on a port with no server raises MCPToolError."""
        client = GitNexusClient(transport="http", port=19999)
        client._started = True
        with pytest.raises(MCPToolError) as exc_info:
            await client.call_tool("gitnexus_query", {"query": "test"})
        assert exc_info.value.tool_name == "gitnexus_query"
        assert "connection_error" in exc_info.value.error_type


# ---------------------------------------------------------------------------
# list_tools
# ---------------------------------------------------------------------------

class TestHTTPClientListTools:

    @pytest.mark.asyncio
    async def test_list_tools(self, http_client):
        tools = await http_client.list_tools()
        assert len(tools) == len(_GITNEXUS_TOOLS)
        names = {t["name"] for t in tools}
        assert "gitnexus_query" in names
        assert "gitnexus_impact" in names
        assert "gitnexus_cypher" in names

    @pytest.mark.asyncio
    async def test_list_tools_cached(self, http_client):
        tools1 = await http_client.list_tools()
        tools2 = await http_client.list_tools()
        assert tools1 is tools2  # same object — cached


# ---------------------------------------------------------------------------
# Tool definitions — OpenAI format
# ---------------------------------------------------------------------------

class TestToolDefinitionsOpenAI:

    def test_format(self):
        client = GitNexusClient(transport="http")
        defs = client.get_tool_definitions_openai()
        assert len(defs) == len(_GITNEXUS_TOOLS)
        for d in defs:
            assert d["type"] == "function"
            fn = d["function"]
            assert "name" in fn
            assert "description" in fn
            assert "parameters" in fn
            params = fn["parameters"]
            assert params["type"] == "object"
            assert "properties" in params


# ---------------------------------------------------------------------------
# Tool definitions — Anthropic format
# ---------------------------------------------------------------------------

class TestToolDefinitionsAnthropic:

    def test_format(self):
        client = GitNexusClient(transport="http")
        defs = client.get_tool_definitions_anthropic()
        assert len(defs) == len(_GITNEXUS_TOOLS)
        for d in defs:
            assert "name" in d
            assert "description" in d
            assert "input_schema" in d
            schema = d["input_schema"]
            assert schema["type"] == "object"


# ---------------------------------------------------------------------------
# Client lifecycle errors
# ---------------------------------------------------------------------------

class TestClientNotStartedError:

    @pytest.mark.asyncio
    async def test_call_before_start(self):
        client = GitNexusClient(transport="http")
        with pytest.raises(RuntimeError, match="not started"):
            await client.call_tool("gitnexus_query", {"query": "test"})


class TestClientInvalidTransport:

    def test_invalid_transport_raises(self):
        with pytest.raises(ValueError, match="Unknown transport"):
            GitNexusClient(transport="websocket")
