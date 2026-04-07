# GitNexus 项目全面评估报告

> 评估日期: 2026-04-03

---

## 一、项目概述

**GitNexus** 是一个为 AI 代码智能而生的知识图谱工具，通过将代码库索引为知识图谱，让 AI Agent 能够深入理解代码结构、依赖关系和执行流程。

| 指标 | 数值 |
|------|------|
| **版本** | 1.5.3 |
| **TypeScript 文件** | 185 个 |
| **代码行数** | ~59,845 行 |
| **测试覆盖** | ~4,937 个测试 (4874 通过) |
| **GitNexus 图谱索引** | 3,570 符号, 8,816 关系, 209 执行流 |

---

## 二、技术架构

### 核心组件

| 组件 | 路径 | 职责 |
|------|------|------|
| **CLI/Core** | `gitnexus/` | TypeScript CLI, 索引管道, MCP 服务器 |
| **Web UI** | `gitnexus-web/` | React/Vite 浏览器应用, WASM 运行 |
| **Claude 插件** | `gitnexus-claude-plugin/` | 市场插件配置 |
| **Cursor 集成** | `gitnexus-cursor-integration/` | 编辑器配置 |

### 三层数据分析模型

```
AST (树-sitter) → CFG (控制流图) → DFG (数据流图)
   Phase 4-8          Phase 12          Phase 12 (dataflow)
```

### 关键技术栈

- **解析引擎**: Tree-sitter (15+ 语言)
- **图数据库**: LadybugDB v0.15 (从 KuzuDB 迁移)
- **嵌入向量**: HuggingFace transformers.js
- **通信协议**: MCP (Model Context Protocol)

---

## 三、支持的语言 (15种)

| Tier 1 (完整) | Tier 2 (完整) | Tier 3 (部分) |
|---------------|---------------|---------------|
| TypeScript, JavaScript | Java, Kotlin | Swift |
| Python | C#, Go, Rust | C |
| | PHP, Ruby, Dart | C++ |

**最近新增**: ArkTS (鸿蒙应用开发语言) - ETS 生态支持

---

## 四、最近活跃度 (2026年3月-4月)

| 提交 | 描述 |
|------|------|
| `3c40c6a` | 添加 ArkTS/HarmonyOS 支持 |
| `171e840` | ArkTS 单元/集成测试 |
| `09798a5` | parse-worker struct/decorator 索引 |
| `13dcef3` | Harmony route, RDB, Preferences 提取 |
| `dd90b4d` | 框架检测、入口评分、预处理钩子 |

---

## 五、测试状态

| 测试类型 | 状态 | 详情 |
|----------|------|------|
| **单元测试** | ✅ 通过 | ~2000 测试 |
| **集成测试** | ⚠️ 4 失败 | 4874 通过 / 8 失败 |
| **TypeScript 检查** | ✅ 通过 | 无编译错误 |
| **已知问题** | skills-e2e 测试 | CSharp context files 更新问题 |

### 失败的测试

- `test/integration/skills-e2e.test.ts` - 4 个测试失败
  - `context files updated` - CSharp 相关
  - 可能与 `--skip-agents-md` 选项处理有关

---

## 六、核心功能完整性

| 功能 | 状态 | 说明 |
|------|------|------|
| 代码索引 | ✅ | 完整的多语言支持 |
| 知识图谱 | ✅ | 3,570 符号, 8K+ 关系 |
| MCP 协议 | ✅ | stdio + HTTP bridge |
| 执行流检测 | ✅ | 209 个执行流 |
| 影响分析 | ✅ | blast radius 分析 |
| 重构支持 | ✅ | 安全的重命名工具 |
| Wiki 生成 | ✅ | LLM 驱动的文档 |
| Skill 生成 | ✅ | 自动生成代理技能 |

---

## 七、代码质量指标

### 优势

1. **活跃维护**: 近30天有多个功能性提交
2. **测试覆盖**: ~5000 测试用例
3. **文档完善**: ARCHITECTURE.md, AGENTS.md, RUNBOOK.md 等
4. **TypeScript 严格**: 无编译错误

### 需关注

1. **测试稳定性**: 4个集成测试失败 (skills-e2e)
2. **从 KuzuDB 迁移**: 刚迁移到 LadybugDB, 有清理工作
3. **可选依赖**: tree-sitter-kotlin/swift 有时警告

---

## 八、安全与合规

| 方面 | 状态 |
|------|------|
| **本地运行** | ✅ 无网络调用 |
| **隐私保护** | ✅ 代码不离开本地 |
| **许可证** | PolyForm Noncommercial |
| **MCP 传输** | 有 10MB 缓冲区限制 |
| **注入防护** | FTS Cypher 转义 |

---

## 九、Roadmap 状态

### 正在构建

- [ ] LLM Cluster Enrichment - LLM 语义聚类命名
- [ ] AST Decorator Detection - @Controller, @Get 等装饰器解析
- [ ] Incremental Indexing - 仅重新索引变更文件

### 已完成 (2026 Q1)

- [x] KuzuDB → LadybugDB 迁移
- [x] ArkTS/HarmonyOS 支持
- [x] Constructor 推断类型解析
- [x] Wiki 生成
- [x] 多文件重命名

---

## 十、总结建议

| 维度 | 评分 | 说明 |
|------|------|------|
| **功能完整度** | ⭐⭐⭐⭐⭐ | 完整的代码智能解决方案 |
| **代码质量** | ⭐⭐⭐⭐☆ | TypeScript 严格, 测试丰富 |
| **维护状态** | ⭐⭐⭐⭐⭐ | 活跃开发, 频繁更新 |
| **文档质量** | ⭐⭐⭐⭐⭐ | 详尽的架构和开发者文档 |
| **测试稳定性** | ⭐⭐☆☆☆ | 有 4 个失败测试需修复 |

### 行动项

1. **优先级高**: 调查 `skills-e2e.test.ts` 中的 4 个失败测试
2. **建议**: 持续监控 LadybugDB 迁移后的稳定性
3. **关注**: ArkTS/HarmonyOS 支持的成熟度

---

## 附录: 关键文件路径

| 文件 | 用途 |
|------|------|
| `ARCHITECTURE.md` | 系统架构文档 |
| `AGENTS.md` | Agent 工作流规则 |
| `GUARDRAILS.md` | 安全边界规则 |
| `CONTRIBUTING.md` | 贡献指南 |
| `RUNBOOK.md` | 运维手册 |
| `TESTING.md` | 测试指南 |

---

*报告生成时间: 2026-04-03*
