# eval/lib/dual_scorer.py
from dataclasses import dataclass
from typing import Any
from eval.lib.difficulty_scorer import DifficultyLevel

@dataclass
class DualResult:
    baseline_f1: float
    gitnexus_f1: float
    delta_f1: float
    baseline_symbol_hit: float
    gitnexus_symbol_hit: float
    delta_symbol_hit: float
    difficulty: DifficultyLevel
    is_significant: bool

class DualScorer:
    """双组评分对比"""

    def _compute_f1(self, predicted: list, ground_truth: list) -> float:
        """计算 F1"""
        if not ground_truth:
            return 0.0

        predicted_set = set(predicted)
        gt_set = set(ground_truth)

        tp = len(predicted_set & gt_set)
        fp = len(predicted_set - gt_set)
        fn = len(gt_set - predicted_set)

        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0

        if precision + recall == 0:
            return 0.0
        return 2 * precision * recall / (precision + recall)

    def _compute_symbol_hit(self, predicted: list, ground_truth: list) -> float:
        """计算 symbol hit rate"""
        if not ground_truth:
            return 0.0
        predicted_set = set(predicted)
        gt_set = set(ground_truth)
        return len(predicted_set & gt_set) / len(gt_set)

    def compare(
        self,
        baseline_pred: dict,
        gitnexus_pred: dict,
        ground_truth: dict,
        difficulty: DifficultyLevel
    ) -> DualResult:
        """对比双组结果"""
        gt_files = ground_truth.get("files", [])
        gt_symbols = ground_truth.get("symbols", [])

        baseline_files = baseline_pred.get("files", [])
        gitnexus_files = gitnexus_pred.get("files", [])

        baseline_symbols = baseline_pred.get("symbols", [])
        gitnexus_symbols = gitnexus_pred.get("symbols", [])

        baseline_f1 = self._compute_f1(baseline_files, gt_files)
        gitnexus_f1 = self._compute_f1(gitnexus_files, gt_files)

        baseline_hit = self._compute_symbol_hit(baseline_symbols, gt_symbols)
        gitnexus_hit = self._compute_symbol_hit(gitnexus_symbols, gt_symbols)

        return DualResult(
            baseline_f1=baseline_f1,
            gitnexus_f1=gitnexus_f1,
            delta_f1=gitnexus_f1 - baseline_f1,
            baseline_symbol_hit=baseline_hit,
            gitnexus_symbol_hit=gitnexus_hit,
            delta_symbol_hit=gitnexus_hit - baseline_hit,
            difficulty=difficulty,
            is_significant=difficulty == DifficultyLevel.COMPLEX
        )
