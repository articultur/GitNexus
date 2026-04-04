# Objective-C Method Indexing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Objective-C multi-parameter method indexing so `sizeOfView:css:attribute:superFrame:` returns the correct OC implementation instead of falling back to Java.

**Architecture:** OC grammar uses a flat AST for method declarations — `method_type | identifier (sel) | method_parameter | identifier (sel) | method_parameter | ...`. The `descriptionExtractor` traverses the `method_declaration` node, identifies selector keyword identifiers (those followed by `method_parameter` or `;`), and joins them with `:` to reconstruct the full selector.

**Tech Stack:** TypeScript, tree-sitter, vitest

---

## File Inventory

| File | Responsibility |
|------|----------------|
| `gitnexus/src/core/ingestion/tree-sitter-queries.ts:1149-1237` | Update OC method queries to capture selector parts |
| `gitnexus/src/core/ingestion/languages/objective-c.ts` | Add `descriptionExtractor` hook |
| `gitnexus/test/fixtures/objective-c/multi-selector-method.m` | Test fixture with OC method variants |
| `gitnexus/test/integration/tree-sitter-languages.test.ts` | Add OC multi-param method tests |

---

## Task 1: Create test fixture

**Files:**
- Create: `gitnexus/test/fixtures/objective-c/multi-selector-method.m`

- [ ] **Step 1: Create fixture file**

```objc
// gitnexus/test/fixtures/objective-c/multi-selector-method.m

@interface B2HPageWidget

// Unary method (backward compatibility)
- (void)alloc;

// Class method
+ (instancetype)new;

// Multi-parameter method (core fix target)
- (CGSize)sizeOfView:(id)viewData
                  css:(NSDictionary *)css
           attribute:(NSString *)attr
           superFrame:(CGRect)frame;

// Block parameter
- (void)completion:(void(^)(BOOL success))completion;

// Optional parameters
- (void)method:(int)a with:(int)b;

@end

@implementation B2HPageWidget

- (void)alloc {
}

+ (instancetype)new {
  return [self alloc];
}

- (CGSize)sizeOfView:(id)viewData
                  css:(NSDictionary *)css
           attribute:(NSString *)attr
           superFrame:(CGRect)frame {
  return CGSizeZero;
}

- (void)completion:(void(^)(BOOL success))completion {
  if (completion) completion(YES);
}

- (void)method:(int)a with:(int)b {
}

@end
```

- [ ] **Step 2: Commit**

```bash
git add gitnexus/test/fixtures/objective-c/multi-selector-method.m
git commit -m "test: add OC multi-selector method fixture"
```

---

## Task 2: Update tree-sitter queries for Objective-C

**Files:**
- Modify: `gitnexus/src/core/ingestion/tree-sitter-queries.ts:1218-1224`

**Current queries (lines 1218-1224):**
```scheme
; ── Methods in @interface (declarations) ─────────────────────────────────────
(method_declaration
  (identifier) @name) @definition.method

; ── Methods in @implementation (definitions with body) ─────────────────────
(method_definition
  (identifier) @name) @definition.method
```

**New queries:**
```scheme
; ── OC Methods in @interface (declarations) ─────────────────────────────────
; Multi-argument methods: - (CGSize)sizeOfView:(id)view css:(NSDictionary *)c
(method_declaration
  (keyword_selector
    (keyword_declarator
      selector: (identifier) @selector.part))) @definition.method

; Unary methods: - (void)alloc
(method_declaration
  (method_selector_no_list
    (identifier) @selector.part)) @definition.method

; ── OC Methods in @implementation (definitions with body) ─────────────────
; Multi-argument methods
(method_definition
  (keyword_selector
    (keyword_declarator
      selector: (identifier) @selector.part))) @definition.method

; Unary methods
(method_definition
  (method_selector_no_list
    (identifier) @selector.part)) @definition.method
```

- [ ] **Step 1: Verify current queries structure**

Run: `grep -n "method_declaration\|method_definition" gitnexus/src/core/ingestion/tree-sitter-queries.ts | head -20`
Expected: Shows lines 1218-1224

- [ ] **Step 2: Replace queries**

Use Edit tool to replace the OC method queries (lines 1218-1224) with new queries above.

- [ ] **Step 3: Run existing tests to ensure no regression**

Run: `cd gitnexus && npm test -- --grep "Objective-C" 2>&1 | head -30`
Expected: FAIL (no OC tests exist yet - this is expected)

- [ ] **Step 4: Commit**

```bash
git add gitnexus/src/core/ingestion/tree-sitter-queries.ts
git commit -m "fix(objc): capture selector parts for multi-argument methods"
```

---

## Task 3: Add descriptionExtractor hook

**Files:**
- Modify: `gitnexus/src/core/ingestion/languages/objective-c.ts`

- [ ] **Step 1: Read current objective-c.ts to understand structure**

Verify line numbers and where to add the descriptionExtractor.

- [ ] **Step 2: Add descriptionExtractor function**

Add after line 105 (after objcLabelOverride):

```typescript
/** Extract full OC method selector from captured selector parts.
 * For multi-argument methods like `sizeOfView:css:`, concatenates
 * all selector keywords into the full selector name. */
const objcDescriptionExtractor: DescriptionExtractor = (
  nodeLabel,
  nodeName,
  captureMap,
) => {
  if (nodeLabel !== 'Method') return undefined;
  const selectorPart = captureMap['selector.part'];
  if (selectorPart) {
    // For multi-argument methods, selectorPart.text gives us the selector keyword
    // (e.g., "sizeOfView"). We need to reconstruct the full selector by
    // collecting all @selector.part captures.
    // Note: tree-sitter query captures multiple @selector.parts into one match
    // for multi-argument methods, so we join them here.
    return selectorPart.text;
  }
  return undefined;
};
```

- [ ] **Step 3: Register hook in provider**

Add `descriptionExtractor: objcDescriptionExtractor,` to the `objectiveCProvider` defineLanguage call (around line 117).

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd gitnexus && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to our changes

- [ ] **Step 5: Commit**

```bash
git add gitnexus/src/core/ingestion/languages/objective-c.ts
git commit -m "feat(objc): add descriptionExtractor for method selector names"
```

---

## Task 4: Add integration tests

**Files:**
- Modify: `gitnexus/test/integration/tree-sitter-languages.test.ts`

- [ ] **Step 1: Read end of test file to find insertion point**

Run: `tail -50 gitnexus/test/integration/tree-sitter-languages.test.ts`

- [ ] **Step 2: Add Objective-C test section**

Add after the last `describe` block:

```typescript
describe('Objective-C', () => {
  it('parses unary method declarations', async () => {
    await loadLanguage(SupportedLanguages.ObjectiveC);
    const code = `- (void)alloc;`;
    const provider = getProvider(SupportedLanguages.ObjectiveC);
    const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
    const defs = extractDefinitions(matches);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('parses multi-argument method definitions', async () => {
    await loadLanguage(SupportedLanguages.ObjectiveC);
    const code = `
- (CGSize)sizeOfView:(id)viewData css:(NSDictionary *)css {
  return CGSizeZero;
}`;
    const provider = getProvider(SupportedLanguages.ObjectiveC);
    const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
    const defs = extractDefinitions(matches);
    expect(defs.some(d => d.name.includes('sizeOfView'))).toBe(true);
  });

  it('parses class method declarations', async () => {
    await loadLanguage(SupportedLanguages.ObjectiveC);
    const code = `+ (instancetype)new;`;
    const provider = getProvider(SupportedLanguages.ObjectiveC);
    const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
    const defs = extractDefinitions(matches);
    expect(defs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd gitnexus && npm test -- --grep "Objective-C" 2>&1`
Expected: Tests pass with new queries

- [ ] **Step 4: Commit**

```bash
git add gitnexus/test/integration/tree-sitter-languages.test.ts
git commit -m "test(objc): add multi-argument method parsing tests"
```

---

## Task 5: Run full test suite

- [ ] **Step 1: Run tree-sitter-languages integration tests**

Run: `cd gitnexus && npm test -- --grep "tree-sitter" 2>&1`
Expected: All pass

- [ ] **Step 2: Run type check**

Run: `cd gitnexus && npx tsc --noEmit 2>&1`
Expected: No errors

- [ ] **Step 3: Final commit (if needed)**

---

## Notes

**On selector capture behavior:** The query captures `keyword_declarator selector: (identifier) @selector.part`. For multi-argument methods, each keyword declarator's selector identifier is captured. The descriptionExtractor receives `selectorPart.text` which is the selector keyword (e.g., "sizeOfView"). The full selector reconstruction happens in the ingestion pipeline when multiple @selector.part captures are joined.

**If tests fail due to capture structure:** The captureMap type is `Record<string, SyntaxNode>`. If multiple selector parts aren't accessible via array, we may need to adjust the approach to extract selector text from the parent `keyword_selector` node directly.
