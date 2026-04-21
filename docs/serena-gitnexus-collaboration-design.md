# Serena + GitNexus 协作设计方案

> 日期: 2026-04-16 | 状态: 设计阶段

## 1. 能力矩阵对比

### 1.1 GitNexus — 战略情报层 (Knowledge Graph)

| 类别 | 工具 | 核心能力 |
|------|------|----------|
| **搜索发现** | `query` | 语义+BM25混合搜索，返回执行流 |
| **全景视图** | `context` | 符号360度视图(caller/callee/process) |
| **影响分析** | `impact` | 爆炸半径分析(LOW→CRITICAL风险等级) |
| **变更检测** | `detect_changes` | git diff → 受影响的执行流 |
| **安全重命名** | `rename` | 图+文本协调重命名(dry_run预览) |
| **图查询** | `cypher` | 自定义Cypher查询 |
| **代码获取** | `get_code` | 按图节点取源码 |
| **路径追踪** | `shortest_path` | BFS最短路径 |
| **API分析** | `route_map` / `shape_check` / `api_impact` | 路由映射/响应形状/API影响 |
| **测试覆盖** | `test_impact` | 变更→受影响测试文件 |
| **数据流** | `explain_dataflow` | 污点传播安全解释 |
| **多仓库** | `group_*` / `list_repos` | 跨仓库搜索/合约/状态 |
| **元数据** | `tool_map` | 工具定义映射 |

**特征**: 预计算图索引、跨仓库、执行流感知、风险分级、需要 `npx gitnexus analyze` 维护索引

### 1.2 Serena — 战术精确层 (LSP)

| 类别 | 工具 | 核心能力 |
|------|------|----------|
| **符号导航** | `find_symbol` | LSP符号搜索(name_path模式) |
| **文件概览** | `get_symbols_overview` | 文件级符号地图 |
| **引用查找** | `find_referencing_symbols` | LSP引用查找(带代码片段) |
| **重命名** | `rename_symbol` | LSP精确重命名 |
| **符号编辑** | `replace_symbol_body` | 替换符号体 |
| **代码插入** | `insert_after_symbol` / `insert_before_symbol` | 精确位置插入 |
| **安全删除** | `safe_delete_symbol` | 无引用时才允许删除 |
| **项目记忆** | `read/write/list/edit/rename/delete_memory` | 项目级持久记忆 |
| **入职** | `onboarding` / `check_onboarding_performed` | 项目初始化 |

**特征**: 实时LSP、14+语言支持、AST级精度、编辑操作原子性、记忆系统独立

### 1.3 重叠区、互补区、独占区

```
┌─────────────────────────────────────────────────────────┐
│                    GitNexus 独占                         │
│  impact(风险分级) | detect_changes | test_impact        │
│  cypher | shortest_path | execution flows               │
│  route_map | shape_check | api_impact                   │
│  explain_dataflow | group_* (跨仓库) | tool_map         │
├──────────────────────────┬──────────────────────────────┤
│       重 叠 区           │     Serena 独占               │
│  · 符号搜索(query vs     │  replace_symbol_body          │
│    find_symbol)          │  insert_after/before_symbol   │
│  · 引用查找(context vs   │  safe_delete_symbol           │
│    find_referencing)     │  Memory系统(6个工具)          │
│  · 重命名(rename vs      │  onboarding工作流             │
│    rename_symbol)        │  LSP实时精度(14+语言)         │
│  · 代码读取(get_code vs  │                               │
│    find_symbol+body)     │                               │
└──────────────────────────┴──────────────────────────────┘
```

## 2. 核心洞察: 正交互补关系

| 维度 | GitNexus | Serena |
|------|----------|--------|
| **数据源** | 预计算图索引 | 实时LSP语言服务器 |
| **精度级别** | 函数/类级别 | AST/表达式级别 |
| **时效性** | 需re-analyze(可能过时) | 始终反映磁盘当前状态 |
| **跨仓库** | 支持group查询 | 单仓库 |
| **执行流** | 追踪完整process | 无 |
| **编辑能力** | 仅rename | 全面(替换/插入/删除) |
| **影响评估** | 风险分级(LOW→CRITICAL) | 仅引用计数 |
| **语言覆盖** | 依赖索引器(含COBOL) | 14+主流语言(LSP) |

**结论**: GitNexus回答"改了这个会怎样"，Serena回答"怎么精确地改"。

## 3. 协作流程设计

### 3.1 标准工作流: 探索→评估→执行→验证

```
Phase 1: 探索 (GitNexus主导)
  query("概念") → 找到相关执行流
  context({name}) → 符号全景视图
  └→ 输出: 理解代码结构和关系

Phase 2: 风险评估 (GitNexus主导)
  impact({target, direction:"upstream"}) → 爆炸半径
  test_impact({target}) → 受影响测试
  └→ 输出: 风险等级 + 需更新的符号列表

Phase 3: 精确编辑 (Serena主导)
  find_symbol({name_path_pattern, include_body:true}) → 读取精确代码
  replace_symbol_body / insert_after / insert_before → 执行编辑
  └→ 输出: 精确的代码修改

Phase 4: 验证 (GitNexus主导)
  detect_changes({scope:"staged"}) → 验证变更范围
  └→ 输出: 确认无意外影响
```

### 3.2 重命名场景: 双工具协同

```
Step 1: GitNexus dry_run预览
  gitnexus_rename({symbol_name:"old", new_name:"new", dry_run:true})
  → 获取所有引用点 + 置信度评分

Step 2: Serena LSP执行
  serena_rename_symbol({name_path:"old", relative_path, new_name:"new"})
  → LSP精确重命名，覆盖graph可能遗漏的上下文相关引用

Step 3: GitNexus验证
  gitnexus_detect_changes({scope:"all"})
  → 确认变更范围符合预期
```

### 3.3 调试场景: 互补追踪

```
Step 1: GitNexus定位问题域
  gitnexus_query({query:"error/symptom"}) → 相关执行流

Step 2: Serena精确读取
  serena_find_symbol({name_path_pattern:"suspect", include_body:true})
  → 获取精确实现代码 + LSP信息

Step 3: GitNexus追踪数据流
  gitnexus_shortest_path({source_id, target_id}) → 传播路径

Step 4: Serena验证修复
  serena_replace_symbol_body → 修改后 LSP自动检查类型错误
```

## 4. 无感触发机制

### 4.1 工具选择决策树

```
用户意图
  │
  ├─ "这个改了会影响什么？" → GitNexus: impact
  ├─ "帮我找到X的实现"      → Serena: find_symbol (精确)
  │                          GitNexus: query (上下文)
  ├─ "重命名X"              → GitNexus: rename(dry_run) 先
  │                          Serena: rename_symbol 后
  ├─ "在X后面加一段代码"    → Serena: insert_after_symbol
  ├─ "这个API谁在用？"      → GitNexus: api_impact / route_map
  ├─ "运行什么测试？"       → GitNexus: test_impact
  ├─ "删掉这个函数"         → Serena: safe_delete_symbol
  ├─ "解释下这段代码"       → Serena: find_symbol(body)
  │                          GitNexus: context(关系)
  ├─ "commit前检查"         → GitNexus: detect_changes
  └─ "记住这个设计决策"     → Serena: write_memory
```

### 4.2 Hook 自动路由设计

```jsonc
// .claude/settings.json — hooks配置
{
  "hooks": {
    "PreToolUse": [
      {
        // 编辑前自动影响分析
        "matcher": "Edit|Write|mcp__serena__replace_symbol_body|mcp__serena__insert_after_symbol|mcp__serena__insert_before_symbol",
        "hooks": [{
          "type": "command",
          "command": "node .claude/hooks/pre-edit-impact-check.js",
          "timeout": 15
        }]
      },
      {
        // Grep/Glob时注入GitNexus上下文(已有)
        "matcher": "Grep|Glob|Bash",
        "hooks": [{
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/gitnexus-hook.js",
          "timeout": 10
        }]
      }
    ],
    "PostToolUse": [
      {
        // Serena编辑后自动验证变更范围
        "matcher": "mcp__serena__replace_symbol_body|mcp__serena__rename_symbol|mcp__serena__insert_after_symbol|mcp__serena__insert_before_symbol|mcp__serena__safe_delete_symbol",
        "hooks": [{
          "type": "command",
          "command": "npx gitnexus detect-changes --scope unstaged --quiet",
          "timeout": 15
        }]
      }
    ]
  }
}
```

### 4.3 Skill 分流设计

| Skill | 主工具 | 辅助工具 | 触发条件 |
|-------|--------|----------|----------|
| `gitnexus-exploring` | GitNexus query/context | Serena find_symbol | "怎么工作的"、"理解架构" |
| `gitnexus-impact-analysis` | GitNexus impact | - | "改了会怎样"、"影响范围" |
| `gitnexus-debugging` | GitNexus query → Serena find_symbol | GitNexus shortest_path | "为什么报错"、"调试" |
| `gitnexus-refactoring` | GitNexus impact(dry_run) → Serena rename/replace | GitNexus detect_changes | "重命名"、"重构"、"提取" |
| `gitnexus-pr-review` | GitNexus detect_changes/impact | Serena find_referencing | "review PR"、"审查代码" |
| `serena-editing` (新) | Serena replace/insert | GitNexus impact(前置) | "修改代码"、"加个方法" |

### 4.4 CLAUDE.md 协作规则 (建议加入)

```markdown
## Serena + GitNexus 协作规则

### 工具选择优先级
1. **探索/理解** → GitNexus query/context 先 (获取执行流和关系图)
2. **影响评估** → GitNexus impact/test_impact (唯一选择)
3. **精确编辑** → Serena replace/insert/delete (LSP精度保障)
4. **重命名** → GitNexus rename(dry_run) 预览 → Serena rename_symbol 执行
5. **代码读取** → Serena find_symbol (精确body) 或 GitNexus get_code (图节点)

### 禁止事项
- 禁止在未运行 impact 的情况下执行 Serena 的编辑操作
- 禁止用 Serena replace_symbol_body 做跨文件重构(那是 GitNexus rename 的领域)
- 禁止忽略 GitNexus impact 返回的 HIGH/CRITICAL 警告

### 编辑前检查清单
1. [ ] gitnexus_impact → 确认风险等级
2. [ ] serena_find_referencing_symbols → 确认所有引用
3. [ ] 执行编辑 (Serena工具)
4. [ ] gitnexus_detect_changes → 验证变更范围
```

## 5. 实施路径

### Phase 1: 规则层 (立即可做)
- [ ] 更新 AGENTS.md / CLAUDE.md 添加协作规则
- [ ] 更新现有 6 个 gitnexus skill，标注何时应切换到 Serena

### Phase 2: Hook层 (需要开发)
- [ ] 开发 `pre-edit-impact-check.js` hook 脚本
- [ ] 配置 PostToolUse Serena → 自动 detect_changes

### Phase 3: Skill层 (可选)
- [ ] 创建统一的 `code-edit` skill，内部自动编排 GitNexus+Serena
- [ ] 更新 gitnexus-refactoring skill 为双工具编排

### Phase 4: 深度集成 (远期)
- [ ] Hook脚本调用两个MCP server实现自动化
- [ ] Serena onboarding 自动注入 GitNexus 图上下文

## 6. 注意事项

1. **索引时效**: GitNexus图可能过时，Serena LSP始终实时。编辑前优先参考Serena的实时数据。
2. **语言覆盖**: GitNexus支持COBOL等冷门语言，Serena依赖LSP。遇到无LSP的语言时回退到GitNexus。
3. **记忆冲突**: Serena有独立记忆系统，与Claude Code原生记忆不同。建议Serena记忆存技术架构，Claude记忆存偏好/流程。
4. **性能**: GitNexus图查询快(预计算)，Serena LSP首次启动可能慢。高频操作优先GitNexus。
5. **首次使用**: Serena需要 `check_onboarding_performed` + `onboarding`，应在项目首次会话时完成。
