# Session Progress

> 最后更新：2026-04-07

---

## 已完成（本会话提交）

### Commit `1d9ebd0` — Vue SFC + tree-sitter-queries 改进
- `parser-loader.ts`：添加 Vue SFC 语言支持（支持 `.vue` 文件预处理为 TypeScript 再解析）
- `tree-sitter-queries.ts`：补全 TypeScript abstract class、private method、interface method signature、C# function_signature_item、Dart call capture

### Commit `7c9cb43` — ArkTS/ObjC/HarmonyOS 解析支持
- `parse-worker.ts`（解析工作线程）：添加 ArkTS struct→class 预处理 + ObjC #import 行过滤
- 测试 fixture 目录：
  - `test/fixtures/sample-code/harmony/entryability/EntryAbility.ets`
  - `test/fixtures/sample-code/harmony/network/HttpService.ets`
  - `test/fixtures/sample-code/harmony/pages/Index.ets`
  - `test/fixtures/sample-code/simple.ets`

### Commit `067b236` — ArkTS/ObjC 预处理 + OC 方法调用解析
- `parsing-processor.ts`：集成 ArkTS struct 预处理与 ObjC 预处理
- `extract-language-call-site.ts`：添加 OC `message_expression` case（`rawNodeName` 修复）

---

## 已完成（工作树未提交，待 commit）

### ArkTS 跨文件集成测试 + 修复 `.ets` 扩展名解析 Bug

**修改文件：**
- `src/core/ingestion/import-resolvers/utils.ts`  
  - **修复 Bug**：`EXTENSIONS` 列表缺少 `.ets`，导致 `./utils` 无法解析到 `utils.ets`，IMPORTS 边无法生成  
  - 在 `.ts` 后添加 `'.ets'`

**新增文件（untracked）：**
- `test/fixtures/lang-resolution/arkts-calls/utils.ets` — 工具函数（`formatName`、`greet`）
- `test/fixtures/lang-resolution/arkts-calls/service.ets` — 服务层（imports utils.ets）
- `test/fixtures/lang-resolution/arkts-calls/main.ets` — 入口（imports service.ets，含 `@Entry struct`）
- `test/integration/resolvers/arkts.test.ts` — 集成测试（8 个断言全部通过）

**测试结果：**
```
✓ extracts top-level functions from all .ets files
✓ captures the @Entry struct as a Class node
✓ emits IMPORTS edges from service.ets to utils.ets
✓ emits IMPORTS edges from main.ets to service.ets
✓ resolves cross-file CALLS: createGreeting → greet
✓ resolves cross-file CALLS: normalizeAndGreet → formatName
✓ resolves cross-file CALLS: runApp → createGreeting
✓ intra-file call: greet → formatName (utils.ets)

Test Files: 1 passed  |  Tests: 8 passed
Full suite:  5287 passed | 92 skipped（无回归）
```

---

## 待完成事项

### P1（高优先级）

#### P1.1 — Variable-Level Dataflow 分析 恢复
- **状态**：`src/core/ingestion/dataflow/index.ts` 是空 stub（仅 `processDataflow()` 空函数）
- **背景**：完整实现（约 3000+ 行）在 commit `61cc230` 中被删除（该 commit 是 ArkTS/ObjC 编译修复时顺带删除）
- **恢复方式**：可直接从 git 历史恢复：
  ```bash
  # 在 gitnexus/ 目录下执行:
  git show '61cc230^:gitnexus/src/core/ingestion/dataflow/cfg-builder.ts' > src/core/ingestion/dataflow/cfg-builder.ts
  git show '61cc230^:gitnexus/src/core/ingestion/dataflow/dfa-engine.ts' > src/core/ingestion/dataflow/dfa-engine.ts
  git show '61cc230^:gitnexus/src/core/ingestion/dataflow/taint-engine.ts' > src/core/ingestion/dataflow/taint-engine.ts
  git show '61cc230^:gitnexus/src/core/ingestion/dataflow/index.ts' > src/core/ingestion/dataflow/index.ts
  # ... 其余文件见下方列表
  ```
- **待恢复文件列表**（共 15 个源码文件 + 3 个 DSL 文件 + 4 个测试文件）：
  ```
  src/core/ingestion/dataflow/cfg-builder.ts
  src/core/ingestion/dataflow/cfg-from-tsg.ts
  src/core/ingestion/dataflow/cfg-post-processor.ts
  src/core/ingestion/dataflow/configs/registry.ts
  src/core/ingestion/dataflow/dfa-engine.ts
  src/core/ingestion/dataflow/incremental.ts
  src/core/ingestion/dataflow/index.ts          ← 需覆盖当前 stub
  src/core/ingestion/dataflow/lattice.ts
  src/core/ingestion/dataflow/path-sensitive.ts
  src/core/ingestion/dataflow/storage-writer.ts
  src/core/ingestion/dataflow/taint-engine.ts
  src/core/ingestion/dataflow/types.ts
  src/core/ingestion/dataflow/dsl/javascript-static-edges.sg
  src/core/ingestion/dataflow/dsl/python-static-edges.sg
  src/core/ingestion/dataflow/dsl/typescript-static-edges.sg
  test/integration/dataflow-impact.test.ts
  test/integration/orm-dataflow.test.ts
  test/unit/dataflow/cfg-builder.test.ts
  test/unit/dataflow/dfa-engine.test.ts
  test/unit/dataflow/fixtures/simple-dataflow/source-to-sink.ts
  ```
- **注意**：`cfg-from-tsg.ts` 依赖 `tree-sitter-graph` CLI（`cargo install tree-sitter-graph`），恢复后需检查该依赖是否可用，否则 TSG 路径会 fallback 到 legacy CFG builder
- **恢复后需**：`npx tsc --noEmit` 确认无编译错误，再运行 `npm test` 验证

#### P1.3 — Test-Impact 分析
- **状态**：未开始，无任何实现
- **目标**：基于已有的 CALLS/IMPORTS 图，实现 symbol → test file 映射，给 diff 推荐最小回归测试集
- **依赖**：P0 完成（已完成）；可利用现有 `gitnexus_impact` 的 upstream/downstream 遍历逻辑

---

### P2（低优先级，暂缓）

- **P1.2 CFG**：已在 dataflow 模块中，随 P1.1 一起恢复
- **P1.4 Multi-language dataflow**：随 P1.1 一起恢复（taint-engine 支持多语言）
- **P2.1~P2.4**：高阶分析能力（安全分析、类型推断增强等），暂缓

---

## 当前 git 状态

```
Branch: main  HEAD: 067b236
Working tree: 1 modified (utils.ts) + 2 untracked dirs (待 commit)

待提交内容：
  M  src/core/ingestion/import-resolvers/utils.ts
  ?? test/fixtures/lang-resolution/arkts-calls/
  ?? test/integration/resolvers/arkts.test.ts
```

**建议下一步 commit 命令：**
```bash
cd /Users/nonon/Desktop/GitNexus/gitnexus
git add src/core/ingestion/import-resolvers/utils.ts \
        test/fixtures/lang-resolution/arkts-calls/ \
        test/integration/resolvers/arkts.test.ts
git commit -m "test(arkts): add cross-file integration test + fix .ets extension resolution

- Add arkts-calls fixture (utils.ets / service.ets / main.ets)
- Add test/integration/resolvers/arkts.test.ts (8 tests, all passing)
- Fix: add .ets to EXTENSIONS list in import-resolvers/utils.ts so
  relative imports between .ets files resolve to IMPORTS edges"
```
