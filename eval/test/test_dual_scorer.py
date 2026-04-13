# eval/test/test_dual_scorer.py
import pytest
from eval.lib.dual_scorer import DualScorer, DualResult
from eval.lib.difficulty_scorer import DifficultyLevel

def test_delta_calculation():
    """测试 delta 计算"""
    scorer = DualScorer()

    # Baseline predicts wrong file (ssl.c), gitnexus predicts correct file (tls.c)
    baseline_pred = {"files": ["src/ssl.c"], "symbols": ["someFunc"]}
    gitnexus_pred = {"files": ["src/tls.c"], "symbols": ["connTLSGetPeerCert", "SSL_get_peer_certificate", "X509_free"]}

    result = scorer.compare(
        baseline_pred, gitnexus_pred,
        ground_truth={"files": ["src/tls.c"], "symbols": ["connTLSGetPeerCert", "SSL_get_peer_certificate", "X509_free"]},
        difficulty=DifficultyLevel.COMPLEX
    )

    assert result.baseline_f1 < result.gitnexus_f1
    assert result.delta_f1 > 0
    assert result.gitnexus_f1 == 1.0  # Perfect file match
    assert result.baseline_f1 == 0.0  # No match
