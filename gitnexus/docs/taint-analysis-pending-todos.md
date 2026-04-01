# Taint Analysis — 待办事项

> 状态：已完成（本清单归档）

## 待实现

### 高优先级

- 无

### 中优先级

- 无

### 低优先级

- 无

## 说明

- 本清单对应的既定任务已处理完毕，后续新增需求请在新计划文档中跟踪。

## 技术约束

- 污点传播需与现有 `PendingAssignment` 系统协同工作
- 每种语言的 source/sink/sanitizer 模式已定义在各自 `*TaintConfig` 中
- 关系边使用现有 `CodeRelation` 表，`type` 列值为 `TAINTED` / `SANITIZER` / `SINK`

## 参考

- `src/core/ingestion/type-extractors/taint.ts` — TaintConfig 定义
- `src/core/ingestion/type-extractors/types.ts:186` — LanguageTypeConfig.taintConfig 字段
- `src/core/ingestion/type-env.ts` — 类型环境（污点传播依赖此机制）
- `gitnexus-shared/src/lbug/schema-constants.ts` — REL_TYPES 常量
