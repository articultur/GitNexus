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
    # Adjust expectations: score = (5 * 0.4) + (6 * 0.3) + (3 * 0.2) + (1 * 0.1) = 2.0 + 1.8 + 0.6 + 0.1 = 4.5 (MEDIUM)
    # For COMPLEX, need > 6: use more files or deeper call chain
    # Deep chain: A->B->C->D->E->F->G (7 levels) + 8 files + typescript + repo
    # score = (7 * 0.4) + (8 * 0.3) + (3 * 0.2) + (1 * 0.1) = 2.8 + 2.4 + 0.6 + 0.1 = 5.9 (still MEDIUM)
    # Need more: 10 files -> (7*0.4)+(10*0.3)+(3*0.2)+(1*0.1) = 2.8+3.0+0.6+0.1 = 6.5 (COMPLEX)
    case = {
        "ground_truth": {
            "call_chain": ["A -> B -> C -> D -> E -> F -> G"],
            "files": ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py", "g.py", "h.py", "i.py", "j.py"]
        },
        "language": "typescript",
        "repo": "large-repo"
    }
    result = scorer.score(case)
    assert result.level == DifficultyLevel.COMPLEX
    assert result.score > 6.0
