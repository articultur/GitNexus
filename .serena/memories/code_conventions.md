# 代码风格与约定

## TypeScript 约定
- 使用 `interface` 而非 `type` 用于对象类型
- 使用 `PascalCase` 命名类和接口
- 使用 `camelCase` 命名函数和变量
- 禁止使用 `any` 类型 (eslint: @typescript-eslint/no-explicit-any)
- 避免使用 `!` 非空断言 (eslint: @typescript-eslint/no-non-null-assertion)

## 代码组织
- 核心逻辑放在 `src/core/` 目录
- CLI 命令使用 `createLazyAction` 延迟加载
- 类型定义放在 `src/types/` 目录
- 工具函数放在 `utils/` 子目录

## 管道处理 (Pipeline)
- `pipeline.ts` 是主入口，包含以下阶段:
  1. `runScanAndStructure` - 文件扫描和结构化
  2. `runChunkedParseAndResolve` - 解析和绑定
  3. `runCrossFileBindingPropagation` - 跨文件绑定传播
  4. `runGraphAnalysisPhases` - 图分析阶段
