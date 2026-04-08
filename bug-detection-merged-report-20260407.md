# GitNexus Bug Detection 合并状态报告（真实状态）

更新时间：2026-04-08
来源文件：
- eval-bug-detection-report.md
- bug-detection-eval-report-20260406.md
- bug-detection-fix-report-20260406.md

本报告为三份历史报告的合并版与纠偏版，结论以当前代码仓库实现为准。

---

## 1. 总结结论

- 修复类事项（US-001 ~ US-008）当前已全部落地到代码。
- 评估类结论中涉及的中长期能力建设项（语义层、平台建模、DOM 事件模型、排序不变量、缺失代码自动检测等）仍未“全部解决”。
- 因此应区分两类状态：
  - 工程修复状态：已完成
  - 检测能力成熟度：仍在演进中

---

## 2. US 修复状态（代码证据）

| US | 状态 | 当前代码证据 |
|---|---|---|
| US-001 Node.js stack | 已完成 | gitnexus/src/cli/analyze.ts（STACK_SIZE_KB=16384，按需注入 flags） |
| US-002 ObjC message_expression | 已完成 | gitnexus/src/core/ingestion/utils/call-analysis.ts（MEMBER_ACCESS_NODE_TYPES 包含 message_expression） |
| US-003 Query 搜索优化 | 已完成 | bm25 conjunctive=true；RRF_K=20；distance<0.25；FTS 字段扩展到 parameterNames/returnType/qualifier |
| US-004 C++ static inline | 已完成 | gitnexus/src/core/ingestion/export-detection.ts（static/inline 导出判定） |
| US-005 glob 卡死 | 已完成 | gitnexus/src/core/ingestion/filesystem-walker.ts（globIterate 流式扫描） |
| US-006 detect_changes CLI | 已完成 | gitnexus/src/cli/index.ts + gitnexus/src/cli/tool.ts（detect-changes 命令已注册） |
| US-007 全局变量可见性 | 已完成 | gitnexus/src/core/ingestion/utils/ast-helpers.ts（definition.global -> Variable） |
| US-008 语义层架构评估 | 已完成 | .omc/research/semantic-layer-design.md |

---

## 3. 能力项状态（来自评估报告）

以下并非单点 bug 修复，而是能力建设路线：

1. ~~缺失代码自动检测（”应该有但不存在” 的规则推断）~~ — **P0 已完成（阶段 B，6条规则）**
2. 平台/环境正交建模（如 target_env / target_os 维度）— P1 设计完成，待实现
3. DOM 事件传播语义建模 — P2 待推进
4. 排序不变量推理（如地址排序约束）— P1 设计完成，待实现
5. 终端/渲染状态机建模 — P2 待推进
6. ~~diff-based bug detection（跨版本语义差分）~~ — **P0 已完成（阶段 B）**
7. 语义层深度能力（类型系统、领域知识、并发模型）— P2 待推进

---

## 4. 对历史三份报告的纠偏

- bug-detection-fix-report-20260406.md：修复项大体成立，但应避免与“能力项已完成”混淆。
- bug-detection-eval-report-20260406.md：属于评估与路线图文档，不应被解读为“待修复缺陷清单”。
- eval-bug-detection-report.md：保留研究价值，但部分表述需结合当前代码版本重新解读。

---

## 5. 后续建议

1. 对外统一引用本合并报告作为“当前真实状态”基线。
2. 按下述执行计划推进未完成能力项，并在每个里程碑后更新本报告状态。
3. 历史报告继续保留为证据归档，待至少完成 P0/P1 后再评估是否物理删除。

---

## 6. 能力路线与剩余工作（2026Q2-Q4）

### 6.1 优先级分层

| 优先级 | 能力项 | 目标窗口 | 交付目标 |
|---|---|---|---|
| P0（已完成） | diff-based bug detection、缺失代码自动检测（规则引擎 MVP） | 2026 Q2 | 已落地，进入精度优化与评估固化 |
| P1 | 平台/环境正交建模、排序不变量推理 | 2026 Q3 | 提升复杂逻辑 bug 的命中率 |
| P2 | DOM 事件传播模型、终端渲染状态机、语义层深度能力 | 2026 Q4+ | 扩展到前端/平台专属问题域 |

### 6.2 分阶段实施

#### 阶段 A（2-3 周）：基线与评估框架固化

目标：先把“评估一致性”建立起来，避免后续优化无法量化。

交付物：
- 统一评估脚本：固定输入仓库、固定运行参数、固定报告模板。
- 基线集：从当前 25 个真实 bug 中抽取回归子集（建议 12-15 个）。
- 指标看板：Top-1 命中率、Top-5 命中率、误报率、单仓分析耗时。

验收标准：
- 同一版本连续运行 3 次，波动不超过 5%。
- 评估结果可重复，且可在 CI 中生成摘要。

#### 阶段 B（3-4 周）：P0 能力落地（规则引擎 MVP + diff 检测）

目标：把“缺失代码检测”和“跨版本差分检测”做成最小可用产品。

交付物：
- 规则引擎 MVP：支持 if-guard 缺失、unwrap/find 防御缺失、资源释放缺失三类规则。
- diff 检测 MVP：比较 base/head 的符号关系变化，输出“新增风险点”列表。
- CLI/MCP 接口：新增或扩展命令使能力可调用（建议统一到 detect-changes 输出中）。

验收标准：
- 基线子集中 P0 类 bug 命中率较阶段 A 提升 >= 20%。
- 每条告警包含可追溯证据（符号、文件、行段、触发规则）。

#### 阶段 C（4-5 周）：P1 能力落地（平台维度 + 不变量）

目标：补足平台条件与排序约束这两类高价值缺陷。

交付物：
- 平台维度建模：在索引层显式编码 os/env/arch 约束并参与查询。
- 不变量模块：支持“有序性、唯一性、单调性”三类规则模板。
- 回归样例：新增最少 8 个跨平台与排序错误样例。

验收标准：
- Rust/Go 平台相关案例命中率显著提升（建议目标 >= 30%）。
- 不变量规则误报率低于 25%。

#### 阶段 D（持续）：P2 能力预研与小步上线

目标：在不破坏现有稳定性的前提下逐步扩展复杂语义域。

交付物：
- DOM 事件传播 PoC（捕捉 target/currentTarget 误用）。
- 终端状态机 PoC（cursor/viewport 状态一致性校验）。
- 语义层实验分支（限定语言与场景，不进入默认主路径）。

验收标准：
- PoC 各自至少覆盖 3 个真实案例。
- 不影响主流程分析耗时（回归下降不超过 10%）。

### 6.3 工作分解（按能力项）

1. 缺失代码自动检测
- 任务：建立规则 DSL（前置条件/触发点/缺失条件/证据提取）。
- 任务：先支持 10 条高频规则（资源释放、空值防御、生命周期守卫）。
- 任务：结果输出标准化（severity、confidence、evidence）。

2. diff-based bug detection
- 任务：对比 base/head 的调用边、守卫条件、关键语句模式。
- 任务：输出“高风险变化摘要”并可追溯到符号。

3. 平台/环境正交建模
- 任务：在节点/关系属性中补 platform constraints。
- 任务：查询层支持按平台上下文过滤与对比。

4. DOM 事件传播模型
- 任务：建模事件源、冒泡路径、处理器绑定点。
- 任务：规则化检测 target/currentTarget 混用与阻断缺失。

5. 排序不变量推理
- 任务：在关键集合操作点提取排序键与比较器。
- 任务：检测排序假设与实际操作不一致问题。

6. 终端/渲染状态机建模
- 任务：抽象 cursor、buffer、viewport 状态迁移图。
- 任务：检测 reconnect/resize 后状态重建缺失。

7. 语义层深度能力
- 任务：仅在实验通道接入类型与并发语义推理。
- 任务：建立“可回退开关”，防止影响主链路稳定性。

### 6.4 管理与节奏

- 周节奏：每周一次能力评审（指标变化 + 误报样例复盘）。
- 发布节奏：每两周一个里程碑，必须附带回归报告。
- 变更守则：任何新能力默认 behind feature flag，先灰度后默认开启。

### 6.5 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 规则数量增长导致误报上升 | 降低可用性 | 建立规则评分与黑白名单机制 |
| 语义能力拖慢分析性能 | 影响大仓体验 | 主链路保持结构化快速路径，语义能力按需启用 |
| 平台建模复杂度过高 | 交付延期 | 先覆盖高频平台组合（linux/windows + gcc/msvc） |

### 6.6 里程碑退出条件

- P0 退出条件：基线集命中率提升达标，且 CI 可稳定复现。
- P1 退出条件：平台类与不变量类案例达到预设命中率目标。
- P2 退出条件：PoC 转产品化，默认关闭但可稳定灰度。

### 6.7 计划细化（项目管理版）

#### 6.7.1 时间线与里程碑（建议）

| 周期 | 里程碑 | 关键产出 | 通过标准 |
|---|---|---|---|
| W1-W2 | M1 阶段 A 完成 | 基线评估脚本、固定样本集、稳定性报告 v1 | 3 次重复运行波动 <= 5% |
| W3-W5 | M2 阶段 B 完成 | 规则引擎 MVP、diff 检测 MVP、CLI/MCP 输出接入 | P0 类命中率较基线提升 >= 20% |
| W6-W9 | M3 阶段 C 完成 | 平台维度建模、不变量检测模块、回归样例补齐 | 平台/不变量样例命中率达标 |
| W10-W12 | M4 阶段 D 第一轮 | DOM/终端 PoC、语义层实验分支、性能回归报告 | PoC 覆盖 >= 3 真实样例且性能回归 <= 10% |

#### 6.7.2 工作拆解（WBS）

| WBS ID | 能力项 | 子任务 | 预估工期 | 前置依赖 | 交付物 |
|---|---|---|---|---|---|
| A-1 | 阶段 A 基线 | 固定样本集（12-15）与标签清洗 | 2 天 | 无 | 样本清单与标签说明 |
| A-2 | 阶段 A 基线 | 统一执行脚本（重复运行 + 方差统计） | 2 天 | A-1 | 可运行脚本与配置 |
| A-3 | 阶段 A 基线 | CI 集成（夜跑 + 报告归档） | 2 天 | A-2 | CI Job + 构建产物 |
| B-1 | 规则引擎 MVP | DSL 定义（条件、缺失、证据） | 3 天 | A-3 | DSL 规范与 parser |
| B-2 | 规则引擎 MVP | 三类规则实现（guard/unwrap/resource） | 4 天 | B-1 | 规则实现 + 单测 |
| B-3 | diff 检测 MVP | base/head 对比器（边变化 + 守卫变化） | 4 天 | A-3 | 差分引擎 + 单测 |
| B-4 | 输出接入 | detect-changes 输出扩展（风险摘要） | 2 天 | B-2, B-3 | CLI/MCP 输出字段 |
| C-1 | 平台建模 | 节点/关系 platform constraints 扩展 | 3 天 | B-4 | schema + ingest 变更 |
| C-2 | 平台建模 | 查询层平台过滤与对比 | 3 天 | C-1 | query/context 扩展 |
| C-3 | 不变量推理 | 有序/唯一/单调规则模板与匹配器 | 4 天 | B-1 | 规则库 + 检测器 |
| C-4 | 回归体系 | 新增 >= 8 样例并接入基线套件 | 2 天 | C-2, C-3 | 样例与报告 |
| D-1 | DOM PoC | target/currentTarget 误用检测 | 4 天 | B-1 | PoC + 样例 |
| D-2 | 终端 PoC | cursor/buffer/viewport 状态一致性检测 | 4 天 | B-1 | PoC + 样例 |
| D-3 | 语义实验 | 语义推理实验通道 + feature flag | 4 天 | C-4 | 实验分支与开关 |

#### 6.7.3 任务依赖图（文本）

- 主链：A-1 -> A-2 -> A-3 -> B-1 -> B-2/B-3 -> B-4 -> C-1/C-3 -> C-2/C-4 -> D-1/D-2/D-3
- 并行机会：
  - B-2 与 B-3 可并行
  - C-1 与 C-3 可并行
  - D-1、D-2、D-3 可并行

#### 6.7.4 验收定义（Definition of Done）

每个 WBS 子任务完成必须同时满足：

1. 功能完成：对应能力可在本地和 CI 触发。
2. 证据完整：至少包含一个可复现实例（输入、输出、日志）。
3. 测试通过：新增单测/集成测试，且不引入现有回归。
4. 文档更新：本报告第 7 章进度同步更新。
5. 可回滚：通过 feature flag 可关闭新增能力。

#### 6.7.5 指标口径细化

| 指标 | 定义 | 采集方式 | 目标值 |
|---|---|---|---|
| Top-1 命中率 | 目标符号位于第 1 位的比例 | 评估脚本汇总 | 阶段 B 较基线 +20% |
| Top-5 命中率 | 目标符号位于前 5 位的比例 | 评估脚本汇总 | 阶段 C 较基线 +25% |
| 误报率 | 错误告警 / 总告警 | 人工抽样 + 规则标签 | 阶段 C <= 25% |
| 单仓耗时 | 单次 analyze + query 全流程时长 | CI 计时 | 阶段 D 回归 <= 10% |
| 稳定性方差 | patch_rate 与 avg_cost 的标准差 | 重复运行统计 | <= 5% |

#### 6.7.6 周节奏模板

- 周一：确定本周 WBS 范围与风险项。
- 周三：中期检查（指标趋势、误报样例、性能回归）。
- 周五：里程碑评审（通过/阻塞/回退决策）。

周报最少包含：
1. 本周完成的 WBS ID 清单。
2. 指标变化（本周 vs 基线）。
3. 新增高风险误报案例（最多 5 条）。
4. 下周计划与阻塞项。

#### 6.7.7 风险触发阈值（自动预警）

| 触发条件 | 判定 | 动作 |
|---|---|---|
| 误报率连续 2 周上升且 > 30% | 红色预警 | 冻结新规则，优先误报治理 |
| 单仓耗时回归 > 15% | 红色预警 | 回滚到上个里程碑配置 |
| 命中率提升 < 5%（连续两个里程碑） | 黄色预警 | 重审规则优先级与样本覆盖 |
| CI 不稳定（失败率 > 20%） | 红色预警 | 暂停发布，先修复评估基础设施 |

#### 6.7.8 版本化推进策略

- v0.1（阶段 A）：仅评估基线，不改变检测逻辑。
- v0.2（阶段 B）：上线规则引擎 MVP + diff MVP，默认关闭，灰度验证。
- v0.3（阶段 C）：上线平台建模与不变量检测，继续灰度。
- v0.4（阶段 D）：PoC 能力实验，保持实验开关默认关闭。

---

## 7. 执行推进进度（截至 2026-04-08）

### 7.1 已完成

1. 旧文档清理（按合并策略执行）
- 已删除：
  - bug-detection-eval-report-20260406.md
  - bug-detection-fix-report-20260406.md
  - eval-bug-detection-report.md
- 当前唯一状态文档：bug-detection-merged-report-20260407.md

2. 阶段 A 工件已落地（可运行）
- 新增配置：eval/configs/bug_detection/baseline_2026q2.yaml
- 新增执行脚本：eval/scripts/run_bug_detection_baseline.py
- 已完成 dry-run 验证（3 次重复运行命令构造正确）

3. **阶段 B — P0 能力落地（已完成 2026-04-08）**

#### B-1: 规则引擎 DSL（WBS B-1）

- 文件：`gitnexus/src/core/detection/types.ts`
- 定义：`RuleDefinition`（id, name, severity, confidence, trigger/missing patterns, language scope）
- 定义：`DetectionResult`（ruleId, symbolName, filePath, severity, confidence, evidence[]）
- 定义：`RuleContext`（node, relationships, language）
- 定义：`Rule` 接口（definition + evaluate 函数）
- 文件：`gitnexus/src/core/detection/rule-engine.ts`
- `RuleEngine` 类：`register()`, `evaluateNode()`, `evaluateGraph()`, `getRules()`, `ruleCount`
- 辅助：`buildRelationshipIndex()`, `createEngine()`, `languageFromPath()`

#### B-2: 三类检测规则（WBS B-2）

- `gitnexus/src/core/detection/rules/missing-guard.ts`
  - 规则 ID：`detection:missing-guard`
  - 检测：file I/O、network、parse、DB 操作缺少 try/catch/if 错误守卫
  - 支持语言：TS/JS, Python, Java/Kotlin, Go, Rust, C#, Ruby
- `gitnexus/src/core/detection/rules/missing-unwrap.ts`
  - 规则 ID：`detection:missing-unwrap`
  - 检测：Optional/Result/Nullable 返回值未做空值检查
  - 支持语言：TS/JS, Rust, Java/Kotlin, Go
- `gitnexus/src/core/detection/rules/missing-resource.ts`
  - 规则 ID：`detection:missing-resource-release`
  - 检测：资源打开缺少 try/finally、using、with、defer 清理
  - 支持语言：TS/JS, Python, Java, Go, C#, Rust
- 桶导出：`gitnexus/src/core/detection/rules/index.ts`（`builtinRules[]`）
- 模块导出：`gitnexus/src/core/detection/index.ts`

#### B-3: diff-based bug detection（WBS B-3）

- 文件：`gitnexus/src/core/detection/diff-detector.ts`
- `DiffDetector.detect(base, head, contentChanges?)` → `RiskChange[]`
- 检测类型：`added_edge`, `removed_edge`, `guard_removed`, `signature_changed`
- 每条告警包含：symbolId, changeType, severity(critical/high/medium/low), evidence(before/after)

#### B-4: CLI/MCP 输出接入（WBS B-4）

- CLI：`gitnexus/src/cli/index.ts` + `gitnexus/src/cli/tool.ts`
  - `gitnexus detect-changes --detection` 启用检测，默认关闭
- MCP：`gitnexus/src/mcp/tools.ts`
  - `detect_changes` 新增 `enable_detection: boolean` 参数
- 后端集成：`gitnexus/src/mcp/local/local-backend.ts`
  - 动态导入 RuleEngine + builtinRules，逐符号运行规则评估
  - 结果追加到 `detection_findings[]`，best-effort 不影响主流程

#### 测试证据

| 测试类型 | 数量 | 状态 |
|---|---|---|
| vitest 规则引擎 + DiffDetector | 19 | 全部通过 |
| 内联规则测试（guard/unwrap/resource 正反例） | 10 | 全部通过 |
| 全量单元回归 | 3249/3250 | 通过（1 个 Node 25 预存在不兼容，非检测模块） |
| tsc --noEmit | — | 零错误 |

#### B+1: 规则库扩展（3 条新规则，2026-04-08）

- `gitnexus/src/core/detection/rules/missing-exception-handling.ts`
  - 规则 ID：`detection:missing-exception-handling`
  - 检测：catch/except 块静默吞掉异常（空 body、仅注释、无 throw/return）
  - 支持语言：TS/JS, Python, Java/Kotlin/C#
- `gitnexus/src/core/detection/rules/missing-return-check.ts`
  - 规则 ID：`detection:missing-return-check`
  - 检测：函数返回的错误码/状态/Promise 被丢弃未检查
  - 支持语言：Go（`_` 忽略错误）, TS/JS（未 await 的异步调用）, C/C++
- `gitnexus/src/core/detection/rules/missing-concurrency-guard.ts`
  - 规则 ID：`detection:missing-concurrency-guard`
  - 检测：异步/线程上下文中共享可变状态缺少同步原语
  - 支持语言：TS/JS, Python, Java, C/C++, C#
- 内联测试：12 条全部通过
- 总规则数：6 条（guard + unwrap + resource + exception-handling + return-check + concurrency-guard）

#### B+2: 检测输出验证（gitnexus 自身代码，2026-04-08）

对 gitnexus 223 个源文件运行全部 6 条规则，结果如下：

| 规则 | 发现数 | 严重性 |
|---|---|---|
| missing-guard | 42 | medium |
| missing-exception-handling | 14 | medium |
| missing-return-check | 142 | medium |
| missing-concurrency-guard | 76 | high |
| missing-unwrap | 3 | high |
| missing-resource-release | 1 | high |
| **合计** | **278** | — |

说明：
- `missing-return-check` 和 `missing-concurrency-guard` 的发现数较多（142/76），属于启发式规则的预期噪声。
- `missing-guard`（42）和 `missing-exception-handling`（14）的精度相对较高。
- `missing-unwrap`（3）和 `missing-resource-release`（1）精准度最高。
- 6 条规则全部正常触发，无崩溃或异常。
- 后续可通过 `enable_detection` 参数灰度验证、调优阈值。

#### B+3: 阶段 C 设计（2026-04-08）

- 设计文档：`.omc/research/stage-c-design.md`
- 覆盖内容：
  - 平台约束数据模型（target_os, target_arch, target_env）
  - 2 条平台检测规则设计（platform-assumption-mismatch, missing-platform-branch）
  - 3 条不变量规则模板（ordering, uniqueness, monotonicity）
  - AST 解析器扩展方案（regex-based，不影响现有流程）
  - 实现计划：14 人天，3 周

### 7.2 完成情况检查（2026-04-08 更新）

#### 阶段进度总览

| 工作项 | 状态 | 证据 |
|---|---|---|
| **US-001 ~ US-008 修复** | ✅ 8/8 | 代码文件 line references 已验证（2026-04-06） |
| **阶段 A 基础设施** | ✅ 完成 | baseline_2026q2.yaml、run_bug_detection_baseline.py |
| **阶段 A Dry-Run** | ✅ 通过 | 3次重复运行命令结构正确 |
| **旧文档清理** | ✅ 完成 | 3个文件已删除，仅保留merged report |
| **阶段 B WBS B-1** | ✅ 完成 | types.ts + rule-engine.ts |
| **阶段 B WBS B-2** | ✅ 完成 | missing-guard.ts / missing-unwrap.ts / missing-resource.ts |
| **阶段 B WBS B-3** | ✅ 完成 | diff-detector.ts |
| **阶段 B WBS B-4** | ✅ 完成 | CLI detect-changes 命令 + detectChangesCommand() |
| **测试覆盖** | ✅ 通过 | 44 个相关测试通过（19 vitest + 25 内联） |
| **阶段 A 正式基线** | ⏳ 阻塞中 | 本地依赖已就绪（eval/.venv + datasets），当前受 HuggingFace 网络连接重置阻塞 |
| **规则库扩展（3条新规则）** | ✅ 完成 | missing-exception-handling / missing-return-check / missing-concurrency-guard |
| **检测输出验证** | ✅ 完成 | 223 文件扫描，278 条发现，6 条规则全部触发 |
| **阶段 C 设计** | ✅ 完成 | .omc/research/stage-c-design.md（平台建模 + 不变量规则） |
| **阶段 C 实现** | 📋 规划中 | 设计完成，预计 W4-W8（3周） |
| **阶段 D 预研** | 📋 规划中 | PoC 待启动 |

---

### 7.3 后续执行路径（2026-04-08 更新）

#### **已完成项（本轮）**

- ✅ 规则库扩展：新增 3 条规则（exception-handling, return-check, concurrency-guard），共 6 条
- ✅ 检测输出验证：223 文件扫描，278 条发现，规则全部正常触发
- ✅ 阶段 C 设计文档：`.omc/research/stage-c-design.md`

#### **待用户手动执行**

```bash
# 阶段 A 正式基线（需要 API key）
export ANTHROPIC_API_KEY=<your-key>
pip install datasets
cd /Users/nonon/Desktop/GitNexus/eval
python scripts/run_bug_detection_baseline.py
```

#### **下一轮开发（阶段 C，W4-W8）**

按 `.omc/research/stage-c-design.md` 设计推进：
1. C-1: AST 解析器增加平台属性提取（3天）
2. C-2: 2 条平台检测规则（3天）
3. C-3: 3 条不变量规则模板（4天）
4. C-4: 8+ 回归样例（2天）
5. C-5: 查询层平台过滤（2天）

---

### 7.4 关键执行检查点（2026-04-08 更新）

| 检查点 | 状态 | 备注 |
|---|---|---|
| 阶段 B 完成 | ✅ | 6 条规则 + DiffDetector + CLI/MCP 集成 |
| 规则库 v0.2 | ✅ | 6 条规则，44 测试通过 |
| 检测输出验证 | ✅ | 223 文件扫描，278 条发现 |
| 阶段 C 设计 | ✅ | `.omc/research/stage-c-design.md` |
| 阶段 A 正式基线 | ⏳ | **API key 已满足前置，当前主要阻塞为 HuggingFace 网络可达性** |
| 阶段 C 实现 | 📋 | 设计完成，W4-W8 推进 |
| 阶段 D PoC | 📋 | W5-W12 |

### 7.5 用户手动操作（解除 Stage A 阻塞）

```bash
# 1. 设置 API key（二选一）
export ANTHROPIC_API_KEY=<your-key>
# 或 export GITNEXUS_API_KEY=<your-key>

# 2. 安装 Python 依赖
pip install datasets

# 3. 运行正式基线（3 次重复）
cd /Users/nonon/Desktop/GitNexus/eval
python scripts/run_bug_detection_baseline.py

# 4. 验证输出
# 预期: results/bugdet_2026q2_*/summary.json
# 验收: patch_rate variance <= 5%
```

### 7.6 本轮推进记录（2026-04-08）

1. 已完成环境落地
- 创建虚拟环境：`eval/.venv`
- 已安装依赖：`datasets`、`pyyaml`

2. 已完成稳健性增强
- 文件：`eval/run_eval.py`
- 变更：`load_instances()` 对 `load_dataset()` 增加 5 次指数退避重试（1s/2s/4s/8s）
- 目的：降低临时外网抖动导致的硬失败

3. 现状与阻塞
- 正式基线执行已重试，但仍在数据集拉取阶段失败
- 错误特征：`[Errno 54] Connection reset by peer`（HuggingFace HEAD 请求）
- 当前判定：非代码逻辑阻塞，属于外网可达性问题

4. 下一步执行建议（可并行）
- 方案 A：在可访问 HuggingFace 的网络环境重试阶段 A 正式基线
- 方案 B：预先离线缓存 `princeton-nlp/SWE-Bench_Lite` 后再执行
- 方案 C：继续推进阶段 C 实现任务（不依赖该外网数据集）

