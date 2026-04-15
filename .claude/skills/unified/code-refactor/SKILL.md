---
name: code-refactor
description: 安全重构 — GitNexus 预览影响 + Serena LSP 精确执行重命名/提取/拆分，双工具协同
---

# Code Refactor — 安全重构

GitNexus 预览全量影响 → 用户确认 → Serena LSP 精确执行 → GitNexus 验证完整性。

## 触发条件

用户说: "重命名"、"提取方法"、"移动到另一个文件"、"拆分"、"重构"

## 执行步骤

### Step 1: 关系全景 (GitNexus)

```
gitnexus_context({name: "目标符号"})
```

获取完整的调用者/被调用者/执行流关系图。

### Step 2: 影响评估 (GitNexus)

```
gitnexus_impact({target: "目标符号", direction: "upstream"})
```

- **HIGH/CRITICAL**: 必须列出所有 d=1 (WILL BREAK) 依赖
- 向用户展示完整的影响范围

### Step 3: 预览修改 (GitNexus dry_run)

```
gitnexus_rename({symbol_name: "旧名", new_name: "新名", dry_run: true})
```

获取:
- 所有将被修改的文件和位置
- 每个修改点的置信度评分 (graph edits vs text_search edits)
- 总修改数量

### Step 4: 展示预览，等待确认

向用户展示:
1. 影响范围摘要 (d=1/2/3 依赖数量)
2. 修改预览列表 (文件 + 位置 + 置信度)
3. 风险等级

用户确认后继续。

### Step 5: 执行重命名 (Serena)

```
serena_rename_symbol({name_path: "符号路径", relative_path: "文件路径", new_name: "新名"})
```

使用 LSP 精确重命名，覆盖 graph 可能遗漏的上下文相关引用。

### Step 6: 验证完整性 (GitNexus)

```
gitnexus_detect_changes({scope: "all"})
```

对比:
- GitNexus dry_run 预览的修改点数量 vs 实际变更文件数
- 如有遗漏: 输出对比报告，手动补充

## 提取/拆分场景

对于 "提取方法"、"移动到另一个文件" 等非重命名重构:

1. `gitnexus_context({name: "目标"})` → 查看所有传入/传出引用
2. `gitnexus_impact({target: "目标", direction: "upstream"})` → 确认所有调用者
3. `serena_find_symbol({include_body: true})` → 读取源代码
4. `serena_insert_after_symbol` / `serena_replace_symbol_body` → 创建新符号 + 修改原符号
5. 手动更新所有 d=1 调用者
6. `gitnexus_detect_changes` → 验证

## 错误处理

| 情况 | 处理 |
|------|------|
| dry_run 预览与 Serena 执行结果不一致 | 输出 diff 对比报告，由用户判断 |
| Serena 重命名失败 | 检查 LSP 是否支持该语言的重命名，回退到手动修改 |
| 遗漏的引用 | 用 `serena_find_referencing_symbols` 交叉验证 |

## 禁止事项

- 不要跳过 dry_run 直接执行重命名
- 不要用 find-and-replace 做重命名
- 不要忽略 d=1 依赖不更新