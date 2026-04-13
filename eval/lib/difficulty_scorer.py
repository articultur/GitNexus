from dataclasses import dataclass
from enum import Enum
from typing import Any

class DifficultyLevel(Enum):
    SIMPLE = "simple"
    MEDIUM = "medium"
    COMPLEX = "complex"

LANGUAGE_COMPLEXITY = {
    "c": 1, "cpp": 1, "go": 1, "rust": 1,
    "python": 2, "ruby": 2, "php": 2, "javascript": 2,
    "typescript": 3, "java": 3, "csharp": 3, "kotlin": 3,
    "swift": 3, "dart": 3,
    "cobol": 4, "scala": 3
}

@dataclass
class DifficultyResult:
    level: DifficultyLevel
    score: float
    breakdown: dict[str, float]

class DifficultyScorer:
    """综合难度评分器

    score = (call_chain_depth * 0.4) + (file_count * 0.3) + (language_complexity * 0.2) + (repo_size * 0.1)
    """

    THRESHOLD_SIMPLE = 3
    THRESHOLD_COMPLEX = 3.9

    def score(self, case: dict[str, Any]) -> DifficultyResult:
        gt = case.get("ground_truth", {})

        # call_chain_depth: 计算 "->" 数量 + 1
        call_chain = gt.get("call_chain", [])
        if isinstance(call_chain, list):
            chain_str = " -> ".join(call_chain) if call_chain else ""
        else:
            chain_str = str(call_chain)
        call_depth = chain_str.count("->") + 1 if chain_str else 1

        # file_count: GT files 数量
        files = gt.get("files", [])
        file_count = len(files) if isinstance(files, list) else 1

        # language_complexity
        lang = case.get("language", "python").lower()
        lang_complexity = LANGUAGE_COMPLEXITY.get(lang, 2)

        # repo_size (简化: 固定权重)
        repo_size = 1

        # 计算总分
        score = (call_depth * 0.4) + (file_count * 0.3) + (lang_complexity * 0.2) + (repo_size * 0.1)

        # 确定级别
        if score < self.THRESHOLD_SIMPLE:
            level = DifficultyLevel.SIMPLE
        elif score > self.THRESHOLD_COMPLEX:
            level = DifficultyLevel.COMPLEX
        else:
            level = DifficultyLevel.MEDIUM

        breakdown = {
            "call_depth": call_depth * 0.4,
            "file_count": file_count * 0.3,
            "lang_complexity": lang_complexity * 0.2,
            "repo_size": repo_size * 0.1
        }

        return DifficultyResult(level, score, breakdown)
