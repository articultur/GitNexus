# Objective-C 方法索引修复设计

**日期**: 2026-03-31
**状态**: 已批准
**问题**: 查询 OC 多参数方法时返回错误的 Java 实现

## 背景

当查询 OC 方法 `sizeOfView:css:attribute:superFrame:` 时，GitNexus 返回了 Java `B2HComponent.sizeOfView` 而不是 iOS 的 `B2HPageWidget.m`。原因是 OC 多参数选择器在 AST 中是嵌套结构，当前的 tree-sitter 查询无法捕获。

## 问题根因

当前查询：
```scheme
(method_definition (identifier) @name) @definition.method
```

**只匹配一元方法**（`identifier` 为直接子节点），无法匹配多参数选择器。

## 解决方案

### 方案 A：修改查询 + descriptionExtractor（已选）

#### 1. 更新 tree-sitter 查询

```scheme
; ── OC Method Definitions (with body) ─────────────────────────────────────
(method_definition
  (keyword_selector
    (keyword_declarator
      selector: (identifier) @selector.part))) @definition.method

(method_definition
  (method_selector_no_list
    (identifier) @selector.part)) @definition.method

(method_definition
  "+" @method.type
  (method_type
    (type_descriptor
      type: (type_identifier) @method.return)))

(method_definition
  "-" @method.type
  (method_type
    (type_descriptor
      type: (type_identifier) @method.return)))

; ── OC Method Declarations (no body) ───────────────────────────────────────
(method_declaration
  (keyword_selector
    (keyword_declarator
      selector: (identifier) @selector.part))) @definition.method

(method_declaration
  (method_selector_no_list
    (identifier) @selector.part)) @definition.method

(method_declaration
  "+" @method.type
  (method_type
    (type_descriptor
      type: (type_identifier) @method.return)))

(method_declaration
  "-" @method.type
  (method_type
    (type_descriptor
      type: (type_identifier) @method.return)))
```

#### 2. 添加 descriptionExtractor 钩子

```typescript
// gitnexus/src/core/ingestion/languages/objective-c.ts

const objcDescriptionExtractor: DescriptionExtractor = (nodeLabel, nodeName, captureMap) => {
  const selectorParts = captureMap['selector.part'];
  if (selectorParts && selectorParts.length > 0) {
    return selectorParts.map(p => p.text).join('');
  }
  return nodeName;
};
```

#### 3. 注册钩子

```typescript
export const objectiveCProvider = defineLanguage({
  // ... existing config
  descriptionExtractor: objcDescriptionExtractor,
});
```

## 测试策略

### 单元测试
- 验证 `descriptionExtractor` 选择器拼接逻辑
- 测试文件: `test/unit/core/ingestion/languages/objective-c.test.ts`

### 集成测试
- 验证完整解析流程
- 测试文件: `test/integration/tree-sitter-languages.test.ts`

### 测试夹具
```objc
// test/fixtures/objective-c/multi-selector-method.m

@interface B2HPageWidget
// 一元方法（回退测试）
- (void)alloc;

// 类型方法
+ (instancetype)new;

// 多参数方法（核心修复）
- (CGSize)sizeOfView:(id)viewData
                  css:(NSDictionary *)css
           attribute:(NSString *)attr
           superFrame:(CGRect)frame;

// Block 参数
- (void)completion:(void(^)(BOOL success))completion;

// 可选参数
- (void)method:(int)a with:(int)b;
@end

@implementation B2HPageWidget
// ... 实现
@end
```

## 覆盖的方法形式

| 形式 | 示例 | 状态 |
|------|------|------|
| 一元方法 | `- (void)alloc;` | ✅ 回退支持 |
| 类型方法 | `+ (instancetype)new;` | ✅ 新增支持 |
| 多参数方法 | `- (CGSize)sizeOfView:css:;` | ✅ 核心修复 |
| 可选参数 | `- (void)method:(int)a with:(int)b;` | ✅ 新增支持 |
| Block 参数 | `- (void)completion:(void(^)(BOOL))block;` | ✅ 新增支持 |

## 文件变更清单

| 文件 | 操作 |
|------|------|
| `src/core/ingestion/languages/objective-c.ts` | 添加 `descriptionExtractor` 钩子 |
| `src/core/ingestion/tree-sitter-queries.ts` | 更新 OC 方法查询 |
| `test/unit/core/ingestion/languages/objective-c.test.ts` | 新建单元测试 |
| `test/fixtures/objective-c/multi-selector-method.m` | 新建测试夹具 |
| `test/integration/tree-sitter-languages.test.ts` | 添加集成测试 |

## 风险评估

| 风险 | 级别 | 缓解 |
|------|------|------|
| `@selector.part` 与其他查询冲突 | 低 | `descriptionExtractor` 仅在 `@definition.method` 匹配时调用 |
| OC 方法性能下降 | 低 | 查询复杂度 O(n)，n=参数数量 |
| 覆盖度回退 | 低 | 一元方法仍通过 `method_selector_no_list` 匹配 |
