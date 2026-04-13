"""完整报告生成器 - 简化版"""
from typing import List
from eval.lib.dual_scorer import DualResult
from eval.lib.difficulty_scorer import DifficultyLevel


class FullReporter:
    """完整报告生成器"""

    def generate(self, results: List[DualResult]) -> str:
        lines = ["Claude Eval Full Report", "=" * 50, ""]

        # 总体统计
        total = len(results)
        if total == 0:
            return "\n".join(lines) + "\nNo results to report"

        improved = sum(1 for r in results if r.delta_f1 > 0.1)
        regressed = sum(1 for r in results if r.delta_f1 < -0.1)
        neutral = total - improved - regressed

        lines.append(f"Total Cases: {total}")
        lines.append(f"Improved: {improved} ({improved/total*100:.1f}%)")
        lines.append(f"Regressed: {regressed} ({regressed/total*100:.1f}%)")
        lines.append(f"Neutral: {neutral} ({neutral/total*100:.1f}%)")
        lines.append("")

        # 按难度分解
        for level in [DifficultyLevel.COMPLEX, DifficultyLevel.MEDIUM, DifficultyLevel.SIMPLE]:
            level_results = [r for r in results if r.difficulty == level]
            if level_results:
                avg_delta = sum(r.delta_f1 for r in level_results) / len(level_results)
                lines.append(f"{level.value.upper()}: n={len(level_results)}, avg_delta={avg_delta:.3f}")

        return "\n".join(lines)
