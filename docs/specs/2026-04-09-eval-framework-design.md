# GitNexus Eval Framework Implementation Spec

> Date: 2026-04-09
> Status: Approved
> Scope: P0–P3 full implementation per `docs/eval-evaluation-framework-design.md`

---

## 1. Overview

将 eval/ 从"单轮推理对照脚本"升级为"多轮 agent loop 评测基础设施"。核心变更：

1. `run_eval.py` 升级为真实多轮 tool calling 执行器
2. GitNexus 组通过 MCP 协议调用真实 MCP server
3. Baseline 组通过 Python 直接实现文件系统工具
4. 扩展评分体系、统计检验、报告增强、CI 门禁

---

## 2. Architecture Decision

### Tool Loop 执行方式

- **Baseline 工具**（read_file, grep_search, file_search, list_dir）：Python 直接实现，文件系统操作
- **GitNexus 工具**：每个 case 启动 GitNexus MCP server（stdio 模式），executor 通过 MCP JSON-RPC 调用
- MCP 层的启动失败、超时、返回异常如实记录，纳入评测结果

理由：MCP 是真实用户界面，MCP 层问题就是真实问题，eval 应如实反映。

### Code Organization

模块化 Python package 方案：

```
eval/
├── lib/                     # 核心模块
│   ├── __init__.py
│   ├── executor.py          # 多轮 tool loop 核心
│   ├── mcp_client.py        # MCP stdio 客户端
│   ├── baseline_tools.py    # 文件系统工具实现
│   ├── scorer.py            # 评分引擎（含 strict/relaxed）
│   ├── stats.py             # 统计检验（bootstrap/Wilcoxon）
│   ├── schema.py            # case schema 定义与验证
│   ├── meta.py              # run-meta / snapshot-meta 生成
│   └── budget.py            # 预算与沙盒控制
├── schemas/                 # JSON Schema 定义文件
├── prompts/templates/       # 按任务类型分模板
│   ├── locate-fix.md
│   ├── trace-call-chain.md
│   └── impact-analysis.md
├── dataset/
│   ├── locked/              # 冻结集（不可覆盖）
│   ├── candidates/          # 候选集（可重建）
│   └── archive/             # 退役集
├── runs/                    # 按 run_id 组织结果
│   └── {run_id}/
│       ├── raw/
│       ├── scores.jsonl
│       ├── summary.json
│       ├── run-meta.json
│       ├── delta-report.md
│       ├── failure-buckets.json
│       ├── per-language-report.md
│       ├── per-task-report.md
│       └── per-repo-report.md
├── scripts/
│   ├── harvest-cases.py
│   ├── prepare-snapshots.sh
│   └── ci-gate.sh
├── run_eval.py              # CLI 入口（轻量委托 lib/）
├── score.py                 # CLI 入口
├── report.py                # CLI 入口
├── tool-attribution.py      # 保留
└── stats.py                 # 统计检验 CLI 入口
```

---

## 3. Module Specifications

### 3.1 `lib/mcp_client.py` — MCP stdio 客户端

```python
class MCPClient:
    def __init__(self, server_cmd: list[str], cwd: str, timeout: float = 30.0)
    async def initialize() -> dict
    async def list_tools() -> list[dict]
    async def call_tool(name: str, args: dict) -> dict
    async def close() -> None
```

- 通过 `subprocess.Popen` 启动 MCP server，stdin/stdout JSON-RPC
- server_cmd 默认: `["node", "gitnexus/dist/mcp/index.js", "--stdio"]`
- cwd 设为 snapshot 目录
- 单次工具调用超时 30s（可配置）
- server 异常统一捕获为 `MCPToolError`，记录 `{tool_name, args, error_type, message}`
- 支持 Anthropic / OpenAI 两种 tool calling 格式的 MCP tool schema 转换

### 3.2 `lib/executor.py` — 多轮 Tool Loop 核心

```python
class ToolLoopExecutor:
    def __init__(self, model: str, max_steps: int = 15, token_budget: int = 50000,
                 max_tokens_per_turn: int = 2048)
    async def run(case: dict, group: str, snapshots_dir: str) -> RawResult
```

**循环逻辑：**

1. 构建初始 messages（system + user prompt）
2. 发送 messages 给模型，附带 tool definitions
3. 如果模型返回 `tool_calls` → 执行工具 → 将 tool result 追加到 messages → 继续循环
4. 如果模型返回纯文本（无 tool_calls）→ 提取 JSON → 结束循环
5. 停止条件（任一满足即停止）：
   - 模型未请求工具调用（返回纯文本）
   - `step_count >= max_steps`
   - `total_tokens >= token_budget`
   - 模型输出包含有效 JSON prediction
6. Baseline 组：注入 4 个 baseline 工具定义
7. GitNexus 组：注入 4 个 baseline 工具 + 通过 MCP `list_tools()` 获取的 GitNexus 工具

**Tool calling 格式：**

- OpenAI/OpenRouter transport: `tools` 参数 + `tool_choice="auto"`
- Anthropic transport: `tools` 参数 + `tool_choice={"type": "auto"}`
- 模型返回的 tool_call 转为标准格式：`{name, arguments}`

**错误处理：**

- 工具执行失败 → 将错误信息作为 tool result 返回给模型（允许模型重试）
- 连续 3 次工具失败 → 强制终止，记录错误
- MCP server 启动失败 → 直接失败，不进入 loop

### 3.3 `lib/baseline_tools.py` — 文件系统工具

4 个工具函数，每个返回 `{content: str, error: str | null}`：

| Tool | 参数 | 实现 |
|------|------|------|
| `read_file` | `path, start_line?, end_line?` | 读取文件，支持行范围 |
| `grep_search` | `query, is_regexp?, include_pattern?` | 子进程调用 ripgrep，回退到 Python re |
| `file_search` | `query` | `pathlib.Path.glob` 匹配 |
| `list_dir` | `path` | `os.listdir` |

**沙盒约束：** 所有路径经过 `resolve()` 后必须以 snapshot 根目录为前缀，否则返回错误。

### 3.4 `lib/scorer.py` — 评分引擎

**GT 分层：**

```python
@dataclass
class GroundTruth:
    edit_gt: GTLayer         # 必须命中的修改文件
    root_cause_gt: GTLayer   # 根因符号
    supporting_gt: GTLayer   # 合理辅助文件

@dataclass
class GTLayer:
    files_must: list[str]
    files_optional: list[str]
    symbols_must: list[str]
    symbols_optional: list[str]
```

**双评分模式：**

- `strict`：仅计算 `files_must` 和 `symbols_must`
- `relaxed`：`must` + `optional` 合并计算

**Symbol 匹配改进：**

- 优先 qualified name 精确匹配
- 后缀匹配（`ClassName.method` 匹配 `module.ClassName.method`）
- 记录每 case 的匹配方式分布：`{exact: n, suffix: n, fuzzy: n}`

**聚合维度：**

- 全局、by_language、by_task_type、by_repo、by_difficulty
- 每个维度包含样本数 `n`，n < 5 标注"解释力有限"

### 3.5 `lib/stats.py` — 统计检验

```python
def paired_deltas(base_scores: list, gn_scores: list) -> list[float]
def bootstrap_ci(deltas: list[float], n_resample: int = 10000, ci: float = 0.95) -> tuple[float, float]
def wilcoxon_test(deltas: list[float]) -> dict  # {statistic, p_value}
def cohen_d(deltas: list[float]) -> float
```

- 所有检验结果包含：均值差、95% CI、p-value、effect size、样本量
- 按维度分别检验：by_language、by_task_type、by_repo、by_difficulty
- 维度强弱判断：Δ F1 > 0 且 Symbol Hit 正向 且 n ≥ 5 且 p < 0.05

### 3.6 `lib/schema.py` — Case Schema

**完整字段列表：**

```json
{
  "id": "string",
  "repo": "string",
  "language": "string",
  "commit_before": "string",
  "commit_fix": "string",
  "task_type": "C1|C2|C3|C4|C5",
  "difficulty": "easy|medium|hard",
  "issue_text": "string",
  "issue_url": "string",
  "pr_number": "int",
  "ground_truth": {
    "files": ["string"],
    "symbols": ["string"],
    "call_chain": ["string"]
  },
  "gt_source": "string",
  "selection_reason": "string",
  "case_status": "draft|reviewed|locked|retired",
  "reviewer": "string",
  "review_notes": "string",
  "leakage_risk": "low|medium|high",
  "task_prompt_style": "locate-fix|trace-call-chain|impact-analysis",
  "gt_files_must": ["string"],
  "gt_files_optional": ["string"],
  "gt_symbols_must": ["string"],
  "gt_symbols_optional": ["string"],
  "root_cause_gt": {"files": [], "symbols": []},
  "supporting_gt": {"files": [], "symbols": []},
  "issue_text_variant": "string",
  "dataset_version": "string",
  "source_commit_range": "string",
  "annotation_version": "int"
}
```

**验证函数：** `validate_case(case: dict) -> list[str]` 返回验证错误列表。

**向后兼容：** 新字段全部 optional，旧 case 可直接使用（缺失字段填充默认值）。

### 3.7 `lib/meta.py` — 元数据管理

**run-meta.json 字段：**

```json
{
  "run_id": "string",
  "dataset_name": "string",
  "dataset_hash": "string",
  "cases_count": "int",
  "groups": ["baseline", "gitnexus"],
  "model_id": "string",
  "provider": "string",
  "prompt_version": "string",
  "script_git_commit": "string",
  "python_version": "string",
  "started_at": "ISO8601",
  "finished_at": "ISO8601",
  "parallelism": "int",
  "retry_policy": "string",
  "sandbox_policy": "string",
  "max_steps": "int",
  "token_budget": "int"
}
```

**snapshot-meta.json 字段：**

```json
{
  "case_id": "string",
  "repo": "string",
  "commit_before": "string",
  "snapshot_created_at": "ISO8601",
  "snapshot_source": "string",
  "sparse_paths": ["string"],
  "snapshot_tool_version": "string",
  "snapshot_hash": "string"
}
```

**函数：**

- `compute_dataset_hash(path: Path) -> str` — SHA256 of concatenated case lines
- `generate_run_meta(args, cases, started_at, finished_at) -> dict`
- `generate_snapshot_meta(case, snapshot_dir) -> dict`

### 3.8 `lib/budget.py` — 预算与沙盒

```python
class BudgetGuard:
    def __init__(self, per_case_token_limit: int = 50000,
                 total_token_budget: int = 5000000)
    def check_case(self, tokens_used: int) -> bool   # 单 case 是否超限
    def check_total(self, tokens_used: int) -> bool   # 总预算是否超限
    def summary(self) -> dict                          # 预算使用摘要

class SandboxPolicy:
    def __init__(self, snapshot_root: Path)
    def validate_path(self, path: str) -> str | None   # 返回错误信息或 None
    def policy_version(self) -> str
```

---

## 4. Prompt Template Design

### 4.1 按任务类型分模板

- `prompts/templates/locate-fix.md` — C1 Bug fix（默认）
- `prompts/templates/trace-call-chain.md` — C3 跨文件调用链
- `prompts/templates/impact-analysis.md` — C5 依赖替换

每个模板包含 baseline 和 gitnexus 两个变体（工具集不同）。

### 4.2 Prompt 版本治理

每个模板文件头部包含元数据注释：

```
<!-- prompt_version: 1.0.0 -->
<!-- prompt_type: locate-fix -->
<!-- prompt_group: baseline -->
```

正式 run 记录 prompt 文件名、内容哈希、填充后哈希。

---

## 5. CLI 入口点设计

### 5.1 `run_eval.py`（重构后）

```bash
python eval/run_eval.py \
    --cases eval/dataset/locked/round-01-curated.jsonl \
    --group both \
    --model anthropic/claude-sonnet-4-5 \
    --output eval/runs/{run_id} \
    --snapshots-dir eval/snapshots \
    --max-steps 15 \
    --token-budget 50000 \
    --resume                    # 跳过已完成的 case
    --case-ids flask-05962,gin-001  # 指定 case
    --shard-index 0 --shard-count 4  # 分片
    --parallelism 2             # 并发
    --retry-count 2             # 失败重试
    --dry-run
```

新增参数：
- `--resume`：跳过 runs/{run_id}/raw/ 下已存在的 case
- `--case-ids`：逗号分隔，只跑指定 case
- `--shard-index / --shard-count`：将 case 集分片
- `--parallelism`：asyncio 并发数
- `--retry-count`：API 错误自动重试次数

### 5.2 `score.py`（重构后）

```bash
python eval/score.py \
    --cases eval/dataset/locked/round-01-curated.jsonl \
    --raw eval/runs/{run_id}/raw \
    --output eval/runs/{run_id} \
    --mode both          # strict / relaxed / both
```

### 5.3 `report.py`（重构后）

```bash
python eval/report.py \
    --summary eval/runs/{run_id}/summary.json \
    --stats eval/runs/{run_id}/stats.json \
    --output eval/runs/{run_id}
```

输出产物：
- `delta-report.md` — 主报告
- `per-language-report.md`
- `per-task-report.md`
- `per-repo-report.md`
- `failure-buckets.json`

### 5.4 `stats.py`（新增）

```bash
python eval/stats.py \
    --scores eval/runs/{run_id}/scores.jsonl \
    --output eval/runs/{run_id}/stats.json
```

---

## 6. Report Enhancements

### 6.1 报告结构

正式 run 的 delta-report.md 包含：

1. 数据集版本与哈希
2. 模型与 provider
3. Prompt 版本
4. 仓库→语言映射概览表（含每仓库样本数与难度分布）
5. Baseline / GitNexus 样本数
6. 核心指标均值差
7. 按仓库、按语言、按任务类型、按难度的 breakdown 表（均含样本数 n）
8. 统计检验结果（CI、p-value、effect size）
9. Failure buckets 分布
10. 污染风险样本占比
11. 成本摘要
12. 维度强弱小结

### 6.2 Failure Buckets

分类：
- `wrong_file`：找错文件
- `right_file_miss_root`：找对文件但漏根因符号
- `call_chain_error`：调用链错误
- `json_parse_error`：JSON 输出不合法
- `token_overbudget`：token 成本过高
- `tool_use_invalid`：GitNexus 工具使用无效
- `api_error`：API 调用失败
- `timeout`：超时

### 6.3 维度强弱判断规范

判断某维度"GitNexus 有收益"需同时满足：
1. Δ File F1 > 0
2. Symbol Hit 同步正向
3. 样本数 n ≥ 5
4. p-value < 0.05

不满足时标注"初步信号"或"样本不足"。

---

## 7. CI Integration (P3)

### 7.1 `scripts/ci-gate.sh`

```bash
bash eval/scripts/ci-gate.sh \
    --cases eval/dataset/locked/round-01-curated.jsonl \
    --threshold 0.15 \
    --mode soft    # soft=warning, hard=block
```

流程：
1. 运行 eval（使用快照，不重新拉取）
2. 评分 + 统计
3. 检查 Δ File F1 是否 ≥ threshold
4. 输出 JUnit XML 格式报告
5. soft 模式：输出 warning，exit 0
6. hard 模式：exit 1 阻断

---

## 8. Dataset Management

### 8.1 冻结流程

`round-01-curated-cases.jsonl` 复制到 `dataset/locked/round-01-curated.jsonl`，计算 SHA256 写入 `dataset/locked/round-01-curated.sha256`。

后续正式 run 通过 `--dataset-hash` 验证数据集完整性。

### 8.2 向后兼容

- 旧 case 缺失新字段时自动填充默认值
- `schema.py` 提供迁移函数 `migrate_case(case: dict) -> dict`

---

## 9. Existing Code Migration

| Current File | Action |
|---|---|
| `run_eval.py` | 保留为 CLI 入口，逻辑委托 `lib/executor.py` + `lib/mcp_client.py` |
| `score.py` | 保留为 CLI 入口，逻辑委托 `lib/scorer.py` |
| `report.py` | 扩展，增加 repo breakdown / failure buckets / stats 章节 |
| `tool-attribution.py` | 保留，微调路径 |
| `scripts/prepare-snapshots.sh` | 增加 `snapshot-meta.json` 生成 |
| `scripts/harvest-cases.py` | 增加 P1 扩展字段支持 |

---

## 10. Dependencies

无新增 Python 包依赖。统计检验使用 Python 标准库 `statistics` 和手写 bootstrap 实现。

如果后续需要 Wilcoxon signed-rank test 的精确实现，可选引入 `scipy.stats`（CI 环境可用 pip install）。

---

## 11. Testing Strategy

每个 lib/ 模块配备对应测试：

- `test/test_mcp_client.py` — mock MCP server 测试
- `test/test_executor.py` — tool loop 单元测试
- `test/test_baseline_tools.py` — 沙盒约束测试
- `test/test_scorer.py` — strict/relaxed 评分测试
- `test/test_stats.py` — 统计函数正确性测试
- `test/test_schema.py` — schema 验证测试
- `test/test_budget.py` — 预算控制测试

测试放在 `eval/test/` 下，用 `pytest` 运行。
