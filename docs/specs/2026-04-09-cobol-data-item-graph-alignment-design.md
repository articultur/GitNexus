# COBOL Data Item Graph Relationship Alignment

> Date: 2026-04-09
> Scope: COBOL ingestion graph model
> Goal: Align COBOL data item edges with other languages' class-member pattern

---

## 1. Problem

COBOL data items currently use flat `CONTAINS` edges from program to every data item at every level. Other languages (Java, TypeScript, Python, Go, C#, etc.) use `HAS_PROPERTY` edges with parent-child hierarchy (class -> property). This inconsistency means:

1. MCP tools that traverse `HAS_PROPERTY` edges miss COBOL data items entirely
2. No parent-child structure between group items and their subordinate fields
3. REDEFINES relationships (memory overlay aliases) are not captured
4. 88-level condition names are orphaned — they belong to their parent data item, not directly to the program

---

## 2. Design

### 2.1 Extraction layer (`cobol-preprocessor.ts`)

Add two optional fields to the data item extraction result:

```typescript
interface CobolDataItem {
  // ... existing fields (level, name, pic, usage, section, etc.) ...
  parentName?: string;   // Name of the parent data item (determined by level stack)
  redefines?: string;    // Name of the data item being REDEFINED
}
```

**Level stack tracking:**

During line-by-line processing in the data division, maintain a stack of `{level: number, name: string}` entries:

1. For each new data item (non-FILLER):
   - Pop stack entries where `entry.level >= current.level`
   - If stack is non-empty, the top entry is the parent → set `parentName`
   - Push current item onto stack
2. For 88-level items:
   - Parent is the most recent non-88 data item (top of stack after skipping 88s)
3. Reset stack on section transitions (WORKING-STORAGE, LINKAGE, FILE, LOCAL-STORAGE)

**REDEFINES extraction:**

Add regex matching for `REDEFINES <name>` clause appearing after the data item name:

```
05 WS-ALT-REC REDEFINES WS-ORIG-REC PIC X(100).
```

The `redefines` field is set to the target name (e.g., `WS-ORIG-REC`).

### 2.2 Graph construction layer (`cobol-processor.ts`)

#### Edge type changes

| Before | After | Reason |
|--------|-------|--------|
| `CONTAINS` (program -> data-item, reason=cobol-data-item) | `HAS_PROPERTY` (program -> top-level data-item) | Align with class-member pattern |
| (none) | `HAS_PROPERTY` (parent-item -> child-item) | New: nested hierarchy |
| (none) | `ACCESSES` (item -> redefines-target, reason=cobol-redefines) | New: overlay relationship |
| `CONTAINS` (program -> 88-level, reason=cobol-data-item) | `HAS_PROPERTY` (parent-item -> 88-level) | 88-level belongs to its parent field |

#### Construction logic

1. Build data item nodes as before (Property label)
2. For top-level items (01/77 level, no parentName):
   - Add `HAS_PROPERTY` edge from program to item
3. For child items (has parentName):
   - Add `HAS_PROPERTY` edge from parent item node to child item node
4. For items with `redefines`:
   - Add `ACCESSES` edge from redefining item to redefined target, reason `cobol-redefines`
5. For 88-level items:
   - Add `HAS_PROPERTY` edge from parent data item to 88-level node

#### Existing edges that remain unchanged

- `CONTAINS` edges for paragraphs, sections, EXEC blocks, entry points, file declarations, etc.
- `ACCESSES` edges for MOVE read/write, CICS file operations, SQL, etc.
- `CALLS` edges for PERFORM, CALL, GO TO, CICS LINK/XCTL, JCL EXEC
- `IMPORTS` edges for COPY

### 2.3 Example: Before vs After

Given this COBOL data division:

```cobol
DATA DIVISION.
WORKING-STORAGE SECTION.
 01 CUSTOMER-RECORD.
     05 CUST-ID          PIC 9(5).
     05 CUST-NAME        PIC X(30).
     05 CUST-BALANCE     PIC 9(7)V99.
 01 WS-ALT-REC REDEFINES CUSTOMER-RECORD.
     05 WS-CODE          PIC X(5).
 01 WS-STATUS             PIC X.
     88 IS-ACTIVE         VALUE "A".
     88 IS-INACTIVE       VALUE "I".
```

**Before (flat CONTAINS):**

```
CUSTUPDT --CONTAINS(cobol-data-item)--> CUSTOMER-RECORD
CUSTUPDT --CONTAINS(cobol-data-item)--> CUST-ID
CUSTUPDT --CONTAINS(cobol-data-item)--> CUST-NAME
CUSTUPDT --CONTAINS(cobol-data-item)--> CUST-BALANCE
CUSTUPDT --CONTAINS(cobol-data-item)--> WS-ALT-REC
CUSTUPDT --CONTAINS(cobol-data-item)--> WS-CODE
CUSTUPDT --CONTAINS(cobol-data-item)--> WS-STATUS
CUSTUPDT --CONTAINS(cobol-data-item)--> IS-ACTIVE
CUSTUPDT --CONTAINS(cobol-data-item)--> IS-INACTIVE
```

**After (hierarchical HAS_PROPERTY):**

```
CUSTUPDT --HAS_PROPERTY--> CUSTOMER-RECORD
  CUSTOMER-RECORD --HAS_PROPERTY--> CUST-ID
  CUSTOMER-RECORD --HAS_PROPERTY--> CUST-NAME
  CUSTOMER-RECORD --HAS_PROPERTY--> CUST-BALANCE
CUSTUPDT --HAS_PROPERTY--> WS-ALT-REC
  WS-ALT-REC --ACCESSES(cobol-redefines)--> CUSTOMER-RECORD
  WS-ALT-REC --HAS_PROPERTY--> WS-CODE
CUSTUPDT --HAS_PROPERTY--> WS-STATUS
  WS-STATUS --HAS_PROPERTY--> IS-ACTIVE
  WS-STATUS --HAS_PROPERTY--> IS-INACTIVE
```

---

## 3. Impact Analysis

### 3.1 Files to modify

| File | Change |
|------|--------|
| `gitnexus/src/core/ingestion/cobol/cobol-preprocessor.ts` | Add `parentName`, `redefines` extraction with level stack |
| `gitnexus/src/core/ingestion/cobol-processor.ts` | Edge type change + hierarchy + REDEFINES construction |
| `gitnexus/test/unit/cobol-preprocessor.test.ts` | New tests for parentName/redefines extraction |
| `gitnexus/test/integration/resolvers/cobol.test.ts` | Update edge assertions (CONTAINS -> HAS_PROPERTY counts) |

### 3.2 Files NOT modified

- `cobol-treesitter-adapter.ts` — experimental PoC, unchanged
- `cobol-copy-expander.ts` — no relationship to graph edges
- Other language processors — no cross-language impact
- MCP tools — `HAS_PROPERTY` is already supported; they will automatically pick up COBOL data items

### 3.3 Backward compatibility

- Graph consumers (MCP tools: query, context, impact) traverse by edge type, not reason
- Changing `CONTAINS` to `HAS_PROPERTY` for data items makes COBOL work with existing `HAS_PROPERTY` traversals
- The `cobol-data-item` reason is preserved on `HAS_PROPERTY` edges for traceability
- Stale indexes will need re-analysis (`npx gitnexus analyze`) to pick up new edge types

---

## 4. Test Strategy

### 4.1 Unit tests (cobol-preprocessor.test.ts)

New test cases:

1. `parentName` for nested items (01 -> 05 -> 10)
2. `parentName` is undefined for top-level 01/77 items
3. 88-level parentName points to preceding non-88 data item
4. `redefines` extracted from REDEFINES clause
5. Level stack reset on section transition (WORKING-STORAGE -> LINKAGE)
6. Multi-program: level stack scoped per program
7. Sibling items at same level get same parent

### 4.2 Integration tests (cobol.test.ts)

Update existing exhaustive test:

1. Count `HAS_PROPERTY` edges instead of `CONTAINS(cobol-data-item)` for data items
2. Verify parent-child `HAS_PROPERTY` edges match expected hierarchy
3. Verify `ACCESSES(cobol-redefines)` edges for REDEFINES items
4. Verify 88-level items have `HAS_PROPERTY` from parent data item, not from program
5. Verify `CONTAINS` count reduced (data items removed, paragraphs/sections remain)

---

## 5. Scope Exclusions

- tree-sitter-cobol as primary parser — blocked by upstream hang bug
- RENAMES, TYPEDEF, BASED ON (COBOL 2002+ extensions) — out of scope for this iteration
- Changes to non-data-item edges (paragraphs, sections, EXEC blocks) — intentionally unchanged
- Free-format COBOL changes — existing support is sufficient
