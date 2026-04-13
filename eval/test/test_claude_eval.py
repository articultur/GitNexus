# eval/test/test_claude_eval.py
import pytest
import argparse
from eval.claude_eval import parse_args

def test_parse_args_defaults():
    """Test default arguments."""
    args = parse_args([])
    assert args.dataset is None
    assert args.output == "eval/claude-runs"
    assert args.report == "simple"
