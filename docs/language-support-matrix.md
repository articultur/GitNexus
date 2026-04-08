# GitNexus 语言支持全景矩阵

> 最后更新：2026-04-08 · 基于 commit `6838e30` (main)  
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
| Go | ✅ | 🟡 | 🟢 | go resolver（`go.mod` module path）+ `extractGoNamedBindings`（包别名路由至 `moduleAliasMap`） |
| C / C++ | ✅ | ⚫ | 🟡 | standard resolver（`#include`/`#import` 扫描，项目内路径）；**无 named-bindings**，宏/全局变量无法绑定 |
| Swift | ✅ | 🟡 | 🟡 | swift resolver（`Package.swift` targets）；`extractSwiftNamedBindings`（`import class/func/var Module.Symbol` 限定导入，`†` 可选安装） |
| Dart | ✅ | 🟡 | 🟢 | dart resolver + `extractDartNamedBindings`（`show` 组合符精确绑定）（`†` 可选安装） |
| Ruby | ✅ | ⚫ | 🟡 | ruby resolver（require/require_relative via callRouter）；**无 named-bindings**，mixin/extend 无法追踪 |
| Objective-C | ✅ | 🟢 | 🟢 | standard resolver（`#import` 扫描）+ `objectivec.ts` named-bindings；category 合并语义已优化 |
| COBOL | ⚫ | ⚫ | ⚫ | COPY 语句无解析；无绑定实现 |

> **现状**：Go（包别名）、Dart（`show` 组合符）、Swift（`import class/func/var` 限定式导入）已实现 named-bindings。剩余缺口：Ruby 因动态 `method_missing`/`include` 难度较高；C/C++ 受预处理器影响最难。

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
| C / C++ | ✅ | 🟢 | Function/Struct/Class/Enum/Typedef | **宏展开**不透明；模板特化弱 |
| PHP | ✅ | 🟡 | Function/Class/Method/Trait | 魔术方法、匿名类弱 |
| Swift | ✅ | 🟡 | Class/Struct/Protocol/Extension/Function（`†` 可选） | @propertyWrapper / actor 弱 |
| Dart | ✅ | 🟡 | Class/Function/Mixin（`†` 可选） | async/isolate 不完整 |
| Ruby | ✅ | 🟡 | Module/Class/Method | `define_method`/`included` 动态定义无法覆盖 |
| Objective-C | ✅ | 🟢 | Interface/Protocol/Category/Property/Method | Category 方法合并建模已优化；methodExtractor 已注册 |
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
| Java | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Kotlin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Python | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟢 |
| Go | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟢 |
| Rust | ✅ | ✅ | ⚫ | 🟡 | ✅ | 🟡 |
| C# | ✅ | ✅ | ⚫ | ✅ | ✅ | 🟡 |
| Ruby | ✅ | ✅ | ✅ | ⚫ | ✅ | 🟢 |
| Swift | ✅ | ✅ | ⚫ | 🟡 | ✅ | 🟡 |
| Dart | ✅ | ✅ | ⚫ | 🟡 | ✅ | 🟡 |
| C / C++ | ✅ | 🟡 | ⚫ | 🔴 | 🟡 | 🔴 |
| Objective-C | ✅ | 🟡 | ⚫ | ⚫ | 🟢 | 🔴 |
| COBOL | 🔴 | ⚫ | ⚫ | ⚫ | 🔴 | ⚫ |

> **路由边现状**：`HANDLES_ROUTE` 边在 TS/JS（Next.js/Expo/Express）+ PHP（file-based）+ Python（Django urlpatterns + FastAPI @app.get/@router.post）+ Ruby（Rails routes.rb）+ **Java/Kotlin（Spring @GetMapping/@PostMapping/@RequestMapping）** + **Go（Gin/Echo/Fiber r.GET/.POST）** 生成。  
> **注**：C/C++/ObjC 的 `#include`/`#import` 通过 `standard.ts` 解析，可生成 IMPORTS 图谱边（仅相对路径/项目内头文件，系统库如 `<stdio.h>` 被过滤）。ArkTS 跨文件 `.ets` 导入已在 commit `2de882c` 修复。

---

## 五、框架识别 / 入口点检测

**组件**：`framework-detection.ts`（55 个框架标识）+ `entry-point-scoring.ts`（472 行评分逻辑）+ `route-extractors/`

| 语言 | 框架检测 | 路由提取 (HANDLES_ROUTE) | 入口点评分 | 综合评级 |
|------|:---:|:---:|:---:|:---:|
| TypeScript / JavaScript | ✅ Next.js/Expo Router/Express/NestJS/React/Prisma/Supabase | ✅ Next.js + Expo → URL 映射 | ✅ | ✅ |
| PHP | ✅ Laravel（routes/controllers/jobs/middleware/providers） | 🟡 仅文件级路由（api/*.php） | 🟢 | 🟢 |
| Java | ✅ Spring Boot/JAX-RS/Java service | ✅ Spring `@GetMapping`/`@PostMapping`/`@RequestMapping` | 🟢 | 🟢 |
| Kotlin | ✅ Spring-Kotlin/Ktor/Android（Activity/Fragment） | ✅ Spring `@GetMapping`/`@PostMapping`/`@RequestMapping` | 🟢 | 🟢 |
| Python | ✅ Django/FastAPI/Flask/generic API | ✅ Django `urlpatterns` + FastAPI `@app.get`/`@router.post` | 🟢 | 🟢 |
| Go | ✅ Gin/Echo/Fiber/gRPC/go-http | ✅ Gin/Echo/Fiber `r.GET()`/`.POST()` | 🟢 | 🟢 |
| Rust | ✅ actix-web/Axum/Rocket/Tokio | ⚫ | 🟢 | 🟡 |
| C# | ✅ ASP.NET/Blazor/SignalR/EF Core/Background Services | ⚫ | 🟢 | 🟡 |
| Ruby | ✅ Rails/Sinatra/executable scripts | ✅ Rails `routes.rb` DSL（resources/get/post/match） | 🟢 | 🟢 |
| Swift | ✅ iOS AppEntry/UIKit/SwiftUI/Vapor（`†` 可选） | ⚫ | 🟡 | 🟡 |
| Dart | ✅ Flutter/Riverpod（`†` 可选） | ⚫ | 🟡 | 🟡 |
| ArkTS | 🟡 Harmony ArkUI（@Entry/@Component 装饰器） | ⚫ | 🟡 | 🟡 |
| C / C++ | 🟢 路径模式/Qt 入口 | ⚫ | 🟢 | 🟢 |
| Objective-C | 🔴 CocoaTouch 路径模式 | ⚫ | 🔴 | 🔴 |
| COBOL | ⚫ | ⚫ | ⚫ | ⚫ |

> **路由提取器现状**：Django（`urlpatterns`/`path()`/`re_path()`）、Rails（`routes.rb` DSL）、Spring（`@GetMapping`/`@PostMapping`/`@RequestMapping`）、FastAPI（`@app.get`/`@router.post`）、Gin/Echo/Fiber（`r.GET()`/`.POST()`）均已集成至 pipeline.ts。剩余缺口：
> 1. **低** — Vapor (Swift)；Laravel explicit routes；Ktor (Kotlin)

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
| C# | FULL | ✅ | **20** | CFG + if/for/foreach/while/do/try-catch/finally/switch/lock/using/throw/return（含 ctor + local_fn） | 🟢 |
| Rust | FULL | ✅ | **18** | CFG + if-let/while-let/match/闭包/async-block/unsafe + ? 运算符；所有权语义未建模 | 🟢 |
| C | FULL | ✅ | **14** | CFG + if/while/do/for/switch/goto/break/continue/return/declaration/expression；宏展开不透明 | 🟡 |
| C++ | FULL | ✅ | **20** | CFG + try-catch/throw/lambda/range-based-for/co_return + C 全部节点；模板展开不透明 | 🟢 |
| Kotlin | FULL | ✅ | **13** | CFG + if/when表达式/for/while/do/try-catch/finally/throw；协程上下文未建模 | 🟢 |
| ArkTS | — | ✅ | 🟡 复用 TS | 依赖 TS DSL；HarmonyOS IPC 边界未专项处理 | 🟡 |
| Vue SFC | — | 🟡 | 🟡 复用 TS | `<script>` 复用 TS；`<template>` 数据流不追踪 | 🟡 |
| PHP | LIMITED | ✅ | ⚫ | 仅 symbol 级污点检测 | 🔴 |
| Ruby | LIMITED | ✅ | ⚫ | 同上 | 🔴 |
| Swift | LIMITED | ✅ | ⚫ | 同上；actor 并发模型未建模（`†` 可选） | 🔴 |
| Dart | LIMITED | ✅ | ⚫ | 同上（`†` 可选） | 🔴 |
| Objective-C | LIMITED | ✅ | **ObjC** | CFG DSL 就绪（@try/@catch/@synchronized/fast-enum）；taint source/sink/sanitizer 已配置（SQL/JS/HTML/路径穿越/动态分派/KVC 注入） | 🟢 |
| COBOL | BASIC | ⚫ | ⚫ | 无污点配置；无 CFG | ⚫ |

> **CFG DSL 现状**：TypeScript(17)、JavaScript(16)、Python(8)、Java(14)、Go(9) 为既有 DSL；Kotlin(13)、C#(20)、Rust(18)、C(14)、C++(20) 已在本轮完成，`LANGUAGE_DSL_MAP` 合计覆盖 **11 种语言**（含 Objective-C）。PHP、Ruby、Swift、Dart 仍无 DSL（均为 LIMITED 层，宏/动态特性影响精度）。

---

## 七、Bug 检测规则覆盖

**9 条内置规则**：`missing-guard` · `missing-unwrap` · `missing-resource` · `missing-exception-handling` · `missing-return-check` · `missing-concurrency-guard` · `sql-injection` · `path-traversal` · `xss`（OWASP A03:2021 / CWE-79）

| 语言 | MG | MU | MR | MEH | MRC | MCG | SQLi | PT | XSS | 得分 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| TypeScript | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **9/9** ✅ |
| JavaScript | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **9/9** ✅ |
| Vue SFC | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚫ | **8/9** 🟢 |
| Python | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **8/9** 🟢 |
| Go | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | **8/9** 🟢 |
| Java | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **8/9** 🟢 |
| Kotlin | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **8/9** 🟢 |
| C# | ✅ | ⚫ | ✅ | ✅ | 🟡 | ✅ | ✅ | ⚫ | ✅ | **6/9** 🟡 |
| PHP | ✅ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ✅ | ✅ | ✅ | **4/9** 🟡 |
| Ruby | ✅ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ✅ | ✅ | ✅ | **4/9** 🟡 |
| Rust | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⚫ | ⚫ | ⚫ | ⚫ | **4/9** 🟡 |
| C / C++ | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ⚫ | ⚫ | ⚫ | **4/9** 🟡 |
| Swift | ✅ | ✅ | ✅ | 🟡 | ⚫ | ✅ | ⚫ | ⚫ | ⚫ | **4/9** 🟡 |
| Dart | ✅ | ✅ | ✅ | ⚫ | ⚫ | ✅ | ⚫ | ⚫ | ⚫ | **4/9** 🟡 |
| ArkTS | ✅ | ✅ | ⚫ | 🟡 | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | **2/9** 🔴 |
| Objective-C | ✅ | ⚫ | ✅ | ⚫ | ✅ | ⚫ | 🟡 | 🟡 | 🟡 | **3/9** 🟡 |
| COBOL | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ | **0/9** ⚫ |

> 列缩写：MG=missing-guard · MU=missing-unwrap · MR=missing-resource · MEH=missing-exception-handling · MRC=missing-return-check · MCG=missing-concurrency-guard · SQLi=sql-injection · PT=path-traversal · XSS=xss  
> **注**：✅ = 有该语言专属检测模式；🟡 = 仅通用 fallback 规则；⚫ = 无适用模式。得分仅计 ✅ 条数（9 条规则总分）。XSS 规则现已实现，覆盖 9 种语言（TS/JS/Python/Java/Kotlin/PHP/Ruby/Go/C#）。Swift/Dart 的 MG/MU/MR/MCG 均已在本轮新增专属模式（`†` 可选依赖）。

---

## 八、综合评级汇总

| 语言 | 导入绑定 | 符号提取 | 节点覆盖 | 框架检测 | 数据流 | Bug检测 | **综合** |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **TypeScript** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **JavaScript** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Python** | ✅ | 🟢 | 🟡 | 🟢 | ✅ | 🟢 | 🟢 |
| **Java** | ✅ | 🟢 | 🟡 | 🟢 | ✅ | 🟢 | 🟢 |
| **Kotlin** | ✅ | 🟢 | 🟡 | 🟢 | 🟢 | 🟢 | 🟢 |
| **Go** | 🟢 | 🟢 | 🟡 | 🟢 | ✅ | 🟢 | 🟢 |
| **Vue SFC** | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 | ✅ | 🟢 |
| **Rust** | ✅ | 🟢 | 🟡 | 🟡 | 🟢 | 🟡 | 🟢 |
| **C#** | ✅ | 🟢 | 🟡 | 🟡 | 🟢 | 🟡 | 🟢 |
| **PHP** | ✅ | 🟡 | 🟢 | 🟢 | 🔴 | 🟡 | 🟡 |
| **Ruby** | 🟡 | 🟡 | 🟡 | 🟢 | 🔴 | 🟡 | 🟢 |
| **ArkTS** | 🟢 | 🟢 | 🟢 | 🟡 | 🟡 | 🟡 | 🟡 |
| **Swift** | 🟡 | 🟡 | 🟡 | 🟡 | 🔴 | 🟡 | 🟡 | <!-- 导入绑定：qualified import extractor 已就绪 -->
| **Dart** | 🟢 | 🟡 | 🟡 | 🟢 | 🔴 | 🟡 | 🟡 |
| **C / C++** | 🟡 | 🟢 | 🔴 | 🟢 | 🟢 | 🟡 | 🟢 |
| **Objective-C** | 🟢 | 🟢 | 🟡 | 🔴 | 🟢 | 🟡 | 🟢 |
| **COBOL** | ⚫ | 🔴 | ⚫ | ⚫ | ⚫ | ⚫ | ⚫ |

> **Tier 划分**：TypeScript/JavaScript 为 **Tier-1**（全维度完整）；Python/Java/Go/Kotlin/Vue SFC/Ruby 为 **Tier-2**（核心能力完整，有局部缺口）；Rust/C#/C/C++/Objective-C 升入 **Tier-2**（CFG DSL + named-bindings + taint 扩展完成）；PHP/ArkTS 为 **Tier-3**；Swift/Dart 为 **Tier-3**（bug 规则 + named-bindings 改善）；COBOL 为 **未就绪**。

---

## 九、缺口与改进建议

| 缺口 | 影响语言 | 实现难度 | 优先级 | 状态 |
|------|---------|:---:|:---:|:---:|
| 路由提取器：Spring `@RequestMapping`/`@GetMapping`（缺 HANDLES_ROUTE 边） | Java, Kotlin | 🟡 中 | 🔴 P1 | ✅ 已完成（e60099a） |
| 路由提取器：FastAPI `@router.xxx` / Gin / Echo / Fiber handler | Python, Go | 🟡 中 | 🔴 P1 | ✅ 已完成（e60099a） |
| named-bindings：Swift（`import class/func/var` 限定式） | Swift | 🟡 中 | 🟡 P2 | ✅ 已完成（e60099a） |
| Objective-C 无 Method 节点（HAS_METHOD 边） | Objective-C | 🟢 低 | 🟡 P2 | ✅ 已完成（未发布） |
| named-bindings：Ruby（`require` 为 wildcard，无 named-import 语义） | Ruby | 🔴 高 | ⚪ 不适用 | ⚫ 跳过（Ruby 无具名导入） |
| C# 无构造函数推断 | C# | 🟢 低 | 🟢 P3 | ✅ 已完成 |
| Vue SFC 模板层无符号提取 | Vue SFC | 🟡 中 | 🟢 P3 | ✅ 已完成 |
| ObjC CFG DSL（控制流图 + limited-tier 数据流分析） | Objective-C | 🟢 低 | 🟡 P2 | ✅ 已完成 |
| ObjC bug 规则（missing-guard / resource / return-check + taint sinks） | Objective-C | 🟡 中 | 🟡 P2 | ✅ 已完成 |
| COBOL 全面支持（tree-sitter 替代 Regex + DATA DIVISION 变量提取） | COBOL | 🔴 高 | ⚫ 战略 | 🔲 开放 |

---

## 十、变更历史

| 日期 | commit | 变更内容 |
|------|--------|----------|
| 2026-04-08 | `6838e30` | **Phase 2 增强**：ObjC named-bindings 实现（`objectivec.ts`）→ 导入绑定 🔴→🟢；C/C++ 框架检测完善（Qt/main 入口）→ 框架检测 🔴→🟢；ObjC/C++ 符号提取优化 → 符号提取 🟡→🟢；ObjC 数据流 taint 扩展完成 → 数据流 🟡→🟢；两者综合评级均升至 🟢，进入 Tier-2 |
| 2026-04-08 | 未发布 | ObjC CFG DSL（`objectivec-static-edges.sg`，覆盖 if/while/for/switch/@try/@catch/@synchronized 等）；ObjC 升入 LANGUAGE_TIERS.LIMITED；missing-guard/resource/return-check 新增 ObjC 专属规则；taint.ts 扩展 ObjC source/sink/sanitizer（SQL/JS/HTML/路径穿越/动态分派/KVC 注入等）；修复 ObjC 容器 AST 节点映射并补充 `test/integration/resolvers/objc.test.ts`（9/9 通过） |
| 2026-04-09 | `e60099a` | Spring `@GetMapping`/`@PostMapping`/`@RequestMapping` 路由提取器（Java/Kotlin）；FastAPI `@app.get`/`@router.post` + Gin/Echo/Fiber `r.GET()/.POST()` 路由提取器（Python/Go）；Swift `import class/func/var` 限定导入 named-binding extractor；ObjC `methodExtractor` 注册（`objcMethodConfig` + `extractOwnerName` 模式，HAS_METHOD 边现在可用） |
| 2026-04-08 | `796aad9` | Rust/C/C++ CFG DSL（各 18/14/20 节点类型）；Kotlin/C# CFG DSL（13/20 节点）；LANGUAGE_DSL_MAP 覆盖 10 种语言；Dart `show`/Go 包别名 named-bindings；Swift/Dart/ArkTS bug 规则扩展（MG/MU/MR/MCG）；COBOL EVALUATE/IF 控制流模拟（CALLS 图边）；XSS 规则（OWASP A03）注册 |
| 2026-04-08 | `36506d0` | 新增 Java/Go CFG DSL（14/9 边）；新增 SQL 注入（OWASP A03）和路径穿越（OWASP A01/CWE-22）检测规则；`builtinRules` 从 6 条扩展为 8 条；Django/Rails 路由提取器集成至 pipeline.ts |
| 2026-04-08 | `b57da45` | 修正 C/C++/ObjC IMPORTS 边误判（已通过 `standard.ts` 实现）；更新 ArkTS/C/C++/ObjC 综合等级 |
| 2026-04-08 | `2de882c` | ArkTS `.ets` 扩展名解析修复（跨文件 IMPORTS 边），新增集成测试 8 个 |
| 2026-04-08 | `0050109` | 初始文档（基于源码静态分析生成） |

*本文档基于 `gitnexus/src/core/ingestion/` 源码直接分析，可作为语言覆盖度评审、功能对齐规划和贡献者参考的基线文档。*
