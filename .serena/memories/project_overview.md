# GitNexus 项目概述

## 项目目的
GitNexus 是一个代码智能平台，支持代码索引、符号关系分析、执行流程追踪、漏洞检测等功能。通过 MCP (Model Context Protocol) 提供工具供 AI 助手使用。

## 技术栈
- **语言**: TypeScript, Python (serena 部分)
- **运行时**: Node.js
- **核心库**: tree-sitter (代码解析), TypeGraphQL, Express
- **CLI 框架**: commander.js
- **包管理**: npm

## 项目结构
```
GitNexus/
├── gitnexus/              # 主 CLI 包 (TypeScript)
│   ├── src/
│   │   ├── cli/          # 命令行入口 (20+ commands)
│   │   ├── core/        # 核心引擎
│   │   │   ├── ingestion/  # 代码解析和索引
│   │   │   ├── graph/   # 图数据库操作
│   │   │   ├── group/   # 服务边界检测
│   │   │   └── detection/ # 漏洞检测规则
│   │   ├── mcp/         # MCP 工具定义
│   │   └── server/      # HTTP API 服务器
├── serena/               # Serena 语义编程工具
├── eval/                 # 评估框架
└── gitnexus-web/        # Web UI
```

## 关键文件
- `gitnexus/src/core/ingestion/pipeline.ts` (2080 行) - 主管道，包含 runPipelineFromRepo
- `gitnexus/src/core/ingestion/call-processor.ts` (2945 行) - 调用关系处理
- `gitnexus/src/cli/index.ts` - CLI 入口，20+ 命令
