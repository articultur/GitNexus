import pytest
from eval.lib.difficulty_scorer import DifficultyScorer, DifficultyLevel

def test_simple_case():
    """测试简单 case (低调用链深度)"""
    scorer = DifficultyScorer()
    case = {
        "ground_truth": {
            "call_chain": ["funcA -> funcB"],
            "files": ["a.py"]
        },
        "language": "python",
        "repo": "small-repo"
    }
    result = scorer.score(case)
    assert result.level == DifficultyLevel.SIMPLE

def test_complex_case():
    """测试复杂 case (高调用链深度、多文件)"""
    scorer = DifficultyScorer()
    case = {
        "ground_truth": {
            "call_chain": ["A -> B -> C -> D -> E"],
            "files": ["a.py", "b.py", "c.py", "d.py"]
        },
        "language": "typescript",
        "repo": "large-repo"
    }
    result = scorer.score(case)
    assert result.level == DifficultyLevel.COMPLEX
