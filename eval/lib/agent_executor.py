# eval/lib/agent_executor.py
import subprocess
import json
import re
import time
from dataclasses import dataclass
from typing import Optional
from pathlib import Path

GITNEXUS_TOOLS = [
    "gitnexus_query", "gitnexus_context", "gitnexus_impact",
    "gitnexus_shortest_path", "gitnexus_get_code", "gitnexus_cypher",
    "gitnexus_detect_changes", "gitnexus_route_map", "gitnexus_test_impact"
]

@dataclass
class AgentResult:
    prediction: dict
    raw_output: str
    duration_s: float
    tokens: int
    success: bool
    error: Optional[str] = None

class AgentExecutor:
    """Claude Code Agent 执行器"""

    def __init__(self, timeout: int = 180):
        self.timeout = timeout

    def _build_command(self, prompt: str, group: str) -> list:
        """构建 claude 命令"""
        base = ["claude", "-p", "--bare", "--dangerously-skip-permissions"]

        if group == "baseline":
            base.extend([
                "--disallowed-tools", ",".join(GITNEXUS_TOOLS),
                "--disable-slash-commands"
            ])

        base.append(prompt)
        return base

    def _parse_json_output(self, output: str) -> dict:
        """从输出中提取 JSON"""
        # 尝试找 ```json ... ``` 块
        json_match = re.search(r'```json\s*(\{.*?\})\s*```', output, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass

        # 尝试直接解析
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            return {"files": [], "symbols": [], "call_chain": [], "error": "parse_failed"}

    def execute(self, prompt: str, worktree_path: str, group: str) -> AgentResult:
        """执行 Claude Code 并返回结果"""
        start = time.time()

        cmd = self._build_command(prompt, group)

        try:
            result = subprocess.run(
                cmd,
                cwd=worktree_path,
                capture_output=True,
                text=True,
                timeout=self.timeout
            )

            output = result.stdout + result.stderr
            duration = time.time() - start

            # 估算 tokens (简单: 字符数 / 4)
            tokens = len(output) // 4

            prediction = self._parse_json_output(output)

            return AgentResult(
                prediction=prediction,
                raw_output=output,
                duration_s=duration,
                tokens=tokens,
                success=True
            )

        except subprocess.TimeoutExpired:
            return AgentResult(
                prediction={},
                raw_output="",
                duration_s=self.timeout,
                tokens=0,
                success=False,
                error="timeout"
            )
        except Exception as e:
            return AgentResult(
                prediction={},
                raw_output="",
                duration_s=time.time() - start,
                tokens=0,
                success=False,
                error=str(e)
            )
