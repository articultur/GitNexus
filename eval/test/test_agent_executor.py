import pytest
import os
import tempfile
from eval.lib.agent_executor import AgentExecutor, AgentResult

def test_baseline_command():
    """测试 baseline 命令生成"""
    executor = AgentExecutor()
    prompt = "Find the bug"

    baseline_cmd = executor._build_command(prompt, group="baseline")
    assert "--disallowed-tools" in baseline_cmd
    assert "--disable-slash-commands" in baseline_cmd

    gitnexus_cmd = executor._build_command(prompt, group="gitnexus")
    assert "--disallowed-tools" not in gitnexus_cmd
    assert "--disable-slash-commands" not in gitnexus_cmd
