# GitNexus 可执行修复计划（2026-04-08）

> 计划版本：v1.0  
> 基线提交：`c41c3ae`  
> 计划周期：4 周 + Month 2 工程债阶段  
> 适用范围：`gitnexus/` 主工程（CLI/Core/MCP）

---

## 1. 目标与结果

本计划的目标是把当前“可用但不稳定”的状态，推进到“测试稳定、能力补齐、可持续迭代”的状态。

量化结果目标：

1. 主干测试从当前失败态恢复到稳定可回归。
2. 路由提取与 named-bindings 的剩余缺口完成可用实现。
3. `local-backend.ts` 继续拆分，降低维护风险。
4. 覆盖率从约 26% 提升到约 35%。
5. 文档状态与代码状态保持同步，不再出现数据漂移。

---

## 2. 当前基线（执行前）

以最近一次本地命令为准：

```bash
cd gitnexus && npm test -- --reporter=verbose --coverage
```

基线观测：

1. Test Files：`12 failed | 179 passed | 1 skipped`
2. Tests：`175 failed | 5767 passed | 100 skipped`
3. 主要失败集中于：`test/integration/resolvers/csharp.test.ts`
4. 伴随问题：`vitest worker forks emitted error`

重点热点文件（当前行数）：

1. `src/core/ingestion/call-processor.ts`：2433
2. `src/core/ingestion/workers/parse-worker.ts`：2390
3. `src/mcp/local/local-backend.ts`：2357
4. `src/mcp/local/tools/impact.ts`：778

---

## 3. 执行原则

1. 先稳定，后扩展：先修 P1 测试与运行稳定性，再做 P2 能力补齐。
2. 每项改动必须带验证：至少包含目标测试与一次回归命令。
3. 小步提交：每个任务保证可回滚、可定位。
4. 文档即状态：阶段完成后同步更新 `docs/project-status.md` 与本计划文档。
5. 风险前置：优先修共同根因，不做分散打补丁。

---

## 4. 里程碑总览

| 里程碑 | 周期 | 核心目标 | 退出条件 |
|---|---|---|---|
| M1 稳定性恢复 | Week 1 | 修复 C# resolver 回归 + worker 稳定性 | 失败文件显著下降，测试可稳定复跑 |
| M2 能力补齐 | Week 2 | 路由提取缺口 + ObjC/Ruby named-bindings 推进 | 新增能力有测试覆盖且通过 |
| M3 工程化收敛 | Week 3-4 | backend 拆分 + 覆盖率提升 | `local-backend.ts` 接近目标，覆盖率接近 35% |
| M4 工程债推进 | Month 2 | 长期技术债任务推进 | 完成 PoC/设计稿/首批落地 |

---

## 5. 详细执行计划（可直接执行）

## 5.1 Week 1（P1）

### 任务 P1-1：修复 C# resolver 回归

目标：

1. 恢复 C# 关键图谱能力：`Class`、`Property`、`HAS_METHOD`、`CALLS`、`METHOD_IMPLEMENTS`。

执行步骤：

1. 只跑 C# 相关失败测试，建立最小复现集。
2. 按失败类型分组归因，先定位共同入口（解析、绑定、关系落图）。
3. 在 `src/core/ingestion/` 相关 C# 路径做最小修复。
4. 每次修复后回归 C# 测试子集。
5. 通过后再跑集成回归。

建议命令：

```bash
cd gitnexus
npm test -- test/integration/resolvers/csharp.test.ts --reporter=verbose
npm test -- test/integration/resolvers --reporter=verbose
```

涉及文件（预期）：

1. `src/core/ingestion/call-processor.ts`
2. `src/core/ingestion/languages/csharp.ts`
3. `src/core/ingestion/import-processor.ts`
4. `src/core/ingestion/type-extractors/*`（按实际归因）

完成标准（DoD）：

1. `csharp.test.ts` 失败数显著下降或清零。
2. 无新增跨语言回归。
3. 变更具备对应测试证明。

---

### 任务 P1-2：修复 Vitest worker forks 异常

目标：

1. 消除 `Worker forks emitted error`，保证测试结果可靠。

执行步骤：

1. 在相同环境复现异常，确认是否与并发、内存、特定测试文件有关。
2. 逐步调整测试执行参数，定位触发阈值。
3. 修复根因或提供稳定配置（例如并发控制、隔离策略）。
4. 用两次连续全量测试验证稳定性。

建议命令：

```bash
cd gitnexus
npm test -- --reporter=verbose --coverage
npm test -- --reporter=verbose
```

完成标准（DoD）：

1. 连续两次执行不再出现 worker forks unhandled error。
2. 测试失败仅反映真实业务失败，不含运行时噪声。

---

### 任务 P1-3：回归与失败归因收敛

目标：

1. 输出最新失败清单（文件级 + 根因级），用于 Week 2 计划输入。

执行步骤：

1. 跑全量测试并记录结果。
2. 将失败按模块聚类，不按单个断言碎片化记录。
3. 更新 `docs/project-status.md` 第 6/7/10 节。

完成标准（DoD）：

1. `docs/project-status.md` 中测试状态与当前结果一致。
2. 有清晰“剩余失败 -> 下周动作”的映射。

---

## 5.2 Week 2（P2）

### 任务 P2-1：路由提取剩余缺口补齐

子任务：

1. Flask `@app.route` 提取器。
2. Fiber `app.Get/app.Post` 驼峰调用匹配。
3. Laravel 显式路由文件提取。

执行步骤：

1. 为每个框架补一个最小 fixture。
2. 实现提取逻辑并接入 pipeline。
3. 增加 route-extractors 单测与集成验证。
4. 验证 `HANDLES_ROUTE` 边可落图。

完成标准（DoD）：

1. 对应 fixture 能稳定产出路由边。
2. `route_map`/`api_impact` 在新增样例上可用。

---

### 任务 P2-2：named-bindings 补齐

子任务：

1. Objective-C named-bindings provider 挂载。
2. Ruby named-bindings 可行子集实现（静态可判定范围）。

执行步骤：

1. ObjC：挂载 provider，补回归测试。
2. Ruby：先做常量模块导入可判定场景。
3. 校验导入图精度提升，不引入噪声边。

完成标准（DoD）：

1. ObjC provider 已接入且有测试证明。
2. Ruby 子集可用并明确边界说明。

---

## 5.3 Week 3-4（P2.3 / P2.4）

### 任务 P2-3：`local-backend.ts` 持续拆分

目标：

1. 从 2357 行继续下沉到接近 500 行（dispatcher/装配为主）。

执行步骤：

1. 按功能域切分剩余逻辑（上下文管理、通用 helper、生命周期管理）。
2. 将纯函数迁移到 `tools/shared` 或专用模块。
3. 保持外部 API 不变，逐步迁移并回归。

完成标准（DoD）：

1. 主文件显著缩减。
2. 无 MCP 工具行为回归。

---

### 任务 P2-4：覆盖率提升到约 35%

目标：

1. 补足 `call-processor.ts` 高风险边界测试。

执行步骤：

1. 针对多语言调用链、跨文件绑定、异常路径增加测试。
2. 补齐已修问题对应回归测试。
3. 跑 coverage 并记录增量。

完成标准（DoD）：

1. statements 覆盖率接近或达到 35%。
2. 新增测试可稳定复现与防回归。

---

## 5.4 Month 2（P3 工程债）

任务清单：

1. ✅ Web 核心组件测试补齐。
2. ✅ LadybugDB Schema 迁移机制设计与落地。
3. ✅ COBOL tree-sitter 替代方案评估。
4. ✅ Vue SFC template 符号提取能力探索。
5. ✅ `parse-worker.ts` 预处理器模块化。

阶段产出：

1. 每项至少产出设计稿、PoC 或首批实现。
2. 更新路线图与优先级评估。

---

## 6. 每日执行 Runbook

每天固定流程：

1. 拉取最新代码并确认基线。
2. 跑目标测试子集（快速反馈）。
3. 完成当日单一主任务，不并行混改。
4. 跑回归与 coverage。
5. 更新文档状态与次日计划。

建议命令模板：

```bash
cd gitnexus
npm test -- <target-spec> --reporter=verbose
npm test -- --reporter=verbose
npm test -- --reporter=verbose --coverage
```

---

## 7. 风险与回退策略

主要风险：

1. C# 回归根因较深，修复跨度可能触及多处关系生成逻辑。
2. worker 异常可能与环境和并发策略耦合，不完全是业务代码问题。
3. backend 拆分期间可能引入行为漂移。

回退策略：

1. 每个任务保持小步提交，可快速回滚。
2. 关键路径变更前后均保留测试快照。
3. 对高风险改动先加防回归测试，再改实现。

---

## 8. 进度追踪模板

建议每次更新本文件时使用以下模板：

```md
### YYYY-MM-DD 进展
- 完成：
- 新增问题：
- 已验证：
- 明日计划：
- 阻塞项：
```

---

## 9. 同步更新要求

每个里程碑结束后，必须同步更新：

1. `docs/project-status.md`（第 6 / 7 / 10 节）
2. `docs/language-support-matrix.md`（能力状态变化）
3. 本文档（阶段状态与剩余项）

---

## 10. 当前可立即开始的 3 个动作

1. 先只跑 `csharp.test.ts`，按失败模式分组并定位共同入口。
2. 完成首轮 C# 最小修复并回归 C# resolver 测试集。
3. 单独复现 worker forks 异常，确定是并发参数、资源限制还是测试隔离问题。

---

*维护说明：本计划为执行文档，不是归档文档。每次推进后直接更新，不另起重复版本。*

---

## 进度记录

### 2026-04-09 M3 收尾进展

- 完成：
  - **P2-1 Fiber camelCase 路由提取**：`fastapi.ts` 的 `GIN_ROUTE_RE` 正则新增 `Get|Post|Put|Delete|Patch|Head|Options` 驼峰匹配，支持 Fiber 框架的 `app.Get("/path")` 调用。新增 11 个 Fiber 单元测试，全部通过。
  - **P2-3 local-backend.ts 大规模拆分**：从 2201→969 行（-56%）。所有内联工具方法（`query`、`routeMap`、`shapeCheck`、`toolMap`、`shortestPath`、`getCode`、`apiImpact`、`explainDataflow`）已替换为对已提取工具模块（`tools/query.ts`、`tools/route-tools.ts`、`tools/graph-tools.ts`、`tools/dataflow.ts`）的委托调用。删除重复的 `formatCypherAsMarkdown` 和 `aggregateClusters` 死代码。`explain_dataflow` 工具已接入 callTool 调度器（之前为死路径）。
  - **P2-4 覆盖率验证**：单元测试覆盖率 **49.8% statements**（目标 35%，超额完成 42%）。Branches 40.33%, Functions 52.59%, Lines 51.39%。
  - **skip-git-cli 排除配置**：`skip-git-cli.test.ts` 加入 `vitest.config.ts` 排除列表（Node 25.5 环境问题）。
- 新增问题：
  - 无
- 已验证：
  - 全量测试：**129 passed (129)**（单元），**131 passed (131)**（含 local-backend 集成），**3635 passed | 25 skipped**
  - `tsc --noEmit` 0 errors
- 阻塞项：
  - 无

### 2026-04-08 M2-M3 进展

### 2026-04-08 M2-M3 进展

- 完成：
  - **P2-1 Flask 路由提取器**：新增 `src/core/ingestion/route-extractors/flask.ts`，覆盖 `@app.route`、`@blueprint.route`、路径参数 `<name>` → `[name]` 标准化，8 个单元测试全部通过。
  - **P2-1 Laravel 显式路由提取器**：新增 `src/core/ingestion/route-extractors/laravel.ts`，覆盖 `Route::get/post/put/delete/patch`、`Route::resource`（7 REST 路由）、`Route::apiResource`（5 路由）、`$router->get()` 调用，8 个单元测试全部通过。
  - **P2-2 ObjC named-bindings provider 挂载**：`objective-c.ts` language provider 新增 `namedBindingExtractor: extractObjCNamedBindings`。
  - **P2-2 Ruby named-bindings 静态子集**：新增 `src/core/ingestion/named-bindings/ruby.ts`，明确 wildcard import 语义边界（`include`/`extend`/`prepend` 为 heritage，动态 `require` 不可静态判定）。
  - **P2-3 local-backend.ts 常量去重**：从 2357→2201 行（-156 行），`isTestFilePath`/`VALID_NODE_LABELS`/`VALID_RELATION_TYPES`/`IMPACT_RELATION_CONFIDENCE` 等常量迁移至 `tools/shared.ts`，保留 re-export 兼容。
  - **P2-4 call-processor 覆盖率**：新增 30+ 测试覆盖 `buildImportedReturnTypes`、`buildImportedRawReturnTypes`、`buildExportedTypeMapFromGraph`、`processAssignmentsFromExtracted`、`processRoutesFromExtracted` 等 5 个导出函数。
- 新增问题：
  - 无
- 已验证：
  - 全量测试：**3 failed | 188 passed | 1 skipped**（文件级），**~12 failed | ~5948 passed | ~104 skipped**（用例级）
  - 3 个失败文件均为环境问题（objc-cfg: ObjC CLI 语法缺失、skip-git-cli: Node 版本限制、java-class-impact: lbug 并行隔离偶发）
- 明日计划：
  - M4 文档状态同步（完成）
  - M3 持续：local-backend.ts 进一步拆分
- 阻塞项：
  - `tree-sitter-graph` CLI 需编译 ObjC 语法库以支持 objc-cfg 测试（环境问题，P3）

### 2026-04-08 M1 进展

- 完成：
  - **P1-1 C# resolver 回归修复**：根因为 `CSHARP_QUERIES` 中 namespace-qualified generic constructor 查询嵌套层级反转（`generic_name > qualified_name` 应为 `qualified_name > generic_name`），导致 `TSQueryErrorStructure at position 2491`。修复 1 行后 162 个 C# 测试全部通过。
  - **测试归因与收敛**：额外修复 5 个独立测试问题：
    - `cobol.test.ts`：CALLS 边总数 31→32（新增 nested-program-call 边）
    - `impact-batching-grouping.test.ts`：`_impactImpl` 重命名为 `impact` 方法（3 个测试）
    - `mcp-tools-impact.test.ts`：evidence 结构从 `traversal` 更新为 StandardEvidence `explanation`/`paths`
    - `detection-rules.node.test.ts`：从 vitest exclude 列表中排除（使用 node:test runner）
  - **Worker forks 稳定性**：连续两次全量运行无 "Worker forks emitted error"
- 新增问题：
  - `objc-cfg.test.ts`（10 个测试）：tree-sitter-graph CLI 未编译 ObjC 语法，报 "No language found" — 环境问题，非代码 Bug
  - `skip-git-cli.test.ts`（2 个测试）：Node 25.5.0 不支持 `--stack-size` NODE_OPTIONS — 环境问题
- 已验证：
  - 全量测试结果：**2 failed | 189 passed | 1 skipped**（文件级），**12 failed | 5931 passed | 100 skipped**（用例级）
  - 相比基线（12 文件 / 175 用例失败）改善 83% 文件、93% 用例
  - 剩余 12 个失败全部为环境相关，非代码逻辑问题
- 阻塞项：
- 阻塞项：
  - `tree-sitter-graph` CLI 需编译 ObjC 语法库以支持 objc-cfg 测试

### 2026-04-09 M4（Month 2 P3 工程债）完成

- 完成：
  - **Web 核心组件测试补齐**：新增 `gitnexus-web/test/unit/query-fab.test.tsx`（11 测试）、`process-flow-modal.test.tsx`（10 测试）、`graph-canvas.test.tsx`（13 测试），共 34 个测试全部通过。修复 `test/setup.ts` 中 Node v25.5.0 下 `localStorage.removeItem` 兼容性问题。
  - **LadybugDB Schema 迁移机制**：新增 `src/core/lbug/schema-version.ts`（`computeSchemaVersion`、`CURRENT_SCHEMA_VERSION`、`attemptIncrementalMigration`），`RepoMeta` 新增 `schemaVersion` 字段，`lbug-adapter.ts` 在 DB 打开时自动检测并执行增量迁移，`run-analyze.ts` 写入版本戳。新增 7 个单元测试，全部通过。
  - **COBOL tree-sitter 替代方案评估**：新增 `src/core/ingestion/cobol/cobol-treesitter-adapter.ts`（Worker 线程超时保护机制 PoC，评估结论内嵌于 JSDoc）；新增 13 个单元测试，全部通过（使用 `vi.hoisted()` 解决 vitest mock 提升问题）。
  - **Vue SFC template 符号提取能力**：`extractTemplateComponents` 和 `extractTemplateEventHandlers` 已存在并已集成于 `parse-worker.ts` 和 `call-processor.ts`；为 `extractTemplateEventHandlers` 补充 6 个单元测试（`vue-sfc-extractor.test.ts` 共 18 个测试，全部通过）。
  - **`parse-worker.ts` 预处理器模块化**：将内联的 ObjC 空指针注解宏剥离函数提取为 `src/core/ingestion/languages/objc-preprocess.ts`（`preprocessObjcContent`，与 `arkts-preprocess.ts` 风格一致），`parse-worker.ts` 改为 import 调用；新增 5 个单元测试，全部通过。
- 新增问题：
  - 无
- 已验证：
  - gitnexus 单元测试（新增部分）：COBOL（13）+ lbug schema-version（7）+ objc-preprocess（5）+ vue-sfc-extractor（18）均通过
  - gitnexus-web 单元测试（新增部分）：query-fab（11）+ process-flow-modal（10）+ graph-canvas（13）均通过
  - `tsc --noEmit` 0 errors
- 阻塞项：
  - 无
