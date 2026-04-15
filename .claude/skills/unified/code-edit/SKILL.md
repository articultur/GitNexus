---
name: code-edit
description: 安全编辑代码 — 先用 GitNexus 评估影响，再用 Serena LSP 精确编辑，最后验证变更范围
---

# Code Edit — 安全编辑

GitNexus 评估风险 → Serena 精确编辑 → GitNexus 验证变更。

## 触发条件

用户说: "改这个函数"、"修复这个方法"、"加一段代码"、"更新实现"

## 执行步骤

### Step 1: 影响评估 (GitNexus)

```
gitnexus_impact({target: "目标符号", direction: "upstream"})
```

检查风险等级:
- **HIGH/CRITICAL**: 列出所有 d=1 (WILL BREAK) 依赖，**警告用户**，确认是否继续
- **LOW/MEDIUM**: 继续下一步

如果目标符号不明确，先用 `gitnexus_query` 定位。

### Step 2: 读取当前代码 (Serena)

```
serena_find_symbol({name_path_pattern: "目标符号", include_body: true})
```

获取 AST 精确的当前代码体。

### Step 3: 展示修改方案

向用户展示:
1. 当前代码
2. 拟定修改
3. 影响分析摘要（受影响的调用者数量和执行流）

等待用户确认后才继续。

### Step 4: 执行编辑 (Serena)

根据修改类型选择工具:
- **替换整个函数/方法体**: `serena_replace_symbol_body`
- **在符号后插入代码**: `serena_insert_after_symbol`
- **在符号前插入代码**: `serena_insert_before_symbol`

### Step 5: 验证变更 (GitNexus)

```
gitnexus_detect_changes({scope: "unstaged"})
```

检查:
- 变更是否只在预期的文件和符号中
- 是否有意外的副作用

如有意外变更: 报告差异，建议回退或补充修改。

## 错误处理

| 情况 | 处理 |
|------|------|
| Serena LSP 不可用 | 回退到 Claude 内置 Edit + `gitnexus_detect_changes` 验证 |
| impact 未找到符号 | 用 `gitnexus_query` 搜索，确认正确符号名后重试 |
| 用户拒绝 HIGH 风险 | 终止流程，建议替代方案（如仅修改测试覆盖的路径） |

## 禁止事项

- 不要跳过 Step 1（影响评估）
- 不要忽略 HIGH/CRITICAL 风险继续编辑
- 不要用 Claude 内置 Edit 代替 Serena 做代码编辑（除非 Serena 不可用）