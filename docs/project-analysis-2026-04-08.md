# GitNexus 项目全景分析报告

> 生成日期：2026-04-08 · 基于 commit `0050109` (main)

---

## 目录

1. [项目概览](#1-项目概览)
2. [架构全景](#2-架构全景)
3. [核心模块解析](#3-核心模块解析)
4. [数据流与处理管道](#4-数据流与处理管道)
5. [语言支持矩阵](#5-语言支持矩阵)
6. [MCP 工具生态](#6-mcp-工具生态)
7. [量化指标](#7-量化指标)
8. [优势分析](#8-优势分析)
9. [待优化项与风险](#9-待优化项与风险)
10. [路线建议](#10-路线建议)

---

## 1. 项目概览

GitNexus 是一个 **代码智能引擎**：通过 tree-sitter 解析 18 种编程语言的源代码，构建知识图谱（符号、调用关系、导入、继承、数据流），并通过 MCP 协议向 AI Agent（Claude、Cursor 等）暴露查询/影响分析/重构等能力。

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
| Node 要求 | ≥ 20.0.0 |
| 主要技术栈 | TypeScript, Tree-sitter, LadybugDB, MCP SDK, React, Vite |

---

## 2. 架构全景

### 2.1 模块图（Mermaid）

```mermaid
graph TB
    subgraph CLI["CLI Layer (gitnexus/src/cli/)"]
        analyze["analyze"]
        serve["serve"]
        mcp_cmd["mcp"]
        tool["tool (query/impact/context)"]
        wiki["wiki"]
        group["group"]
        setup["setup"]
    end

    subgraph Core["Core Engine (gitnexus/src/core/)"]
        subgraph Ingestion["Ingestion Pipeline"]
            walker["filesystem-walker"]
            parser["parsing-processor\n+ WorkerPool"]
            structure["structure-processor"]
            imports["import-processor"]
            calls["call-processor"]
            heritage["heritage-processor"]
            mro["mro-processor"]
            community["community-processor"]
            process_proc["process-processor"]
            dataflow["dataflow/\n(CFG + DFA + Taint)"]
            detection["detection/\n(rule-engine + 6 rules)"]
        end

        subgraph Support["Support Modules"]
            search["search/\n(BM25 + hybrid)"]
            embeddings["embeddings/\n(transformers.js)"]
            wiki_gen["wiki/\n(LLM generator)"]
            group_svc["group/\n(multi-repo)"]
            augmentation["augmentation/\n(LLM enrichment)"]
        end

        lbug["lbug/\n(LadybugDB adapter)"]
        graph["graph/\n(in-memory KG)"]
        treesitter["tree-sitter/\n(parser-loader)"]
    end

    subgraph MCP["MCP Server (gitnexus/src/mcp/)"]
        server["server.ts\n(stdio transport)"]
        tools_def["tools.ts\n(20 tool definitions)"]
        backend["local-backend.ts\n(tool implementations)"]
        resources["resources.ts\n(URI templates)"]
    end

    subgraph HTTP["HTTP Server (gitnexus/src/server/)"]
        api["api.ts (Express)"]
        mcp_http["mcp-http.ts"]
    end

    subgraph Storage["Storage"]
        repo_mgr["repo-manager.ts"]
        git_util["git.ts"]
        lbug_db[(".gitnexus/lbug/\n(LadybugDB files)")]
        registry[("~/.gitnexus/\nregistry.json")]
    end

    subgraph Web["Web UI (gitnexus-web/)"]
        react["React + Tailwind"]
        sigma["Sigma.js Graph"]
        wasm["WASM Indexer"]
        langchain["LangChain Chat"]
    end

    CLI --> Core
    analyze --> walker --> parser --> structure --> imports --> calls
    calls --> heritage --> mro --> community --> process_proc --> dataflow
    dataflow --> detection
    parser --> treesitter
    structure --> graph
    imports --> graph
    calls --> graph
    heritage --> graph
    graph --> lbug --> lbug_db
    lbug --> repo_mgr --> registry

    MCP --> backend --> lbug
    backend --> search
    backend --> embeddings
    server --> tools_def

    HTTP --> api --> backend
    HTTP --> mcp_http --> server

    serve --> HTTP
    mcp_cmd --> MCP
    Web --> HTTP

    style Core fill:#1a1a2e,stroke:#e94560,color:#eee
    style MCP fill:#16213e,stroke:#0f3460,color:#eee
    style CLI fill:#0f3460,stroke:#53354a,color:#eee
    style Web fill:#533483,stroke:#e94560,color:#eee
```

### 2.2 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 层 │ Claude / Cursor / VS Code / 自定义 LLM Agent    │
├───────────┼─────────────────────────────────────────────────┤
│  协议层   │ MCP (stdio) │ HTTP REST │ MCP-over-HTTP         │
├───────────┼─────────────┼───────────┼───────────────────────┤
│  工具层   │ 20 MCP tools│ Express   │ Resources + Prompts   │
├───────────┼─────────────┴───────────┴───────────────────────┤
│  服务层   │ LocalBackend: query · impact · context · detect │
│           │ rename · test_impact · api_impact · route_map   │
├───────────┼─────────────────────────────────────────────────┤
│  分析层   │ 12-Phase Ingestion Pipeline                     │
│           │ BM25 + Vector Hybrid Search                     │
│           │ Bug Detection (rule-engine + diff-detector)     │
├───────────┼─────────────────────────────────────────────────┤
│  图谱层   │ KnowledgeGraph (in-memory) → LadybugDB (Cypher)│
│           │ 15 Node Types · 20+ Edge Types                  │
├───────────┼─────────────────────────────────────────────────┤
│  解析层   │ Tree-sitter (18 languages) + COBOL regex        │
│           │ WorkerPool (多线程 AST 提取)                     │
├───────────┼─────────────────────────────────────────────────┤
│  存储层   │ .gitnexus/lbug/ │ ~/.gitnexus/registry.json    │
└───────────┴─────────────────┴───────────────────────────────┘
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
| 5 | `call-processor` | 函数调用/方法调用关系 | 2411 行（最大单文件之一） |
| 6 | `heritage-processor` | 继承/实现关系 | — |
| 7 | `mro-processor` | 方法解析顺序（C3 MRO） | 857行 |
| 8 | `community-processor` | Leiden 社区检测/功能聚类 | — |
| 9 | `process-processor` | 执行流（call chain）识别 | — |
| 10 | `framework-detection` | 框架检测（React/Next.js/Express 等） | — |
| 11 | `dataflow/processDataflow` | 数据流分析（DFA + Taint） | Optional |
| 12 | `dataflow/processCFG` | 控制流图构建 | Optional |

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

### 3.3 Bug 检测模块

**架构**：`rule-engine.ts`（规则注册/评估） + `diff-detector.ts`（变更风险分析） + 6 条内置规则

| 规则 | 检测内容 | 适用语言 |
|------|---------|---------|
| `missing-guard` | 缺少错误保护的 I/O 操作 | TS/JS/Python/Go/Ruby |
| `missing-resource` | 资源未释放（连接、流） | TS/JS/Python/Go |
| `missing-exception-handling` | 异常被静默吞掉 | 全部 |
| `missing-return-check` | 返回值未检查 | C/C++/Go/TS/JS |
| `missing-unwrap` | Rust unwrap()无保护 | Rust |
| `missing-concurrency-guard` | 并发无同步控制 | 全部 |

### 3.4 搜索与嵌入

- **BM25 索引**：基于 LadybugDB FTS（全文搜索），对符号名/描述建索引
- **向量搜索**：可选，使用 `@huggingface/transformers` + `onnxruntime-node` 本地嵌入
- **混合搜索**：RRF（Reciprocal Rank Fusion, k=20）融合 BM25 + 向量结果

### 3.5 Group（多仓库协调）

Group 模块管理跨仓库的微服务架构分析：

- **contract-extractor**：提取模块间接口契约
- **service-boundary-detector**：识别服务边界
- **sync**：跨仓库索引同步
- 5 个 MCP 工具：`group_list/sync/contracts/query/status`

---

## 4. 数据流与处理管道

### 4.1 端到端数据流

```
用户仓库                           .gitnexus/
  │                                    │
  ▼                                    ▼
stat 文件 ──▶ AST 解析 ──▶ 内存图 ──▶ LadybugDB ──▶ MCP/HTTP ──▶ AI Agent
  │(Phase1)   │(Phase2)    │(P3-P10)   │(写入)         │(查询)       │
  │           │            │           │               │             │
  │ fs.stat   │ tree-sitter│ addNode() │ CSV bulk      │ Cypher      │ 工具调用
  │ 过滤大文件│ 多线程解析 │ addRel()  │ load          │ BFS/DFS     │ 语义搜索
  │           │ LRU Cache  │ community │ FTS index     │ 混合排序    │
  │           │            │ process   │ embeddings    │             │
  └───────────┴────────────┴───────────┴───────────────┴─────────────┘
```

### 4.2 MCP 工具调用链

```
Agent (Claude/Cursor)
  │
  ▼ MCP stdio / HTTP
server.ts (CallToolRequestSchema)
  │
  ▼ dispatch
local-backend.ts::callTool(method, params)
  │
  ├─▶ query()     → bm25Search() + semanticSearch() → RRF → processGrouping
  ├─▶ context()   → Cypher (callers/callees/refs) → categorize
  ├─▶ impact()    → resolveTarget → BFS(depth≤3) → risk + processes + modules
  ├─▶ test_impact() → resolveSeed → BFS upstream → filter isTestFile
  ├─▶ detect_changes() → git diff → mapToSymbols → affectedProcesses
  ├─▶ rename()    → dryRun preview → graph edits + text edits
  ├─▶ cypher()    → raw Cypher → markdown format
  └─▶ ...20 tools total
```

### 4.3 Web UI 数据流

```
浏览器                                 后端
  │                                     │
  ├─ WASM IndexedDB (离线模式)          │
  │  └─ tree-sitter-wasm → 本地图谱     │
  │                                     │
  └─ REST/MCP-HTTP (在线模式) ──────────▶ Express api.ts
                                         │
                                         ▼
                                    LocalBackend → LadybugDB
```

---

## 5. 语言支持矩阵

| 语言 | Tree-sitter | Import 解析 | 类型提取 | Route 提取 | 数据流 |
|------|:-----------:|:-----------:|:--------:|:----------:|:------:|
| TypeScript | ✅ | ✅ | ✅ | Next.js/Express | ✅ DSL |
| JavaScript | ✅ | ✅ (同 TS) | ✅ (同 TS) | Next.js/Express | ✅ DSL |
| Python | ✅ | ✅ | ✅ | Django/Flask | ✅ DSL |
| Java | ✅ | ✅ (JVM) | ✅ (JVM) | Spring | ⚠️ 有限 |
| Kotlin | ⚠️ optional | ✅ (JVM) | ✅ (JVM) | — | — |
| Go | ✅ | ✅ | ✅ | — | — |
| Rust | ✅ | ✅ | ✅ | — | — |
| C/C++ | ✅ | — | ✅ | — | — |
| C# | ✅ | ✅ | ✅ | — | — |
| PHP | ✅ | ✅ | ✅ | Laravel | — |
| Ruby | ✅ | ✅ | ✅ | — | — |
| Swift | ⚠️ optional | ✅ | ✅ | — | — |
| Dart | ⚠️ optional | ✅ | ✅ | — | — |
| Objective-C | ✅ | — | ✅ | — | — |
| Vue SFC | ✅ | ✅ | — | — | — |
| ArkTS (.ets) | ✅ (via TS) | ✅ (同 TS) | — | — | — |
| COBOL | ⚠️ regex | — | — | — | — |

> ✅ = 完整支持 · ⚠️ = 部分/可选支持 · — = 无支持

---

## 6. MCP 工具生态

### 6.1 工具清单（20 个）

| 类别 | 工具 | 用途 |
|------|------|------|
| **发现** | `list_repos` | 发现已索引仓库 |
| **搜索** | `query` | 混合搜索（BM25 + 语义） |
| | `cypher` | 原始 Cypher 查询 |
| | `get_code` | 按 UID 获取源码 |
| | `shortest_path` | BFS 最短路径 |
| **分析** | `context` | 符号 360° 视图 |
| | `impact` | 爆破半径分析 |
| | `test_impact` | 变更→测试文件映射 |
| | `detect_changes` | Git diff → 受影响符号 |
| | `api_impact` | API 路由影响分析 |
| **API** | `route_map` | 路由映射 |
| | `shape_check` | 响应形状检查 |
| | `tool_map` | MCP/RPC 工具映射 |
| **重构** | `rename` | 图感知安全重命名 |
| **安全** | `explain_dataflow` | LLM 解释污点路径 |
| **Group** | `group_list/sync/contracts/query/status` | 多仓库协调 |

### 6.2 Resources（可读资源 URI）

```
gitnexus://repo/{name}/context     — 仓库概览 + 索引新鲜度
gitnexus://repo/{name}/schema      — Cypher 图谱 Schema
gitnexus://repo/{name}/clusters    — 功能区域列表
gitnexus://repo/{name}/processes   — 执行流列表
gitnexus://repo/{name}/process/{n} — 单个执行流追踪
gitnexus://repo/{name}/cluster/{n} — 单个功能区域详情
```

### 6.3 Prompts（预设提示）

| Prompt | 用途 |
|--------|------|
| `detect_impact` | 引导式变更影响分析流程 |
| `generate_map` | 生成架构文档（Mermaid 图） |

---

## 7. 量化指标

### 7.1 代码规模

| 组件 | 源文件数 | 源代码行数 | 测试文件数 | 测试代码行数 |
|------|:--------:|:---------:|:----------:|:----------:|
| gitnexus (CLI/Core) | 223 | 70,500 | 176 | 76,761 |
| gitnexus-web (UI) | 52 | 16,010 | — | — |
| gitnexus-shared | 6 | 478 | — | — |
| **合计** | **281** | **86,988** | **176** | **76,761** |

> 测试代码量 ≈ 源代码量的 109%，测试-源比率优秀。

### 7.2 最大文件（Top 10 复杂度热点）

| 文件 | 行数 | 角色 |
|------|:----:|------|
| `mcp/local/local-backend.ts` | 4,187 | MCP 工具实现（God Object 风险） |
| `ingestion/call-processor.ts` | 2,411 | 函数调用解析 |
| `ingestion/workers/parse-worker.ts` | 2,380 | 多线程 AST 解析 |
| `ingestion/cobol/cobol-preprocessor.ts` | 2,279 | COBOL 预处理 |
| `ingestion/pipeline.ts` | 2,010 | 管道编排 |
| `ingestion/cobol-processor.ts` | 1,453 | COBOL 处理 |
| `ingestion/type-extractors/taint.ts` | 1,317 | 污点分析基础 |
| `ingestion/tree-sitter-queries.ts` | 1,311 | TSG 查询定义 |
| `server/api.ts` | 1,270 | HTTP REST API |
| `ingestion/type-env.ts` | 1,258 | 类型环境 |

### 7.3 依赖

| 类型 | 数量 |
|------|:----:|
| dependencies (CLI/Core) | 32 |
| devDependencies | 11 |
| optionalDependencies | 3 (tree-sitter-dart/kotlin/swift) |
| tree-sitter 语言绑定 | 15 |

### 7.4 测试

| 指标 | 数值 |
|------|:----:|
| 单元测试文件 | 87 |
| 集成测试文件 | 37 |
| E2E 测试（Web） | 5 |
| 总通过测试数 | ~5,318 |
| 跳过测试数 | 92 |
| 覆盖率下限 | 语句 26% / 分支 23% / 函数 28% / 行 27% |
| CI workflows | 10 |

### 7.5 索引能力参考

据 AGENTS.md 元数据（自索引）：

| 指标 | 数值 |
|------|:----:|
| 索引符号数 | 4,343 |
| 关系数 | 10,259 |
| 执行流 | 342 |

---

## 8. 优势分析

### ✅ 架构优势

1. **协议标准化**：原生 MCP 协议集成，兼容 Claude、Cursor 等主流 AI Agent，无需定制适配
2. **多语言覆盖**：18 种语言的 tree-sitter 支持，含 ArkTS/COBOL 等小众语言，覆盖主流开发场景
3. **图谱驱动**：从 AST → 知识图谱 → Cypher 查询的全链路，支持任意复杂度的代码关系分析
4. **数据流分析**：具备 CFG + DFA + Taint 三层分析能力，可执行安全性/数据流追踪
5. **零 LLM 依赖核心**：索引/分析/查询全流程无需 LLM，仅 Wiki 生成和增强模块可选使用

### ✅ 工程优势

6. **测试-源比率 109%**：测试代码量超过源代码量，CI 有 10 条 workflow 守护质量
7. **渐进式覆盖**：vitest auto-ratchet 机制（覆盖率只升不降）
8. **多运行模式**：CLI（本地分析）、MCP stdio（Agent 集成）、HTTP（Web UI 桥接）、WASM（浏览器离线）四种运行模式
9. **增量设计**：AST 缓存（LRU 50）、跨文件再处理阈值机制、增量 dataflow 分析
10. **预提交守护**：pre-commit hooks 强制格式化 + typecheck + 测试

### ✅ 产品优势

11. **Next-Step Hints**：MCP 工具响应自带下一步操作建议，引导 Agent 形成多步工作流
12. **多仓库支持**：Group 模块支持跨仓库查询/契约检测/边界分析
13. **Bug 检测**：6 条内置规则 + diff-detector 变更风险分析，从图谱维度发现缺陷
14. **双模搜索**：BM25 关键词 + 语义向量的 RRF 融合，兼顾精确和语义匹配

---

## 9. 待优化项与风险

### 🔴 高优先级

#### H1. `local-backend.ts` 巨型文件（4,187 行）

**问题**：20 个 MCP 工具的实现全部集中在一个文件中，违反单一职责原则。BFS 遍历、Cypher 查询构建、风险评分、Git diff 解析等逻辑混杂。

**风险**：认知负荷高、并发修改冲突频繁、难以独立测试。

**建议**：按工具域拆分为独立模块：
```
mcp/local/
├── local-backend.ts       (dispatcher + shared utilities)
├── tools/
│   ├── query-tool.ts      (query + bm25 + semantic)
│   ├── impact-tool.ts     (impact + test_impact + BFS)
│   ├── context-tool.ts    (context + explore)
│   ├── detect-tool.ts     (detect_changes)
│   ├── rename-tool.ts     (rename)
│   ├── route-tools.ts     (route_map + shape_check + api_impact)
│   └── graph-tools.ts     (cypher + shortest_path + get_code)
```

#### H2. 测试覆盖率偏低（26% 语句）

**问题**：测试文件数量多（176 个），但覆盖率仅 26%。说明测试集中在核心路径，大量边缘分支未覆盖。

**风险**：回归风险高，尤其是语言解析器和多线程 worker 路径。

**建议**：
- 短期：对 Top 10 最大文件（占总行数 30%）补充边界条件测试
- 中期：将覆盖率下限提升至 40% statements / 35% branches
- 配合 mutation testing 找出"假通过"的测试

#### H3. C/C++ 和 Objective-C 导入解析缺失

**问题**：C/C++ 和 Objective-C 有 type-extractor 但无 import-resolver，无法建立跨文件 IMPORTS 边。

**影响**：impact 分析在 C/C++ 项目中无法追踪 `#include` 依赖链。

**建议**：实现 `c-cpp.ts` import-resolver（解析 `#include` 为 IMPORTS 边）。

### 🟡 中优先级

#### M1. COBOL 支持基于正则（非 tree-sitter）

**问题**：COBOL 使用自定义正则处理器（2,279 + 1,453 = 3,732 行），而非 tree-sitter。维护成本高，解析准确率不可控。

**建议**：评估 `tree-sitter-cobol` 的成熟度，如可用则迁移。

#### M2. 数据流分析仅 3 语言有 DSL

**问题**：`dataflow/dsl/` 目录仅有 `javascript-static-edges.sg`、`python-static-edges.sg`、`typescript-static-edges.sg`。Java/Go/Rust 等主流语言未覆盖。

**影响**：数据流分析（DATA_FLOW/TAINTED 边）在非 JS/TS/Python 项目中无法工作。

**建议**：按优先级为 Java→Go→Rust 添加 DSL 规则。

#### M3. 检测规则数量偏少

**问题**：仅 6 条检测规则，且多为"缺失某模式"类型。缺少复杂逻辑缺陷检测（如数据竞争、死锁模式、SQL 注入等）。

**建议**：
- 参考 Semgrep/CodeQL 的规则体系，优先补充安全类规则（SQL injection、XSS、path traversal）
- 利用已有 taint-engine 实现 Source→Sink 安全规则

#### M4. Web UI 无测试

**问题**：`gitnexus-web/` 虽有 Playwright E2E（5 个），但无组件级单元测试（52 个源文件、24 个组件）。

**建议**：对核心交互组件（`GraphCanvas`、`QueryFAB`、`ProcessFlowModal`）添加 vitest + @testing-library 测试。

#### M5. Optional Dependencies 安装体验不佳

**问题**：`tree-sitter-kotlin/swift/dart` 为 optional，安装时会出 warning。tree-sitter native bindings 需要 python3 + make + g++。

**建议**：提供预编译 binary（napi-rs）或明确文档化安装前置条件。

### 🟢 低优先级

#### L1. 无 ESLint/Prettier 运行时配置

**问题**：仓库有 `eslint.config.mjs` 和 `.prettierrc`，但无 `npm run lint` 命令，pre-commit 仅运行 prettier。

**建议**：在 CI 和 pre-commit 中集成 ESLint。

#### L2. `parse-worker.ts` 中的语言预处理逻辑分散

**问题**：ArkTS struct→class 预处理、ObjC `#import` 过滤等逻辑内联在 worker 中（2,380 行），与核心解析逻辑耦合。

**建议**：提取为独立的 `preprocessors/` 目录，每种语言一个预处理器。

#### L3. Schema 演变无迁移机制

**问题**：`schema.ts` 定义了 LadybugDB 表结构，但无版本号或迁移脚本。添加新节点/边类型时依赖 `clean` + 重建。

**建议**：添加 schema version 和增量迁移逻辑。

#### L4. `server/api.ts`（1,270 行）与 `local-backend.ts` 逻辑重叠

**问题**：HTTP API 路由中直接实现部分查询逻辑，与 MCP backend 存在重复代码路径。

**建议**：HTTP API 统一委托给 LocalBackend，消除重复实现。

#### L5. 嵌入模型加载延迟

**问题**：首次嵌入需下载 onnxruntime 模型（~200MB），无进度提示，在无网环境会超时。

**建议**：添加模型缓存状态检查和离线回退提示。

---

## 10. 路线建议

### 短期（1-2 周）

| 项 | 优先级 | 预估工作量 |
|----|:------:|:---------:|
| 拆分 `local-backend.ts` 为工具模块 | H1 🔴 | 2-3 天 |
| Top 5 大文件补充测试（覆盖率→35%） | H2 🔴 | 3-4 天 |
| C/C++ `#include` import resolver | H3 🔴 | 1-2 天 |

### 中期（2-4 周）

| 项 | 优先级 | 预估工作量 |
|----|:------:|:---------:|
| Java/Go dataflow DSL 规则 | M2 🟡 | 每语言 2-3 天 |
| 安全检测规则（SQL injection, XSS） | M3 🟡 | 3-5 天 |
| Web UI 组件测试（核心 5 个组件） | M4 🟡 | 2-3 天 |
| HTTP API 委托到 LocalBackend | L4 🟢 | 1-2 天 |

### 长期（1-2 月）

| 项 | 优先级 | 预估工作量 |
|----|:------:|:---------:|
| COBOL tree-sitter 迁移评估 | M1 🟡 | 1-2 周 |
| LadybugDB schema 迁移机制 | L3 🟢 | 3-5 天 |
| 预处理器模块化 | L2 🟢 | 2-3 天 |
| 嵌入模型离线缓存 | L5 🟢 | 1-2 天 |

---

*报告完毕。本文档可作为项目评审、技术选型参考和迭代规划的基线文档。*
