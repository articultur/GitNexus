# GitNexus Claude Eval 重新设计方案

## 目标

建立基于真实 Claude Code Agent 的评估系统，更准确反映用户在真实场景下的能力差异。

## 核心变化

| 维度 | 当前方案 | 新方案 |
|------|---------|--------|
| 执行方式 | Python API 单轮调用 | Claude Code CLI 多轮 Agent |
| 环境隔离 | 文件系统 Snapshot | git worktree |
| 对比组 | Python Baseline Tools | Claude Code vs Claude Code + GitNexus |
| 评估目标 | 工具有效性 | 真实用户决策价值 |

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                 claude_eval.py (CLI)                    │
├─────────────────────────────────────────────────────────┤
│  Case Loader → Difficulty Scorer → Agent Executor       │
│       ↓              ↓                ↓                │
│  JSONL cases    综合评分分级      Claude Code CLI      │
│                                  (worktree 隔离)        │
├─────────────────────────────────────────────────────────┤
│  Scoring Engine ← Prediction Parser                     │
│       ↓                                                 │
│  Delta Calculator                                       │
├─────────────────────────────────────────────────────────┤
│  Report Generator                                      │
│  ├── Simple: Delta % + 主要发现                        │
│  └── Full: 统计 + Case 明细 + 趋势                    │
└─────────────────────────────────────────────────────────┘
```

## 评估流程

### 1. Case 准备
1. 从 JSONL 加载 case
2. 创建 git worktree (`git worktree add /tmp/{case_id}`)
3. Checkout 到 `commit_before`

### 2. 难度分级
```python
score = (call_chain_depth * 0.4) +
        (file_count * 0.3) +
        (language_complexity * 0.2) +
        (repo_size * 0.1)

# 阈值
simple: score < 3
medium: 3 <= score <= 6
complex: score > 6
```

| 维度 | 权重 | 衡量方式 |
|------|------|---------|
| 调用链深度 | 40% | GT call_chain 层数 |
| 跨文件程度 | 30% | GT files 数量 |
| 语言复杂度 | 20% | 编译型 < 脚本型 < 高级类型系统 |
| 代码规模 | 10% | repo 文件数 |

### 3. 双组并行执行

**Baseline 命令:**
```bash
claude -p \
  --disallowed-tools "gitnexus_query,gitnexus_context,gitnexus_impact,gitnexus_shortest_path,gitnexus_get_code,gitnexus_cypher,gitnexus_detect_changes,gitnexus_route_map,gitnexus_test_impact" \
  --disable-slash-commands \
  --bare \
  --dangerously-skip-permissions \
  "{prompt}"
```

**GitNexus 命令:**
```bash
claude -p \
  --bare \
  --dangerously-skip-permissions \
  "{prompt}"
```

### 4. 评分
- **简单任务**: 定性 (`✅` 找到 / `❌` 未找到 / `≈` 部分找到)
- **复杂任务**: 量化 (F1, Delta %, symbol_hit_rate)

### 5. 报告

**Simple Report:**
```
GitNexus Impact Summary
=======================
Overall: +15% on complex tasks, neutral on simple tasks

Complex Tasks (n=12):
  - File F1: +23%
  - Symbol Hit: +18%

Simple Tasks (n=23):
  - 持平 (无显著差异)

Key Finding: GitNexus 主要在深层调用链场景发挥作用
```

**Full Report:**
- 统计显著性 (p-value, CI)
- Case 级别明细
- 按 repo / language / difficulty 分解
- 趋势分析

## 文件结构

```
eval/
├── claude_eval.py           # 新 CLI 入口
├── lib/
│   ├── agent_executor.py    # Claude Code 执行
│   ├── difficulty_scorer.py # 难度分级
│   └── dual_scorer.py      # 双组评分对比
├── report_simple.py         # 简单报告
├── report_full.py          # 完整报告
└── ... (复用现有)
```

## 命令行接口

```bash
# 单 case 快速验证
python claude_eval.py \
  --case redis-14855 \
  --repo redis/redis \
  --commit b3ce4c28ca733529d4456b504616c1b408962a67 \
  --issue "Fix X509 memory leak..."

# 批量评估
python claude_eval.py \
  --dataset dataset/fast.jsonl \
  --output eval/claude-runs/ \
  --parallelism 4

# 报告选项
python claude_eval.py ... --report simple    # 简单报告
python claude_eval.py ... --report full      # 完整报告
python claude_eval.py ... --report both     # 两者都
```

## 复用组件

- `eval/lib/scorer.py` — 评分逻辑
- `eval/schemas/case-schema.json` — case 结构
- `eval/prompts/` — prompt 模板

## 执行模式

| 模式 | 场景 | 触发 |
|------|------|------|
| 快速验证 | 开发时 / PR 检查 | CLI 单 case |
| 完整评估 | 发布前 / 重大决策 | 后台批量 |

## 已知限制

1. **成本**: 每个 case 消耗真实 API tokens
2. **随机性**: Agent 行为有随机成分，结果不完全可复现
3. **Worktree 清理**: 需要正确清理 worktree 避免污染

## 待验证假设

1. `--disallowed-tools` 能完全阻止 GitNexus MCP 工具调用
2. `--disable-slash-commands` 能完全阻止 GitNexus skills
3. Claude Code 的 skill 解析确实会被这个 flag 禁用
