---
name: code-explore
description: 深度探索代码 — 自动编排 GitNexus (关系/执行流) + Serena (精确代码)，用于理解架构和代码工作方式
---

# Code Explore — 代码探索

使用 GitNexus + Serena 协同探索代码，先获取关系全貌，再精确读取实现。

## 触发条件

用户说: "怎么工作的"、"理解这个模块"、"看看这个函数"、"分析下"、"解释下"

## 执行步骤

### Step 1: GitNexus 搜索定位

```
gitnexus_query({query: "用户描述的概念"})
```

找到相关的执行流和符号。返回按相关性排序的 process 和 symbol。

如果没有结果，回退到 `gitnexus_cypher` 或直接用 Serena `find_symbol` 搜索。

### Step 2: GitNexus 关系视图

对 Step 1 发现的关键符号:

```
gitnexus_context({name: "符号名"})
```

获取 360 度视图: 调用者、被调用者、参与的执行流、文件位置。

### Step 3: Serena 精确代码

对需要看具体实现的符号:

```
serena_find_symbol({name_path_pattern: "符号名", include_body: true})
```

获取 AST 精确的完整代码体。

**交替提醒**: 如果已经连续使用同一个服务器超过 5 次（例如连续多次 `serena_find_symbol`），必须切换回另一个服务器获取全局视角（用 `gitnexus_context` 看关系，或用 `gitnexus_query` 搜索相关执行流）。

### Step 4: 深入细节（可选）

根据需要选择:
- **数据流追踪**: `gitnexus_shortest_path({source_id, target_id})`
- **文件内部结构**: `serena_get_symbols_overview({relative_path: "文件路径", depth: 1})`
- **执行流详情**: 读取 `gitnexus://repo/{name}/process/{processName}` 资源

### Step 5: 输出总结

向用户展示:
1. **结构关系** — 谁调用谁、属于哪个执行流、在哪个模块
2. **代码实现** — 核心函数的完整代码
3. **关键发现** — 值得注意的设计模式、潜在问题

## 错误处理

| 情况 | 处理 |
|------|------|
| GitNexus 索引过时 | 提示用户运行 `npx gitnexus analyze`，回退到 Serena 全量搜索 |
| Serena LSP 未就绪 | 仅用 GitNexus context + Claude 内置 Read 读取代码 |
| 符号名不唯一 | 用 `gitnexus_context` 返回的候选列表让用户选择 |