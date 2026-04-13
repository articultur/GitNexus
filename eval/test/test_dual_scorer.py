# eval/test/test_dual_scorer.py
import pytest
from eval.lib.dual_scorer import DualScorer, DualResult
from eval.lib.difficulty_scorer import DifficultyLevel

def test_delta_calculation():
    """测试 delta 计算"""
    scorer = DualScorer()

    baseline_pred = {"files": ["src/tls.c", "src/ssl.c"], "symbols": ["connTLSGetPeerCert"]}
    gitnexus_pred = {"files": ["src/tls.c"], "symbols": ["connTLSGetPeerCert", "SSL_get_peer_certificate", "X509_free"]}

    result = scorer.compare(
        baseline_pred, gitnexus_pred,
        ground_truth={"files": ["src/tls.c"], "symbols": ["connTLSGetPeerCert", "SSL_get_peer_certificate", "X509_free"]},
        difficulty=DifficultyLevel.COMPLEX
    )

    assert result.baseline_f1 < result.gitnexus_f1
    assert result.delta_f1 > 0
