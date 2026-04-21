# GitNexus 项目整体架构与结构

> 更新时间: 2026-04-16

## 1. 项目概述

GitNexus 是一个**本地代码智能引擎**，通过 Tree-sitter 解析 + Neo4j 图数据库索引代码结构，为 AI 编码助手提供零服务端调用的代码理解能力。核心能力包括：代码符号查询、影响分析、数据流追溯、安全检测、跨仓库 Group 管理。

**核心技术栈**: TypeScript (CLI + MCP + Web) | Python (Eval + Serena) | Neo4j | Tree-sitter

**支持语言**: TypeScript/JavaScript, Python, Java, Kotlin, Go, Rust, C/C++, C#, Swift, Objective-C, PHP, Ruby, Dart, COBOL, Vue, ArkTS 等 20+ 种语言

---

## 2. 顶层目录结构

```
GitNexus/                          # Monorepo 根目录
├── gitnexus/                      # [TS] 核心 CLI 包 — 分析引擎 + MCP 服务器
├── gitnexus-shared/               # [TS] 共享类型定义 (graph/lbug/language-detection)
├── gitnexus-web/                  # [TS] Web UI — React + Vite 图谱可视化界面
├── gitnexus-claude-plugin/        # Claude Code 插件 skills
├── gitnexus-cursor-integration/   # Cursor 编辑器集成 skills
├── gitnexus-test-setup/           # 测试辅助配置
├── serena/                        # [Python] Serena — LSP 驱动的语义编码工具 (git submodule)
├── eval/                          # [Python] 评估框架 — 3-arm 对比评估系统
├── docs/                          # 项目文档
├── .claude/                       # Claude Code skills 和配置
├── .serena/                       # Serena 项目配置
├── .omc/                          # OMC 工作流状态
└── .gitnexus/                     # GitNexus 索引元数据
```

---

## 3. 核心模块详解

### 3.1 gitnexus/ — 核心 CLI 包

**package.json scripts**: `analyze`, `mcp`, `serve`, `test:unit`, `build`, `clean` 等

#### 3.1.1 src/cli/ — 命令行入口 (24 个文件)

| 命令文件 | CLI 命令 | 功能 |
|----------|----------|------|
| `index.ts` | `gitnexus` | CLI 入口和命令注册 |
| `analyze.ts` | `gitnexus analyze` | 核心索引命令，编排整个分析管道 |
| `mcp.ts` | `gitnexus mcp` | 启动 MCP stdio 服务器 |
| `serve.ts` | `gitnexus serve` | 启动 HTTP + MCP 双协议服务器 |
| `setup.ts` | `gitnexus setup` | 交互式初始化向导 |
| `index-repo.ts` | `gitnexus index-repo` | 索引单个仓库 |
| `group.ts` | `gitnexus group` | 跨仓库 Group 管理 |
| `tool.ts` | `gitnexus tool` | 直接调用单个分析工具 |
| `use.ts` | `gitnexus use` | 快捷使用指定工具 |
| `query.ts` | (内置) | 语义查询入口 |
| `ai-context.ts` | (内置) | AI 上下文生成 |
| `wiki.ts` | `gitnexus wiki` | Wiki 文档自动生成 |
| `push.ts` | `gitnexus push` | 推送索引到远程存储 |
| `pull.ts` | `gitnexus pull` | 拉取远程索引 |
| `remote.ts` | `gitnexus remote` | 远程存储管理 |
| `remote-config.ts` | (内置) | 远程配置管理 |
| `clean.ts` | `gitnexus clean` | 清理索引缓存 |
| `status.ts` | `gitnexus status` | 索引状态查看 |
| `list.ts` | `gitnexus list` | 列出已索引仓库 |
| `augment.ts` | `gitnexus augment` | 增量增强索引 |
| `eval-server.ts` | `gitnexus eval-server` | 评估用的 API 服务器 |
| `skill-gen.ts` | (内置) | Skill 文件自动生成 |

#### 3.1.2 src/core/ — 核心分析引擎

##### ingestion/ — 代码索引管道 (48 个文件/目录, 代码量最大)

这是整个项目最核心的模块，负责将源代码解析为图数据库中的节点和关系。

**主管道**:
| 文件 | 大小 | 功能 |
|------|------|------|
| `pipeline.ts` | 78KB | 索引主管道，编排所有 processor，支持增量索引 |
| `run-analyze.ts` | 13KB | analyze 命令的执行逻辑 |
| `parse-content.ts` | 1.3KB | 文件内容解析入口 |

**核心处理器 (Processors)**:
| 文件 | 大小 | 功能 |
|------|------|------|
| `call-processor.ts` | 119KB | 函数调用关系提取 — 最大单文件，处理跨文件调用链 |
| `cobol-processor.ts` | 56KB | COBOL 语言特殊处理 |
| `tree-sitter-queries.ts` | 57KB | Tree-sitter 语法树查询模板 |
| `type-env.ts` | 54KB | 类型环境管理 — 类型推断和解析 |
| `framework-detection.ts` | 34KB | 框架自动检测 (Express, Spring, Django 等) |
| `mro-processor.ts` | 30KB | Method Resolution Order — 继承链方法解析 |
| `process-processor.ts` | 18KB | 执行流程 (Execution Flow) 提取 |
| `heritage-processor.ts` | 15KB | 继承/实现关系处理 |
| `parsing-processor.ts` | 25KB | 语法解析处理器 |
| `import-processor.ts` | 19KB | 导入关系处理 |
| `community-processor.ts` | 14KB | 社区发现算法 — 自动功能聚类 |
| `entry-point-scoring.ts` | 15KB | 入口点评分 — 识别 main/router/handler |
| `symbol-table.ts` | 15KB | 符号表管理 |
| `export-detection.ts` | 9KB | 导出检测 |

**语言支持层**:
| 目录/文件 | 功能 |
|-----------|------|
| `languages/` | 20 个语言配置文件 (typescript, python, java, go, rust, c-cpp, csharp, swift, objective-c, php, ruby, dart, kotlin, cobol, vue, arkts) |
| `language-provider.ts` | 语言提供者注册中心 |
| `language-config.ts` | 语言通用配置 |
| `import-resolvers/` | 13 个语言导入解析器 |
| `named-bindings/` | 13 个语言命名绑定解析器 (函数参数、变量绑定) |
| `type-extractors/` | 16 个类型提取器 (含 taint 分析和模板推断) |
| `field-extractors/` | 14 个字段/属性提取器配置 |
| `method-extractors/` | 13 个方法提取器配置 |
| `route-extractors/` | 11 个 Web 框架路由提取器 (Spring, Django, Flask, FastAPI, Rails, Laravel, Next.js, Express middleware) |
| `call-sites/` | 调用点提取 |
| `class-extractors/` | 类结构提取 |

**数据流分析 (dataflow/)**:
| 文件 | 功能 |
|------|------|
| `cfg-builder.ts` | 控制流图 (CFG) 构建 |
| `dfa-engine.ts` | 数据流分析引擎 |
| `taint-engine.ts` | 污点追踪引擎 |
| `path-sensitive.ts` | 路径敏感分析 |
| `lattice.ts` | 数据流格 (Lattice) |
| `incremental.ts` | 增量数据流更新 |
| `cfg-post-processor.ts` | CFG 后处理 |
| `cfg-from-tsg.ts` | 从 Tree-sitter 图构建 CFG |
| `storage-writer.ts` | 数据流结果写入存储 |
| `dsl/` | 12 种语言的静态边 DSL 定义 (.sg 文件) |

**COBOL 支持 (cobol/)**:
| 文件 | 功能 |
|------|------|
| `cobol-preprocessor.ts` | COBOL 预处理器 (84KB) |
| `cobol-copy-expander.ts` | COPY 语句展开 |
| `cobol-treesitter-adapter.ts` | Tree-sitter 适配器 |
| `jcl-parser.ts` | JCL 解析器 |
| `jcl-processor.ts` | JCL 处理器 |

**并行处理 (workers/)**:
| 文件 | 功能 |
|------|------|
| `parse-worker.ts` | 解析 Worker (87KB) |
| `worker-pool.ts` | Worker 线程池管理 |

**辅助工具 (utils/)**:
| 文件 | 功能 |
|------|------|
| `ast-helpers.ts` | AST 辅助函数 |
| `call-analysis.ts` | 调用分析工具 |
| `method-props.ts` | 方法属性提取 |

##### embeddings/ — 向量嵌入
| 文件 | 功能 |
|------|------|
| `embedder.ts` | 嵌入向量生成 (支持多种 provider) |
| `embedding-pipeline.ts` | 嵌入管道编排 |
| `http-client.ts` | 嵌入 API HTTP 客户端 |
| `text-generator.ts` | 文本描述生成 |
| `types.ts` | 嵌入相关类型 |

##### detection/ — 安全漏洞检测
| 文件 | 功能 |
|------|------|
| `diff-detector.ts` | 基于 diff 的变更检测 |
| `rule-engine.ts` | 检测规则引擎 |
| `rules/sql-injection.ts` | SQL 注入检测 |
| `rules/xss.ts` | XSS 跨站脚本检测 |
| `rules/path-traversal.ts` | 路径穿越检测 |
| `rules/missing-guard.ts` | 缺少守卫条件检测 |
| `rules/missing-concurrency-guard.ts` | 缺少并发守卫检测 |
| `rules/missing-exception-handling.ts` | 缺少异常处理检测 |
| `rules/missing-resource.ts` | 资源泄漏检测 |
| `rules/missing-return-check.ts` | 返回值未检查检测 |
| `rules/missing-unwrap.ts` | 未解包检测 |

##### group/ — 跨仓库 Group 管理
| 文件 | 功能 |
|------|------|
| `service.ts` | Group 服务核心逻辑 |
| `config-parser.ts` | Group 配置解析 |
| `matching.ts` | 跨仓库接口匹配 |
| `service-boundary-detector.ts` | 服务边界自动检测 |
| `sync.ts` | Group 同步逻辑 |
| `storage.ts` | Group 存储层 |
| `extractors/grpc-extractor.ts` | gRPC 接口提取 |
| `extractors/http-route-extractor.ts` | HTTP 路由接口提取 |
| `extractors/topic-extractor.ts` | 消息主题接口提取 |

##### 其他 core 子模块
| 目录 | 功能 |
|------|------|
| `graph/` | 图操作封装 (graph.ts, types.ts) |
| `lbug/` | LBug 格式适配器 — CSV 生成、schema 管理、连接池 |
| `search/` | 搜索引擎 — BM25 索引 + 混合搜索 |
| `tree-sitter/` | Tree-sitter 解析器加载器 |
| `wiki/` | Wiki 文档生成 — 图谱查询、LLM 客户端、Cursor 集成 |
| `augmentation/` | 索引增强引擎 |

#### 3.1.3 src/mcp/ — MCP 服务器

| 文件/目录 | 大小 | 功能 |
|-----------|------|------|
| `server.ts` | 12KB | MCP 服务器入口，注册所有工具和资源 |
| `tools.ts` | 28KB | 核心工具注册表和分发 |
| `resources.ts` | 17KB | MCP 资源定义 (repo context, clusters, processes) |
| `compatible-stdio-transport.ts` | 7KB | 兼容性 stdio 传输层 |
| `staleness.ts` | 0.2KB | 索引新鲜度检查 |
| `core/` | - | Embedder 适配器 + LBug 适配器 |
| `local/` | - | 本地后端实现 |
| `local/local-backend.ts` | 20KB | 本地文件系统后端 |
| `local/tools/` | - | 13 个独立工具实现 |

**MCP 工具清单 (local/tools/)**:
| 工具文件 | 工具名称 | 功能 |
|----------|----------|------|
| `query.ts` | `gitnexus_query` | 语义代码搜索 |
| `context.ts` | `gitnexus_context` | 符号 360 度视图 (调用者/被调用者/执行流) |
| `impact.ts` | `gitnexus_impact` | 变更影响分析 (blast radius) |
| `detect.ts` | `gitnexus_detect_changes` | 变更检测 (staged/unstaged/compare) |
| `rename.ts` | `gitnexus_rename` | 图感知安全重命名 |
| `graph-tools.ts` | `gitnexus_cypher` + 多个 | 图查询工具集 |
| `route-tools.ts` | `gitnexus_route_map` + 多个 | 路由映射工具 |
| `test-impact.ts` | `gitnexus_test_impact` | 测试影响分析 |
| `dataflow.ts` | `gitnexus_explain_dataflow` | 数据流解释 |
| `overview.ts` | `gitnexus_tool_map` | 代码概览 |
| `resources.ts` | (内部) | 资源读取工具 |
| `shared.ts` | (内部) | 共享工具函数 |
| `git-diff-parser.ts` | (内部) | Git diff 解析 |

#### 3.1.4 src/server/ — HTTP 服务器
| 文件 | 大小 | 功能 |
|------|------|------|
| `api.ts` | 46KB | REST API 路由定义 (仓库管理、分析、查询、配置) |
| `analyze-job.ts` | 6KB | 异步分析任务管理 |
| `analyze-worker.ts` | 3KB | 分析 Worker |
| `git-clone.ts` | 4KB | Git 仓库克隆 |
| `mcp-http.ts` | 4KB | MCP over HTTP 传输 |

#### 3.1.5 src/storage/ — 存储层
| 文件 | 功能 |
|------|------|
| `repo-manager.ts` | 仓库索引文件管理 |
| `git.ts` | Git 操作封装 |

---

### 3.2 gitnexus-web/ — Web 可视化界面

React 18 + Vite + TypeScript + Tailwind CSS + WebGPU 图渲染

#### 组件层 (src/components/)

| 组件 | 功能 |
|------|------|
| `App.tsx` | 应用主框架 |
| `GraphCanvas.tsx` | WebGPU/Sigma.js 图谱可视化画布 |
| `RepoAnalyzer.tsx` | 仓库分析主视图 |
| `RepoLanding.tsx` | 仓库着陆页 |
| `FileTreePanel.tsx` | 文件树浏览器 |
| `ProcessesPanel.tsx` | 执行流程面板 |
| `ProcessFlowModal.tsx` | 执行流程详情弹窗 |
| `CodeReferencesPanel.tsx` | 代码引用面板 |
| `QueryFAB.tsx` | 浮动查询按钮 |
| `RightPanel.tsx` | 右侧信息面板 |
| `Header.tsx` | 顶部导航 |
| `SettingsPanel.tsx` | 设置面板 (40KB) |
| `HelpPanel.tsx` | 帮助文档面板 |
| `OnboardingGuide.tsx` | 新手引导 |
| `DropZone.tsx` | 拖拽分析区域 |
| `AnalyzeProgress.tsx` | 分析进度 |
| `AnalyzeOnboarding.tsx` | 分析入门 |
| `MarkdownRenderer.tsx` | Markdown 渲染器 |
| `MermaidDiagram.tsx` | Mermaid 图表渲染 |
| `StatusBar.tsx` | 状态栏 |
| `ToolCallCard.tsx` | MCP 工具调用卡片 |
| `LoadingOverlay.tsx` | 加载遮罩 |
| `EmbeddingStatus.tsx` | 嵌入状态 |
| `WebGPUFallbackDialog.tsx` | WebGPU 降级对话框 |

#### 数据层
| 目录/文件 | 功能 |
|-----------|------|
| `hooks/useAppState.tsx` | 全局应用状态管理 (44KB) |
| `hooks/useSigma.ts` | Sigma.js 图渲染 hook |
| `hooks/useBackend.ts` | 后端 API 调用 hook |
| `services/backend-client.ts` | 后端 HTTP 客户端 (22KB) |
| `lib/graph-adapter.ts` | 图数据适配 |
| `lib/mermaid-generator.ts` | Mermaid 图表生成 |
| `core/graph/` | 图核心逻辑 |
| `core/llm/` | LLM 集成 |
| `core/ingestion/` | 前端索引逻辑 |
| `config/` | 前端配置 |

#### E2E 测试
- Playwright 测试框架
- `e2e/` 目录包含端到端测试用例

---

### 3.3 gitnexus-shared/ — 共享类型定义

| 文件/目录 | 功能 |
|-----------|------|
| `src/index.ts` | 导出入口 |
| `src/graph/` | 图相关类型定义 |
| `src/lbug/` | LBug 格式类型 |
| `src/language-detection.ts` | 语言自动检测逻辑 |
| `src/languages.ts` | 语言枚举和元数据 |
| `src/pipeline.ts` | 管道相关类型 |

---

### 3.4 eval/ — 评估框架 (Python)

3-arm 对比评估系统：**baseline** (普通搜索) vs **search_agent** vs **gitnexus**

#### 核心文件
| 文件 | 大小 | 功能 |
|------|------|------|
| `claude_eval.py` | 27KB | 主评估脚本 — 编排 3-arm 执行、评分、报告 |
| `lib/agent_executor.py` | 15KB | Claude agent 执行器 — 调用 Anthropic API |
| `lib/dual_scorer.py` | 32KB | 双重评分系统 — 正确性 + 工具合规性 |
| `lib/schema.py` | 7KB | 数据模型定义 (EvalCase, EvalResult, TripleResult) |
| `lib/stats.py` | 5KB | 统计分析 (平均值、置信区间、胜率) |
| `lib/difficulty_scorer.py` | 3KB | 题目难度评分 |
| `lib/worktree_manager.py` | 10KB | Git worktree 管理 (隔离执行环境) |
| `lib/budget.py` | 1KB | Token 预算控制 |
| `lib/meta.py` | 3KB | 元数据管理 |

#### 评估流程
```
1. 加载 dataset/ 中的评估案例 (JSONL)
2. 对每个案例，并行启动 3 个 arm:
   - baseline:    Claude + 基础工具 (Grep/Read/Glob)
   - search_agent: Claude + search agent 工具
   - gitnexus:    Claude + GitNexus MCP 工具
3. 每个 arm 在独立的 git worktree 中执行
4. dual_scorer 评分: 正确性 + 工具使用合规度
5. 生成对比报告 (stats + 可视化)
```

#### 目录结构
```
eval/
├── claude_eval.py           # 主入口
├── lib/                      # 评估库
├── dataset/                  # JSONL 格式评估数据集
├── snapshots/                # 远程仓库快照 (供测试用)
├── results/                  # 评估结果输出
├── prompts/                  # 评估 prompt 模板
├── scripts/                  # 辅助脚本 (数据集准备等)
├── schemas/                  # JSON Schema
├── test/                     # 评估框架自身测试
└── run/                      # 运行时临时文件
```

---

### 3.5 serena/ — Serena 语义编码工具 (Python 子模块)

Serena 是一个独立的 LSP 驱动编码助手，通过 git submodule 集成到项目中。

#### 核心模块 (src/serena/)
| 文件 | 大小 | 功能 |
|------|------|------|
| `agent.py` | 48KB | Agent 编排引擎 |
| `cli.py` | 54KB | CLI 入口 |
| `symbol.py` | 46KB | 符号管理 (查找、读取、编辑、重命名) |
| `mcp.py` | 16KB | MCP 服务器实现 |
| `project.py` | 33KB | 项目管理 (加载、配置、索引) |
| `code_editor.py` | 20KB | 代码编辑器 (插入、替换、删除符号) |
| `hooks.py` | 19KB | Hook 系统 |
| `dashboard.py` | 38KB | Web Dashboard |
| `ls_manager.py` | 11KB | Language Server 管理器 |
| `task_executor.py` | 10KB | 任务执行器 |

#### 工具集 (src/serena/tools/)
| 文件 | 功能 |
|------|------|
| `symbol_tools.py` | 符号操作工具 (查找、引用、重命名) |
| `file_tools.py` | 文件操作工具 |
| `memory_tools.py` | 项目记忆工具 |
| `config_tools.py` | 配置工具 |
| `cmd_tools.py` | 命令执行工具 |
| `workflow_tools.py` | 工作流工具 |
| `jetbrains_tools.py` | JetBrains IDE 集成 |
| `query_project_tools.py` | 跨项目查询 |
| `tools_base.py` | 工具基类 |

#### SolidLSP (src/solidlsp/)
统一的 Language Server Protocol 客户端库，内置 **58 个语言服务器** 适配器:
- TypeScript, Python, Java, Go, Rust, C#, C++, Kotlin, Swift, Ruby, PHP, Dart, Scala, Haskell, Elixir, Erlang, Lua, Fortran, MATLAB, Solidity 等

#### Interprompt (src/interprompt/)
提示词工程库 — Jinja 模板、多语言 prompt 管理

---

### 3.6 集成层

#### gitnexus-claude-plugin/ — Claude Code 插件
Skills 定义:
| Skill | 功能 |
|-------|------|
| `gitnexus-exploring` | 代码探索 |
| `gitnexus-debugging` | 调试辅助 |
| `gitnexus-impact-analysis` | 影响分析 |
| `gitnexus-pr-review` | PR 审查 |
| `gitnexus-guide` | 工具参考指南 |

#### gitnexus-cursor-integration/ — Cursor 集成
与 Claude 插件类似，提供 Cursor 编辑器 skill 支持 (exploring, debugging, impact-analysis, pr-review)

---

## 4. 关键数据流

### 4.1 索引管道 (Indexing Pipeline)

```
$ gitnexus analyze
        │
        ▼
FileSystemWalker ─── 遍历源文件，跳过 .gitignore/node_modules
        │
        ▼
LanguageProvider ─── 语言检测 + 加载对应 Tree-sitter grammar
        │
        ▼
ParseWorker ─── 多线程并行解析
        │
        ▼
Pipeline (串行编排)
        │
        ├── ParsingProcessor    ──→ 符号表 (函数/类/变量/导入)
        ├── HeritageProcessor   ──→ 继承/实现关系
        ├── ImportProcessor     ──→ 跨文件导入关系
        ├── CallProcessor       ──→ 函数调用关系 (119KB 核心)
        ├── MROProcessor        ──→ 方法解析顺序
        ├── TypeEnv             ──→ 类型推断 + 解析
        ├── FrameworkDetection  ──→ 框架识别 (路由/中间件)
        ├── ProcessProcessor    ──→ Execution Flow 提取
        ├── CommunityProcessor  ──→ 功能聚类 (Louvain 算法)
        ├── EntryPointScoring   ──→ 入口点识别
        └── DataflowPipeline    ──→ CFG + DFA + 污点分析
                │
                ▼
        Neo4j Graph Storage ──→ 节点 (Symbol) + 边 (CALLS, IMPORTS, INHERITS...)
```

### 4.2 MCP 查询流程 (Query Flow)

```
Claude Code / Cursor
        │
        ▼ (MCP stdio)
gitnexus mcp
        │
        ├── gitnexus_query("auth")     ──→ 图谱语义搜索
        ├── gitnexus_context("login")  ──→ 符号全息视图
        ├── gitnexus_impact("User")    ──→ 变更影响分析
        ├── gitnexus_detect_changes()  ──→ Git diff 变更检测
        ├── gitnexus_rename("old","new") ─→ 图感知重命名
        └── gitnexus_cypher("MATCH...") ─→ 自定义 Cypher 查询
        │
        ▼
Neo4j 图数据库 ──→ 返回符号、关系、执行流
```

### 4.3 安全检测流程 (Detection Flow)

```
$ gitnexus tool detect
        │
        ▼
DiffDetector ─── 获取 Git diff
        │
        ▼
RuleEngine ─── 加载检测规则
        │
        ├── SQLInjection     ──→ 检测 SQL 注入
        ├── XSS              ──→ 检测跨站脚本
        ├── PathTraversal    ──→ 检测路径穿越
        ├── MissingGuard     ──→ 检测缺失守卫
        ├── MissingResource  ──→ 检测资源泄漏
        └── ... (9 种规则)
        │
        ▼
检测结果 (文件 + 行号 + 风险等级 + 建议)
```

### 4.4 评估流程 (Eval Flow)

```
$ python claude_eval.py
        │
        ▼
加载 dataset/*.jsonl 评估案例
        │
        ▼
WorktreeManager ─── 创建 3 个隔离的 git worktree
        │
        ├── baseline arm     ──→ Claude + 基础工具 (Grep/Read/Glob)
        ├── search_agent arm ──→ Claude + search agent
        └── gitnexus arm     ──→ Claude + GitNexus MCP 工具
        │
        ▼
AgentExecutor ─── 调用 Anthropic API 执行任务
        │
        ▼
DualScorer ─── 双重评分 (正确性 + 工具合规度)
        │
        ▼
Stats + Report ─── 统计对比 + 生成报告
```

---

## 5. 存储架构

| 存储层 | 技术 | 用途 |
|--------|------|------|
| 图数据库 | Neo4j | 代码实体 (Symbol, File, Cluster) + 关系 (CALLS, IMPORTS, INHERITS...) |
| 文件快照 | `snapshots/` | 远程仓库索引快照 |
| 向量索引 | 文件系统 | 嵌入向量 (如启用 `--embeddings`) |
| 元数据 | `.gitnexus/meta.json` | 索引统计信息、嵌入数量 |
| Group 存储 | YAML + Graph | 跨仓库 Group 配置和同步数据 |

---

## 6. 外部集成

| 集成 | 连接方式 | 用途 |
|------|----------|------|
| Claude Code | MCP stdio (`gitnexus mcp`) | 代码查询、影响分析、变更检测 |
| Cursor | Skill 文件 | 代码探索、调试、重构 |
| Serena | MCP stdio (`uvx serena mcp`) | LSP 级符号编辑、引用查找 |
| Web UI | HTTP (`gitnexus serve`) | 图谱可视化、交互式分析 |
| Neo4j | Bolt 协议 | 图数据库 |
| Anthropic API | HTTPS | 评估框架调用 Claude |

---

## 7. 构建与开发

| 命令 | 位置 | 功能 |
|------|------|------|
| `npm run build` | gitnexus/ | 编译 TypeScript |
| `npm run test:unit` | gitnexus/ | 运行单元测试 (vitest) |
| `npm run lint` | 根目录 | ESLint 检查 |
| `npx gitnexus analyze` | 项目目录 | 执行代码分析 |
| `npx gitnexus analyze --embeddings` | 项目目录 | 分析 + 生成嵌入 |
| `python claude_eval.py` | eval/ | 运行评估 |

**CI/CD**: `.github/` 目录包含 GitHub Actions 配置
**代码质量**: Husky + lint-staged + Prettier + ESLint
**测试**: Vitest (单元) + Playwright (E2E)

---

## 8. 配置文件

| 文件 | 功能 |
|------|------|
| `.mcp.json` | MCP 服务器配置 (gitnexus + serena) |
| `.gitnexus/meta.json` | GitNexus 索引元数据 |
| `.serena/` | Serena 项目配置 |
| `.claude/` | Claude Code skills 和设置 |
| `CLAUDE.md` | Claude Code 项目指令 |
| `AGENTS.md` | Agent 行为规范 |
| `GUARDRAILS.md` | 开发护栏规则 |
| `ARCHITECTURE.md` | 架构文档 |
