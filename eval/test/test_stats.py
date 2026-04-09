"""Tests for the statistical testing module."""

import pytest

from eval.lib.stats import (
    bootstrap_ci,
    cohen_d,
    compute_dimension_stats,
    judge_strength,
    paired_deltas,
    wilcoxon_signed_rank_test,
)


# ─── paired_deltas ───────────────────────────────────────────────────────────


def test_paired_deltas():
    """Compute deltas between paired scores."""
    base = [0.5, 0.6, 0.7, 0.8]
    gn = [0.6, 0.7, 0.8, 0.9]
    result = paired_deltas(base, gn)
    assert result == pytest.approx([0.1, 0.1, 0.1, 0.1])


def test_paired_deltas_empty():
    """Empty lists produce empty result."""
    assert paired_deltas([], []) == []


def test_paired_deltas_mismatch():
    """Different length lists raise ValueError."""
    with pytest.raises(ValueError, match="same length"):
        paired_deltas([1.0, 2.0], [3.0])


# ─── bootstrap_ci ────────────────────────────────────────────────────────────


def test_bootstrap_ci_positive():
    """All positive deltas produce a positive CI."""
    deltas = [0.1, 0.2, 0.15, 0.25, 0.3, 0.18, 0.22, 0.12, 0.28, 0.17]
    lo, hi = bootstrap_ci(deltas)
    assert lo > 0
    assert hi > lo


def test_bootstrap_ci_zero():
    """All zero deltas produce CI containing 0."""
    deltas = [0.0, 0.0, 0.0, 0.0, 0.0]
    lo, hi = bootstrap_ci(deltas)
    assert lo == 0.0
    assert hi == 0.0


def test_bootstrap_ci_known_data():
    """Known dataset: CI should contain the sample mean."""
    deltas = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    lo, hi = bootstrap_ci(deltas, n_resample=5000)
    mean = sum(deltas) / len(deltas)
    assert lo <= mean <= hi


def test_bootstrap_ci_empty():
    """Empty deltas return (0, 0)."""
    assert bootstrap_ci([]) == (0.0, 0.0)


# ─── wilcoxon_signed_rank_test ───────────────────────────────────────────────


def test_wilcoxon_all_positive():
    """All positive deltas produce a significant p-value."""
    deltas = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4]
    result = wilcoxon_signed_rank_test(deltas)
    assert result["p_value"] < 0.05
    assert result["n"] == 10
    assert result["statistic"] >= 0


def test_wilcoxon_mixed():
    """Mixed deltas: check p-value is a valid float in [0, 1]."""
    deltas = [-0.3, 0.5, -0.1, 0.8, 0.2, -0.4, 0.6, 0.1, -0.2, 0.7]
    result = wilcoxon_signed_rank_test(deltas)
    assert 0.0 <= result["p_value"] <= 1.0
    assert result["n"] == 10


def test_wilcoxon_all_zero():
    """All zeros: p_value = 1.0."""
    deltas = [0.0, 0.0, 0.0, 0.0, 0.0]
    result = wilcoxon_signed_rank_test(deltas)
    assert result["p_value"] == 1.0
    assert result["n"] == 5


def test_wilcoxon_small_n():
    """Small sample still works."""
    deltas = [0.1, 0.2, 0.3]
    result = wilcoxon_signed_rank_test(deltas)
    assert result["n"] == 3
    assert 0.0 <= result["p_value"] <= 1.0


def test_wilcoxon_with_ties():
    """Ties in absolute differences are handled with average ranks."""
    deltas = [1.0, -1.0, 2.0, 0.5]
    result = wilcoxon_signed_rank_test(deltas)
    assert result["n"] == 4
    assert 0.0 <= result["p_value"] <= 1.0


# ─── cohen_d ─────────────────────────────────────────────────────────────────


def test_cohen_d_large():
    """Large consistent effect produces large d."""
    deltas = [1.0, 1.1, 0.9, 1.2, 0.8, 1.0, 1.1, 0.95, 1.05, 1.0]
    d = cohen_d(deltas)
    assert d > 2.0


def test_cohen_d_small():
    """Small noisy effect produces small d."""
    deltas = [0.01, -0.02, 0.03, -0.01, 0.02]
    d = cohen_d(deltas)
    assert abs(d) < 1.0


def test_cohen_d_zero():
    """Zero variance returns 0."""
    assert cohen_d([0.0, 0.0, 0.0]) == 0.0


def test_cohen_d_empty():
    """Empty list returns 0."""
    assert cohen_d([]) == 0.0


# ─── compute_dimension_stats ─────────────────────────────────────────────────


def test_compute_dimension_stats():
    """Grouping by dimension works and returns expected keys."""
    base = [
        {"language": "python", "task_type": "C1", "repo": "a/b", "difficulty": "easy",
         "file_f1": 0.5, "symbol_hit_rate": 0.4},
        {"language": "python", "task_type": "C2", "repo": "a/b", "difficulty": "medium",
         "file_f1": 0.6, "symbol_hit_rate": 0.5},
        {"language": "go", "task_type": "C1", "repo": "c/d", "difficulty": "easy",
         "file_f1": 0.4, "symbol_hit_rate": 0.3},
        {"language": "go", "task_type": "C2", "repo": "c/d", "difficulty": "medium",
         "file_f1": 0.3, "symbol_hit_rate": 0.2},
        {"language": "python", "task_type": "C1", "repo": "a/b", "difficulty": "hard",
         "file_f1": 0.7, "symbol_hit_rate": 0.6},
    ]
    gn = [
        {"language": "python", "task_type": "C1", "repo": "a/b", "difficulty": "easy",
         "file_f1": 0.7, "symbol_hit_rate": 0.6},
        {"language": "python", "task_type": "C2", "repo": "a/b", "difficulty": "medium",
         "file_f1": 0.8, "symbol_hit_rate": 0.7},
        {"language": "go", "task_type": "C1", "repo": "c/d", "difficulty": "easy",
         "file_f1": 0.5, "symbol_hit_rate": 0.4},
        {"language": "go", "task_type": "C2", "repo": "c/d", "difficulty": "medium",
         "file_f1": 0.4, "symbol_hit_rate": 0.3},
        {"language": "python", "task_type": "C1", "repo": "a/b", "difficulty": "hard",
         "file_f1": 0.9, "symbol_hit_rate": 0.8},
    ]

    result = compute_dimension_stats(base, gn, "language")
    assert "python" in result
    assert "go" in result
    assert result["python"]["n"] == 3
    assert result["go"]["n"] == 2
    assert result["python"]["delta_mean"] > 0
    # Check all expected keys present
    for key in ("delta_mean", "ci_low", "ci_high", "p_value", "effect_size",
                "n", "symbol_delta_mean", "strength"):
        assert key in result["python"]


def test_compute_dimension_stats_mismatch():
    """Mismatched lengths raise ValueError."""
    with pytest.raises(ValueError, match="same length"):
        compute_dimension_stats([{"file_f1": 0.5}], [], "language")


# ─── judge_strength ──────────────────────────────────────────────────────────


def test_judge_strength_strong():
    """Meets all criteria for strong."""
    result = judge_strength(delta_f1=0.15, delta_symbol=0.10, n=10, p_value=0.01)
    assert result == "strong"


def test_judge_strength_moderate():
    """Delta positive but p >= 0.05 or delta_symbol <= 0."""
    result = judge_strength(delta_f1=0.10, delta_symbol=0.05, n=10, p_value=0.20)
    assert result == "moderate"


def test_judge_strength_moderate_no_symbol():
    """Delta positive but symbol delta is zero."""
    result = judge_strength(delta_f1=0.10, delta_symbol=0.0, n=10, p_value=0.01)
    assert result == "moderate"


def test_judge_strength_preliminary():
    """Positive delta but n < 5."""
    result = judge_strength(delta_f1=0.10, delta_symbol=0.05, n=4, p_value=0.01)
    assert result == "preliminary"


def test_judge_strength_insufficient():
    """n < 3."""
    result = judge_strength(delta_f1=0.10, delta_symbol=0.05, n=2, p_value=0.01)
    assert result == "insufficient_samples"


def test_judge_strength_no_benefit():
    """Delta <= 0."""
    result = judge_strength(delta_f1=0.0, delta_symbol=0.05, n=10, p_value=0.01)
    assert result == "no_benefit"


def test_judge_strength_no_benefit_negative():
    """Negative delta."""
    result = judge_strength(delta_f1=-0.1, delta_symbol=-0.05, n=10, p_value=0.01)
    assert result == "no_benefit"
