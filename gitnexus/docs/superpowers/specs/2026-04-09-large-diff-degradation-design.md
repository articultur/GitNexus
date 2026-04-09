# GitNexus 大型 Diff 安全降级设计 v2

> **状态**: ✅ 已实现 (2026-04-09)
> 
> **实现提交**:
> - `f2c2d63` feat(degradation): add degradation constants and types
> - `11c66c9` feat(mcp): refactor local backend tools and lbug schema handling
> - `5f45ad0` feat(degradation): add git diff parser degradation support
> - `ba84799` feat(degradation): update detect_changes tool for degradation support
> - `3816c15` feat(cli): add degradation control options to detect-changes
> - `2e9260e` feat(config): add environment variable support for degradation thresholds
> - `702962e` test(degradation): add unit tests for diff degradation
> - `2a7c4f2` test(degradation): add integration tests for diff degradation

## 1. 背景与问题

### 1.1 问题场景

当用户提交超大变更（如 +19,371 行）时，`gitnexus detect_changes` 会因 ENOBUFS 失败：

```
git diff <base> <head>  →  输出 >512KB 的 diff 文本
                          ↓
                    Node.js stdout pipe 缓冲区溢出
                          ↓
                    Error: ENOBUFS
```

### 1.2 根本原因

- Git diff 输出量超过 Node.js 子进程管道缓冲区限制（通常 64KB-256KB）
- 错误发生在 `git-diff-parser.ts` 的 `getDiffHunks()` 函数
- 不是 GitNexus 代码 bug，而是 git 命令层面的限制

### 1.3 设计目标

1. **优雅降级**：超大 diff 时返回有用信息，而不是完全失败
2. **保留价值**：即使没有行级变更，文件级信息仍有分析价值
3. **Drill-down 路径**：提供进一步精确查询的方法
4. **用户友好**：明确告知用户结果精度和后续操作建议
5. **向后兼容**：保持现有 MCP 客户端的兼容性
6. **性能可控**：避免降级模式引入新的性能问题

---

## 2. 设计方案

### 2.1 分层响应策略

```
┌─────────────────────────────────────────────────────────────┐
│                    Diff 大小检测                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ≤ 512KB          512KB - 2MB           > 2MB              │
│    ↓                 ↓                    ↓                │
│ 正常模式          降级模式            极端降级              │
│ 行级精度          符号级精度          文件级精度            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 三种精度级别

| 级别 | 触发条件 | 返回信息 | 精度 |
|------|---------|---------|------|
| **normal** | diff ≤ 512KB | 文件 + 行变更 + 精确符号 | 行级 |
| **symbol-level** | 512KB < diff ≤ 2MB | 文件 + 文件内所有符号 | 符号级 |
| **file-level** | diff > 2MB | 仅文件列表 | 文件级 |

### 2.3 降级模式返回格式

```typescript
interface DegradedDetectResult {
  // 元信息
  truncated: true;
  precision: 'symbol-level' | 'file-level';
  reason: 'diff_exceeded_512kb' | 'diff_exceeded_2mb';
  original_diff_size: number;  // 字节数
  
  // 统计信息 [v2 新增]
  stats: {
    total_files: number;
    total_symbols: number;
    diff_size_bytes: number;
    diff_size_human: string;
  };
  
  // 变更信息
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    
    // symbol-level 精度才有
    symbols?: Array<{
      name: string;
      uid: string;
      type: 'Function' | 'Method' | 'Class' | 'Variable';
      line_start: number;
      line_end: number;
    }>;
    
    // drill-down 命令 [v2 修复：使用 --uid]
    drill_down?: {
      command: string;  // 包含 --uid 参数
      description: string;
    };
  }>;
  
  // 用户指导
  suggestion: string;
  alternative_commands: string[];
  
  // [v2 新增] 向后兼容字段
  changed_files: string[];
  affected_symbols: Array<{ name: string; uid: string; file: string }>;
  execution_flows: [];  // 明确为空
}
```

---

## 3. 实现细节

### 3.1 常量定义

```typescript
// src/mcp/local/tools/shared.ts

/** Diff 大小阈值 */
export const DIFF_SIZE_THRESHOLDS = {
  /** 正常模式最大值 - 行级精度 */
  NORMAL_MAX: 512 * 1024,  // 512KB
  
  /** 降级模式最大值 - 符号级精度 */
  SYMBOL_LEVEL_MAX: 2 * 1024 * 1024,  // 2MB
  
  /** [v2 新增] 滞后系数 - 防止边界抖动 */
  HYSTERESIS: 0.95,
} as const;

/** [v2 新增] 可配置阈值 */
export interface DegradationConfig {
  normalMaxBytes?: number;
  symbolLevelMaxBytes?: number;
  enableSymbolLevel?: boolean;
}

/** 精度级别 */
export type DetectPrecision = 'normal' | 'symbol-level' | 'file-level';

/** 降级原因 */
export type DegradedReason = 
  | 'diff_exceeded_512kb' 
  | 'diff_exceeded_2mb'
  | 'file_count_exceeded';
```

### 3.2 [v2 新增] 文件路径索引

```typescript
// src/mcp/local/local-backend.ts

import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types.js';

/**
 * 文件路径到符号的索引，加速符号查询
 */
export class FilePathIndex {
  private index: Map<string, GraphNode[]> = new Map();
  private built = false;
  
  /**
   * 从知识图谱构建索引
   */
  build(graph: KnowledgeGraph): void {
    if (this.built) return;
    
    for (const node of graph.iterNodes()) {
      const filePath = node.properties.filePath;
      if (!filePath) continue;
      
      if (!this.index.has(filePath)) {
        this.index.set(filePath, []);
      }
      this.index.get(filePath)!.push(node);
    }
    
    // 按行号排序
    for (const [path, symbols] of this.index) {
      symbols.sort((a, b) => 
        (a.properties.line || 0) - (b.properties.line || 0)
      );
    }
    
    this.built = true;
  }
  
  /**
   * 查找文件内的所有符号
   * O(1) 查找，不再需要遍历全图
   */
  findSymbolsInFile(filePath: string): GraphNode[] {
    return this.index.get(filePath) || [];
  }
  
  /**
   * 获取索引统计信息
   */
  getStats(): { files: number; symbols: number } {
    let symbols = 0;
    for (const syms of this.index.values()) {
      symbols += syms.length;
    }
    return { files: this.index.size, symbols };
  }
}
```

### 3.3 Git Diff 解析器改造

核心改动：
1. 添加 diff 大小检测和精度级别判断
2. 实现三层降级逻辑
3. 添加滞后机制防止边界抖动
4. 使用文件路径索引加速符号查询
5. 多层兜底方案（git log）

### 3.4 detect_changes 工具改造

核心改动：
1. 支持单文件模式
2. 构建降级响应时保持向后兼容
3. 添加统计信息

### 3.5 CLI 命令扩展

新增参数：
- `--file <path>`: 单文件模式
- `--precision <level>`: 强制精度级别
- `--normal-max <bytes>`: 自定义阈值
- `--symbol-max <bytes>`: 自定义阈值

### 3.6 配置文件支持

支持环境变量和配置文件自定义阈值。

---

## 4. 示例输出

### 4.1 符号级降级输出

```json
{
  "truncated": true,
  "precision": "symbol-level",
  "reason": "diff_exceeded_512kb",
  "stats": {
    "total_files": 15,
    "total_symbols": 87,
    "diff_size_bytes": 1048576,
    "diff_size_human": "1.00 MB"
  },
  "files": [
    {
      "path": "src/auth/login.ts",
      "status": "modified",
      "symbols": [
        {
          "name": "validateUser",
          "uid": "func_abc123",
          "type": "Function",
          "line_start": 45,
          "line_end": 89
        }
      ],
      "drill_down": {
        "command": "gitnexus impact validateUser --uid func_abc123 --direction upstream",
        "description": "Analyze impact of validateUser (exact match by UID)"
      }
    }
  ],
  "suggestion": "Diff too large for line-level analysis...",
  "changed_files": ["src/auth/login.ts", ...],
  "affected_symbols": [...],
  "execution_flows": []
}
```

---

## 5. 测试计划

### 5.1 单元测试

- 边界值测试（正好 512KB / 2MB）
- 图索引不可用时的降级行为
- 自定义配置测试
- 向后兼容测试

### 5.2 集成测试

- 超大提交降级测试
- 单文件模式测试
- 自定义阈值测试

### 5.3 性能测试

- 文件路径索引构建性能
- 符号查询性能

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解措施 | 状态 |
|------|------|---------|------|
| 符号级降级可能包含未修改的符号 | 误报 | 明确标注精度级别，提供 drill-down | ✅ |
| 文件级降级信息有限 | 价值降低 | 提供单文件分析模式 | ✅ |
| 符号查询性能 | 大仓库慢 | 文件路径索引 O(1) 查找 | ✅ |
| Drill-down 不精确 | 多符号歧义 | 使用 --uid 参数 | ✅ |
| 向后兼容 | MCP 客户端报错 | 保持兼容字段 | ✅ |
| 多层降级失败 | 最终无结果 | git log 兜底 | ✅ |

---

## 7. 变更日志

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-04-09 | 初始设计 |
| v2 | 2026-04-09 | 加入评审发现的 10 个缺陷修复 |
| v3 | 2026-04-09 | 实现完成，添加实现状态和提交记录 |