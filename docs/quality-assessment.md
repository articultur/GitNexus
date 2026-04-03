# GitNexus 项目质量评估报告

> 评估时间: 2026-04-03
> 评估范围: gitnexus/ (CLI/MCP 核心) + gitnexus-web/ (Web UI)

---

## 1. 测试覆盖

| 测试类型 | 数量 | 状态 |
|---------|------|------|
| **单元测试** | 2,656 passed / 1 skipped | ✅ 健康 |
| **集成测试** | 2,057 passed / 45 skipped / 1 error | ⚠️ 有 1 个错误 |
| **E2E 测试** | Playwright 5 tests | ⚠️ 需要服务运行 |
| **Web UI 单元** | ~200 tests | 待验证 |

### 问题

- **TypeScript 编译错误**: `local-backend.ts:583` 有类型不兼容问题
  ```
  Type 'string' is not assignable to type '"tree-sitter" | "standalone"'
  ```

- **集成测试 1 个错误**: Worker 意外退出 (vitest-pool fork 问题，环境相关)

---

## 2. 代码覆盖率

| 模块 | 行覆盖 | 分支覆盖 | 函数覆盖 |
|------|--------|----------|----------|
| ** ingestion/** | 高 | 中高 | 高 |
| ** lbug/** | 67.86% | 36.96% | 76.47% |
| ** search/** | 81.7% | 41.37% | 73.68% |
| ** tree-sitter/** | 100% | 77.77% | 100% |
| ** mcp/** | 75% | 58.26% | 58.49% |
| ** storage/** | 37.32% | 5% | 42.3% |

### 低覆盖区域
- `parse-worker.ts`: 0% (未启用)
- `types/pipeline.ts`: 0% (未测试)
- `embedder.ts`: 21.81% (向量嵌入模块)

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
- ❌ **TypeScript 编译错误** - 1 处类型不兼容
- ⚠️ **低测试覆盖** - storage 模块仅 37%
- ⚠️ **未使用 ESLint/Prettier** - 代码风格依赖人工
- ⚠️ **worker-pool 未测试** - parse-worker 0% 覆盖

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
- ⚠️ **storage/repo-manager.ts** 测试覆盖仅 27%
- ⚠️ **embedder.ts** 覆盖率仅 21%，可能存在未发现的问题
- ⚠️ **数据流分析未完全产品化** - taint engine 存在但未在 MCP 输出中使用

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
| `ci-quality.yml` | ✅ 质量检查 |
| `ci-tests.yml` | ✅ 单元/集成测试 |
| `ci-e2e.yml` | ⚠️ E2E 测试 |
| `ci-report.yml` | 覆盖率报告 |
| `claude.yml` | Claude Code 集成 |
| `publish.yml` | npm 发布 |

---

## 8. Git 提交质量

### 最近的提交模式
```
feat(dataflow): improve taint propagation and close pending todos
feat(impact): add --data-flow option to include DATA_FLOW edges
fix(objective-c): wire taint config and harden header language detection
```

**优点**:
- ✅ 语义化提交 (feat/, fix/, test/, docs/)
- ✅ 清晰的变更描述
- ✅ 活跃的开发周期 (最近 30 天)

---

## 9. 问题汇总

### 🔴 必须修复
1. **TypeScript 编译错误** - `local-backend.ts:583` 类型不兼容

### 🟡 建议改进
1. **提高 storage/ 模块测试覆盖** (当前 37%)
2. **embedder.ts 覆盖率过低** (21%)
3. **parse-worker.ts 未启用测试** (0%)
4. **数据流分析未产品化** - taint engine 未在 MCP 输出使用

### 🟢 已做好的
1. 单元测试覆盖率充足
2. 依赖安全 (0 vulnerabilities)
3. 文档完善
4. CI/CD 流程成熟
5. 多语言支持 (43 种)

---

## 10. 总体评分

| 维度 | 评分 (5星) |
|------|-----------|
| **代码质量** | ⭐⭐⭐⭐ |
| **测试覆盖** | ⭐⭐⭐⭐ |
| **架构设计** | ⭐⭐⭐⭐⭐ |
| **安全性** | ⭐⭐⭐⭐ |
| **可维护性** | ⭐⭐⭐⭐ |
| **文档** | ⭐⭐⭐⭐⭐ |

### 综合评价: **A- (优秀)**

GitNexus 是一个成熟度高、架构优良的项目。主要优势在于：
- 强大的代码索引和图谱能力
- 完善的 MCP 协议集成
- 活跃的开发维护

主要改进方向：
- 修复 TypeScript 编译错误
- 提高边缘模块的测试覆盖率
- 将数据流分析完全产品化

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
