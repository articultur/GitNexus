# GitNexus 项目质量评估报告

> 评估时间: 2026-04-05
> 评估范围: gitnexus/ (CLI/MCP 核心) + gitnexus-web/ (Web UI)

---
## 1. 测试覆盖

| 测试类型 | 数量 | 状态 |
|---------|------|------|
| **单元** | 3,109 passed / 1 skipped | ✅ 健康 |
| **集成** | 2,090 passed / 45 skipped | ✅ 健康 |
| **E2E 测试** | Playwright 5 tests | ⚠️ 需要服务运行 |
| **Web UI 单元** | ~200 tests | 待验证 |

### 问题

- **TypeScript 编译**: ✅ 干净，0 errors
- **LadybugDB lock 改进**: 重试延迟改为 exponential backoff + jitter，macOS 连接数降到 4，偶发概率降低

---

## 2. 代码覆盖率

| 模块 | 行覆盖 | 分支覆盖 | 函数覆盖 |
|------|--------|----------|----------|
| ** ingestion/** | 高 | 中高 | 高 |
| ** lbug/** | 67.86% | 36.96% | 76.47% |
| ** search/** | 81.7% | 41.37% | 73.68% |
| ** tree-sitter/** | 100% | 77.77% | 100% |
| ** mcp/** | 75% | 58.26% | 58.49% |
| ** storage/** | ~80% | — | — |

### 低覆盖区域（已改进）
- `parse-worker.ts`: ✅ 44 tests（test/unit/parse-worker.test.ts）
- `embedder.ts`: ✅ 69% 覆盖（17 tests）
- `types/pipeline.ts`: 0% (未测试)

---

## 3. 安全性

| 检查项 | 结果 |
|--------|------|
| **npm audit** | ✅ 0 vulnerabilities |
| **依赖毒性** | ✅ 无问题 |
| **硬编码凭证** | ⚠️ 需人工审查 |
| **MCP 协议安全** | ⚠️ 无内置防护 (需手动配置) |

---

## 4. 代码质量

### 优势
- ✅ **TypeScript 严格模式** - 强类型保障
- ✅ **Vitest 测试框架** - 快速可靠
- ✅ **模块化架构** - 清晰的关注点分离
- ✅ **Tree-sitter 解析** - 支持 43 种语言
- ✅ **CI/CD 完善** - 多个 GitHub Actions 工作流
- ✅ **文档齐全** - ARCHITECTURE.md, AGENTS.md, GUARDRAILS.md

### 问题
- ⚠️ **未使用 ESLint/Prettier** - 代码风格依赖人工
- ⚠️ **数据流分析未完全产品化** - taint engine 存在但 DFA facts 未写出（需 def-use 链）

---

## 5. 架构质量

### 优势
| 特性 | 评分 | 说明 |
|------|------|------|
| **模块化** | ⭐⭐⭐⭐⭐ | ingestion/search/graph/lbug 清晰分离 |
| **可扩展性** | ⭐⭐⭐⭐⭐ | 43 种语言处理器，易添加新语言 |
| **MCP 协议** | ⭐⭐⭐⭐ | 完善的工具暴露机制 |
| **持久化** | ⭐⭐⭐⭐ | LadybugDB 图数据库 |
| **搜索能力** | ⭐⭐⭐⭐ | BM25 + 向量混合搜索 |

### 架构问题
- ⚠️ **storage/repo-manager.ts** ✅ 已改善（64 tests）
- ⚠️ **embedder.ts** ✅ 已改善（69% 覆盖，17 tests）
- ⚠️ **数据流分析未完全产品化** - taint paths 已写入 KG，DFA facts 需 def-use 链

---

## 6. 依赖健康

```
npm audit: found 0 vulnerabilities
Dependencies: ~200+ packages
DevDependencies: 充分
Native bindings: tree-sitter (需要 python3, make, g++)
Optional deps: kotlin, swift (可选)
```

---

## 7. CI/CD 流程

| 工作流 | 状态 |
|--------|------|
| `ci_quality.yml` | ✅ 质量检查 |
| `ci_tests.yml` | ✅ 单元/集成测试 |
| `ci_e2e.yml` | ⚠️ E2E 测试 |
| `ci_report.yml` | ✅ 覆盖率报告 |
| `claude.yml` | Claude Code 集成 |
| `publish.yml` | npm 发布 |

---

## 8. Git 提交质量

### 最近的提交模式
```
feat(dataflow): TSG routing + ESM fix + storage tests
feat(dataflow): TSG post-processor + DSL + integration tests
fix(embeddings): reset currentDevice on disposeEmbedder
fix(lbug+dataflow): lock retry improvements + DEF-002 fix
fix(dataflow): add random suffix to TSG temp file path
```

**优点**:
- ✅ 语义化提交 (feat/, fix/, test/, docs/)
- ✅ 清晰的变更描述
- ✅ 活跃的开发周期 (最近 30 天)

---

## 9. 问题汇总

### 🟡 建议改进
1. **数据流分析未完全产品化** - taint paths 已写入 KG，DFA facts → DataFlowEdge 需 def-use 链
2. **LadybugDB lock** - 改进后仍偶发（N-API destructor bug 无法在 GitNexus 层修复）
3. **间歇性测试失败** - LadybugDB lock 改进中，e2e 测试隔离待加强

### 🟢 已做好的
1. ✅ 单元+集成测试 5,199 passed，覆盖充足
2. ✅ 依赖安全 (0 vulnerabilities)
3. ✅ TypeScript 编译干净
4. ✅ 文档完善
5. ✅ CI/CD 流程成熟
6. ✅ 多语言支持 (43 种)
7. ✅ storage 测试覆盖（64 tests）
8. ✅ embedder.ts 测试覆盖（69%）
9. ✅ parse-worker 测试（44 tests）
10. ✅ DEF-002 修复（_nodeCounter 移入 WalkState）

---

## 10. 总体评分

| 维度 | 评分 (5星) |
|------|-----------|
| **代码质量** | ⭐⭐⭐⭐ |
| **测试覆盖** | ⭐⭐⭐⭐ |
| **架构设计** | ⭐⭐⭐⭐⭐ |
| **安全性** | ⭐⭐⭐⭐ |
| **可维护性** | ⭐⭐⭐⭐ |
| **文档** | ⭐⭐⭐⭐ |

### 综合评价: **A- (优秀)**

GitNexus 是一个成熟度高、架构优良的项目。主要优势在于：
- 强大的代码索引和图谱能力
- 完善的 MCP 协议集成
- 活跃的开发维护

主要改进方向：
- DFA facts → DataFlowEdge 需要 def-use 链追踪（dataflow 产品化最后一步）
- LadybugDB N-API destructor bug 需等待上游修复

---

## 附录: 运行测试命令

```bash
# 单元测试
cd gitnexus && npm run test:unit

# 集成测试
cd gitnexus && npm run test:integration

# 覆盖率
cd gitnexus && npm run test:coverage

# TypeScript 检查
cd gitnexus && npx tsc --noEmit

# Web UI 测试
cd gitnexus-web && npm test
```
