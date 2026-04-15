---
name: code-review
description: 代码审查 — GitNexus 变更检测 + 影响分析 + Serena 引用验证，生成风险矩阵和测试建议
---

# Code Review — 代码审查

GitNexus 检测变更 + 评估影响 → Serena 精确引用验证 → 输出审查报告。

## 触发条件

用户说: "review 这个 PR"、"审查这些改动"、"commit 前检查"、"看看改动"

## 执行步骤

### Step 1: 检测变更 (GitNexus)

```
gitnexus_detect_changes({scope: "staged"})
```

如果没有 staged 变更，尝试:
```
gitnexus_detect_changes({scope: "unstaged"})
```

获取变更的符号列表、受影响的执行流、变更类型分类。

### Step 2: 逐符号影响分析 (GitNexus + Serena)

对每个变更符号并行执行:

**GitNexus — 影响范围:**
```
gitnexus_impact({target: "符号名", direction: "upstream"})
```
获取风险等级和依赖图。

**Serena — 引用验证:**
```
serena_find_referencing_symbols({name_path: "符号名", relative_path: "文件路径"})
```
获取 LSP 精确引用，与 GitNexus 图数据交叉对比。

### Step 3: 测试影响 (GitNexus)

```
gitnexus_test_impact({target: "符号名"})
```

获取建议运行的测试文件列表，按优先级分类 (must_run / should_run / can_skip)。

### Step 4: 输出审查报告

向用户展示:

**1. 变更概览**
- 变更文件列表 + 变更类型
- 受影响的执行流数量

**2. 风险矩阵**

| 符号 | 风险等级 | d=1 依赖数 | Serena 引用数 | 差异 |
|------|----------|-----------|-------------|------|

注: "差异" 列对比 GitNexus 图引用数 vs Serena LSP 引用数，不一致说明图索引可能过时。

**3. 建议测试列表**
- must_run: 必须运行的测试
- should_run: 建议运行的测试
- can_skip: 可跳过的测试

**4. 发现的问题**（如有）
- 遗漏的依赖更新
- HIGH/CRITICAL 风险项需要特别注意
- 安全检测命中（如 sql-injection, xss）

## 错误处理

| 情况 | 处理 |
|------|------|
| GitNexus 索引过时 | 仅用 Serena 引用查找，在报告中标注 "图索引可能过时" |
| Serena LSP 未启动 | 仅用 GitNexus 影响分析，跳过引用交叉验证 |
| 无变更检测到 | 提示用户 stage 文件或检查 scope 参数 |

## 禁止事项

- 不要在没有检测变更的情况下做审查
- 不要遗漏 HIGH/CRITICAL 风险项不报告