"""Statistical testing for eval results — pure Python, no scipy dependency."""

from __future__ import annotations

import math
import random
from collections import defaultdict


# ─── Normal distribution helpers ─────────────────────────────────────────────


def _normal_cdf(z: float) -> float:
    """Standard normal CDF using error function approximation."""
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def _normal_sf(z: float) -> float:
    """Survival function (1 - CDF)."""
    return 1 - _normal_cdf(z)


# ─── Core functions ──────────────────────────────────────────────────────────


def paired_deltas(base_scores: list[float], gn_scores: list[float]) -> list[float]:
    """Compute per-case delta: gn - base. Lists must be same length, paired by index."""
    if len(base_scores) != len(gn_scores):
        raise ValueError(
            f"Score lists must have the same length, "
            f"got {len(base_scores)} and {len(gn_scores)}"
        )
    return [g - b for g, b in zip(gn_scores, base_scores)]


def bootstrap_ci(
    deltas: list[float],
    n_resample: int = 10_000,
    ci: float = 0.95,
    seed: int = 42,
) -> tuple[float, float]:
    """Bootstrap confidence interval for mean delta.

    Returns (lower, upper) bounds of the CI.
    """
    if not deltas:
        return (0.0, 0.0)

    rng = random.Random(seed)
    n = len(deltas)
    means: list[float] = []

    for _ in range(n_resample):
        sample = [deltas[rng.randint(0, n - 1)] for _ in range(n)]
        means.append(sum(sample) / n)

    means.sort()
    alpha = 1 - ci
    lo_idx = int(math.floor((alpha / 2) * n_resample))
    hi_idx = int(math.floor((1 - alpha / 2) * n_resample))
    # Clamp to valid range
    lo_idx = max(0, min(lo_idx, n_resample - 1))
    hi_idx = max(0, min(hi_idx, n_resample - 1))

    return (means[lo_idx], means[hi_idx])


def wilcoxon_signed_rank_test(deltas: list[float]) -> dict:
    """Wilcoxon signed-rank test without scipy.

    Returns {"statistic": float, "p_value": float, "n": int}.
    Uses normal approximation with continuity correction.
    """
    # Filter out zero differences
    diffs = [d for d in deltas if d != 0]
    n = len(diffs)

    if n == 0:
        return {"statistic": 0.0, "p_value": 1.0, "n": len(deltas)}

    # Compute ranks of absolute differences
    abs_diffs = [abs(d) for d in diffs]

    # Sort and assign ranks, handling ties with average ranks
    indexed = sorted(enumerate(abs_diffs), key=lambda x: x[1])
    ranks = [0.0] * n

    i = 0
    while i < n:
        j = i
        # Find all items with the same absolute value
        while j < n - 1 and indexed[j + 1][1] == indexed[j][1]:
            j += 1
        # Average rank for ties (ranks are 1-based)
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[indexed[k][0]] = avg_rank
        i = j + 1

    # Compute W+ and W-
    w_plus = sum(r for r, d in zip(ranks, diffs) if d > 0)
    w_minus = sum(r for r, d in zip(ranks, diffs) if d < 0)

    # Use W as the smaller of the two
    w_stat = min(w_plus, w_minus)

    # Normal approximation
    # E[W] = n(n+1)/4
    e_w = n * (n + 1) / 4

    # Variance — check for ties
    unique_ranks = set(ranks)
    if len(unique_ranks) == n:
        # No ties
        var_w = n * (n + 1) * (2 * n + 1) / 24
    else:
        # Tie correction
        tie_correction = sum(r**3 - r for r in _tie_group_sizes(ranks)) / 48
        var_w = n * (n + 1) * (2 * n + 1) / 24 - tie_correction

    if var_w <= 0:
        return {"statistic": w_stat, "p_value": 1.0, "n": len(deltas)}

    # z-score with continuity correction
    z = (e_w - w_stat - 0.5) / math.sqrt(var_w)
    if z < 0:
        z = -z

    # Two-tailed p-value
    p_value = 2 * _normal_sf(z)

    return {"statistic": float(w_stat), "p_value": float(p_value), "n": len(deltas)}


def _tie_group_sizes(ranks: list[float]) -> list[int]:
    """Return sizes of tied groups in the rank list."""
    counts: dict[float, int] = defaultdict(int)
    for r in ranks:
        counts[r] += 1
    return [c for c in counts.values() if c > 1]


def cohen_d(deltas: list[float]) -> float:
    """Cohen's d effect size for paired samples = mean(deltas) / std(deltas)."""
    if not deltas:
        return 0.0

    n = len(deltas)
    mean = sum(deltas) / n
    variance = sum((d - mean) ** 2 for d in deltas) / n

    if variance == 0:
        return 0.0

    return mean / math.sqrt(variance)


# ─── Dimension analysis ──────────────────────────────────────────────────────


def compute_dimension_stats(
    base_scores: list[dict],
    gn_scores: list[float],
    dimension: str,
) -> dict[str, dict]:
    """Per-dimension statistical analysis.

    Args:
        base_scores: List of score dicts (each with language, task_type, repo,
            difficulty, file_f1, symbol_hit_rate).
        gn_scores: Parallel list of GitNexus score dicts with same keys.
        dimension: Key to group by (e.g. "language", "task_type", "repo",
            "difficulty").

    Returns:
        {dimension_value: {delta_mean, ci_low, ci_high, p_value, effect_size,
            n, symbol_delta_mean, strength}}
    """
    if len(base_scores) != len(gn_scores):
        raise ValueError("base_scores and gn_scores must have the same length")

    # Group by dimension
    groups: dict[str, dict] = defaultdict(lambda: {"base_f1": [], "gn_f1": [],
                                                     "base_sym": [], "gn_sym": []})

    for b, g in zip(base_scores, gn_scores):
        key = b.get(dimension, "unknown")
        if isinstance(key, str) and key:
            groups[key]["base_f1"].append(float(b.get("file_f1", 0)))
            groups[key]["gn_f1"].append(float(g.get("file_f1", 0)))
            groups[key]["base_sym"].append(float(b.get("symbol_hit_rate", 0)))
            groups[key]["gn_sym"].append(float(g.get("symbol_hit_rate", 0)))

    results: dict[str, dict] = {}

    for dim_val, scores in sorted(groups.items()):
        deltas_f1 = paired_deltas(scores["base_f1"], scores["gn_f1"])
        deltas_sym = paired_deltas(scores["base_sym"], scores["gn_sym"])
        n = len(deltas_f1)

        if n == 0:
            continue

        delta_mean = sum(deltas_f1) / n
        symbol_delta_mean = sum(deltas_sym) / n

        ci_low, ci_high = bootstrap_ci(deltas_f1)
        wilcoxon_result = wilcoxon_signed_rank_test(deltas_f1)
        effect = cohen_d(deltas_f1)
        p_value = wilcoxon_result["p_value"]

        results[dim_val] = {
            "delta_mean": round(delta_mean, 6),
            "ci_low": round(ci_low, 6),
            "ci_high": round(ci_high, 6),
            "p_value": round(p_value, 6),
            "effect_size": round(effect, 6),
            "n": n,
            "symbol_delta_mean": round(symbol_delta_mean, 6),
            "strength": judge_strength(delta_mean, symbol_delta_mean, n, p_value),
        }

    return results


def judge_strength(
    delta_f1: float, delta_symbol: float, n: int, p_value: float
) -> str:
    """Judge dimension strength based on statistical criteria.

    Returns one of: "strong", "moderate", "preliminary",
    "insufficient_samples", "no_benefit".
    """
    if n < 3:
        return "insufficient_samples"
    if delta_f1 <= 0:
        return "no_benefit"
    if n < 5:
        return "preliminary"
    if delta_f1 > 0 and delta_symbol > 0 and p_value < 0.05:
        return "strong"
    if delta_f1 > 0 and n >= 5:
        return "moderate"
    # Fallback — should not be reached, but be safe
    return "moderate"
