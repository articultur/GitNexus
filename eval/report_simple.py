from typing import List
from eval.lib.dual_scorer import DualResult
from eval.lib.difficulty_scorer import DifficultyLevel

class SimpleReporter:
    """简单报告生成器"""

    def generate(self, results: List[DualResult]) -> str:
        if not results:
            return "No results to report"

        # 按难度分组
        complex_results = [r for r in results if r.difficulty == DifficultyLevel.COMPLEX]
        simple_results = [r for r in results if r.difficulty == DifficultyLevel.SIMPLE]
        medium_results = [r for r in results if r.difficulty == DifficultyLevel.MEDIUM]

        lines = ["GitNexus Impact Summary", "=" * 40, ""]

        # 总体评估
        all_deltas = [r.delta_f1 for r in results]
        avg_delta = sum(all_deltas) / len(all_deltas) if all_deltas else 0

        if avg_delta > 0.1:
            overall = f"+{int(avg_delta * 100)}% overall improvement"
        elif avg_delta < -0.1:
            f"{int(avg_delta * 100)}% overall regression"
        else:
            overall = "neutral overall"

        lines.append(f"Overall: {overall}")
        lines.append("")

        # 复杂任务
        if complex_results:
            avg_delta_complex = sum(r.delta_f1 for r in complex_results) / len(complex_results)
            pct = f"+{int(avg_delta_complex * 100)}%" if avg_delta_complex >= 0 else f"{int(avg_delta_complex * 100)}%"
            lines.append(f"Complex Tasks (n={len(complex_results)}):")
            lines.append(f"  - F1 Delta: {pct}")
            lines.append("")

        # 简单任务
        if simple_results:
            deltas = [r.delta_f1 for r in simple_results]
            if all(d == 0 for d in deltas):
                lines.append(f"Simple Tasks (n={len(simple_results)}): neutral")
            else:
                lines.append(f"Simple Tasks (n={len(simple_results)}): mixed results")
            lines.append("")

        return "\n".join(lines)
