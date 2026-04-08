# GitNexus 项目状态全景文档

> 基于 commit `796aad9` (main) · 更新日期：2026-04-08  
> 合并自：`project-analysis-2026-04-08.md` · `feature-gap-assessment.md` · `session-progress.md`

---

## 目录

1. [项目概览](#1-项目概览)
2. [架构全景](#2-架构全景)
3. [核心模块解析](#3-核心模块解析)
4. [迭代进展记录](#4-迭代进展记录)
5. [功能缺口评估](#5-功能缺口评估)
6. [当前测试状态](#6-当前测试状态)
7. [MCP 工具生态](#7-mcp-工具生态)
8. [量化指标](#8-量化指标)
9. [执行计划](#9-执行计划)

---

## 1. 项目概览

GitNexus 是一个**代码智能引擎**：通过 tree-sitter 解析 18 种编程语言的源代码，构建知识图谱（符号、调用关系、导入、继承、数据流），并通过 MCP 协议向 AI Agent（Claude、Cursor 等）暴露查询 / 影响分析 / 重构等能力。

```
┌────────────────────────────────────────────────────────────────┐
│                        GitNexus Monorepo                       │
├──────────────┬──────────────┬──────────────┬──────────────────┤
│  gitnexus/   │gitnexus-web/ │gitnexus-     │   eval/          │
│  CLI + Core  │  React SPA   │shared/       │  SWE-bench       │
│  + MCP Server│  + WASM 图谱 │  共享类型     │  评估框架        │
│  v1.5.3      │  Vite+Sigma  │              │  Python+Docker   │
└──────────────┴──────────────┴──────────────┴──────────────────┘
```

| 维度 | 数据 |
|------|------|
| 版本 | `1.5.3` (npm) |
| License | PolyForm Noncommercial 1.0.0 |
| Node 要求 | ≥ 20.0.0（v22+ 已兼容，已验证 v24.1） |
| 主要技术栈 | TypeScript, Tree-sitter, LadybugDB, MCP SDK, React, Vite |

---

## 2. 架构全景

### 2.1 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 层 │ Claude / Cursor / VS Code / 自定义 LLM Agent    │
├───────────┼─────────────────────────────────────────────────┤
│  协议层   │ MCP (stdio) │ HTTP REST │ MCP-over-HTTP         │
├───────────┼─────────────┼───────────┼───────────────────────┤
│  工具层   │ 20 MCP tools│ Express   │ Resources + Prompts   │
├───────────┼─────────────┴───────────┴───────────────────────┤
│  服务层   │ LocalBackend (dispatcher) + 11 tool modules     │
│           │ query · impact · context · detect · rename      │
│           │ route-tools · graph-tools · dataflow · overview  │
├───────────┼─────────────────────────────────────────────────┤
│  分析层   │ 12-Phase Ingestion Pipeline                     │
│           │ BM25 + Vector Hybrid Search                     │
│           │ Bug Detection (rule-engine · 9 rules)           │
├───────────┼─────────────────────────────────────────────────┤
│  图谱层   │ KnowledgeGraph (in-memory) → LadybugDB (Cypher)│
│           │ 15 Node Types · 20+ Edge Types                  │
├───────────┼─────────────────────────────────────────────────┤
│  解析层   │ Tree-sitter (18 languages) + COBOL regex        │
│           │ WorkerPool 多线程 AST 提取                       │
├───────────┼─────────────────────────────────────────────────┤
│  存储层   │ .gitnexus/lbug/ │ ~/.gitnexus/registry.json    │
└───────────┴─────────────────┴───────────────────────────────┘
```

### 2.2 MCP 工具目录布局（`b57da45` 重构后）

```
mcp/local/
├── local-backend.ts       ← dispatcher + shared utilities（2,357 行）
└── tools/
    ├── query.ts           ← BM25 + 语义搜索 + RRF 融合
    ├── impact.ts          ← BFS 爆破半径 + risk 评分
    ├── context.ts         ← caller/callee/360° 符号视图
    ├── detect.ts          ← git diff → 受影响符号
    ├── rename.ts          ← 图感知安全重命名
    ├── route-tools.ts     ← route_map + shape_check + api_impact
    ├── graph-tools.ts     ← cypher + shortest_path + get_code
    ├── dataflow.ts        ← explain_dataflow
    ├── test-impact.ts     ← 变更→测试文件映射
    ├── overview.ts        ← list_repos
    └── shared.ts          ← 共享工具函数
```

---

## 3. 核心模块解析

### 3.1 Ingestion Pipeline（12 阶段）

| Phase | 模块 | 职责 | 关键参数 |
|-------|------|------|---------|
| 1 | `filesystem-walker` | 扫描仓库文件（仅 stat，不加载内容） | `MAX_FILE_SIZE=512KB` |
| 2 | `parsing-processor` + `WorkerPool` | 并行 tree-sitter AST 解析 | `CHUNK_BYTE_BUDGET=20MB` |
| 3 | `structure-processor` | 提取 Class/Function/Interface 节点 | — |
| 4 | `import-processor` | 导入图构建 + 合成绑定 | `MAX_SYNTHETIC_BINDINGS=1000` |
| 5 | `call-processor` | 函数调用/方法调用关系 | 2,411 行（最大单文件） |
| 6 | `heritage-processor` | 继承/实现关系 | — |
| 7 | `mro-processor` | 方法解析顺序（C3 MRO） | 857 行 |
| 8 | `community-processor` | Leiden 社区检测/功能聚类 | — |
| 9 | `process-processor` | 执行流（call chain）识别 | — |
| 10 | `framework-detection` | 框架检测（55 个框架标识） + 路由提取 | — |
| 11 | `dataflow/processDataflow` | DFA + Taint 分析 | Optional |
| 12 | `dataflow/processCFG` | CFG 构建（10 语言 DSL） | Optional |

### 3.2 图谱模型

**节点类型（15 种）：**
```
File · Folder · Function · Class · Interface · Method ·
Constructor · Property · CodeElement · Struct · Enum ·
Trait · Impl · Community · Process · Route · Tool
```

**边类型（20+ 种）：**
```
核心关系:      CONTAINS · DEFINES · CALLS · IMPORTS · EXTENDS · IMPLEMENTS
成员关系:      HAS_METHOD · HAS_PROPERTY · MEMBER_OF
重写/访问:     OVERRIDES · METHOD_OVERRIDES · METHOD_IMPLEMENTS · ACCESSES
流程关系:      STEP_IN_PROCESS · ENTRY_POINT_OF
框架关系:      HANDLES_ROUTE · FETCHES · HANDLES_TOOL
数据流关系:    DATA_FLOW · PROPAGATES · RETURNS · TAINTED ·
              SANITIZES · SINK_REACHABLE · ALIASES · CFG_EDGE
```

### 3.3 CFG DSL 覆盖（`dataflow/dsl/`，11 语言）

| 语言 | DSL 文件 | 行数 | 状态 |
|------|---------|:---:|:---:|
| TypeScript | `typescript-static-edges.sg` | — | ✅ 原有（17 边类型） |
| JavaScript | `javascript-static-edges.sg` | — | ✅ 原有（16 边类型） |
| Python | `python-static-edges.sg` | — | ✅ 原有（8 边类型） |
| Java | `java-static-edges.sg` | — | ✅ `36506d0`（14 边类型） |
| Go | `go-static-edges.sg` | — | ✅ `36506d0`（9 边类型） |
| Kotlin | `kotlin-static-edges.sg` | 233 | ✅ `796aad9` |
| C# | `csharp-static-edges.sg` | 301 | ✅ `796aad9` |
| Rust | `rust-static-edges.sg` | 320 | ✅ `796aad9` |
| C | `c-static-edges.sg` | 206 | ✅ `796aad9` |
| C++ | `cpp-static-edges.sg` | 278 | ✅ `796aad9` |
| Objective-C | `objectivec-static-edges.sg` | 282 | ✅ 未发布（本次补全） |

### 3.4 Bug 检测规则（`detection/rules/`，9 条）

| 规则 | 分类 | 状态 |
|------|------|:---:|
| `missing-guard` | 缺失防御型 | ✅ 原有（含 Swift/Dart/ArkTS 模式扩展 `796aad9`） |
| `missing-unwrap` | 缺失防御型 | ✅ 原有（含扩展） |
| `missing-resource` | 缺失防御型 | ✅ 原有（含扩展） |
| `missing-exception-handling` | 缺失防御型 | ✅ 原有 |
| `missing-return-check` | 缺失防御型 | ✅ 原有 |
| `missing-concurrency-guard` | 缺失防御型 | ✅ 原有（含扩展） |
| `sql-injection` | Taint-based（OWASP A03） | ✅ `36506d0` |
| `path-traversal` | Taint-based（OWASP A01 / CWE-22） | ✅ `36506d0` |
| `xss` | Taint-based（OWASP A03）| ✅ `796aad9`（DOM sink + dangerouslySetInnerHTML） |

### 3.5 路由提取器（`route-extractors/`）

| 提取器 | 覆盖框架 | 状态 |
|--------|---------|:---:|
| `nextjs.ts` | Next.js Pages + App Router → URL 映射 | ✅ 原有 |
| `expo.ts` | Expo Router → URL 映射 | ✅ 原有 |
| `php.ts` | Laravel 文件级路由 | ✅ 原有 |
| `middleware.ts` | Express middleware 路由 | ✅ 原有 |
| `django.ts` | Django `urls.py` `path()`/`re_path()` | ✅ `796aad9` |
| `rails.ts` | Rails `routes.rb` DSL（get/post/resources 等） | ✅ `796aad9` |

### 3.6 Named Bindings（`named-bindings/`）

| 语言 | 文件 | 状态 |
|------|------|:---:|
| TypeScript | `typescript.ts` | ✅ 原有 |
| Python | `python.ts` | ✅ 原有 |
| Java | `java.ts` | ✅ 原有 |
| Kotlin | `kotlin.ts` | ✅ 原有 |
| Rust | `rust.ts` | ✅ 原有 |
| C# | `csharp.ts` | ✅ 原有 |
| PHP | `php.ts` | ✅ 原有 |
| Dart | `dart.ts` | ✅ `796aad9`（`show` combinator 提取） |
| Go | `go.ts` | ✅ `796aad9`（package alias / `isModuleAlias` 提取） |
| Ruby | — | ⚫ 待实现 |
| Swift | — | ⚫ 待实现 |

---

## 4. 迭代进展记录

### 历史 commit 链（有效代码变更）

| Commit | 日期 | 主要内容 |
|--------|------|---------|
| `36694e4` | 早期 | 恢复 Dataflow Phase 12 完整实现（cfg-builder/dfa-engine/taint-engine） |
| `53df277` | 早期 | 修复 C/C++/ObjC `#include`/`#import` IMPORTS 边；搜索精度提升 |
| `f3ad103` | 早期 | 添加 Bug 检测引擎（rule-engine + diff-detector）+ 6 条初始规则 |
| `91f2d08` | 早期 | 恢复 CFG/Dataflow 回归测试套件 |
| `2de882c` | 早期 | 修复 ArkTS `.ets` 扩展名解析 Bug（IMPORTS 边），8 个集成测试全通过 |
| `067b236` | 2026-04-08 | ArkTS ObjC 预处理集成（parse-worker + parsing-processor）|
| `b57da45` | 2026-04-08 | **H1 解决**：local-backend 拆分为 11 模块（backend: 4,187→2,357 行）；Node v24 `--stack-size` 兼容修复；新增 mcp-tools-shared（16 tests）+ mcp-tools-overview（19 tests） |
| `36506d0` | 2026-04-08 | **M2**：Java/Go CFG DSL；**M3**：SQL injection + path traversal 规则（规则数 6→8）；**M4**：Web 组件测试 19 个；**M5**：CONTRIBUTING.md 依赖说明 |
| `796aad9` | 2026-04-08 | **P2/P3/战略**：Kotlin/C#/Rust/C/C++ CFG DSL；Dart/Go named-bindings；Swift/Dart/ArkTS bug 规则扩展；XSS 规则（规则数 8→9）；Django + Rails 路由提取器；COBOL EVALUATE/IF → CALLS 边；tools 单元测试（impact: 388, context: 241, query: 244）；route-extractors 单元测试（212 tests）；named-bindings 测试（Dart: 90, Go: 80） |
| 未发布 | 2026-04-08 | **ObjC 完善收尾**：`entry-point-scoring.ts` 修复 `awakeFromNib` 正则；新增 `objectivec-static-edges.sg` 并接入 `LANGUAGE_DSL_MAP`；ObjC tier BASIC→LIMITED；ObjC taint source/sink/sanitizer 扩展；3 条检测规则补 ObjC 模式；修复 ObjC AST 容器节点映射；新增 `test/integration/resolvers/objc.test.ts` + fixture（9/9 通过） |

---

## 5. 功能缺口评估

### ✅ 已解决（原高优先级）

| 原问题 | Commit | 解决方案 |
|--------|--------|---------|
| `local-backend.ts` God Object（4,187 行） | `b57da45` | 拆分为 11 个 tool 模块，backend 降至 2,357 行 |
| Dataflow `index.ts` 为空 stub | `36694e4`/`91f2d08` | 完整恢复（cfg-builder / dfa-engine / taint-engine / path-sensitive） |
| Bug 检测规则引擎缺失 | `f3ad103` | 6 条规则 + diff-detector；后续扩展至 9 条 |
| C/C++/ObjC `#include`/`#import` 无 IMPORTS 边 | `53df277` | `standard.ts` 实现 `resolveCImport`/`resolveCppImport`，含集成测试 |
| ArkTS `.ets` 跨文件 IMPORTS 边解析 Bug | `2de882c` | 修复 `import-resolvers/utils.ts` 中 `.ets` 扩展名缺失，8 个集成测试全通过 |
| Node v24 `--stack-size` 兼容性（CI 36 个测试失败） | `b57da45` | `analyze.ts` 检测 `NODE_MAJOR < 22`，`STACK_FLAG_SUPPORTED`；v22+ 不注入该选项 |
| MCP tools 单元测试缺失 | `b57da45`/`796aad9` | impact（388 tests）+ context（241）+ query（244）+ overview（19）+ shared（16） |
| Java/Go Dataflow DSL 缺失 | `36506d0` | `java-static-edges.sg`（14 边）/ `go-static-edges.sg`（9 边） |
| 安全类 taint-based 检测规则缺失 | `36506d0` + `796aad9` | sql-injection / path-traversal / xss，共 3 条新增 |
| Kotlin/C#/Rust/C/C++ CFG DSL 缺失 | `796aad9` | 5 个 `.sg` 文件，合计 1,338 行 |
| Dart/Go named-bindings 缺失 | `796aad9` | `dart.ts`（show combinator）/ `go.ts`（package alias） |
| Django/Rails 路由提取缺失 | `796aad9` | `django.ts`（urls.py path/re_path）/ `rails.ts`（routes.rb DSL） |
| Swift/Dart/ArkTS bug 规则覆盖极低 | `796aad9` | 扩展 missing-guard/unwrap/resource/concurrency-guard 模式匹配 |
| COBOL 无 CALLS 边（EVALUATE/IF 调用） | `796aad9` | `cobol-preprocessor.ts` 新增 EVALUATE/IF regex 提取 |

---

### 🔴 P1 — 当前高优先级

#### P1.1 — 部分测试仍在失败（4 个测试文件，5 个用例）

| 失败测试 | 根因 | 影响 |
|---------|------|------|
| `detection-rules.node.test.ts` | 设计使用 `node:test` runner，vitest 无法正确执行（**预期行为**） | 无（已知，不算真正失败） |
| `impact-batching-grouping.test.ts`（3 用例） | `tools/impact.ts` batching/chunking 逻辑与测试期望不匹配 | MCP impact 工具批处理路径回归风险 |
| `skip-git-cli.test.ts`（1 用例） | `analyze.ts` 自我重生（respawn）后 stderr 输出格式变化，测试断言 `--skip-git` 字符串未出现 | CLI 错误提示回归 |
| `resolvers/cobol.test.ts`（1 用例） | COBOL EVALUATE/IF 新增后总 CALLS 边从 31 变为 32，测试断言未更新 | 次要（数值更新即可修复） |

> COBOL 用例修复：将 `test/integration/resolvers/cobol.test.ts` line 695 的 `.toBe(31)` 改为 `.toBe(32)`，约 5 分钟工作量。

---

### 🟡 P2 — 中优先级

#### P2.1 — 路由提取：Spring / FastAPI / Flask / Gin / Echo 仍缺失

- **现状**：Django（✅）和 Rails（✅）已实现；Spring Boot、FastAPI/Flask python、Gin/Echo/Fiber Go 框架识别存在但**不生成 `HANDLES_ROUTE` 边**
- **影响**：`route_map` 和 `api_impact` MCP 工具在 Java/Kotlin/Python（Flask/FastAPI）/Go 项目中返回空结果
- **方案**：
  1. Spring（Java/Kotlin）：扫描 `@RequestMapping`/`@GetMapping`/`@PostMapping` 注解
  2. FastAPI/Flask（Python）：扫描 `@app.route()`/`@router.xxx()` 装饰器
  3. Gin/Echo/Fiber（Go）：扫描 `router.GET(...)`/`r.Post(...)` 调用
  4. 每框架约 2 天

#### P2.2 — Ruby / Swift named-bindings 仍缺失

- **现状**：Dart 和 Go 已在 `796aad9` 实现；Ruby（mixin/extend）和 Swift（`import Swift.module`）仍为 `wildcard` 语义
- **影响**：Ruby/Swift 符号绑定精度低，`named-bindings` 导入图边质量差
- **方案**：Ruby 难度较高（动态 `include`/`extend`）；Swift 相对清晰（模块级 import）

#### P2.3 — `local-backend.ts` 仍有 2,357 行

- **现状**：工具逻辑已外移，但仍残留大量共享辅助函数和生命周期管理代码
- **目标**：≤ 500 行纯 dispatcher；约 2 天

#### P2.4 — 测试覆盖率

- `tools/impact.ts`（728 行）、`tools/context.ts`（495 行）、`tools/query.ts`（429 行）已有专属单元测试（`796aad9`），但 `call-processor.ts`（2,411 行）边界条件覆盖仍不足
- 覆盖率当前约 26% statements（auto-ratchet floor）；目标：35%

---

### 🟢 P3 — 低优先级 / 工程债务

| 项 | 描述 | 预估工作量 |
|----|------|:---------:|
| Spring / FastAPI / Gin 路由提取（P2.1 后续） | 继续路由提取器覆盖 | 每框架 2 天 |
| Ruby named-bindings | 动态 `include`/`extend` 较难静态捕获 | 3~5 天 |
| Swift named-bindings | 模块级 import 提取 | 1~2 天 |
| Objective-C Category 合并语义 | category 方法归并与归属策略仍可优化 | 2 天 |
| COBOL 迁移 tree-sitter | 现有 regex 处理器 3,700+ 行，可评估 `tree-sitter-cobol` | 1~2 周 |
| Web UI 核心组件单元测试 | `GraphCanvas`/`ProcessFlowModal`/`QueryFAB` 无组件级测试 | 2~3 天 |
| LadybugDB Schema 迁移机制 | 新增节点/边类型需 clean + 重建，无版本化迁移 | 3~5 天 |
| Vue SFC 模板层符号提取 | 仅解析 `<script>` 块，`<template>` 中组件引用无法入图 | 3~5 天 |
| `parse-worker.ts` 预处理器模块化 | ArkTS/ObjC 预处理内联在 2,380 行 worker 中 | 2~3 天 |

---

## 6. 当前测试状态

> 数据来自 `npm run test` 于 HEAD `796aad9`

| 指标 | 数值 |
|------|:----:|
| 测试文件数（总） | 185（含 1 跳过） |
| **通过** | **5,759** |
| **失败** | **5**（4 个文件） |
| 跳过 | 128 |
| 运行时长 | ~321 秒（含集成测试） |

**失败详情：**

| 文件 | 失败数 | 是否阻塞 | 修复难度 |
|------|:------:|:-------:|:-------:|
| `detection-rules.node.test.ts` | 1 | ❌ 否（预期行为，node:test 设计） | — |
| `impact-batching-grouping.test.ts` | 3 | ⚠️ 是 | 🟡 中 |
| `skip-git-cli.test.ts` | 1 | ⚠️ 是 | 🟡 中 |
| `resolvers/cobol.test.ts` | 1 | ✅ 易修复 | 🟢 低（改 31→32） |

---

## 7. MCP 工具生态

### 工具清单（20 个）

| 类别 | 工具 | 用途 |
|------|------|------|
| **发现** | `list_repos` | 发现已索引仓库 |
| **搜索** | `query` | 混合搜索（BM25 + 语义，RRF k=20） |
| | `cypher` | 原始 Cypher 查询 |
| | `get_code` | 按 UID 获取源码 |
| | `shortest_path` | BFS 最短路径 |
| **分析** | `context` | 符号 360° 视图（callers/callees/refs） |
| | `impact` | 爆破半径分析（BFS depth≤3 + risk 评分） |
| | `test_impact` | 变更→测试文件映射 |
| | `detect_changes` | git diff → 受影响符号 |
| | `api_impact` | API 路由影响分析 |
| **API** | `route_map` | 路由映射（依赖 HANDLES_ROUTE 边） |
| | `shape_check` | 响应形状检查 |
| | `tool_map` | MCP/RPC 工具映射 |
| **重构** | `rename` | 图感知安全重命名 |
| **安全** | `explain_dataflow` | LLM 解释污点路径 |
| **Group** | `group_list` / `group_sync` / `group_contracts` / `group_query` / `group_status` | 多仓库协调 |

### Resources（可读资源 URI）

```
gitnexus://repo/{name}/context     — 仓库概览 + 索引新鲜度
gitnexus://repo/{name}/schema      — Cypher 图谱 Schema
gitnexus://repo/{name}/clusters    — 功能区域列表
gitnexus://repo/{name}/processes   — 执行流列表
gitnexus://repo/{name}/process/{n} — 单个执行流追踪
gitnexus://repo/{name}/cluster/{n} — 单个功能区域详情
```

---

## 8. 量化指标

### 代码规模（截至 `796aad9`）

| 组件 | 源文件 | 源码行 | 测试文件 | 测试行 |
|------|:------:|:------:|:--------:|:------:|
| gitnexus (CLI/Core) | ~240+ | ~76,000+ | 185 | ~82,000+ |
| gitnexus-web (UI) | 52 | 16,010 | — | — |
| gitnexus-shared | 6 | 478 | — | — |

### 最大复杂度热点（Top 10）

| 文件 | 行数 | 当前状态 |
|------|:----:|---------|
| `ingestion/call-processor.ts` | 2,411 | 未拆分 |
| `ingestion/workers/parse-worker.ts` | 2,380 | 未拆分（含 ArkTS/ObjC 预处理内联） |
| `mcp/local/local-backend.ts` | **2,357** | 已从 4,187 降至此（目标 ≤500，P2.3） |
| `ingestion/cobol/cobol-preprocessor.ts` | 2,279 | — |
| `ingestion/pipeline.ts` | 2,010 | — |
| `detection/rules/xss.ts` | 249 | 新增（`796aad9`） |
| `mcp/local/tools/impact.ts` | 728 | `b57da45` 拆分产物 |
| `mcp/local/tools/context.ts` | 495 | `b57da45` 拆分产物 |
| `mcp/local/tools/query.ts` | 429 | `b57da45` 拆分产物 |

### 测试演进

| 时间节点 | 通过测试数 | 失败情况 |
|---------|:---------:|---------|
| `0050109`（初始） | ~5,318 | 有历史失败 |
| `b57da45` | ~5,450 | Node v24 CI 36 个失败修复 |
| `36506d0` | ~5,580 | — |
| `796aad9`（当前） | **5,759** | 5 个失败（见第 6 节） |

---

## 9. 执行计划

```
本周（紧急修复，P1.1）
  ├── D1: 修复 cobol.test.ts（.toBe(31)→.toBe(32)）约 5 分钟
  ├── D1: 修复 impact-batching-grouping.test.ts（3 个用例）—— batching 逻辑对齐
  └── D2: 修复 skip-git-cli.test.ts（respawn 后 stderr 捕获方式）

下周（P2 路由覆盖扩展）
  ├── D1~D3: Spring Boot 路由提取器（Java/Kotlin @RequestMapping）
  └── D4~D5: FastAPI/Flask 路由提取器（Python @router/@app.route）

Week 3（P2 继续）
  ├── Gin/Echo/Fiber 路由提取器（Go router.GET/r.Post）
  └── Swift named-bindings + Ruby named-bindings 评估

Week 4（P2.3 + P2.4 工程债）
  ├── local-backend.ts 减至 ≤500 行（提取状态管理到 LocalBackendCore）
  └── 覆盖率提升：call-processor 边界测试，目标 statements 35%

Month 2（P3 工程债）
  ├── Web UI GraphCanvas/ProcessFlowModal 组件测试
  ├── LadybugDB Schema 迁移机制
  └── COBOL 评估 tree-sitter-cobol 替代方案
```

---

## 附录：历史误判纠正

| 误判 | 实际状态 |
|------|---------|
| "C/C++/ObjC `#include` 无法生成 IMPORTS 边" | ❌ 误判 —— `standard.ts` 中已通过 `resolveCImport`/`resolveCppImport` 实现，含集成测试 |
| "Dataflow `index.ts` 为空 stub" | ❌ 误判 —— 已在 `36694e4` 完整恢复，含 cfg-builder/dfa-engine/taint-engine |
| "`detection-rules.node.test.ts` 测试框架失败" | ❌ 误判 —— 设计上使用 `node:test` runner（规避 vitest fork OOM），vitest 无法扫描是预期行为 |
| "Java/Go 无 CFG DSL，explain_dataflow 工具在这两种语言无效" | ❌ 已解决 —— `36506d0` 实现了 Java（14 边）/ Go（9 边）DSL；`796aad9` 追加了 Kotlin/C#/Rust/C/C++ |
| "XSS 规则未实现，是最重要的缺口" | ❌ 已解决 —— `796aad9` 新增 `xss.ts`（249 行，覆盖 DOM sink/innerHTML/eval/dangerouslySetInnerHTML） |

---

*本文档基于 `gitnexus/src/` 源码直接分析，可作为迭代规划、代码评审和贡献者参考的基线文档。*
