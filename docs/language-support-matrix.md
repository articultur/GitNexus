# GitNexus 语言支持全景矩阵

> 最后更新：2026-04-08 · 基于 commit `36506d0` (main)  
> 数据来源：`gitnexus/src/core/ingestion/` 源码实际分析（非文档推测）

---

## 图例说明

| 符号 | 含义 |
|------|------|
| ✅ | 完整支持 |
| 🟢 | 良好（功能完整，有少量缺口） |
| 🟡 | 部分支持（核心能力有限） |
| 🔴 | 有限支持（仅基础功能） |
| ⚫ | 缺失/不支持 |
| `†` | 可选依赖（optional npm package） |

---

## 一、解析基础能力

| 语言 | 扩展名 | 解析引擎 | 安装方式 |
|------|--------|----------|---------|
| TypeScript | `.ts` `.tsx` | tree-sitter-typescript | 必装 |
| JavaScript | `.js` `.jsx` | tree-sitter-javascript | 必装 |
| Python | `.py` | tree-sitter-python | 必装 |
| Java | `.java` | tree-sitter-java | 必装 |
| Kotlin | `.kt` `.kts` | tree-sitter-kotlin | `†` 可选 |
| Go | `.go` | tree-sitter-go | 必装 |
| Rust | `.rs` | tree-sitter-rust | 必装 |
| C# | `.cs` | tree-sitter-c-sharp | 必装 |
| C | `.c` | tree-sitter-c | 必装 |
| C++ | `.cpp` `.cc` `.h` `.hpp` | tree-sitter-cpp | 必装 |
| PHP | `.php` `.phtml` `.php8` | tree-sitter-php | 必装 |
| Ruby | `.rb` `.rake` `.gemspec` | tree-sitter-ruby | 必装 |
| Swift | `.swift` | tree-sitter-swift | `†` 可选 |
| Dart | `.dart` | tree-sitter-dart | `†` 可选 |
| Objective-C | `.m` `.mm` | tree-sitter-objc | 必装 |
| Vue SFC | `.vue` | tree-sitter-typescript（脚本块） | 必装 |
| ArkTS | `.ets` | tree-sitter-typescript（超集） | 必装 |
| COBOL | `.cbl` `.cob` `.cobol` `.cpy` | 自定义 Regex 处理器 | 内置 |

---

## 二、导入 / 符号绑定能力

**组件**：`import-resolvers/`（路径解析）+ `named-bindings/`（标识符绑定）

| 语言 | import-resolver | named-bindings | 综合评级 | 说明 |
|------|:---:|:---:|:---:|---|
| TypeScript | ✅ | ✅ | ✅ | 完整 TS resolver + named-bindings |
| JavaScript | ✅ | ✅ | ✅ | 复用 TS 基础设施 |
| Python | ✅ | ✅ | ✅ | python resolver + python named-bindings |
| Java | ✅ | ✅ | ✅ | jvm resolver + java named-bindings |
| Kotlin | ✅ | ✅ | ✅ | jvm resolver + kotlin named-bindings（`†` 可选安装） |
| Rust | ✅ | ✅ | ✅ | rust resolver + rust named-bindings |
| C# | ✅ | ✅ | ✅ | csharp resolver + csharp named-bindings，`.csproj` RootNamespace 加载 |
| PHP | ✅ | ✅ | ✅ | php resolver + php named-bindings，`composer.json` PSR-4 |
| ArkTS | ✅ | 🟡 | 🟢 | 复用 TS resolver；named-bindings 沿用 TS，无 HarmonyOS 装饰器专项 |
| Vue SFC | ✅ | 🟡 | 🟢 | vue resolver + `<script>` 部分用 TS；`<template>` 绑定未覆盖 |
| Go | ✅ | ⚫ | 🟡 | go resolver（`go.mod` module path）存在；**无 named-bindings**，包级变量绑定缺失 |
| C / C++ | ✅ | ⚫ | 🟡 | standard resolver（`#include`/`#import` 扫描，项目内路径）；**无 named-bindings**，宏/全局变量无法绑定 |
| Swift | ✅ | ⚫ | 🟡 | swift resolver（`Package.swift` targets）；**无 named-bindings**（`†` 可选安装） |
| Dart | ✅ | ⚫ | 🟡 | dart resolver；**无 named-bindings**（`†` 可选安装） |
| Ruby | ✅ | ⚫ | 🟡 | ruby resolver（require/require_relative via callRouter）；**无 named-bindings**，mixin/extend 无法追踪 |
| Objective-C | ✅ | ⚫ | 🔴 | standard resolver（`#import` 扫描）；**无 named-bindings**；category/protocol 解析缺失 |
| COBOL | ⚫ | ⚫ | ⚫ | COPY 语句无解析；无绑定实现 |

> **可行性**：Go、Swift、Dart 的 named-bindings 实现难度中等（Tree-sitter AST 模式清晰）；Ruby 因动态 `method_missing`/`include` 难度较高；C/C++ 受预处理器影响最难。

---

## 三、符号结构提取

**组件**：`type-extractors/`（14 个提取器）

| 语言 | 提取器 | 评级 | 可提取节点类型 | 缺口 |
|------|:---:|:---:|---|---|
| TypeScript | ✅ | ✅ | Function/Class/Interface/Type/Enum/Namespace/Arrow/Generic/Decorator | — |
| JavaScript | ✅ | ✅ | 同 TS（动态部分略有降级） | — |
| ArkTS | 🟡 | 🟢 | 复用 TS（+Harmony 装饰器） | 组件生命周期方法未专项提取 |
| Vue SFC | 🟡 | 🟢 | `<script>` 完整（同 TS）；`<template>` 部分 | template bindings 缺失 |
| Java | ✅ | 🟢 | Class/Method/Constructor/Field/Interface/Enum/Annotation | Lambda 推断类型弱 |
| Kotlin | ✅ | 🟢 | 同 JVM + data class/extension function（`†` 可选） | 协程上下文未建模 |
| Go | ✅ | 🟢 | Function/Struct/Interface/Method | embedded struct 继承关系弱 |
| Python | ✅ | 🟢 | Function/Class/Method/Decorator | 动态属性（`__dict__`）不完整 |
| Rust | ✅ | 🟢 | Function/Struct/Enum/Impl/Trait/Module | lifetime/generic bounds 未完整建模 |
| C# | ✅ | 🟢 | Class/Method/Property/Interface/Struct/Enum/Namespace | LINQ 表达式树弱 |
| C / C++ | ✅ | 🟡 | Function/Struct/Class/Enum/Typedef | **宏展开**不透明；模板特化弱 |
| PHP | ✅ | 🟡 | Function/Class/Method/Trait | 魔术方法、匿名类弱 |
| Swift | ✅ | 🟡 | Class/Struct/Protocol/Extension/Function（`†` 可选） | @propertyWrapper / actor 弱 |
| Dart | ✅ | 🟡 | Class/Function/Mixin（`†` 可选） | async/isolate 不完整 |
| Ruby | ✅ | 🟡 | Module/Class/Method | `define_method`/`included` 动态定义无法覆盖 |
| Objective-C | ✅ | 🟡 | Interface/Protocol/Category/Property | Category 方法分散，合并建模弱；**无 Method 节点** |
| COBOL | ⚫ | 🔴 | 仅 DIVISION/SECTION/PARAGRAPH（Regex 提取） | Data Division 变量未完整提取 |

---

## 四、图谱关系类型覆盖

**衡量**：CALLS / IMPORTS / HANDLES_ROUTE / EXPORTS_TYPE / IS_MEMBER_OF 等边类型的实际输出

| 语言 | CALLS | IMPORTS | HANDLES_ROUTE | EXPORTS_TYPE | IS_MEMBER_OF | 评级 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| TypeScript | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| JavaScript | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ArkTS | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟢 |
| Vue SFC | ✅ | ✅ | 🟡 | 🟡 | ✅ | 🟢 |
| PHP | ✅ | ✅ | 🟡 | 🟡 | ✅ | 🟢 |
| Java | ✅ | ✅ | ⚫ | ✅ | ✅ | 🟡 |
| Kotlin | ✅ | ✅ | ⚫ | ✅ | ✅ | 🟡 |
| Python | ✅ | ✅ | ⚫ | 🟡 | ✅ | 🟡 |
| Go | ✅ | ✅ | ⚫ | 🟡 | ✅ | 🟡 |
| Rust | ✅ | ✅ | ⚫ | 🟡 | ✅ | 🟡 |
| C# | ✅ | ✅ | ⚫ | ✅ | ✅ | 🟡 |
| Ruby | ✅ | ✅ | ⚫ | ⚫ | ✅ | 🟡 |
| Swift | ✅ | ✅ | ⚫ | 🟡 | ✅ | 🟡 |
| Dart | ✅ | ✅ | ⚫ | 🟡 | ✅ | 🟡 |
| C / C++ | ✅ | 🟡 | ⚫ | 🔴 | 🟡 | 🔴 |
| Objective-C | ✅ | 🟡 | ⚫ | ⚫ | 🟡 | 🔴 |
| COBOL | 🔴 | ⚫ | ⚫ | ⚫ | 🔴 | ⚫ |

> **最大空白**：`HANDLES_ROUTE` 边仅在 TS/JS（Next.js/Expo/Express）+ PHP（file-based）生成，**Spring `@RequestMapping`、Django `urlpatterns`、Rails `routes.rb`、Gin/Echo/Fiber handler、FastAPI `@router.xxx`** 均未实现。  
> **注**：C/C++/ObjC 的 `#include`/`#import` 通过 `standard.ts` 解析，可生成 IMPORTS 图谱边（仅相对路径/项目内头文件，系统库如 `<stdio.h>` 被过滤）。ArkTS 跨文件 `.ets` 导入已在 commit `2de882c` 修复。

---

## 五、框架识别 / 入口点检测

**组件**：`framework-detection.ts`（55 个框架标识）+ `entry-point-scoring.ts`（472 行评分逻辑）+ `route-extractors/`

| 语言 | 框架检测 | 路由提取 (HANDLES_ROUTE) | 入口点评分 | 综合评级 |
|------|:---:|:---:|:---:|:---:|
| TypeScript / JavaScript | ✅ Next.js/Expo Router/Express/NestJS/React/Prisma/Supabase | ✅ Next.js + Expo → URL 映射 | ✅ | ✅ |
| PHP | ✅ Laravel（routes/controllers/jobs/middleware/providers） | 🟡 仅文件级路由（api/*.php） | 🟢 | 🟢 |
| Java | ✅ Spring Boot/JAX-RS/Java service | ⚫ | 🟢 | 🟡 |
| Kotlin | ✅ Spring-Kotlin/Ktor/Android（Activity/Fragment） | ⚫ | 🟢 | 🟡 |
| Python | ✅ Django/FastAPI/Flask/generic API | ⚫ | 🟢 | 🟡 |
| Go | ✅ Gin/Echo/Fiber/gRPC/go-http | ⚫ | 🟢 | 🟡 |
| Rust | ✅ actix-web/Axum/Rocket/Tokio | ⚫ | 🟢 | 🟡 |
| C# | ✅ ASP.NET/Blazor/SignalR/EF Core/Background Services | ⚫ | 🟢 | 🟡 |
| Ruby | ✅ Rails/Sinatra/executable scripts | ⚫ | 🟡 | 🟡 |
| Swift | ✅ iOS AppEntry/UIKit/SwiftUI/Vapor（`†` 可选） | ⚫ | 🟡 | 🟡 |
| Dart | ✅ Flutter/Riverpod（`†` 可选） | ⚫ | 🟡 | 🟡 |
| ArkTS | 🟡 Harmony ArkUI（@Entry/@Component 装饰器） | ⚫ | 🟡 | 🟡 |
| C / C++ | 🔴 路径模式/Qt 入口 | ⚫ | 🔴 | 🔴 |
| Objective-C | 🔴 CocoaTouch 路径模式 | ⚫ | 🔴 | 🔴 |
| COBOL | ⚫ | ⚫ | ⚫ | ⚫ |

> **可行性**：路由提取器（生成 HANDLES_ROUTE）是框架感知图谱中价值最高的缺口。优先级：
> 1. **高** — Spring `@RequestMapping`/`@GetMapping` (Java/Kotlin)
> 2. **高** — Django `path()`/`re_path()` + FastAPI `@router.xxx` (Python)
> 3. **中** — Rails `routes.rb` DSL (Ruby)；Gin/Echo/Fiber `router.GET(...)` (Go)
> 4. **低** — Vapor (Swift)；Laravel explicit routes

---

## 六、数据流分析 (Dataflow)

**层级**：CFG DSL（控制流边）> 污点配置（source/sink/sanitizer）> LANGUAGE_TIERS

| 语言 | LANGUAGE_TIER | Taint Config | CFG DSL 边数 | 实际能力 | 评级 |
|------|:---:|:---:|:---:|---|:---:|
| TypeScript | FULL | ✅ | **17** | 完整 CFG + 过程间污点追踪 | ✅ |
| JavaScript | FULL | ✅ | **16** | 完整 CFG + 过程间污点追踪 | ✅ |
| Java | FULL | ✅ | **14** | CFG + try/catch/synchronized 语义 + 过程间污点 | ✅ |
| Python | FULL | ✅ | **8** | CFG + 污点追踪（async/await 基础） | ✅ |
| Go | FULL | ✅ | **9** | CFG + defer/panic/recover 语义 + goroutine 边界 | ✅ |
| C# | FULL | ✅ | ⚫ 无 DSL | 污点 source/sink 检测；**无 CFG** → 路径不可靠 | 🟡 |
| Rust | FULL | ✅ | ⚫ 无 DSL | 污点 source/sink；Rust 所有权语义未建模 | 🟡 |
| C | FULL | ✅ | ⚫ 无 DSL | 污点 source/sink；指针别名分析缺失 | 🟡 |
| C++ | FULL | ✅ | ⚫ 无 DSL | 同 C；模板展开不透明 | 🟡 |
| Kotlin | — | ✅ | ⚫ 无 DSL | 污点 config 独立存在；Java DSL **不适用** Kotlin AST | 🟡 |
| ArkTS | — | ✅ | 🟡 复用 TS | 依赖 TS DSL；HarmonyOS IPC 边界未专项处理 | 🟡 |
| Vue SFC | — | 🟡 | 🟡 复用 TS | `<script>` 复用 TS；`<template>` 数据流不追踪 | 🟡 |
| PHP | LIMITED | ✅ | ⚫ | 仅 symbol 级污点检测 | 🔴 |
| Ruby | LIMITED | ✅ | ⚫ | 同上 | 🔴 |
| Swift | LIMITED | ✅ | ⚫ | 同上；actor 并发模型未建模（`†` 可选） | 🔴 |
| Dart | LIMITED | ✅ | ⚫ | 同上（`†` 可选） | 🔴 |
| Objective-C | BASIC | ✅ | ⚫ | 极简：仅检测 sink 调用点 | 🔴 |
| COBOL | BASIC | ⚫ | ⚫ | 无污点配置；无 CFG | ⚫ |

> **CFG DSL 建设可行性**（`*.sg` 语言）：
> - 🟢 **Kotlin** — 与 Java DSL 结构相似，节点名差异明确，工作量 1-2 天
> - 🟢 **C#** — AWAIT/LOCK 语义清晰，树结构访问者比较直接
> - 🟡 **Rust** — `unsafe` 块 + `?` 运算符 + `match` arm 复杂，需要 2-3 天
> - 🟡 **C/C++** — 指针别名与预处理器阻碍静态边精度，难度高

---

## 七、Bug 检测规则覆盖

**8 条内置规则**：`missing-guard` · `missing-unwrap` · `missing-resource` · `missing-exception-handling` · `missing-return-check` · `missing-concurrency-guard` · `sql-injection` · `path-traversal`

| 语言 | MG | MU | MR | MEH | MRC | MCG | SQLi | PT | 得分 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| TypeScript | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **8/8** ✅ |
| JavaScript | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **8/8** ✅ |
| Vue SFC | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **8/8** ✅ |
| Python | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **7/8** 🟢 |
| Go | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | **7/8** 🟢 |
| Java | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **7/8** 🟢 |
| Kotlin | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **7/8** 🟢 |
| C# | ✅ | ⚫ | ✅ | ✅ | 🟡 | ✅ | ✅ | ⚫ | **5/8** 🟡 |
| Rust | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⚫ | ⚫ | ⚫ | **4/8** 🟡 |
| C / C++ | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ⚫ | ⚫ | **4/8** 🟡 |
| PHP | ✅ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ✅ | ✅ | **3/8** 🟡 |
| Ruby | ✅ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ✅ | ✅ | **3/8** 🟡 |
| Swift | 🟡 | ⚫ | ⚫ | 🟡 | ⚫ | ⚫ | ⚫ | ⚫ | **1/8** 🔴 |
| Dart | 🟡 | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | **1/8** 🔴 |
| ArkTS | 🟡 | ⚫ | ⚫ | 🟡 | ⚫ | ⚫ | ⚫ | ⚫ | **1/8** 🔴 |
| Objective-C | 🟡 | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | **1/8** 🔴 |
| COBOL | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | **0/8** ⚫ |

> 列缩写：MG=missing-guard · MU=missing-unwrap · MR=missing-resource · MEH=missing-exception-handling · MRC=missing-return-check · MCG=missing-concurrency-guard · SQLi=sql-injection · PT=path-traversal  
> **注**：🟡 = 仅通用 fallback 规则；✅ = 有该语言专属检测模式；⚫ = 规则不适用该语言。得分仅计 ✅ 条数。XSS 规则当前**未实现**，是 8 条之外最重要的缺口。

---

## 八、综合评级汇总

| 语言 | 导入绑定 | 符号提取 | 节点覆盖 | 框架检测 | 数据流 | Bug检测 | **综合** |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **TypeScript** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **JavaScript** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Python** | ✅ | 🟢 | 🟡 | 🟡 | ✅ | 🟢 | 🟢 |
| **Java** | ✅ | 🟢 | 🟡 | 🟡 | ✅ | 🟢 | 🟢 |
| **Kotlin** | ✅ | 🟢 | 🟡 | 🟡 | 🟡 | 🟢 | 🟢 |
| **Go** | 🟡 | 🟢 | 🟡 | 🟡 | ✅ | 🟢 | 🟢 |
| **Vue SFC** | 🟢 | 🟢 | 🟢 | 🟢 | 🟡 | ✅ | 🟢 |
| **Rust** | ✅ | 🟢 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 |
| **C#** | ✅ | 🟢 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 |
| **PHP** | ✅ | 🟡 | 🟢 | 🟢 | 🔴 | 🟡 | 🟡 |
| **Ruby** | 🟡 | 🟡 | 🟡 | 🟡 | 🔴 | 🟡 | 🟡 |
| **ArkTS** | 🟢 | 🟢 | 🟢 | 🟡 | 🟡 | 🔴 | 🟡 |
| **Swift** | 🟡 | 🟡 | 🟡 | 🟡 | 🔴 | 🔴 | 🔴 |
| **Dart** | 🟡 | 🟡 | 🟡 | 🟢 | 🔴 | 🔴 | 🔴 |
| **C / C++** | 🟡 | 🟡 | 🔴 | 🔴 | 🟡 | 🟡 | 🔴 |
| **Objective-C** | 🔴 | 🟡 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| **COBOL** | ⚫ | 🔴 | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ |

> **Tier 划分**：TypeScript/JavaScript 为 **Tier-1**（全维度完整）；Python/Java/Go/Kotlin/Vue SFC 为 **Tier-2**（核心能力完整，有局部缺口）；Rust/C#/PHP/Ruby/ArkTS 为 **Tier-3**（关键能力缺失）；其余为 **Tier-4/未就绪**。

---

## 九、缺口与改进建议

| 缺口 | 影响语言 | 实现难度 | 优先级 |
|------|---------|:---:|:---:|
| 路由提取器：Spring / Django / Rails / Gin / FastAPI（缺 HANDLES_ROUTE 边） | Java/Kotlin/Python/Go/Ruby | 🟡 中 | 🔴 P1 |
| Kotlin CFG DSL（`kotlin-static-edges.sg`） | Kotlin | 🟢 低 | 🔴 P1 |
| C# CFG DSL（`csharp-static-edges.sg`） | C# | 🟢 低 | 🔴 P1 |
| XSS 检测规则（SQL 注入/路径穿越已实现，XSS 仍未覆盖） | TS/JS/PHP/Ruby | 🟢 低 | 🔴 P1 |
| Rust CFG DSL（`rust-static-edges.sg`） | Rust | 🟡 中 | 🟡 P2 |
| named-bindings：Go / Swift / Dart / Ruby | 4 语言 | 🟡 中 | 🟡 P2 |
| Bug 检测规则：Swift/Dart/ArkTS 覆盖扩展（各仅 1/8） | Swift, Dart, ArkTS | 🟢 低 | 🟡 P2 |
| Objective-C 无 Method 节点（HAS_METHOD 边） | Objective-C | 🟢 低 | 🟡 P2 |
| C/C++ CFG DSL | C/C++ | 🔴 高 | 🟢 P3 |
| C# 无构造函数推断 | C# | 🟢 低 | 🟢 P3 |
| Vue SFC 模板层无符号提取 | Vue SFC | 🟡 中 | 🟢 P3 |
| COBOL 全面支持（tree-sitter 替代 Regex） | COBOL | 🔴 高 | ⚫ 战略 |

---

## 十、变更历史

| 日期 | commit | 变更内容 |
|------|--------|----------|
| 2026-04-08 | `36506d0` | 新增 Java/Go CFG DSL（`java-static-edges.sg` 14 边、`go-static-edges.sg` 9 边）；新增 SQL 注入（OWASP A03）和路径穿越（OWASP A01/CWE-22）检测规则；`builtinRules` 从 6 条扩展为 8 条；新增 M4 Web 组件测试 |
| 2026-04-08 | `b57da45` | 修正 C/C++/ObjC IMPORTS 边误判（已通过 `standard.ts` 实现）；更新 ArkTS/C/C++/ObjC 综合等级；重排缺口优先级，将 dataflow DSL 和路由提取提升为 🔴 |
| 2026-04-08 | `2de882c` | ArkTS `.ets` 扩展名解析修复（跨文件 IMPORTS 边），新增集成测试 8 个 |
| 2026-04-08 | `0050109` | 初始文档（基于源码静态分析生成） |

*本文档基于 `gitnexus/src/core/ingestion/` 源码直接分析，可作为语言覆盖度评审、功能对齐规划和贡献者参考的基线文档。*
