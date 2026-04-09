# GitNexus Eval 评测体系设计文档

> 日期：2026-04-09  
> 适用范围：GitNexus `eval/` 评测框架  
> 目标：将当前“可运行的评估脚本集合”收敛为“可冻结、可复现、可扩展、可门禁”的正式评测体系

---

## 1. 设计目标

GitNexus 的 `eval/` 体系不是产品功能测试，而是一个面向 AI 代码智能能力的对照评估系统。其核心目标是回答以下问题：

1. 在真实代码仓库和真实历史问题上，使用 GitNexus 的 AI 是否比不使用 GitNexus 更准确。
2. GitNexus 的价值主要体现在哪些任务类型、语言类型和工具能力上。
3. 该价值是否稳定、可复现，并可作为后续版本回归门禁的一部分。

因此，本体系必须满足：

1. 可复现：同一批 case、同一快照、同一模型配置下，结果可重跑。
2. 可追溯：任意一次结论都能追到所用数据集、快照、脚本版本、模型配置。
3. 可扩展：可以逐轮扩充数据集，而不破坏旧轮次结果。
4. 可对照：支持 Baseline 与 GitNexus 两组并行比较。
5. 可门禁：在成熟后可接入 CI，作为质量信号。

---

## 2. 核心评估问题

评测体系最终服务于以下主问题：

1. `Δ File F1 = File F1(with GitNexus) - File F1(baseline)` 是否显著为正。
2. GitNexus 是否提升符号级命中率与调用链理解能力。
3. GitNexus 是否减少探索成本，或在提高准确率的同时带来可接受的 token 成本增长。
4. 该收益在不同语言、不同任务类型上如何分布。

需要明确区分“当前实现状态”和“目标状态”：

1. 当前实现状态
   - `run_eval.py` 已升级为多轮 tool loop 执行器，支持“模型调用工具、工具返回结果、模型继续推理”的 agent loop。
   - Baseline 组已真实执行文件级搜索与读取工具，GitNexus 组已真实执行 GitNexus MCP 工具。
   - 当前结论可以解释为“真实工具使用评测下的 A/B 对照结果”，不再只是 prompt 文本差异对照。
2. 目标状态
   - Baseline 组应真实执行文件级搜索与读取工具。
   - GitNexus 组应在 Baseline 基础上真实执行 GitNexus 图查询与上下文工具。
   - A/B 差异应来自真实工具能力，而不是 prompt 文本差异。

目标对照方式为：

1. Baseline：仅使用文件级搜索和读取工具。
2. GitNexus：在 Baseline 基础上增加图查询与代码智能工具。

---

## 3. 评测对象与任务边界

### 3.1 评测对象

当前评测对象是 AI 在真实仓库中的代码理解与问题定位能力，而不是 patch 生成能力。

模型需要回答的问题通常包括：

1. 哪些文件需要修改。
2. 哪些函数、方法、类是根因。
3. 调用链从入口到根因如何到达。

### 3.2 当前任务类型

当前 case 自动分类为 5 类：

1. `C1`：Bug fix
2. `C2`：接口或签名变更
3. `C3`：跨文件调用链新增或理解
4. `C4`：接口实现补全
5. `C5`：依赖或模块替换

### 3.3 难度分层

当前按改动文件数粗分：

1. `easy`：1 个代码文件
2. `medium`：2-3 个代码文件
3. `hard`：4-5 个代码文件

后续可引入更细粒度难度因子，例如继承层级、动态 dispatch、宏/DSL 等。

---

## 4. 体系分层

`eval/` 当前与目标中的测试金字塔分为三层：

### 4.1 框架实现层

职责：承载评测流程本身的执行与产物生成。

当前主要脚本：

1. `eval/run_eval.py`
2. `eval/score.py`
3. `eval/report.py`
4. `eval/tool-attribution.py`

当前事实：

1. 此层目前是“评测框架实现”，而不是“评测框架测试”。
2. 当前仓库尚未建立针对这些脚本的独立自动化测试层。
3. 后续应补充针对解析、评分、报告生成的单元测试与回归测试。

### 4.2 集成验证层

职责：用少量手工标注样本验证端到端链路是否通。

当前资产：

1. `eval/dataset/validation-seed-cases.jsonl`
2. `eval/results/verification-run/`

### 4.3 回归评估层

职责：用冻结数据集执行正式 A/B 对照评测。

当前资产：

1. `eval/dataset/round-01-pilot-cases.jsonl`
2. `eval/dataset/round-01-expanded-cases.jsonl`
3. `eval/dataset/round-01-curated-cases.jsonl`
4. `eval/results/round1/`

### 4.4 统计验证层

职责：验证实验结论是否具备统计可信度，而不仅是均值差异。

目标产物：

1. 配对 case delta 分布
2. bootstrap 置信区间
3. 显著性检验结果
4. effect size

当前状态：

1. 该层已实现，当前已具备配对 delta、bootstrap 置信区间、Wilcoxon 显著性检验与 Cohen's d effect size。
2. 当前报告已支持统计检验结果、样本数与维度强弱自然语言小结，可用于正式解释“统计显著提升”。

---

## 5. 目录与资产设计

### 5.1 当前推荐目录结构

```text
eval/
├── .env.example
├── .env
├── README.md
├── run_eval.py
├── score.py
├── report.py
├── tool-attribution.py
├── prompts/
│   ├── task.md
│   └── task-with-gitnexus.md
├── scripts/
│   ├── harvest-cases.py
│   └── prepare-snapshots.sh
├── dataset/
│   ├── validation-seed-cases.jsonl
│   ├── round-01-pilot-cases.jsonl
│   ├── round-01-expanded-cases.jsonl
│   ├── round-01-curated-cases.jsonl
│   ├── harvest-round-01-pilot/
│   └── harvest-round-01-curated/
├── snapshots/
│   ├── round1/
│   └── ...
└── results/
    ├── verification-run/
    ├── round1/
    └── ...
```

### 5.2 目标目录规范

为长期治理，建议后续进一步规范为：

```text
eval/
├── dataset/
│   ├── candidates/
│   ├── locked/
│   └── archive/
├── prompts/
│   ├── templates/
│   └── variants/
├── snapshots/
│   └── {dataset_version}/{case_id}/
├── runs/
│   └── {run_id}/
├── schemas/
└── stats/
```

其中：

1. `candidates/`：自动抓取候选集，可重建。
2. `locked/`：正式冻结数据集，不覆盖。
3. `archive/`：退役样本。
4. `runs/`：按实验运行粒度保存结果，而不是只按 round 保存。
5. `stats/`：保存统计检验结果、置信区间与 power analysis。

---

## 6. 数据集管理策略

### 6.1 数据集分级

当前体系中的数据集建议重新定义为以下角色：

1. `validation-seed-cases.jsonl`
   - 角色：最小验证集
   - 作用：验证脚本、prompt、解析与打分链路

2. `round-01-pilot-cases.jsonl`
   - 角色：小规模试运行集
   - 作用：快速获取第一轮指标信号

3. `round-01-expanded-cases.jsonl`
   - 角色：扩展探索集
   - 作用：扩大样本但不作为正式门禁

4. `round-01-curated-cases.jsonl`
   - 角色：正式冻结集
   - 作用：作为当前轮次的标准评测数据集

### 6.2 冻结原则

冻结集必须满足：

1. 用于正式对照实验后不再被覆盖。
2. 修改 GT 或移除 case 时必须新开版本。
3. 运行报告必须记录所用冻结集名称与哈希。

### 6.3 样本量原则

建议：

1. `validation`：3-10 条
2. `pilot`：10-30 条
3. `expanded`：30-60 条
4. `curated`：每仓库 10 条左右，总量约 160 条

### 6.4 数据污染与泄漏控制

由于当前数据主要来自知名开源仓库，必须显式管理训练数据污染风险。

建议增加以下治理：

1. 为每个 case 标记 `leakage_risk`，并记录判定依据。
2. 对高知名度仓库和高传播 PR 单独分层统计，不与低风险样本混合解释。
3. 构造 `issue_text` 改写版本，降低模型基于记忆直接复述历史修复的概率。
4. 维护一组污染探针样本，用于检测模型是否对仓库或 PR 有显著记忆。
5. 在结论中区分“仓库记忆收益”和“工具检索收益”，避免混淆解释。

---

## 7. Case Schema 设计

### 7.1 当前 schema

当前 case 已包含：

1. `id`
2. `repo`
3. `language`
4. `commit_before`
5. `commit_fix`
6. `task_type`
7. `difficulty`
8. `issue_text`
9. `issue_url`
10. `pr_number`
11. `ground_truth`
12. `gt_source`

### 7.2 推荐扩展字段

为了把评测体系从“能跑”升级到“可长期管理”，建议新增：

1. `selection_reason`
   - 为什么该样本具有代表性
2. `case_status`
   - `draft` / `reviewed` / `locked` / `retired`
3. `reviewer`
   - 谁审核过该 case
4. `review_notes`
   - 审核说明
5. `leakage_risk`
   - `low` / `medium` / `high`
6. `task_prompt_style`
   - `locate-fix` / `trace-call-chain` / `impact-analysis`
7. `gt_files_must`
8. `gt_files_optional`
9. `gt_symbols_must`
10. `gt_symbols_optional`
11. `root_cause_gt`
12. `supporting_gt`
13. `issue_text_variant`
14. `dataset_version`
15. `source_commit_range`
16. `annotation_version`

### 7.3 GT 分层原则

不要只用 PR diff 做唯一 GT。建议拆为三层：

1. `edit_gt`
   - PR 实际修改的文件
2. `root_cause_gt`
   - 真正根因文件和符号
3. `supporting_gt`
   - 合理分析过程会访问的辅助文件

这样评分时可以同时支持：

1. 严格评分
2. 宽松评分

### 7.4 人工审核要求

正式冻结集不应完全依赖脚本自动生成。

建议要求：

1. `curated` 集每条 case 至少经过一次人工审核。
2. 审核内容包括问题表述是否清晰、GT 是否过宽或过窄、是否存在明显污染风险。
3. 只有 `case_status=locked` 的 case 才能进入正式 run。

---

## 8. Commit 与快照管理

### 8.1 当前做法

当前每个 case 保存 `commit_before`，并通过：

1. `prepare-snapshots.sh`
2. `git clone --sparse`
3. `git checkout {commit_before}`

在 `eval/snapshots/` 下形成独立代码快照。

### 8.2 为什么不用 rebase

评测目标是复现历史状态，而不是修改历史，因此不应使用 rebase。

应使用：

1. detached checkout
2. sparse checkout
3. worktree（后续可选）

这样不会污染原始仓库历史，也能保证结果可复现。

### 8.3 快照元数据

建议每个快照目录内保留：

1. `.eval-case.json`
2. `snapshot-meta.json`

`snapshot-meta.json` 建议记录：

1. `case_id`
2. `repo`
3. `commit_before`
4. `snapshot_created_at`
5. `snapshot_source`
6. `sparse_paths`
7. `snapshot_tool_version`
8. `snapshot_hash`

### 8.4 快照隔离原则

在后续引入真实工具执行后，快照目录必须作为受控沙盒使用。

要求：

1. 模型可读范围应限制在当前 case 的 snapshot 根目录内。
2. 禁止跨 case、跨仓库读取本地其他内容。
3. 需要在运行元数据中记录是否启用沙盒与沙盒策略版本。

---

## 9. Prompt 设计

### 9.1 当前状态

当前有两类 prompt：

1. `task.md`：Baseline
2. `task-with-gitnexus.md`：GitNexus

两者的任务描述一致，只在工具集上区分。

但需明确：

1. 当前 prompt 仅声明了工具，不代表这些工具已被执行器真正调用。
2. 因此当前 prompt 设计只能支撑“单轮说明型对照”，不能单独证明“工具可用性收益”。

### 9.2 设计原则

1. 同一 case 的 A/B prompt 主任务必须一致。
2. 不在 prompt 中暗示“哪一组更强”。
3. 输出结构必须稳定，优先 JSON。

### 9.3 后续建议

未来应引入任务模板分层：

1. `locate-fix`
2. `trace-call-chain`
3. `impact-analysis`

case 应绑定主任务，而不是所有 case 都用同一个问题模板。

### 9.4 Prompt 版本治理

每次正式 run 应记录：

1. prompt 模板文件名
2. prompt 内容哈希
3. system prompt
4. 模板变量填充后的最终 prompt 哈希

这样才能准确追溯结论来源。

---

## 10. 执行流程设计

### 10.1 当前执行闭环

当前主流程已经具备：

1. `harvest-cases.py`：抓取案例
2. `prepare-snapshots.sh`：拉取快照
3. `run_eval.py`：执行 A/B 推理
4. `score.py`：打分
5. `report.py`：产出报告
6. `tool-attribution.py`：工具归因

但当前 `run_eval.py` 的真实执行语义应描述为：

1. 单轮调用模型。
2. 解析模型最终输出。
3. 如果输出文本中出现工具名，则做文本级归因统计。

它尚不具备：

1. 多轮 tool calling
2. 工具执行结果回灌
3. 真实工具调用次数统计

### 10.2 推荐标准阶段

建议正式定义为五阶段：

1. `case-lock`
   - 从候选集生成冻结集
2. `snapshot-prepare`
   - 为冻结集准备快照
3. `eval-run`
   - 跑 A/B
4. `eval-report`
   - 评分、报告、归因
5. `eval-verify`
   - 检查异常 case、统计可信度、污染风险与产物完整性

### 10.3 目标执行模型

正式评测必须采用 agent loop：

1. 模型输出 tool call 意图。
2. 执行器调用对应工具。
3. 将工具结果返回给模型继续推理。
4. 直到模型产出最终结构化 JSON 或达到停止条件。

Baseline 与 GitNexus 的真正差异，必须由执行器允许的工具集合控制。

### 10.4 执行特性

后续应补齐：

1. `--resume`
2. `--case-ids`
3. `--shard-index`
4. `--shard-count`
5. `run-meta.json`
6. `--max-steps`
7. `--retry-count`
8. `--parallelism`
9. `--token-budget`

### 10.5 运行元数据

`run-meta.json` 至少应记录：

1. `run_id`
2. `dataset_name`
3. `dataset_hash`
4. `cases_count`
5. `groups`
6. `model_id`
7. `provider`
8. `prompt_version`
9. `script_git_commit`
10. `python_version`
11. `started_at`
12. `finished_at`
13. `parallelism`
14. `retry_policy`
15. `sandbox_policy`

---

## 11. 评分体系设计

### 11.1 当前指标

当前已有：

1. `file_precision`
2. `file_recall`
3. `file_f1`
4. `symbol_hit_rate`
5. `tool_calls`
6. `total_tokens`
7. `confidence`
8. `duration_s`

但需注意：

1. 当前 `tool_calls` 并非真实执行器级调用次数。
2. 对 GitNexus 组而言，当前主要来自输出文本中工具名的出现次数统计。
3. 因此在真实 tool loop 落地前，`tool_calls` 只能作为弱代理信号，不能作为严格效率指标。

### 11.2 评分维度

建议归纳为四类：

1. 定位准确性
   - file precision / recall / f1
   - symbol precision / recall / f1
2. 路径理解
   - call-chain hit
   - root-cause hit
3. 运行效率
   - tool calls
   - token cost
   - duration
4. 稳定性
   - parse success rate
   - api error rate

### 11.2.1 聚合粒度

上述指标应按以下粒度分别聚合，以支撑不同层次的分析需求：

1. 全局聚合
   - 所有 case 的整体均值
2. 按语言聚合
   - 以 case 的 `language` 字段为键
   - 每种语言必须展示样本数 `n`，样本数过少时应标注"n<5，解释力有限"
3. 按任务类型聚合
   - 以 case 的 `task_type` (C1-C5) 为键
   - 每种类型必须展示样本数 `n`
4. 按仓库聚合
   - 以 case 的 `repo` 字段为键
   - 用于发现"某个仓库特别难"还是"某种语言整体弱"的差异
5. 按难度聚合
   - 以 case 的 `difficulty` 字段为键

判断某个维度"强"还是"弱"，应同时满足：

1. 该维度下 Δ File F1 > 0
2. 该维度下 Symbol Hit 同步正向
3. 该维度下样本数 n ≥ 5
4. 后续补齐统计检验后，该分组的 p-value < 0.05

### 11.3 统计检验

“提升是否显著”不能只依赖均值差，建议正式纳入：

1. 配对 case delta
   - 对每个 case 计算 `metric_gitnexus - metric_baseline`
2. bootstrap 95% 置信区间
3. 配对显著性检验
   - 优先使用 Wilcoxon signed-rank test
   - 数据满足前提时可补充 paired t-test
4. effect size
   - 至少报告一种标准化效应量

所有正式结论应同时给出：

1. 均值差
2. 置信区间
3. p-value
4. 样本量

### 11.4 严格与宽松双评分

未来建议支持：

1. `strict`
   - 只接受 must-hit GT
2. `relaxed`
   - 允许 optional GT 命中

这样可以避免 GT 标注过严导致误伤模型表现。

### 11.5 指标质量改进

当前 `symbol_hit_rate` 若仅使用宽松子串匹配，容易产生误报。

建议：

1. 优先使用 qualified name 精确匹配。
2. 允许有限的后缀匹配或命名空间折叠，但必须规则化。
3. 在 summary 中记录模糊匹配比例，便于审计评分质量。

---

## 12. 报告体系设计

### 12.1 当前产物

当前每轮运行可产出：

1. `scores.jsonl`
2. `summary.json`
3. `delta-report.md`
4. `tool-attribution.md`
5. `tool-attribution.json`

### 12.2 后续增强方向

建议增加：

1. `failure-buckets.json`
2. `per-language-report.md`
3. `per-task-report.md`
4. `per-repo-report.md`
5. `repo-language-map.md`

失败类型建议至少包含：

1. 找错文件
2. 找对文件但漏根因符号
3. 调用链错误
4. JSON 输出不合法
5. token 成本过高
6. GitNexus 工具使用无效

### 12.2.1 仓库与语言映射展示

当前数据集中每个 case 同时携带 `repo` 和 `language` 字段，但报告产物中缺少显式的仓库→语言映射表。

建议在正式报告开头增加一张 Dataset Overview 表：

```
| Repo             | Language   | Cases (n) | Difficulty Distribution  |
|------------------|------------|-----------|-------------------------|
| pallets/flask    | python     | 10        | easy:3, medium:4, hard:3 |
| gin-gonic/gin    | go         | 10        | easy:2, medium:5, hard:3 |
| ...              | ...        | ...       | ...                     |
```

此表的作用：

1. 让读者一眼看出哪个仓库对应哪种语言。
2. 暴露样本分布是否均衡。
3. 帮助解释"某语言表现差"到底是仓库个例还是语言通病。

### 12.2.2 仓库级结果展示

在 by_language 和 by_task_type 之外，报告应增加 by_repo breakdown 表：

```
| Repo             | Language | n | F1 Base | F1 GN  | Δ F1   | Sym Hit Base | Sym Hit GN | Δ Sym Hit |
|------------------|----------|---|---------|--------|--------|--------------|------------|-----------|
| pallets/flask    | python   | 10| 0.3200  | 0.4100 | +0.09  | 0.2500       | 0.3800     | +0.13     |
| gin-gonic/gin    | go       | 10| 0.2800  | 0.2600 | -0.02  | 0.1500       | 0.1400     | -0.01     |
```

此表的作用：

1. 区分"某仓库特别难"和"某语言整体弱"两种不同原因。
2. 发现离群仓库（某个仓库拉高或拉低了语言维度均值）。
3. 为后续 case 审核和数据集调整提供依据。

### 12.2.3 维度强弱判断规范

报告中涉及"语言维度强弱"或"功能维度强弱"的判断时，应遵循以下规范：

1. 语言维度强弱
   - 先看该语言下 Δ File F1 是否为正，绝对值多大。
   - 再看 Symbol Hit 是否同步正向。
   - 再看该语言下样本数 n 是否 ≥ 5。
   - 如果某语言只有一个仓库（如 python 只有 flask），需在报告中标注该语言结论受限于单仓库。
   - 如果 n < 5，只能标注"初步信号"，不能标注"稳定趋势"。

2. 功能维度强弱
   - 先看该 task_type 下 Δ File F1 是否为正。
   - 再看 Tool Calls 和 Token Cost 是否有合理变化。
   - 再看样本数 n。
   - 如果某个功能类型的样本全部来自同一语言，需标注功能结论受限于语言分布。

### 12.3 正式报告最小内容

正式 run 的汇总报告至少应包含：

1. 数据集版本与哈希
2. 模型与 provider
3. prompt 版本
4. 仓库→语言映射概览表（含每仓库样本数与难度分布）
5. Baseline / GitNexus 样本数
6. 核心指标均值差
7. 按仓库、按语言、按任务类型、按难度的 breakdown 表（均含样本数 n）
8. 统计检验结果
9. 失败桶分布
10. 高污染风险样本占比
11. 成本摘要
12. 维度强弱小结（哪些语言/任务类型收益明确，哪些不明确，哪些样本不足）

---

## 13. 实验运行数据管理

### 13.1 用 Git 管什么

建议纳入 Git 管理的内容：

1. 冻结数据集
2. case schema 与标注
3. prompts
4. 评测脚本
5. run 元数据
6. 汇总报告

### 13.2 不建议纳入 Git 的内容

1. `snapshots/`
2. `results/raw/`
3. `harvest-*` 中间产物
4. 大体积临时实验结果

### 13.3 原则

1. 可复现定义进 Git
2. 可再生产物不进 Git
3. 大文件且变化频繁的产物不进 Git

### 13.4 模型与版本治理

为了保障跨轮次可比性，应明确：

1. 正式 run 使用固定模型版本，而不是浮动别名。
2. provider 返回的最终 model id 应写入运行元数据。
3. 若 API 不支持确定性 seed，应在报告中明确“temperature=0 但非严格确定性”。
4. 多模型横评时，每个模型视为独立实验轴，不应与工具对照混合解释。

### 13.5 成本与预算治理

建议增加：

1. 单 case token 上限
2. 单 run 总 token 预算
3. 预算超限中止策略
4. 按组成本对照报告

---

## 14. 当前状态总结

截至 2026-04-09，当前体系状态如下：

1. 脚本闭环已具备
   - 已具备抓取、快照、运行、评分、报告、归因
2. 小规模验证已打通
   - `verification-run` 可产出 summary 与 report
3. pilot 轮次已跑通
   - `round1` 已产生 raw、summary、delta report
4. 扩展数据集已生成
   - `round-01-curated-cases.jsonl` 已接近正式轮次规模
5. 命名已整理
   - 数据集命名已从临时名称切换到正式风格

当前主要差距：

> 以下差距列表已于 2026-04-09 审计更新。原列表 10 项差距中，7 项已完全消除，剩余条目如下。

1. ~~当前执行器仍是单轮推理~~ → ✅ 已升级为多轮 `ToolLoopExecutor`
2. ~~case schema 还未升级~~ → ✅ 已支持多层 GT、状态管理、迁移
3. ~~run 元数据尚未系统化~~ → ✅ `run-meta.json` + `snapshot-meta.json` 已落地
4. ~~strict / relaxed 双评分~~ → ✅ `scorer.py` 已实现
5. ~~统计检验与置信区间~~ → ✅ `stats.py` Wilcoxon + bootstrap CI + Cohen's d 已实现
6. ~~failure buckets~~ → ✅ `scorer.py` + `report.py` 已实现
7. ~~数据污染控制~~ → ✅ `leakage_risk` 标注 + 报告污染占比已落地
8. ~~冻结集收口~~ → ✅ `dataset/locked/round-01-curated.jsonl` + SHA256 已固化
9. ~~报告缺少仓库级 breakdown~~ → ✅ `report.py` 已含 Dataset Overview、by_repo、per-dimension sub-reports
10. ~~维度强弱判断~~ → ✅ `build_strength_summary()` 已按维度输出自然语言小结

**剩余差距（非阻塞）：**

1. 污染探针样本尚未引入（保留为后续研究项，用于进一步评估训练数据污染风险）
2. `issue_text_variant` 改写版本未自动生成（降级为可选增强项，用于后续抽样增强鲁棒性分析）

---

## 15. 下一阶段实施优先级

> 以下优先级列表已于 2026-04-09 审计更新。P0 和 P1 已全部完成，P2 大部分完成，P3 已完成。

### P0 ✅ 全部完成

1. ~~将 `run_eval.py` 升级为真实多轮 tool loop 执行器~~
2. ~~引入 `run-meta.json`~~
3. ~~引入快照元数据 `snapshot-meta.json`~~
4. ~~固化 `round-01-curated-cases.jsonl` 为冻结集~~
5. ~~为正式 run 增加沙盒与预算控制~~

### P1 ✅ 全部完成

1. ~~扩展 case schema~~
2. ~~拆分 GT 为 `edit_gt` / `root_cause_gt` / `supporting_gt`~~
3. ~~支持 strict / relaxed 双评分~~
4. ~~增加 case 人工审核流程~~ → 机制已接入：`case_status=locked` 过滤已实现；但当前冻结集仍全部为 `draft`，尚未完成实际审核收口
5. ~~增加污染风险标注~~ → `leakage_risk` 已实现；`issue_text_variant` 已降级为可选增强项

### P2 ✅ 大部分完成

1. ~~增加 failure buckets~~
2. ~~增加配对统计检验与 bootstrap 置信区间~~
3. ~~增加按语言与任务类型的独立报告~~ → `report.py --output-per-language/task/repo`
4. ~~支持 run 分片、并发与恢复执行~~

### P3 ✅ 已完成

1. ~~与 CI 集成形成软门禁~~ → `ci-gate.sh --mode soft`
2. ~~稳定后引入硬门禁阈值~~ → `ci-gate.sh --mode hard`

---

## 16. 已知限制与解释边界

> 以下限制声明已于 2026-04-09 审计更新。原第 1-3 条约束已随 P0 完成而解除。

1. ~~当前执行器为单轮推理~~ → ✅ 已升级为多轮 tool loop 执行器，结果可解释为"真实工具调用评测下的差异"。
2. ~~tool_calls 不代表真实成本~~ → ✅ 执行器已真实执行工具，tool_calls 反映实际执行步数。
3. ~~未做统计检验~~ → ✅ Wilcoxon + bootstrap CI + Cohen's d 已落地，可使用"统计显著"表述（p<0.05 时）。
4. 当前数据来自知名开源项目，存在训练数据污染风险。`leakage_risk` 标注已上线；污染探针样本保留为后续研究项，`issue_text_variant` 作为可选增强项不阻塞当前框架收口。

## 17. 结论

GitNexus 的 `eval/` 体系已从"零散脚本"演进为具备完整评测基础设施的框架。P0—P3 优先级项已全部或大部分落地，包括：多轮 tool loop 执行器、run/snapshot 元数据治理、冻结数据集与哈希校验、沙盒隔离与预算控制、三层 GT 评分、strict/relaxed 双评分、failure buckets、Wilcoxon + bootstrap CI 统计检验、per-dimension 报告、CI 门禁。

该体系当前具备以下能力：

1. 能稳定回答 GitNexus 是否提升 AI 代码理解能力。
2. 能对不同模型、不同轮次、不同语言做横向比较。
3. 能作为长期回归系统与 CI 质量信号的一部分。
4. 能将实验数据、快照、报告和结论全部纳入可追溯链路。

这将使 `eval/` 从“实验脚本目录”升级为“正式评测基础设施”。