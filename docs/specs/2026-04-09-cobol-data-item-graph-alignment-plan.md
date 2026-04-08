# COBOL Data Item Graph Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align COBOL data item graph edges with other languages by using `HAS_PROPERTY` edges with parent-child hierarchy instead of flat `CONTAINS`.

**Architecture:** Two-layer change: (1) add `parentName` field via level-stack tracking in `cobol-preprocessor.ts`, (2) rewrite data-item edge construction in `cobol-processor.ts` to use `HAS_PROPERTY` for program→item and parent→child edges, plus `ACCESSES(cobol-redefines)` for REDEFINES. The `redefines` field is already extracted — no changes needed there.

**Tech Stack:** TypeScript, Vitest, GitNexus graph API (KnowledgeGraph, generateId)

**Spec:** `docs/specs/2026-04-09-cobol-data-item-graph-alignment-design.md`

---

## File Structure

### Files to modify

| File | Responsibility |
|------|---------------|
| `gitnexus/src/core/ingestion/cobol/cobol-preprocessor.ts` | Add `parentName` to data item interface + level-stack extraction |
| `gitnexus/src/core/ingestion/cobol-processor.ts` | Rewrite data-item edges: HAS_PROPERTY + hierarchy + REDEFINES |
| `gitnexus/test/unit/cobol-preprocessor.test.ts` | Add parentName and hierarchy tests |
| `gitnexus/test/integration/resolvers/cobol.test.ts` | Update edge assertions for new edge types |

---

## Task 1: Add `parentName` to preprocessor interface

**Files:**
- Modify: `gitnexus/src/core/ingestion/cobol/cobol-preprocessor.ts:57-70`

- [ ] **Step 1: Add `parentName` to the data item interface**

In `CobolRegexResults.dataItems` array type (around line 57-70), add the `parentName` field:

```typescript
dataItems: Array<{
    name: string;
    level: number;
    line: number;
    pic?: string;
    usage?: string;
    occurs?: number;
    dependingOn?: string;
    redefines?: string;
    parentName?: string;    // Name of the parent data item (level-stack tracking)
    values?: string[];
    isExternal?: boolean;
    isGlobal?: boolean;
    section: 'working-storage' | 'linkage' | 'file' | 'local-storage' | 'screen' | 'unknown';
  }>;
```

- [ ] **Step 2: Run type check to verify the interface compiles**

Run: `cd gitnexus && npx tsc --noEmit 2>&1 | head -20`
Expected: PASS (new optional field, no breaking change)

- [ ] **Step 3: Commit**

```bash
git add gitnexus/src/core/ingestion/cobol/cobol-preprocessor.ts
git commit -m "feat(cobol): add parentName field to data item interface"
```

---

## Task 2: Add failing tests for parentName extraction

**Files:**
- Modify: `gitnexus/test/unit/cobol-preprocessor.test.ts`

- [ ] **Step 1: Add parentName tests in a new describe block**

Add after the existing "Data Division" describe block (around line 413) in `test/unit/cobol-preprocessor.test.ts`:

```typescript
// -------------------------------------------------------------------------
// parentName extraction (level-stack tracking)
// -------------------------------------------------------------------------
describe('parentName extraction', () => {
  it('top-level 01 items have no parentName', () => {
    const src = cobol(
      '      IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. TESTPROG.',
      '      DATA DIVISION.',
      '      WORKING-STORAGE SECTION.',
      '       01 WS-VAR               PIC X(10).',
      '       01 WS-OTHER             PIC 9(5).',
    );
    const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
    expect(r.dataItems.find((d) => d.name === 'WS-VAR')?.parentName).toBeUndefined();
    expect(r.dataItems.find((d) => d.name === 'WS-OTHER')?.parentName).toBeUndefined();
  });

  it('05-level under 01 gets parentName of the 01 group', () => {
    const src = cobol(
      '      IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. TESTPROG.',
      '      DATA DIVISION.',
      '      WORKING-STORAGE SECTION.',
      '       01 WS-RECORD.',
      '           05 WS-NAME          PIC X(30).',
      '           05 WS-AMOUNT        PIC 9(7).',
    );
    const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
    expect(r.dataItems.find((d) => d.name === 'WS-RECORD')?.parentName).toBeUndefined();
    expect(r.dataItems.find((d) => d.name === 'WS-NAME')?.parentName).toBe('WS-RECORD');
    expect(r.dataItems.find((d) => d.name === 'WS-AMOUNT')?.parentName).toBe('WS-RECORD');
  });

  it('10-level under 05 gets parentName of the 05 item', () => {
    const src = cobol(
      '      IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. TESTPROG.',
      '      DATA DIVISION.',
      '      WORKING-STORAGE SECTION.',
      '       01 WS-RECORD.',
      '           05 WS-NAME.',
      '               10 WS-FIRST     PIC X(15).',
      '               10 WS-LAST      PIC X(15).',
      '           05 WS-AMOUNT        PIC 9(7).',
    );
    const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
    expect(r.dataItems.find((d) => d.name === 'WS-FIRST')?.parentName).toBe('WS-NAME');
    expect(r.dataItems.find((d) => d.name === 'WS-LAST')?.parentName).toBe('WS-NAME');
    expect(r.dataItems.find((d) => d.name === 'WS-AMOUNT')?.parentName).toBe('WS-RECORD');
  });

  it('88-level gets parentName of preceding non-88 data item', () => {
    const src = cobol(
      '      IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. TESTPROG.',
      '      DATA DIVISION.',
      '      WORKING-STORAGE SECTION.',
      '       01 WS-STATUS             PIC X.',
      '           88 IS-ACTIVE         VALUE "A".',
      '           88 IS-INACTIVE       VALUE "I".',
    );
    const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
    expect(r.dataItems.find((d) => d.name === 'IS-ACTIVE')?.parentName).toBe('WS-STATUS');
    expect(r.dataItems.find((d) => d.name === 'IS-INACTIVE')?.parentName).toBe('WS-STATUS');
  });

  it('level stack resets on section transition', () => {
    const src = cobol(
      '      IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. TESTPROG.',
      '      DATA DIVISION.',
      '      WORKING-STORAGE SECTION.',
      '       01 WS-RECORD.',
      '           05 WS-NAME          PIC X(30).',
      '      LINKAGE SECTION.',
      '       01 LS-PARAM             PIC X(10).',
    );
    const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
    expect(r.dataItems.find((d) => d.name === 'WS-NAME')?.parentName).toBe('WS-RECORD');
    // LS-PARAM is in a new section — no parent from working-storage
    expect(r.dataItems.find((d) => d.name === 'LS-PARAM')?.parentName).toBeUndefined();
  });

  it('sibling items at same level get same parent', () => {
    const src = cobol(
      '      IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. TESTPROG.',
      '      DATA DIVISION.',
      '      WORKING-STORAGE SECTION.',
      '       01 WS-RECORD.',
      '           05 WS-A             PIC X(10).',
      '           05 WS-B             PIC X(10).',
      '           05 WS-C             PIC X(10).',
    );
    const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
    expect(r.dataItems.find((d) => d.name === 'WS-A')?.parentName).toBe('WS-RECORD');
    expect(r.dataItems.find((d) => d.name === 'WS-B')?.parentName).toBe('WS-RECORD');
    expect(r.dataItems.find((d) => d.name === 'WS-C')?.parentName).toBe('WS-RECORD');
  });

  it('77-level is always top-level (no parentName)', () => {
    const src = cobol(
      '      IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. TESTPROG.',
      '      DATA DIVISION.',
      '      WORKING-STORAGE SECTION.',
      '       01 WS-RECORD.',
      '           05 WS-NAME          PIC X(30).',
      '       77 WS-STANDALONE         PIC 9(5).',
    );
    const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
    expect(r.dataItems.find((d) => d.name === 'WS-STANDALONE')?.parentName).toBeUndefined();
  });

  it('nested program level stack is scoped per program', () => {
    const src = cobol(
      '      IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. OUTER.',
      '      DATA DIVISION.',
      '      WORKING-STORAGE SECTION.',
      '       01 WS-OUTER-REC.',
      '           05 WS-OUTER-FIELD   PIC X(10).',
      '      IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. INNER.',
      '      DATA DIVISION.',
      '      WORKING-STORAGE SECTION.',
      '       01 WS-INNER-REC.',
      '           05 WS-INNER-FIELD   PIC X(10).',
      '       END PROGRAM INNER.',
      '       END PROGRAM OUTER.',
    );
    const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
    expect(r.dataItems.find((d) => d.name === 'WS-OUTER-FIELD')?.parentName).toBe('WS-OUTER-REC');
    expect(r.dataItems.find((d) => d.name === 'WS-INNER-FIELD')?.parentName).toBe('WS-INNER-REC');
  });

  it('REDEFINES item has parentName and redefines both set', () => {
    const src = cobol(
      '      IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. TESTPROG.',
      '      DATA DIVISION.',
      '      WORKING-STORAGE SECTION.',
      '       01 WS-RECORD.',
      '           05 WS-NAME          PIC X(30).',
      '       01 WS-ALT REDEFINES WS-RECORD.',
      '           05 WS-CODE          PIC X(30).',
    );
    const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
    const alt = r.dataItems.find((d) => d.name === 'WS-ALT');
    expect(alt?.parentName).toBeUndefined(); // 01-level, top-level
    expect(alt?.redefines).toBe('WS-RECORD');
    expect(r.dataItems.find((d) => d.name === 'WS-CODE')?.parentName).toBe('WS-ALT');
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd gitnexus && npx vitest run test/unit/cobol-preprocessor.test.ts -t "parentName extraction" 2>&1 | tail -30`
Expected: All 9 tests FAIL — `parentName` is `undefined` because level-stack logic is not implemented yet.

- [ ] **Step 3: Commit failing tests**

```bash
git add gitnexus/test/unit/cobol-preprocessor.test.ts
git commit -m "test(cobol): add parentName extraction tests (currently failing)"
```

---

## Task 3: Implement level-stack tracking in preprocessor

**Files:**
- Modify: `gitnexus/src/core/ingestion/cobol/cobol-preprocessor.ts`

- [ ] **Step 1: Add level stack variables**

In the `extractCobolSymbolsWithRegex` function, find the state variables section (search for `let currentDataSection`). Add after the existing data-section variable:

```typescript
// Level-stack for tracking data item parent-child hierarchy
let dataLevelStack: Array<{ level: number; name: string }> = [];
```

- [ ] **Step 2: Reset stack on section transitions**

Find where `currentDataSection` is reassigned (the switch/case that handles `FILE SECTION`, `WORKING-STORAGE SECTION`, etc.). After each `currentDataSection = '...'` assignment, add:

```typescript
dataLevelStack = [];
```

- [ ] **Step 3: Reset stack on program boundary**

Find where `programBoundaryStack` is modified (when a new `IDENTIFICATION DIVISION` or `PROGRAM-ID` is encountered). Add `dataLevelStack = [];` at the same point.

- [ ] **Step 4: Set parentName and update stack for 88-level items**

In the 88-level extraction block (search for `lv88Match`), after `result.dataItems.push(...)`, the item is already pushed. Modify the block to set `parentName` BEFORE push. Find the 88-level push (around line 1924):

Replace:
```typescript
result.dataItems.push({
  name,
  level: 88,
  line: lineNum,
  values,
  section: currentDataSection,
});
```

With:
```typescript
// 88-level parent is the top of the stack (most recent non-88 data item)
const parent88 = dataLevelStack.length > 0 ? dataLevelStack[dataLevelStack.length - 1].name : undefined;
result.dataItems.push({
  name,
  level: 88,
  line: lineNum,
  values,
  section: currentDataSection,
  parentName: parent88,
});
// 88-levels do NOT go on the level stack — they are conditions, not data items
```

- [ ] **Step 5: Set parentName and update stack for regular data items**

In the standard data item extraction block (search for `const item: CobolRegexResults['dataItems'][number]`), before `result.dataItems.push(item)`:

After the `item` object is constructed and all clauses are applied (after line 1990 `if (clauses.isGlobal) item.isGlobal = true;`), add:

```typescript
// Level-stack: determine parentName
if (item.level === 77) {
  // 77-level is always standalone — no parent
  item.parentName = undefined;
  // Don't push 77 to stack — it can't have children
} else if (item.level === 1 || item.level === 66) {
  // 01/66-level starts a new record — pop everything at or above this level
  dataLevelStack = dataLevelStack.filter((e) => e.level < item.level);
  item.parentName = undefined;
  dataLevelStack.push({ level: item.level, name: item.name });
} else {
  // Subordinate level (02-49): find parent by popping stack
  dataLevelStack = dataLevelStack.filter((e) => e.level < item.level);
  const parent = dataLevelStack.length > 0 ? dataLevelStack[dataLevelStack.length - 1] : undefined;
  item.parentName = parent?.name;
  dataLevelStack.push({ level: item.level, name: item.name });
}
```

Insert this block right before `result.dataItems.push(item);` (the push for standard data items, around line 1992).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd gitnexus && npx vitest run test/unit/cobol-preprocessor.test.ts -t "parentName extraction" 2>&1 | tail -30`
Expected: All 9 tests PASS.

- [ ] **Step 7: Run full preprocessor test suite to verify no regressions**

Run: `cd gitnexus && npx vitest run test/unit/cobol-preprocessor.test.ts 2>&1 | tail -20`
Expected: All tests PASS (existing tests should not be affected — `parentName` is optional and does not change existing fields).

- [ ] **Step 8: Commit**

```bash
git add gitnexus/src/core/ingestion/cobol/cobol-preprocessor.ts
git commit -m "feat(cobol): implement level-stack tracking for parentName extraction"
```

---

## Task 4: Add failing tests for graph edge changes

**Files:**
- Modify: `gitnexus/test/integration/resolvers/cobol.test.ts`

- [ ] **Step 1: Update CONTAINS edge assertions**

The current test asserts exactly 36 `CONTAINS` edges with reason `cobol-data-item`. These will become `HAS_PROPERTY` edges. Update the assertion block.

Find the test `'produces exactly 36 CONTAINS edges with reason cobol-data-item'` (around line 327). Replace it with:

```typescript
it('produces zero CONTAINS edges with reason cobol-data-item (migrated to HAS_PROPERTY)', () => {
  const edges = getRelationships(result, 'CONTAINS').filter(
    (e) => e.rel.reason === 'cobol-data-item',
  );
  expect(edges.length).toBe(0);
});
```

- [ ] **Step 2: Add HAS_PROPERTY top-level assertions**

Add a new describe block after the CONTAINS edge section:

```typescript
describe('HAS_PROPERTY edge completeness', () => {
  it('produces exactly 25 HAS_PROPERTY edges for top-level data items (program -> 01/77 level)', () => {
    const edges = getRelationships(result, 'HAS_PROPERTY');
    // Top-level items: program directly owns 01/77 level items
    // These are edges where source is a program/module node, target is a Property node
    const topLevelEdges = edges.filter(
      (e) => e.rel.reason === 'cobol-data-item',
    );
    expect(topLevelEdges.length).toBe(25);
  });

  it('produces exactly 11 HAS_PROPERTY edges for child data items (parent -> child)', () => {
    const edges = getRelationships(result, 'HAS_PROPERTY');
    const childEdges = edges.filter(
      (e) => e.rel.reason === 'cobol-data-item-child',
    );
    expect(childEdges.length).toBe(11);
  });

  it('CUSTOMER-RECORD has HAS_PROPERTY children CUST-ID, CUST-NAME, CUST-BALANCE', () => {
    const edges = getRelationships(result, 'HAS_PROPERTY').filter(
      (e) => e.rel.reason === 'cobol-data-item-child' && e.source === 'CUSTOMER-RECORD',
    );
    expect(edges.length).toBe(3);
    expect(edgeSet(edges)).toEqual([
      'CUSTOMER-RECORD \u2192 CUST-BALANCE',
      'CUSTOMER-RECORD \u2192 CUST-ID',
      'CUSTOMER-RECORD \u2192 CUST-NAME',
    ]);
  });

  it('END-OF-FILE (88-level) has HAS_PROPERTY from WS-EOF', () => {
    const edges = getRelationships(result, 'HAS_PROPERTY').filter(
      (e) => e.rel.reason === 'cobol-data-item-child' && e.target === 'END-OF-FILE',
    );
    expect(edges.length).toBe(1);
    expect(edges[0].source).toBe('WS-EOF');
  });

  it('PREMIUM-CUSTOMER and REGULAR-CUSTOMER (88-level) have HAS_PROPERTY from WS-CUST-TYPE', () => {
    const edges = getRelationships(result, 'HAS_PROPERTY').filter(
      (e) => e.rel.reason === 'cobol-data-item-child' && e.source === 'WS-CUST-TYPE',
    );
    expect(edges.length).toBe(2);
    expect(edgeSet(edges)).toEqual([
      'WS-CUST-TYPE \u2192 PREMIUM-CUSTOMER',
      'WS-CUST-TYPE \u2192 REGULAR-CUSTOMER',
    ]);
  });

  it('total HAS_PROPERTY edges = 36 (25 top-level + 11 child)', () => {
    expect(getRelationships(result, 'HAS_PROPERTY').length).toBe(36);
  });
});
```

- [ ] **Step 3: Update grand total CONTAINS assertion**

Find the test `'produces exactly 81 total CONTAINS edges'` (around line 692). Update:

```typescript
it('produces exactly 45 total CONTAINS edges (data items migrated to HAS_PROPERTY)', () => {
  // 4 program-id + 1 nested-program + 2 section + 21 paragraph
  // + 8 exec-cics + 1 exec-sql + 1 dynamic-call
  // + 1 cics-dynamic-program + 2 entry-point + 1 file-declaration
  // + 1 jcl-job + 2 jcl-step
  // = 45 (data items no longer CONTAINS)
  expect(getRelationships(result, 'CONTAINS').length).toBe(45);
});
```

- [ ] **Step 4: Run integration tests to verify they fail**

Run: `cd gitnexus && npx vitest run test/integration/resolvers/cobol.test.ts 2>&1 | tail -30`
Expected: FAIL — the new HAS_PROPERTY tests fail because the processor still uses CONTAINS.

- [ ] **Step 5: Commit failing tests**

```bash
git add gitnexus/test/integration/resolvers/cobol.test.ts
git commit -m "test(cobol): update integration tests for HAS_PROPERTY edge migration"
```

---

## Task 5: Implement graph edge migration in processor

**Files:**
- Modify: `gitnexus/src/core/ingestion/cobol-processor.ts`

- [ ] **Step 1: Build a data-item name-to-nodeId map before edge construction**

Find the section `// ── Build data item Map early` (around line 504). The `buildDataItemMap` helper already exists but uses the data item name. We also need a map keyed by composite key to match items with parentName. Add BEFORE the existing `buildDataItemMap` call:

```typescript
// ── Build Property node IDs and a lookup by composite key ──
const dataItemNodeIds = new Map<string, string>();
for (const item of extracted.dataItems) {
  if (item.name === 'FILLER') continue;
  const propId = generatePropertyId(filePath, item);
  const key = `${item.section}:${item.level}:${item.name}`;
  dataItemNodeIds.set(key, propId);
}

// Lookup a data item's Property node ID by name within the same program scope
function findParentPropertyId(parentName: string, childItem: typeof extracted.dataItems[number]): string | undefined {
  const upper = parentName.toUpperCase();
  // Search for a matching data item name — could be in any section
  for (const item of extracted.dataItems) {
    if (item.name.toUpperCase() === upper) {
      return generatePropertyId(filePath, item);
    }
  }
  return undefined;
}
```

- [ ] **Step 2: Replace the flat CONTAINS data-item loop with hierarchical HAS_PROPERTY**

Replace the entire data-item loop block (lines 476-502). The current code is:

```typescript
  // ── Data items -> Property nodes ─────────────────────────────────
  for (const item of extracted.dataItems) {
    if (item.name === 'FILLER') continue; // Skip anonymous fillers
    const propId = generatePropertyId(filePath, item);
    const itemOwner = findOwningProgramName(item.line, extracted.programs);
    const itemParent = programModuleIds.get(itemOwner ?? '') ?? parentId;
    graph.addNode({
      id: propId,
      label: 'Property',
      properties: {
        name: item.name,
        filePath,
        startLine: item.line,
        endLine: item.line,
        language: SupportedLanguages.Cobol,
        description: `level:${item.level} section:${item.section}${item.pic ? ` pic:${item.pic}` : ''}`,
      },
    });
    graph.addRelationship({
      id: generateId('CONTAINS', `${itemParent}->${propId}`),
      type: 'CONTAINS',
      sourceId: itemParent,
      targetId: propId,
      confidence: 1.0,
      reason: 'cobol-data-item',
    });
  }
```

Replace with:

```typescript
  // ── Data items -> Property nodes ─────────────────────────────────
  for (const item of extracted.dataItems) {
    if (item.name === 'FILLER') continue; // Skip anonymous fillers
    const propId = generatePropertyId(filePath, item);
    const itemOwner = findOwningProgramName(item.line, extracted.programs);
    const itemParent = programModuleIds.get(itemOwner ?? '') ?? parentId;
    graph.addNode({
      id: propId,
      label: 'Property',
      properties: {
        name: item.name,
        filePath,
        startLine: item.line,
        endLine: item.line,
        language: SupportedLanguages.Cobol,
        description: `level:${item.level} section:${item.section}${item.pic ? ` pic:${item.pic}` : ''}`,
      },
    });

    if (item.parentName) {
      // Child data item → HAS_PROPERTY from parent data item to this item
      const parentNodeId = findParentPropertyId(item.parentName, item);
      if (parentNodeId) {
        graph.addRelationship({
          id: generateId('HAS_PROPERTY', `${parentNodeId}->${propId}`),
          type: 'HAS_PROPERTY',
          sourceId: parentNodeId,
          targetId: propId,
          confidence: 1.0,
          reason: 'cobol-data-item-child',
        });
      } else {
        // Fallback: parent not found (cross-section reference) → link to program
        graph.addRelationship({
          id: generateId('HAS_PROPERTY', `${itemParent}->${propId}`),
          type: 'HAS_PROPERTY',
          sourceId: itemParent,
          targetId: propId,
          confidence: 1.0,
          reason: 'cobol-data-item',
        });
      }
    } else {
      // Top-level data item → HAS_PROPERTY from program/module to this item
      graph.addRelationship({
        id: generateId('HAS_PROPERTY', `${itemParent}->${propId}`),
        type: 'HAS_PROPERTY',
        sourceId: itemParent,
        targetId: propId,
        confidence: 1.0,
        reason: 'cobol-data-item',
      });
    }
  }
```

- [ ] **Step 3: Add REDEFINES ACCESSES edges**

After the existing OCCURS DEPENDING ON block (around line 522), add:

```typescript
  // ── REDEFINES -> ACCESSES edges (memory overlay relationship) ──
  for (const item of extracted.dataItems) {
    if (item.name === 'FILLER' || !item.redefines) continue;
    const propId = generatePropertyId(filePath, item);
    const redefTargetId = dataItemMap.get(item.redefines.toUpperCase());
    if (redefTargetId) {
      graph.addRelationship({
        id: generateId('ACCESSES', `${propId}->redefines->${item.redefines}`),
        type: 'ACCESSES',
        sourceId: propId,
        targetId: redefTargetId,
        confidence: 1.0,
        reason: 'cobol-redefines',
      });
    }
  }
```

- [ ] **Step 4: Run integration tests to verify they pass**

Run: `cd gitnexus && npx vitest run test/integration/resolvers/cobol.test.ts 2>&1 | tail -40`
Expected: All tests PASS — HAS_PROPERTY edges replace CONTAINS for data items.

- [ ] **Step 5: Run the full test suite to verify no regressions**

Run: `cd gitnexus && npx vitest run 2>&1 | tail -20`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add gitnexus/src/core/ingestion/cobol-processor.ts
git commit -m "feat(cobol): migrate data items to HAS_PROPERTY with parent-child hierarchy"
```

---

## Task 6: Add unit tests for REDEFINES ACCESSES edges

**Files:**
- Modify: `gitnexus/test/unit/cobol-preprocessor.test.ts`

- [ ] **Step 1: Verify redefines extraction is already tested**

The preprocessor already extracts `redefines` (see existing test coverage). Run to confirm:

Run: `cd gitnexus && npx vitest run test/unit/cobol-preprocessor.test.ts -t "REDEFINES" 2>&1 | tail -10`
Expected: If there are existing redefines tests, they pass. If not, add one.

- [ ] **Step 2: Add REDEFINES graph edge test in integration suite**

Add to the `cobol.test.ts` integration file, inside the `HAS_PROPERTY edge completeness` describe block:

```typescript
it('REDEFINES produces ACCESSES edge (when present in fixture)', () => {
  // Current fixture has no REDEFINES — verify the ACCESSES edges don't include redefines
  const redefEdges = getRelationships(result, 'ACCESSES').filter(
    (e) => e.rel.reason === 'cobol-redefines',
  );
  // No REDEFINES in current fixture — expect 0
  expect(redefEdges.length).toBe(0);
});
```

- [ ] **Step 3: Run integration tests**

Run: `cd gitnexus && npx vitest run test/integration/resolvers/cobol.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add gitnexus/test/integration/resolvers/cobol.test.ts
git commit -m "test(cobol): add REDEFINES ACCESSES edge assertion"
```

---

## Task 7: Update node completeness test for HAS_PROPERTY edge count

**Files:**
- Modify: `gitnexus/test/integration/resolvers/cobol.test.ts`

- [ ] **Step 1: Verify node counts are unchanged**

Node counts should not change — we only changed edges, not nodes. Run:

Run: `cd gitnexus && npx vitest run test/integration/resolvers/cobol.test.ts -t "node completeness" 2>&1 | tail -20`
Expected: All PASS — nodes unchanged.

- [ ] **Step 2: Add a grand total edge count assertion**

Find the `describe('grand totals')` block. Update to include HAS_PROPERTY:

```typescript
it('produces exactly 36 total HAS_PROPERTY edges', () => {
  // 25 top-level data items + 11 child data items
  expect(getRelationships(result, 'HAS_PROPERTY').length).toBe(36);
});
```

- [ ] **Step 3: Run full integration test suite**

Run: `cd gitnexus && npx vitest run test/integration/resolvers/cobol.test.ts 2>&1 | tail -20`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add gitnexus/test/integration/resolvers/cobol.test.ts
git commit -m "test(cobol): add HAS_PROPERTY grand total assertion"
```

---

## Self-Review

**1. Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| Add `parentName` to data item extraction | Task 1 (interface) + Task 3 (implementation) |
| Level-stack tracking for parent-child | Task 3 |
| 88-level parent attribution | Task 3 (Step 4) |
| CONTAINS → HAS_PROPERTY for data items | Task 5 (Step 2) |
| Parent→child HAS_PROPERTY edges | Task 5 (Step 2) |
| REDEFINES ACCESSES edges | Task 5 (Step 3) |
| Section transition stack reset | Task 3 (Step 2) |
| Program boundary stack reset | Task 3 (Step 3) |
| Integration test updates | Tasks 4, 6, 7 |

**2. Placeholder scan:** No TBD/TODO. All steps have concrete code.

**3. Type consistency:**
- `parentName?: string` declared in Task 1, used in Task 3 (set) and Task 5 (read)
- `HAS_PROPERTY` edge type used consistently in Tasks 4, 5, 7
- `cobol-data-item` reason for top-level edges, `cobol-data-item-child` reason for parent→child edges — consistent across Tasks 4 and 5
- `cobol-redefines` reason used in Task 5 (Step 3) and Task 6
- `generatePropertyId` used consistently — same function, same composite key
