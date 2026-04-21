# 任务完成检查清单

## 代码修改后必须执行
1. 运行 `npx gitnexus analyze` 更新索引 (如修改了代码)
2. 运行 `npm run lint` 检查代码风格
3. 运行 `npx tsc --noEmit` 确保类型正确

## GitNexus 特定规则
- 编辑符号前必须运行 `gitnexus_impact` 分析影响范围
- 提交前必须运行 `gitnexus_detect_changes` 验证变更范围
- 高风险/关键风险变更需先警告用户

## Serena 工具使用
- 使用 `find_symbol` 查找符号
- 使用 `get_symbols_overview` 获取文件概览
- 使用 `find_referencing_symbols` 查找引用
