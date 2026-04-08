# GitNexus Eval -- A/B Effectiveness Evaluation Framework

A controlled evaluation framework that measures **delta = F(with GitNexus) - F(baseline)** across real-world PR-based cases from open-source repositories.

The framework uses a **multi-turn tool loop** where an LLM agent interacts with code tools (and optionally GitNexus MCP tools) to diagnose issues, then reports predicted files and symbols. GitNexus cases get access to 9 additional code-intelligence tools (query, context, impact, etc.) via an MCP integration.

---

## Quick Start

### 1. Set up environment

```bash
cp eval/.env.example eval/.env
# Fill ONE model profile + GITHUB_TOKEN
```

Supported model auth profiles in `eval/.env`:

1. OpenRouter
   OPENROUTER_API_KEY=...

2. MiniMax (OpenAI-compatible)
   MINIMAX_API_KEY=...
   MINIMAX_API_BASE=https://api.minimaxi.com/v1

3. Generic OpenAI-compatible
   OPENAI_API_KEY=...
   OPENAI_BASE_URL=https://api.openai.com/v1

4. Anthropic-style
   ANTHROPIC_API_KEY=...
   # or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL

For GitHub harvesting:
GITHUB_TOKEN=...

### 2. Harvest cases from GitHub

```bash
python eval/scripts/harvest-cases.py \
    --repos flask gin polly express retrofit \
    --output eval/dataset/cases.jsonl \
    --max-per-repo 10 \
    --github-token $GITHUB_TOKEN
```

Or start from the included seed cases:

```bash
cp eval/dataset/validation-seed-cases.jsonl eval/dataset/cases.jsonl
```

### 3. Prepare code snapshots

```bash
bash eval/scripts/prepare-snapshots.sh \
    --cases eval/dataset/cases.jsonl \
    --snapshots-dir eval/snapshots
```

### 4. Run A/B evaluation

```bash
# Both groups
python eval/run_eval.py --cases eval/dataset/cases.jsonl --group both

# Or one group at a time
python eval/run_eval.py --group baseline
python eval/run_eval.py --group gitnexus
```

### 5. Score results

```bash
# Both strict and relaxed modes (default)
python eval/score.py --mode both

# Or a single mode
python eval/score.py --mode strict
```

### 6. Generate report

```bash
python eval/report.py
python eval/tool-attribution.py
```

Output: `eval/results/delta-report.md` and `eval/results/tool-attribution.md`

---

## Directory Layout

```
eval/
├── .env.example              # API key config template
├── run_eval.py               # A/B runner -- multi-turn tool loop executor
├── score.py                  # Computes File F1 / Symbol Hit vs ground truth
├── report.py                 # Generates delta-report.md with breakdowns
├── stats.py                  # Statistical significance (Wilcoxon, bootstrap CI)
├── tool-attribution.py       # Analyses which GitNexus tools drove gains
├── lib/
│   ├── __init__.py
│   ├── executor.py           # ToolLoopExecutor -- model <-> tool loop
│   ├── scorer.py             # GT layering, strict/relaxed scoring, aggregation
│   ├── stats.py              # Pure-Python statistical tests (no scipy)
│   ├── baseline_tools.py     # File tools (read, grep, list, glob)
│   ├── budget.py             # Token budget guard
│   ├── mcp_client.py         # GitNexus MCP client (http + stdio transports)
│   ├── meta.py               # Run metadata generation
│   └── schema.py             # Case schema validation and migration
├── schemas/
│   └── case-schema.json      # JSON Schema for case validation
├── runs/                      # Output root for run_eval.py ({run_id}/ per run)
├── test/
│   ├── test_e2e.py           # End-to-end integration test
│   ├── test_executor.py      # ToolLoopExecutor unit tests
│   ├── test_scorer.py        # Scoring engine unit tests
│   ├── test_stats.py         # Statistical test unit tests
│   ├── test_schema.py        # Case schema validation tests
│   ├── test_budget.py        # Budget guard tests
│   ├── test_baseline_tools.py # Baseline tool tests
│   ├── test_mcp_client.py    # MCP client tests
│   └── mock_mcp_server.py    # Mock MCP server for testing
├── dataset/
│   ├── validation-seed-cases.jsonl   # 5 hand-annotated validation cases
│   ├── round-01-pilot-cases.jsonl    # first pilot batch (16 cases)
│   ├── round-01-expanded-cases.jsonl # expanded batch (32 cases)
│   ├── round-01-curated-cases.jsonl  # curated round-01 dataset
│   ├── harvest-round-01-pilot/       # per-repo harvest outputs for pilot batch
│   ├── harvest-round-01-curated/     # per-repo harvest outputs for curated batch
│   └── cases.jsonl                   # active dataset alias used by commands
├── scripts/
│   ├── harvest-cases.py      # GitHub PR harvester -> cases.jsonl
│   ├── prepare-snapshots.sh  # Clone + gitnexus analyze per case
│   └── junit_report.py       # Convert results to JUnit XML
├── prompts/
│   ├── task.md               # Baseline prompt (file tools only)
│   ├── task-with-gitnexus.md # GitNexus prompt (+ 9 MCP tools)
│   └── templates/            # Per-task-style prompt templates
│       ├── locate-fix-baseline.md
│       ├── locate-fix-gitnexus.md
│       ├── trace-call-chain-baseline.md
│       ├── trace-call-chain-gitnexus.md
│       ├── impact-analysis-baseline.md
│       └── impact-analysis-gitnexus.md
├── snapshots/
│   └── {case_id}/            # Sparse-checkout of repo at commit_before
└── results/
    ├── raw/                  # {case_id}_{group}.json -- raw LLM outputs
    ├── scores.jsonl          # Per-case metrics
    ├── scores-relaxed.jsonl  # Per-case metrics (relaxed mode)
    ├── summary.json          # Aggregate + delta (strict)
    ├── summary-relaxed.json  # Aggregate + delta (relaxed)
    ├── stats.json            # Statistical significance data
    ├── delta-report.md       # Human-readable report -- main output
    ├── tool-attribution.md   # Per-tool usage & F1 impact
    └── tool-attribution.json
```

---

## Case Schema

Each line in the active dataset file (for example `cases.jsonl` or `round-01-curated-cases.jsonl`) is a JSON object:

```json
{
  "id": "flask-00001",
  "repo": "pallets/flask",
  "language": "python",
  "commit_before": "1.1.1",
  "commit_fix": "a8d1a40b1c3e",
  "task_type": "C1",
  "difficulty": "medium",
  "issue_text": "...",
  "issue_url": "https://github.com/...",
  "pr_number": 3659,
  "ground_truth": {
    "files": ["src/flask/ctx.py", "src/flask/globals.py"],
    "symbols": ["AppContext.pop", "_AppCtxGlobals"],
    "call_chain": ["entry_function -> intermediate -> root_cause"]
  },
  "gt_source": "pr_diff",
  "case_status": "reviewed",
  "leakage_risk": "low",
  "task_prompt_style": "locate-fix",
  "annotation_version": 1,
  "gt_files_must": ["src/flask/ctx.py"],
  "gt_files_optional": ["src/flask/globals.py"],
  "gt_symbols_must": ["AppContext.pop"],
  "gt_symbols_optional": ["_AppCtxGlobals"],
  "root_cause_gt": {
    "files": ["src/flask/ctx.py"],
    "symbols": ["AppContext.pop"]
  },
  "supporting_gt": {
    "files": ["src/flask/helpers.py"],
    "symbols": ["find_app"]
  }
}
```

### Required fields

| Field | Description |
|-------|-------------|
| `id` | Unique case identifier |
| `repo` | `owner/repo` on GitHub |
| `language` | Primary language |
| `commit_before` | Commit SHA before the fix |
| `commit_fix` | Commit SHA of the fix |
| `task_type` | One of C1-C5 (see task types) |
| `difficulty` | `easy`, `medium`, or `hard` |
| `issue_text` | Issue / PR description |
| `ground_truth` | Object with `files` and `symbols` arrays |
| `gt_source` | How GT was derived (e.g. `pr_diff`) |

### P1 extended fields (optional, defaults applied)

| Field | Default | Description |
|-------|---------|-------------|
| `case_status` | `draft` | `draft`, `reviewed`, `locked`, `retired` |
| `leakage_risk` | `medium` | `low`, `medium`, `high` |
| `task_prompt_style` | `locate-fix` | Prompt template style |
| `annotation_version` | `1` | Schema version for the annotation |
| `gt_files_must` | `[]` | Files that must be found (strict scoring) |
| `gt_files_optional` | `[]` | Files that give bonus credit (relaxed scoring) |
| `gt_symbols_must` | `[]` | Symbols that must be found (strict scoring) |
| `gt_symbols_optional` | `[]` | Symbols that give bonus credit (relaxed scoring) |
| `root_cause_gt` | `{files:[], symbols:[]}` | Root cause layer |
| `supporting_gt` | `{files:[], symbols:[]}` | Supporting evidence layer |

### Task types

| Type | Description | Target % |
|------|-------------|---------|
| C1 | Bug fix | 40% |
| C2 | Interface/signature change | 20% |
| C3 | New cross-file call chain | 20% |
| C4 | Interface implementation | 10% |
| C5 | Dependency/module swap | 10% |

---

## GT Layering and Scoring Modes

Ground truth is organized in three layers, each with **must** and **optional** items:

1. **Edit GT** -- files/symbols that were directly modified in the fix
2. **Root Cause GT** -- the underlying root cause symbols and files
3. **Supporting GT** -- supporting evidence files and symbols

The scorer supports two modes:

| Mode | GT items used | Use case |
|------|--------------|----------|
| **strict** | `*_must` only | Primary evaluation: only essential items count |
| **relaxed** | `*_must` + `*_optional` | Generous evaluation: partial credit for adjacent findings |

Old-format cases (only `ground_truth.files`/`ground_truth.symbols`) are automatically mapped to the `edit_gt.files_must` and `root_cause_gt.symbols_must` layers.

---

## Metrics

| Metric | Description |
|--------|-------------|
| File F1 | Harmonic mean of precision+recall on predicted vs GT files |
| Symbol Hit Rate | % of GT symbols found (substring match) in prediction |
| Tool Calls | Number of tool invocations per case |
| Token Cost | Total tokens (prompt + completion) |
| Confidence | Model-reported confidence (0-1) |

The key headline metric is **delta File F1** (GitNexus - Baseline).

---

## Prompt Templates

Cases are matched to prompt templates by their `task_prompt_style` field. There are 3 task styles, each with a baseline and GitNexus variant (6 templates total):

| Style | Baseline Template | GitNexus Template | Description |
|-------|-------------------|-------------------|-------------|
| `locate-fix` | `prompts/templates/locate-fix-baseline.md` | `prompts/templates/locate-fix-gitnexus.md` | Find the files/symbols to fix (default) |
| `trace-call-chain` | `prompts/templates/trace-call-chain-baseline.md` | `prompts/templates/trace-call-chain-gitnexus.md` | Trace execution paths between symbols |
| `impact-analysis` | `prompts/templates/impact-analysis-baseline.md` | `prompts/templates/impact-analysis-gitnexus.md` | Analyze blast radius of a change |

If the task-specific template does not exist, the system falls back to `locate-fix-{group}.md`.

---

## CLI Reference

### run_eval.py

```
python eval/run_eval.py [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--cases` | `eval/dataset/validation-seed-cases.jsonl` | Path to JSONL cases file |
| `--group` | `both` | `baseline`, `gitnexus`, or `both` |
| `--model` | `anthropic/claude-sonnet-4-5` | LLM model identifier |
| `--output` | `eval/runs` | Root output directory |
| `--snapshots-dir` | `eval/snapshots` | Per-case snapshots directory |
| `--max-tokens` | `2048` | Max completion tokens per turn |
| `--case-filter` | `""` | Run cases whose id starts with prefix |
| `--dry-run` | off | Print prompts without calling API |
| `--resume` | off | Skip cases whose output already exists |
| `--case-ids` | `""` | Comma-separated case IDs (overrides `--case-filter`) |
| `--shard-index` | `0` | Shard index for distributed runs (0-based) |
| `--shard-count` | `1` | Total shards (1 = no sharding) |
| `--parallelism` | `1` | Concurrent cases (1 = sequential) |
| `--retry-count` | `2` | Retries per API call on transient errors |
| `--max-steps` | `15` | Max tool-loop round-trips per case |
| `--token-budget` | `50000` | Per-case token budget |
| `--run-id` | auto | Explicit run ID (default: timestamp) |

### score.py

```
python eval/score.py [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--cases` | `eval/dataset/cases.jsonl` | Path to JSONL cases file |
| `--raw` | `eval/results/raw` | Directory with raw results |
| `--output` | `eval/results` | Output directory |
| `--mode` | `both` | `strict`, `relaxed`, or `both` |

### report.py

```
python eval/report.py [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--summary` | `eval/results/summary.json` | Aggregate summary JSON |
| `--scores` | `eval/results/scores.jsonl` | Per-case scores JSONL |
| `--stats` | `""` | Path to stats.json (enables significance section) |
| `--output` | `eval/results/delta-report.md` | Main report output |
| `--output-per-language` | `""` | Per-language sub-report path |
| `--output-per-task` | `""` | Per-task sub-report path |
| `--output-per-repo` | `""` | Per-repo sub-report path |

### stats.py

```
python eval/stats.py [OPTIONS]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--scores` | `eval/runs/latest/scores.jsonl` | Scored results JSONL |
| `--output` | `eval/runs/latest/stats.json` | Stats output JSON |

---

## Statistical Testing

The framework includes pure-Python statistical tests (no scipy dependency):

- **Paired deltas**: Per-case `gn_score - base_score` for each metric
- **Bootstrap 95% CI**: 10,000 resamples of the mean delta
- **Wilcoxon signed-rank test**: Non-parametric test with normal approximation and tie correction
- **Cohen's d**: Effect size for paired samples

Results are reported per dimension (language, task_type, repo, difficulty) with a strength classification:

| Strength | Criteria |
|----------|----------|
| `strong` | n >= 5, delta > 0, symbol delta > 0, p < 0.05 |
| `moderate` | n >= 5, delta > 0 |
| `preliminary` | 3 <= n < 5, delta > 0 |
| `insufficient_samples` | n < 3 |
| `no_benefit` | delta <= 0 |

---

## CI Gate

The eval test suite can be run in CI to verify framework correctness:

```bash
# Run all eval tests
python -m pytest eval/test/ -v

# Run only E2E integration test
python -m pytest eval/test/test_e2e.py -v
```

All tests use mocked model responses and mock MCP servers -- no API keys needed in CI.

---

## Expected Conclusions

| ID | Hypothesis | Threshold |
|----|-----------|-----------|
| C1 | GitNexus improves File F1 | delta >= +0.20 |
| C2 | GitNexus reduces tool calls | delta <= -30% |
| C3 | GitNexus reduces token cost | delta <= -25% |
| C4 | T2/T3 tasks benefit most | delta F1 highest for C2/C3 types |
| C5 | Typed langs benefit more | Java/C#/Go delta > Python/JS/Ruby delta |
| C6 | `impact` + `context` most valuable | Highest delta F1 in tool-attribution |
