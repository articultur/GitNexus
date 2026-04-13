import pytest
from eval.lib.difficulty_scorer import DifficultyLevel
from eval.lib.dual_scorer import DualResult
from eval.report_simple import SimpleReporter

def test_simple_report():
    """测试简单报告生成"""
    results = [
        DualResult(0.5, 0.7, 0.2, 0.3, 0.6, 0.3, DifficultyLevel.COMPLEX, True),
        DualResult(0.8, 0.8, 0.0, 0.9, 0.9, 0.0, DifficultyLevel.SIMPLE, False),
    ]

    reporter = SimpleReporter()
    report = reporter.generate(results)

    assert "GitNexus Impact Summary" in report
    assert "complex" in report.lower()
    assert "+20%" in report or "+30%" in report
