# GitNexus 功能缺口评估报告

> 最后更新：2026-04-08 · 基于 commit `b57da45` (main)

---

## 一、已完成项（截至本次评估）

| 原问题 | 完成 commit | 状态 |
|--------|------------|------|
| `local-backend.ts` God Object（4,187 行） | `b57da45` | ✅ 拆分为 11 个工具模块，主文件降至 2,357 行 |
| Dataflow 模块（`index.ts` 为空 stub） | `91f2d08` | ✅ 完整恢复（cfg-builder / dfa-engine / taint-engine / path-sensitive 等） |
| Bug 检测规则引擎缺失 | `f3ad103` | ✅ 6 条规则 + diff-detector 落地（`src/core/detection/`） |
| C/C++/ObjC `#include`/`#import` 无 IMPORTS 边 | `53df277` | ✅ 已通过 `standard.ts` 的 `resolveCImport`/`resolveCppImport` 实现，含集成测试 |
| ArkTS `.ets` 跨文件 IMPORTS 边解析 Bug | `2de882c` | ✅ 修复 `import-resolvers/utils.ts` 中 `.ets` 扩展名缺失，8 个集成测试全通过 |
| MCP tools 单元测试缺失 | `b57da45` | ✅ 新增 `mcp-tools-shared.test.ts`（16 tests）+ `mcp-tools-overview.test.ts`（19 tests）|

---

## 二、当前缺口（优先级排序）

### 🔴 P1 — 高优先级（影响核心质量/CI 稳定性）

#### P1.1 — Node v24 `--stack-size` 兼容性导致 CI 失败

- **现象**：`test/integration/cli-e2e.test.ts` 和 `test/integration/skills-e2e.test.ts` 中共 36 个测试失败
- **根因**：`analyze.ts` 通过 `NODE_OPTIONS` 注入 `--stack-size=16384`，在 Node v24 下被运行时 ban 掉（exit code 9）
- **影响**：CI 红色，单元测试计数被噪音污染
- **方案**：在 `analyze.ts` 中检测 Node 版本，Node ≥ 22 改用 `--max-old-space-size` 或去除注入；约 0.5 天

#### P1.2 — 测试覆盖率偏低，工具模块无专属单元测试

- **现象**：覆盖率阈值仅 26% statements（auto-ratchet floor），拆分后新增的 `tools/impact.ts`（728 行）、`tools/context.ts`（495 行）、`tools/query.ts`（429 行）无专属单元测试
- **影响**：MCP 核心工具（impact 爆破半径分析、context 符号视图）回归风险高
- **方案**：
  1. 为 `tools/impact.ts` 的 `runImpactBFS` 逻辑写单元测试（mock LadybugDB）
  2. 为 `tools/context.ts` 的 caller/callee 组装逻辑写单元测试
  3. 补充 `call-processor.ts`（2,411 行）边界输入测试
  4. 目标：statements 覆盖率从 26% 提升至 35%；约 3~4 天

---

### 🟡 P2 — 中优先级（扩展分析深度/语言覆盖）

#### P2.1 — Java / Go Dataflow DSL 规则缺失

- **现象**：`dataflow/dsl/` 仅有 `typescript-static-edges.sg`、`javascript-static-edges.sg`、`python-static-edges.sg`
- **影响**：Java/Go 是企业最常见语言，无 DSL 意味着 `TAINTED`/`DATA_FLOW` 边在这两种语言中完全不生成，`explain_dataflow` MCP 工具在 Java/Go 项目中无效
- **方案**：参照 `typescript-static-edges.sg` 结构定义 source/sink/sanitizer 节点模式，按 Java → Go → Rust 顺序，每种语言约 2~3 天

#### P2.2 — 路由提取覆盖仅 Next.js/Expo（`HANDLES_ROUTE` 边）

- **现象**：Django / Spring / Rails / Flask / Gin 等框架虽已被 `framework-detection.ts` 识别，但不生成结构化 `HANDLES_ROUTE` 边
- **影响**：`route_map` MCP 工具在 Python/Java/Ruby/Go 项目中返回空结果，`api_impact` 工具覆盖受限
- **方案**：
  1. Python Django：扫描 `urls.py` 的 `path()`/`re_path()` 调用，生成 `HANDLES_ROUTE` 边
  2. Java Spring Boot：扫描 `@RequestMapping`/`@GetMapping` 等注解，提取 URL 模式
  3. 每个框架约 2 天

#### P2.3 — 安全类 taint-based 检测规则缺失

- **现象**：现有 6 条规则均为"缺失防御模式"型（`missing-guard`、`missing-unwrap` 等），无主动 Source→Sink 安全类规则
- **影响**：taint-engine 已具备完整能力，但无 SQL 注入/XSS/路径穿越等规则，`explain_dataflow` 工具的安全价值未充分发挥
- **方案**：在 `detection/rules/` 新增 3 条 taint-based 规则：
  - `sql-injection.ts`：DB query source + 用户输入
  - `xss-sink.ts`：DOM 写入 / `dangerouslySetInnerHTML`
  - `path-traversal.ts`：`fs.readFile`/`open` + 用户输入路径
  - 约 3~5 天

#### P2.4 — `local-backend.ts` 仍有 2,357 行

- **现象**：拆分后工具逻辑已外移，但仍残留大量辅助函数和共享状态管理代码
- **方案**：继续将状态初始化、生命周期管理抽到 `LocalBackendCore`，目标 ≤ 500 行纯 dispatcher；约 2 天

---

### 🟢 P3 — 低优先级（工程债务 / 长期改善）

| 项 | 描述 | 预估工作量 |
|----|------|:---------:|
| Web UI 核心组件单元测试 | 24 个组件，`GraphCanvas`/`ProcessFlowModal`/`QueryFAB` 无组件级测试 | 2~3 天 |
| Objective-C Method Extractor | 无 `HAS_METHOD` 边，OC 方法调用图不完整 | 2 天 |
| COBOL 迁移 tree-sitter | 现有 regex 处理器 3,700+ 行，可评估 `tree-sitter-cobol` | 1~2 周 |
| LadybugDB Schema 迁移机制 | 新增节点/边类型需 clean + 重建，无版本化迁移 | 3~5 天 |
| Vue SFC 模板层符号提取 | 仅解析 `<script>` 块，`<template>` 中组件引用无法入图 | 3~5 天 |
| `parse-worker.ts` 预处理器模块化 | ArkTS/ObjC 预处理逻辑内联在 2,380 行 worker 中 | 2~3 天 |
| Named Bindings 扩展（Go/Ruby/Swift/Dart） | 当前为 `wildcard` 语义，精度低于 `named` | 每语言 1~2 天 |

---

## 三、执行计划

```
Week 1（P1 清零）
  ├── D1~D2: 修复 Node v24 --stack-size 兼容问题
  │          → cli-e2e + skills-e2e 36 个失败归零，CI 恢复绿色
  └── D3~D5: tools/impact.ts + tools/context.ts 单元测试
             → 覆盖率目标 ≥ 33% statements

Week 2（P2.1 Java DSL）
  ├── D1~D3: java-static-edges.sg（数据流 DSL）
  └── D4~D5: call-processor 边界测试 + 覆盖率巩固

Week 3~4（P2.2/P2.3）
  ├── Django 路由提取（urls.py → HANDLES_ROUTE）
  ├── Spring Boot 路由提取（@RequestMapping → HANDLES_ROUTE）
  └── sql-injection / xss / path-traversal 安全检测规则

Month 2（P3 工程债务）
  ├── Web UI GraphCanvas/ProcessFlowModal 组件测试
  ├── local-backend.ts 减至 ≤500 行
  └── Schema 迁移机制
```

---

## 四、已纠正的历史误判

| 误判 | 实际状态 |
|------|---------|
| "C/C++/ObjC `#include` 无法生成 IMPORTS 边" | ❌ 误判 —— `standard.ts` 中 `resolveCImport`/`resolveCppImport` 已实现，`cpp.test.ts` 有集成测试验证 |
| "Dataflow index.ts 为空 stub" | ❌ 误判 —— 已在 `91f2d08` 完整恢复，含 cfg-builder/dfa-engine/taint-engine |
| "`detection-rules.node.test.ts` 测试框架失败" | ❌ 误判 —— 该文件设计上使用 `node:test` runner（规避 vitest fork OOM），vitest 无法扫描是预期行为 |

---

*本文档基于 `gitnexus/src/core/ingestion/` 及 `src/mcp/local/` 源码直接分析，可作为迭代规划、代码评审和技术选型的基线文档。*
