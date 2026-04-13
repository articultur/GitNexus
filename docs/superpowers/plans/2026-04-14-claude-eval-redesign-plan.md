# Claude Eval 重新设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立基于 Claude Code CLI 的评估系统，实现真实场景下的 GitNexus 能力对比

**Architecture:** 使用 git worktree 隔离环境，通过 claude CLI 的 --disallowed-tools 和 --disable-slash-commands 控制工具权限，双组并行执行后对比评分

**Tech Stack:** Python 3, Claude Code CLI, git worktree, JSONL

---

## 文件结构

```
eval/
├── claude_eval.py              # 主 CLI 入口
├── lib/
│   ├── __init__.py
│   ├── agent_executor.py       # Claude Code 执行器 (新建)
│   ├── difficulty_scorer.py   # 难度分级器 (新建)
│   ├── dual_scorer.py         # 双组评分对比 (新建)
│   ├── worktree_manager.py    # worktree 管理 (新建)
│   └── scorer.py              # (复用现有)
├── report_simple.py            # 简单报告 (新建)
├── report_full.py             # 完整报告 (新建)
└── schemas/case-schema.json   # (复用现有)
```

---

## Task 1: Worktree Manager

**Files:**
- Create: `eval/lib/worktree_manager.py`
- Test: `eval/test/test_worktree_manager.py`

- [ ] **Step 1: 创建测试文件**

```python
# eval/test/test_worktree_manager.py
import pytest
import tempfile
import os
from pathlib import Path

def test_create_worktree():
    """测试 worktree 创建和清理"""
    from eval.lib.worktree_manager import WorktreeManager
    
    with tempfile.TemporaryDirectory() as tmpdir:
        manager = WorktreeManager(base_dir=tmpdir)
        
        # 创建 worktree
        result = manager.create("redis/redis", "b3ce4c2")
        assert result.success
        assert Path(result.path).exists()
        assert (result.path / ".git").exists()
        
        # 清理
        manager.cleanup(result.case_id)
        assert not Path(result.path).exists()
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_worktree_manager.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: 实现 worktree_manager.py**

```python
# eval/lib/worktree_manager.py
import subprocess
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

@dataclass
class WorktreeResult:
    case_id: str
    path: str
    success: bool
    error: Optional[str] = None

class WorktreeManager:
    def __init__(self, base_dir: str = "/tmp/claude-eval-worktrees"):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.worktrees: dict[str, str] = {}
    
    def create(self, repo: str, commit: str, case_id: Optional[str] = None) -> WorktreeResult:
        """创建 worktree"""
        case_id = case_id or f"{repo.replace('/', '-')}-{commit[:7]}"
        worktree_path = self.base_dir / case_id
        
        if worktree_path.exists():
            shutil.rmtree(worktree_path)
        
        try:
            # git clone shallow
            result = subprocess.run(
                ["git", "clone", "--depth", "1", f"https://github.com/{repo}.git", str(worktree_path)],
                capture_output=True, text=True, timeout=120
            )
            if result.returncode != 0:
                return WorktreeResult(case_id, str(worktree_path), False, result.stderr)
            
            # fetch and checkout commit
            subprocess.run(["git", "fetch", "--depth", "1", "origin", commit], 
                          cwd=worktree_path, capture_output=True)
            subprocess.run(["git", "checkout", commit],
                          cwd=worktree_path, capture_output=True)
            
            self.worktrees[case_id] = str(worktree_path)
            return WorktreeResult(case_id, str(worktree_path), True)
            
        except Exception as e:
            return WorktreeResult(case_id, str(worktree_path), False, str(e))
    
    def cleanup(self, case_id: str) -> bool:
        """清理 worktree"""
        if case_id in self.worktrees:
            path = Path(self.worktrees.pop(case_id))
            if path.exists():
                shutil.rmtree(path)
            return True
        return False
    
    def cleanup_all(self):
        """清理所有 worktree"""
        for case_id in list(self.worktrees.keys()):
            self.cleanup(case_id)
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_worktree_manager.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/nonon/Desktop/GitNexus
git add eval/lib/worktree_manager.py eval/test/test_worktree_manager.py
git commit -m "feat(eval): add worktree manager for git isolation"
```

---

## Task 2: Difficulty Scorer

**Files:**
- Create: `eval/lib/difficulty_scorer.py`
- Test: `eval/test/test_difficulty_scorer.py`

- [ ] **Step 1: 创建测试文件**

```python
# eval/test/test_difficulty_scorer.py
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
    case = {
        "ground_truth": {
            "call_chain": ["A -> B -> C -> D -> E"],
            "files": ["a.py", "b.py", "c.py", "d.py"]
        },
        "language": "typescript",
        "repo": "large-repo"
    }
    result = scorer.score(case)
    assert result.level == DifficultyLevel.COMPLEX
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_difficulty_scorer.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: 实现 difficulty_scorer.py**

```python
# eval/lib/difficulty_scorer.py
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
    THRESHOLD_COMPLEX = 6
    
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
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_difficulty_scorer.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add eval/lib/difficulty_scorer.py eval/test/test_difficulty_scorer.py
git commit -m "feat(eval): add difficulty scorer with composite formula"
```

---

## Task 3: Agent Executor

**Files:**
- Create: `eval/lib/agent_executor.py`
- Test: `eval/test/test_agent_executor.py`

- [ ] **Step 1: 创建测试**

```python
# eval/test/test_agent_executor.py
import pytest
import os
import tempfile
from eval.lib.agent_executor import AgentExecutor, AgentResult

def test_baseline_command():
    """测试 baseline 命令生成"""
    executor = AgentExecutor()
    prompt = "Find the bug"
    
    baseline_cmd = executor._build_command(prompt, group="baseline")
    assert "--disallowed-tools" in baseline_cmd
    assert "--disable-slash-commands" in baseline_cmd
    
    gitnexus_cmd = executor._build_command(prompt, group="gitnexus")
    assert "--disallowed-tools" not in gitnexus_cmd
    assert "--disable-slash-commands" not in gitnexus_cmd
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_agent_executor.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: 实现 agent_executor.py**

```python
# eval/lib/agent_executor.py
import subprocess
import json
import re
from dataclasses import dataclass
from typing import Optional
from pathlib import Path

GITNEXUS_TOOLS = [
    "gitnexus_query", "gitnexus_context", "gitnexus_impact",
    "gitnexus_shortest_path", "gitnexus_get_code", "gitnexus_cypher",
    "gitnexus_detect_changes", "gitnexus_route_map", "gitnexus_test_impact"
]

@dataclass
class AgentResult:
    prediction: dict
    raw_output: str
    duration_s: float
    tokens: int
    success: bool
    error: Optional[str] = None

class AgentExecutor:
    """Claude Code Agent 执行器"""
    
    def __init__(self, timeout: int = 180):
        self.timeout = timeout
    
    def _build_command(self, prompt: str, group: str) -> list:
        """构建 claude 命令"""
        base = ["claude", "-p", "--bare", "--dangerously-skip-permissions"]
        
        if group == "baseline":
            base.extend([
                "--disallowed-tools", ",".join(GITNEXUS_TOOLS),
                "--disable-slash-commands"
            ])
        
        base.append(prompt)
        return base
    
    def _parse_json_output(self, output: str) -> dict:
        """从输出中提取 JSON"""
        # 尝试找 ```json ... ``` 块
        json_match = re.search(r'```json\s*(\{.*?\})\s*```', output, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass
        
        # 尝试直接解析
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            return {"files": [], "symbols": [], "call_chain": [], "error": "parse_failed"}
    
    def execute(self, prompt: str, worktree_path: str, group: str) -> AgentResult:
        """执行 Claude Code 并返回结果"""
        import time
        start = time.time()
        
        cmd = self._build_command(prompt, group)
        
        try:
            result = subprocess.run(
                cmd,
                cwd=worktree_path,
                capture_output=True,
                text=True,
                timeout=self.timeout
            )
            
            output = result.stdout + result.stderr
            duration = time.time() - start
            
            # 估算 tokens (简单: 字符数 / 4)
            tokens = len(output) // 4
            
            prediction = self._parse_json_output(output)
            
            return AgentResult(
                prediction=prediction,
                raw_output=output,
                duration_s=duration,
                tokens=tokens,
                success=True
            )
            
        except subprocess.TimeoutExpired:
            return AgentResult(
                prediction={},
                raw_output="",
                duration_s=self.timeout,
                tokens=0,
                success=False,
                error="timeout"
            )
        except Exception as e:
            return AgentResult(
                prediction={},
                raw_output="",
                duration_s=time.time() - start,
                tokens=0,
                success=False,
                error=str(e)
            )
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_agent_executor.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add eval/lib/agent_executor.py eval/test/test_agent_executor.py
git commit -m "feat(eval): add agent executor for Claude Code CLI"
```

---

## Task 4: Dual Scorer

**Files:**
- Create: `eval/lib/dual_scorer.py`
- Test: `eval/test/test_dual_scorer.py`

- [ ] **Step 1: 创建测试**

```python
# eval/test/test_dual_scorer.py
import pytest
from eval.lib.dual_scorer import DualScorer, DualResult
from eval.lib.difficulty_scorer import DifficultyLevel

def test_delta_calculation():
    """测试 delta 计算"""
    scorer = DualScorer()
    
    baseline_pred = {"files": ["src/tls.c"], "symbols": ["connTLSGetPeerCert"]}
    gitnexus_pred = {"files": ["src/tls.c"], "symbols": ["connTLSGetPeerCert", "SSL_get_peer_certificate", "X509_free"]}
    
    result = scorer.compare(
        baseline_pred, gitnexus_pred,
        ground_truth={"files": ["src/tls.c"], "symbols": ["connTLSGetPeerCert", "SSL_get_peer_certificate", "X509_free"]},
        difficulty=DifficultyLevel.COMPLEX
    )
    
    assert result.baseline_f1 < result.gitnexus_f1
    assert result.delta_f1 > 0
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_dual_scorer.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: 实现 dual_scorer.py**

```python
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
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_dual_scorer.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add eval/lib/dual_scorer.py eval/test/test_dual_scorer.py
git commit -m "feat(eval): add dual scorer for baseline vs gitnexus comparison"
```

---

## Task 5: Simple Reporter

**Files:**
- Create: `eval/report_simple.py`
- Test: `eval/test/test_report_simple.py`

- [ ] **Step 1: 创建测试**

```python
# eval/test/test_report_simple.py
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_report_simple.py -v`
Expected: FAIL

- [ ] **Step 3: 实现 report_simple.py**

```python
# eval/report_simple.py
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
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_report_simple.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add eval/report_simple.py eval/test/test_report_simple.py
git commit -m "feat(eval): add simple reporter"
```

---

## Task 6: 主 CLI 入口

**Files:**
- Create: `eval/claude_eval.py`
- Test: `eval/test/test_claude_eval.py`

- [ ] **Step 1: 创建测试**

```python
# eval/test/test_claude_eval.py
import pytest
import argparse
from eval.claude_eval import parse_args

def test_parse_args_defaults():
    """测试默认参数"""
    args = parse_args([])
    assert args.dataset is None
    assert args.output == "eval/claude-runs"
    assert args.report == "simple"
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_claude_eval.py -v`
Expected: FAIL

- [ ] **Step 3: 实现 claude_eval.py**

```python
#!/usr/bin/env python3
# eval/claude_eval.py
"""Claude Code CLI based A/B Evaluation"""

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

from eval.lib.agent_executor import AgentExecutor
from eval.lib.difficulty_scorer import DifficultyScorer, DifficultyLevel
from eval.lib.dual_scorer import DualScorer
from eval.lib.worktree_manager import WorktreeManager
from eval.report_simple import SimpleReporter

def parse_args():
    parser = argparse.ArgumentParser(description="Claude Code A/B Evaluation")
    parser.add_argument("--dataset", help="JSONL dataset file")
    parser.add_argument("--case", help="Single case ID")
    parser.add_argument("--repo", help="Repo (e.g., redis/redis)")
    parser.add_argument("--commit", help="Commit SHA")
    parser.add_argument("--issue", help="Issue description")
    parser.add_argument("--output", default="eval/claude-runs", help="Output directory")
    parser.add_argument("--report", choices=["simple", "full", "both"], default="simple")
    parser.add_argument("--parallelism", type=int, default=1)
    return parser.parse_args()

def load_cases(dataset_path: str) -> List[dict]:
    """从 JSONL 加载 cases"""
    cases = []
    with open(dataset_path) as f:
        for line in f:
            if line.strip():
                cases.append(json.loads(line))
    return cases

def build_prompt(case: dict) -> str:
    """构建评估 prompt"""
    return f"""You are an expert software engineer analyzing a codebase to locate a bug.

## Repository
Repo: {case['repo']}
Language: {case.get('language', 'unknown')}
Commit: {case.get('commit_before', 'unknown')}

## Issue Description
{case.get('issue_text', '')}

## Task
Find the root cause file, key symbols involved, and the call chain that leads to this issue. 
Output your answer as JSON with the following structure:
{{
  "files": ["list of relevant files"],
  "symbols": ["key function/variable names"],
  "call_chain": ["ordered list of function calls showing the path"]
}}

Just analyze the code and output JSON."""

def run_single_case(case: dict, executor: AgentExecutor, worktree_mgr: WorktreeManager) -> Optional[DualResult]:
    """运行单个 case"""
    # 创建 worktree
    worktree = worktree_mgr.create(
        repo=case["repo"],
        commit=case.get("commit_before", ""),
        case_id=case["id"]
    )
    
    if not worktree.success:
        print(f"Failed to create worktree: {worktree.error}")
        return None
    
    prompt = build_prompt(case)
    
    # 执行 baseline
    baseline_result = executor.execute(prompt, worktree.path, "baseline")
    
    # 执行 gitnexus
    gitnexus_result = executor.execute(prompt, worktree.path, "gitnexus")
    
    # 清理 worktree
    worktree_mgr.cleanup(case["id"])
    
    if not baseline_result.success or not gitnexus_result.success:
        return None
    
    # 评分
    scorer = DifficultyScorer()
    difficulty = scorer.score(case)
    
    dual_scorer = DualScorer()
    return dual_scorer.compare(
        baseline_result.prediction,
        gitnexus_result.prediction,
        case.get("ground_truth", {}),
        difficulty.level
    )

def main():
    args = parse_args()
    
    # 初始化组件
    executor = AgentExecutor()
    worktree_mgr = WorktreeManager()
    scorer = DifficultyScorer()
    
    Path(args.output).mkdir(parents=True, exist_ok=True)
    
    # 加载 cases
    if args.dataset:
        cases = load_cases(args.dataset)
    elif args.case and args.repo and args.commit:
        cases = [{
            "id": args.case,
            "repo": args.repo,
            "commit_before": args.commit,
            "issue_text": args.issue or "",
            "language": "unknown",
            "ground_truth": {"files": [], "symbols": []}
        }]
    else:
        print("Error: must specify --dataset or --case/--repo/--commit")
        sys.exit(1)
    
    # 运行评估
    results = []
    for case in cases:
        print(f"Running: {case['id']}")
        result = run_single_case(case, executor, worktree_mgr)
        if result:
            results.append(result)
    
    # 生成报告
    if args.report in ("simple", "both"):
        reporter = SimpleReporter()
        print("\n" + "=" * 40)
        print(reporter.generate(results))
    
    # 保存结果
    output_path = Path(args.output) / "results.json"
    with open(output_path, "w") as f:
        json.dump([
            {
                "difficulty": r.difficulty.value,
                "baseline_f1": r.baseline_f1,
                "gitnexus_f1": r.gitnexus_f1,
                "delta_f1": r.delta_f1
            }
            for r in results
        ], f, indent=2)
    
    print(f"\nResults saved to {output_path}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /Users/nonon/Desktop/GitNexus && python -m pytest eval/test/test_claude_eval.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add eval/claude_eval.py eval/test/test_claude_eval.py
git commit -m "feat(eval): add claude_eval CLI entry point"
```

---

## Task 7: Full Reporter (简化版)

**Files:**
- Create: `eval/report_full.py`
- Test: `eval/test/test_report_full.py` (可选)

由于完整报告需要更多统计功能，作为后续扩展。

- [ ] **Step 1: 实现基础版**

```python
# eval/report_full.py
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
```

- [ ] **Step 2: 提交**

```bash
git add eval/report_full.py
git commit -m "feat(eval): add full reporter"
```

---

## 执行选项

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-claude-eval-redesign-plan.md`**

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
