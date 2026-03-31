# Taint Analysis — 待办事项

> 状态：基础设施已就绪，引擎待实现

## 已完成

- [x] `TaintConfig` 接口定义（`type-extractors/taint.ts`）
- [x] 12 种语言的 `*TaintConfig` 实现（Java/Kotlin/Go/Dart/C#/C/Rust/Swift/TypeScript/PHP/Python/Ruby）
- [x] `taintConfig` wiring 到各语言 `LanguageTypeConfig`
- [x] `TAINTED` / `SANITIZER` / `SINK` 加入 `REL_TYPES` 常量
- [x] Schema 定义（`CodeRelation.type` 列存储关系类型）

## 待实现

### 高优先级

- [ ] **构建污点分析引擎**（核心缺失）
  - 在 AST 遍历过程中消费 `languageTypeConfig.taintConfig`
  - 调用 `extractSourceDeclaration` / `extractSinkCall` / `extractSanitizerCall`
  - 通过 `PendingAssignment` 链传播污点标注（`TaintAnnotation`）
  - 将 `SOURCE` / `SANITIZER` / `SINK` 关系写入 `CodeRelation` 表

- [ ] **修复 `taint.ts` 文档注释**
  - 移除第 8 行 `extractTaintSource / extractTaintSink / extractTaintSanitizer` 的声明（这三个函数从未实现）

### 中优先级

- [ ] **Objective-C 支持**
  - `objcTaintConfig` 已定义（`taint.ts:557`），但无 `objc.ts` 语言 extractor
  - 若未来支持 ObjC，需创建对应的 type extractor 并 wiring

- [ ] **`TaintAnnotation` 消费逻辑**
  - `TaintAnnotation` 类型已定义，但 `PendingAssignment` 链传播污点的逻辑尚未实现
  - 需在 `type-env.ts` 或新设 `taint-propagator.ts` 中实现

### 低优先级

- [ ] **ObjC 独立文件清理**
  - 若确定不支持 ObjC，可移除 `objcTaintConfig` 定义，避免误导

## 技术约束

- 污点传播需与现有 `PendingAssignment` 系统协同工作
- 每种语言的 source/sink/sanitizer 模式已定义在各自 `*TaintConfig` 中
- 关系边使用现有 `CodeRelation` 表，`type` 列值为 `TAINTED` / `SANITIZER` / `SINK`

## 参考

- `src/core/ingestion/type-extractors/taint.ts` — TaintConfig 定义
- `src/core/ingestion/type-extractors/types.ts:186` — LanguageTypeConfig.taintConfig 字段
- `src/core/ingestion/type-env.ts` — 类型环境（污点传播依赖此机制）
- `gitnexus-shared/src/lbug/schema-constants.ts` — REL_TYPES 常量
