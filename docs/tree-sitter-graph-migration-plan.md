# tree-sitter-graph Migration Plan for cfg-builder.ts

**Date:** 2026-04-04
**Status:** Research Complete -- Awaiting Decision
**Owner:** GitNexus Core Team

---

## 1. Executive Summary

### What tree-sitter-graph Is

tree-sitter-graph (GitHub: tree-sitter/tree-sitter-graph, v0.12) is a Rust library that defines a **declarative DSL** for constructing arbitrary graph structures from tree-sitter parse trees. Instead of imperatively walking an AST in TypeScript, you write a `.sg` file containing pattern-match rules that declaratively specify which graph nodes and edges to create. The Rust runtime executes the DSL and emits a graph.

The DSL has three layers:

| Layer | Mechanism | CFG Use Case |
|-------|-----------|--------------|
| Pattern matching | tree-sitter query syntax `(node_type) @capture` | Identify AST nodes of interest (if_statement, for_statement, etc.) |
| Graph construction | Stanza blocks with `node`, `edge`, `attr` statements | Create CFG nodes and labeled edges per matched node |
| Data flow | `let`/`var`/`set`, scoped variables (`@node.var`) | Pass node references across stanzas for cross-referencing |

### What It Would Replace

`cfg-builder.ts` is a 788-line TypeScript module that imperatively walks a tree-sitter AST using deeply nested `if (t === '...')` chains and three mutable stacks (`loopStack`, `tryStack`, `lastSeqId`). It produces a control-flow graph with 12 edge types.

**Replaced code breakdown (lines of active CFG-building logic):**

| Concern | Lines | What It Does |
|---------|-------|--------------|
| `walkNode()` core | ~240 | 5 major branches with deeply nested if-chains |
| Helper functions | ~60 | `walkChildren`, `findChild`, `getNamedChild`, `getNamedChildren` |
| Type definitions + classification sets | ~80 | `StmtNode`, `WalkState`, `CONTROL_STMT_TYPES`, `BRANCH_TYPES`, `LOOP_TYPES`, `TERMINAL_STMT_TYPES`, `SKIP_TYPES`, `SIMPLE_STMT_TYPES` |
| Branch collectors | ~80 | `collectIfBranches`, `collectSwitchCases` |
| Function extraction | ~50 | `extractFunctionId`, `extractNameFromFunctionNode`, `FUNCTION_NODE_TYPES` |
| Conversion + deduplication | ~30 | `StmtNode[]` → `CFGNode[]`, `seenEdges` deduplication |
| **Active CFG-building logic subtotal** | **~540** | |

The deprecated `buildCFGFromStatements` text-based API (~100 lines) is out of scope for this migration.

**Estimated reduction: ~540 lines of active logic → ~150-200 lines of DSL + ~150-200 lines of Rust host functions = ~400 total (-140 lines, ~26% reduction)**

The absolute line count reduction is modest because dynamic scope resolution (BREAK/CONTINUE/THROW) requires new Rust code. The real value is **reduced complexity**: declarative DSL is far easier to audit, extend, and debug than imperative nested if-chains with mutable state.

---

## 2. Why This Matters

### Current cfg-builder.ts Complexity

The 240-line `walkNode()` function is the core problem. It handles 6 categories of AST nodes:

1. **Terminal statements** (return, throw, break, continue) — each pushes to or pops from `loopStack`/`tryStack`, resets `lastSeqId`
2. **Conditionals** (if, ternary) — collects branch entry nodes, emits TRUE_BRANCH/FALSE_BRANCH edges
3. **Loops** (while, do, for, for-in, for-of) — pushes to `loopStack`, emits LOOP_HEADER self-edge, recurses into body
4. **Switch** — collects all case blocks, emits SWITCH_CASE edges
5. **Try/catch** — pushes to `tryStack`, emits TRY_BODY, CATCH, and THROW edges
6. **Simple statements** — emits NEXT fall-through edges

The `WalkState` interface carries three independent mutable accumulators simultaneously:

```typescript
interface WalkState {
  nodes: StmtNode[];
  edges: Array<{ from: string; to: string; type: CFGEdgeType }>;
  nextBlockNumber: number;
  loopStack: string[];       // dynamic: push/pop as we enter/exit loops
  tryStack: string[];         // dynamic: push/pop as we enter/exit try blocks
  lastSeqId: string | null;   // sequential: tracks last statement for fall-through
}
```

The `loopStack` and `tryStack` represent **dynamic scope**: BREAK must route to the innermost enclosing loop, and THROW must route to the innermost enclosing catch. The current implementation handles this correctly but it is difficult to reason about locally — understanding any individual edge emission requires tracing through the full call stack.

### tree-sitter-graph's Declarative Model

In the DSL, each stanza declares:

```
(if_statement) @if
{
  node @if.header              ; create CFG node for the if header
  edge @if.header -> @if.then ; TRUE_BRANCH
  edge @if.header -> @if.else ; FALSE_BRANCH
}
```

No mutable state. No stacks. The graph structure is derived from AST structure. This eliminates entire categories of bugs (forgot to push/pop a stack, forgot to reset `lastSeqId`, forgot to check if a stack is empty before popping).

---

## 3. The Dynamic Scope Problem

This is the most important section of this document. tree-sitter-graph's scoped variables are **static** — they are attached to syntax node positions and do not change during traversal. CFG-building requires **dynamic scope** for three constructs.

### BREAK and CONTINUE

In a nested loop structure:

```typescript
for (let i = 0; i < 10; i++) {
  for (let j = 0; j < 10; j++) {
    if (j === 5) break;   // Which loop does this break from?
  }
  console.log(i);
}
```

A `break` inside the inner loop must route to the **innermost** enclosing loop header — not the outer one. The current TypeScript implementation handles this with a `loopStack`: push the header ID when entering a loop, pop when exiting, and BREAK targets `loopStack[loopStack.length - 1]`.

tree-sitter-graph's scoped variables cannot express this. When a stanza matches `break_statement`, the scoped variables available are those attached to nodes in the break statement's subtree — not the enclosing loop headers above it in the AST. The static scope of `@loop.node` does not change based on traversal depth.

**Solution:** Custom Rust host function `resolve-loop-header(@break_statement)` that walks upward through parent syntax nodes using the tree-sitter cursor API, looking for the nearest ancestor whose scoped variable is a loop header.

### THROW and Exception Routing

Similarly, `throw` must route to the **innermost** enclosing catch clause:

```typescript
try {
  try {
    throw new Error();
  } catch (inner) {
    // Which catch handles this?
  }
} catch (outer) {
  // Only the inner catch is in scope here
}
```

The `tryStack` in the current implementation tracks active try blocks. A custom Rust function `resolve-throw-target(@throw)` would walk up the parent chain to find the nearest enclosing try/catch scope.

### Sequential Ordering (lastSeqId / NEXT edges)

The `lastSeqId` mechanism creates NEXT edges between sequential statements:

```typescript
let a = 1;    // node A
let b = 2;    // node B  — lastSeqId = A, so emit NEXT: A → B
let c = 3;    // node C  — lastSeqId = B, so emit NEXT: B → C
return c;     // lastSeqId = C, emit NEXT: C → return
```

This is a **dynamic ordering** problem: the "previous statement" depends on the traversal path taken. In tree-sitter-graph, you can sort nodes by source position (`start-row`, `start-column`), but the DSL's ordered iteration (`for item in @list`) iterates over children in AST order, not necessarily execution order for all languages.

**Solution:** Custom Rust function `track-sequential(@stmt)` that maintains a mutable global scoped variable tracking the last-seen statement node ID, updated as each statement is visited.

### Summary: What Requires Custom Rust Functions

| Construct | Problem | Custom Function Needed |
|-----------|---------|----------------------|
| BREAK | Innermost enclosing loop is dynamic | `resolve-loop-header(@break)` |
| CONTINUE | Innermost enclosing loop is dynamic | `resolve-loop-header(@continue)` |
| THROW | Innermost enclosing catch is dynamic | `resolve-throw-target(@throw)` |
| NEXT (fall-through) | "Previous" depends on traversal path | `track-sequential(@stmt)` |

This is a legitimate extension point in tree-sitter-graph's design. The library was explicitly designed for custom host functions. The Rust implementation for these three functions is estimated at ~150-200 lines.

---

## 4. Phase-by-Phase Implementation Plan

### Phase 1: Proof of Concept (2-3 days)

**Goal:** Validate that tree-sitter-graph can express TypeScript CFG node creation for simple sequential code.

**Steps:**

1. Install tree-sitter-graph CLI:
   ```bash
   cargo install --features cli tree-sitter-graph
   ```

2. Write a minimal 30-line DSL file covering sequential TypeScript statements with no edges:
   ```graphlang
   ; TypeScript sequential statement DSL — POC only (no edges)
   (return_statement) @ret
   {
     node @ret.cfg
     attr (@ret.cfg) label = (source-text @ret)
   }

   (expression_statement) @expr
   {
     node @expr.cfg
     attr (@expr.cfg) label = (source-text @expr)
   }

   (variable_declaration) @decl
   {
     node @decl.cfg
     attr (@decl.cfg) label = (source-text @decl)
   }
   ```

3. Run the DSL against 5-10 representative TypeScript files:
   ```bash
   tree-sitter-graph parse --graph /dev/stdout my-file.ts my-file.ts.sg
   ```

4. Compare output to current `buildCFG` for simple sequential code (no loops, no try/catch, no breaks).

5. Verify stdlib functions (`source-text`, `node-type`, `named-child-index`, `named-child-count`) are sufficient for basic node creation.

**Exit Criterion:** DSL-generated nodes match TypeScript `buildCFG` output for simple sequential code. If stdlib functions are insufficient for basic node attributes, this is a showstopper and the migration stops here.

---

### Phase 2: Static Edge DSL (1 week)

**Goal:** Express all CFG edges that do NOT require dynamic scope resolution.

**Steps:**

1. Add stanza patterns for each statically resolvable edge type:

   **TRUE_BRANCH / FALSE_BRANCH (if/ternary):**
   ```graphlang
   (if_statement
     condition: (_) @cond
     consequence: (_) @then
     alternative: (_)? @else
   ) @if
   {
     node @if.header
     node @then.body
     edge @if.header -> @then.body { type = "TRUE_BRANCH" }
     if some @else {
       node @else.body
       edge @if.header -> @else.body { type = "FALSE_BRANCH" }
     }
   }
   ```

   **SWITCH_CASE / SWITCH_DEFAULT:**
   ```graphlang
   (switch_statement) @sw
   {
     node @sw.header
     for case in (named-children @sw "switch_case") {
       node case.cfg
       edge @sw.header -> case.cfg { type = "SWITCH_CASE" }
     }
   }
   ```

   **TRY_BODY / CATCH:**
   ```graphlang
   (try_statement
     body: (_) @try_body
     handler: (catch_clause)? @catch
   ) @try
   {
     node @try.cfg
     node @try_body.body
     edge @try.cfg -> @try_body.body { type = "TRY_BODY" }
     if some @catch {
       node @catch.handler
       edge @try.cfg -> @catch.handler { type = "CATCH" }
     }
   }
   ```

   **Sequential NEXT edges** using `named-child-index` ordering:
   ```graphlang
   ; Sequential NEXT between consecutive children
   (block (_)* @stmts) @blk
   {
     let prev = (node)
     for stmt in @stmts {
       node stmt.cfg
       edge prev -> stmt.cfg { type = "NEXT" }
       let prev = stmt.cfg
     }
   }
   ```

2. Extend TypeScript DSL to cover all statement types from cfg-builder.ts:
   - 5 terminal types: return, throw, break, continue
   - 5 loop types: while, do, for, for-in, for-of
   - 5 branch types: if, switch, ternary, try/catch, labeled statement
   - All SIMPLE_STMT_TYPES from cfg-builder.ts

3. Run full test suite against all TypeScript test fixtures.

4. Parallelize: write DSL files for JavaScript and Python while TypeScript is in review.

**Note:** BREAK, CONTINUE, and THROW will emit placeholder edges in this phase. They will be wired up correctly in Phase 3.

**Exit Criterion:** Full TypeScript test suite passes with all statically resolvable edges correct. BREAK/CONTINUE/THROW edges may be absent or approximated — this is acceptable for Phase 2.

---

### Phase 3: Custom Rust Host Functions for Dynamic Scope (1 week)

**Goal:** Implement BREAK/CONTINUE/THROW routing as Rust host functions.

**Steps:**

1. **Design host function signatures:**
   ```rust
   // Hypothetical — actual API TBD based on tree-sitter-graph v0.12 internals
   fn resolve_loop_header(captures: &Captures,arena: &mut AstNodeArena) -> NodeIndex
   fn resolve_throw_target(captures: &Captures, arena: &mut AstNodeArena) -> NodeIndex
   fn track_sequential(captures: &Captures, state: &mut SequentialState) -> NodeIndex
   ```

2. **Implement `resolve-loop-header`** in Rust:
   - Receives a `break_statement` or `continue_statement` node
   - Walks upward through parent nodes using `node.parent()` chain
   - Uses scoped variables to identify candidate loop headers (scoped var `@loop.node` attached to loop header stanzas)
   - Returns the innermost enclosing loop header node index
   - Estimated: ~50 lines of Rust

3. **Implement `resolve-throw-target`** in Rust:
   - Receives a `throw_statement` node
   - Walks upward through parent nodes looking for `try_statement` nodes
   - Tracks which catch clauses are in scope at the throw point
   - Returns the innermost enclosing catch clause node index
   - Estimated: ~50 lines of Rust

4. **Implement `track-sequential`** in Rust:
   - Maintains a mutable node reference (initialized to null)
   - On each call: returns current reference, updates to the argument node
   - Replaces the `lastSeqId` mutable variable
   - Estimated: ~30 lines of Rust

5. **Wire DSL to host functions:**
   ```graphlang
   (break_statement) @break
   {
     node @break.cfg
     let target = (resolve-loop-header @break)  ; custom function
     edge @break.cfg -> target { type = "BREAK" }
   }
   ```

6. Integrate by calling tree-sitter-graph library directly (not CLI) so host functions are available via Rust FFI or a Node.js addon.

**Exit Criterion:** BREAK, CONTINUE, and THROW edges route to the correct targets in nested loop/try scenarios. Verify with test fixtures covering:
- Nested loops with break in inner loop
- Nested try/catch with throw in inner try
- Mixed nesting (loops inside try/catch, try/catch inside loops)

---

### Phase 4: Integration Layer and Full Test Suite (1 week)

**Goal:** Replace `cfg-builder.ts` with the tree-sitter-graph-based pipeline.

**Steps:**

1. **Create `cfg-from-tsg.ts`** — TypeScript wrapper that:
   - Loads the appropriate DSL file for the target language
   - Calls tree-sitter-graph (via Node.js `child_process` for CLI mode, or direct FFI for library mode)
   - Parses the graph output back into `CFGNode[]` / `CFGEdge[]`

2. **Add integration tests** that compare output of old `buildCFG` and new pipeline:
   ```typescript
   // Integration test pattern
   for (const fixture of typeScriptFixtures) {
     const legacyResult = buildCFG(parseTree(fixture), source, 'typescript');
     const tsgResult = buildCFGFromTSG(parseTree(fixture), source, 'typescript');
     assertEdgeEquivalence(legacyResult, tsgResult);
   }
   ```

3. **Mark legacy APIs as deprecated:**
   - `buildCFGFromStatements` (already marked)
   - Any remaining text-based overloads

4. **Run full test suite** across all supported languages (15+).

5. **Update AGENTS.md** to document the new CFG building approach, including the requirement to run impact analysis on DSL files when modifying CFG edge semantics.

6. **Performance benchmark** — compare tree-sitter-graph (CLI mode) vs. current TypeScript implementation on representative corpus. If CLI spawn overhead is problematic, this is the signal to invest in Rust library integration.

**Exit Criterion:** All tests pass. CFG output from new pipeline is equivalent (same nodes and edges, possibly in different order) to the existing `buildCFG` output.

---

### Phase 5: Per-Language Rollout (ongoing)

**Goal:** Complete migration for all 15+ supported languages.

**Rollout order and complexity estimates:**

| Language | Complexity | Estimated Time |
|----------|------------|-----------------|
| TypeScript | Reference implementation | Already done in Phases 1-4 |
| JavaScript | Very similar to TS | 1-2 days |
| Python | Different AST structure (elif, with_statement) | 2-3 days |
| Go | Simple — no try/catch, goroutines add complexity | 2 days |
| Rust | Ownership makes some patterns complex | 2-3 days |
| C | for-loop init/cond/update separate | 2 days |
| C++ | Similar to C, extra constructor/destructor edges | 2-3 days |
| Java | try-with-resources, lambdas add complexity | 2-3 days |
| C# | try/catch + LINQ + async/await | 2-3 days |
| Ruby | rescue/ensure semantics differ | 2-3 days |
| PHP | Mixed PHP/HTML, many loop types | 2 days |
| Kotlin | Sealed classes, when expression (like switch) | 2-3 days |
| Swift | guard, defer, optional chaining | 2-3 days |
| Dart | async/await, isolate messaging | 2-3 days |
| Objective-C | Complex preprocessor + method signatures | 3-5 days |

**Total for Phase 5: ~30-40 days** (6-8 weeks of full-time work, or parallelized across team members).

---

## 5. Risk Analysis

### Risk 1: Dynamic Scope Requires Rust (HIGH)

**Description:** BREAK/CONTINUE/THROW routing requires custom Rust host functions. This adds a Rust crate dependency to the GitNexus toolchain, which currently has no Rust components.

**Likelihood:** High — this is a architectural certainty, not a probability.

**Impact:** HIGH. Requires Rust tooling, a new crate (`gitnexus-cfg-graph`), and FFI/binding layer between Node.js and Rust.

**Mitigation:** Implement Phase 1 and Phase 2 first. Phase 2 covers ~80% of the edge types with zero Rust dependency. Phase 3 is the committed investment only after Phases 1-2 validate the approach. If the Rust host function implementation proves intractable, BREAK/CONTINUE/THROW can remain as a TypeScript post-processing pass on DSL-generated CFGs.

### Risk 2: Loss of TypeScript Type Safety in DSL (MEDIUM)

**Description:** The DSL is a string loaded at runtime. Typos in query patterns, missing captures, and attribute type errors surface only at runtime.

**Likelihood:** Medium — tree-sitter query syntax is well-known to GitNexus developers (used in `tree-sitter-queries.ts`).

**Impact:** Medium — runtime errors in DSL are harder to debug than TypeScript compilation errors.

**Mitigation:** Invest in test coverage that runs DSL against representative code samples for each language. tree-sitter-graph produces parseable error messages for malformed DSL files. Consider a VS Code extension for DSL syntax highlighting and basic validation.

### Risk 3: Performance Regression (MEDIUM)

**Description:** The current TypeScript implementation is a single synchronous walk. tree-sitter-graph in CLI mode spawns a new Rust process per file, which adds per-file overhead.

**Likelihood:** Medium.

**Impact:** Medium — latency for CFG building on single files.

**Mitigation:** Benchmark both approaches. If CLI overhead is problematic, invest in Rust library integration (calling tree-sitter-graph as a library rather than CLI). Library-mode tree-sitter-graph should be significantly faster than the TypeScript imperative walk due to Rust's performance.

### Risk 4: Debugging and Introspection (MEDIUM)

**Description:** With imperative code, debugging a missing edge means setting a breakpoint in `walkNode`. With DSL, debugging requires understanding tree-sitter-graph's execution model, output format, and the custom Rust function internals.

**Likelihood:** Low — tree-sitter-graph has a `print` DSL statement for debugging execution.

**Impact:** Medium — increased mean time to diagnose CFG bugs.

**Mitigation:** Invest in visualization tools that render DSL-generated CFGs for human inspection. GraphViz or D3 output from the graph format. The `print` DSL statement provides stanza-level tracing.

### Risk 5: tree-sitter-graph Version Stability (LOW-MEDIUM)

**Description:** tree-sitter-graph is at v0.12. The README notes lazy evaluation "will likely become the only supported strategy in future releases," which could introduce breaking API changes.

**Likelihood:** Low-Medium.

**Impact:** Low — pinning to a specific version in `Cargo.toml` mitigates surprise updates.

**Mitigation:** Pin to a specific version. The DSL language itself appears stable based on the changelog. The v0.12 stdlib functions (`source-text`, `node-type`, `named-child-index`, etc.) are well-established.

### Risk 6: Multi-Language Maintenance Burden (MEDIUM)

**Description:** cfg-builder.ts currently handles 15+ languages with shared sets and language-specific branches in `isContainer()`. A DSL migration requires per-language DSL files, which could become a maintenance burden if languages diverge in their AST structure.

**Likelihood:** Medium.

**Impact:** Medium — ongoing per-language DSL maintenance as languages evolve.

**Mitigation:** GitNexus already maintains per-language query strings in `tree-sitter-queries.ts` for 15+ languages. This expertise transfers directly. Languages that share AST structure (e.g., C/C++) can share DSL patterns.

---

## 6. Exit Criteria

### Phase 1 (POC)

| Criterion | Pass | Fail |
|-----------|------|------|
| tree-sitter-graph CLI installs and runs | DSL runs on 1 test file | CLI fails to install or crashes |
| stdlib functions sufficient for basic node creation | Node labels match `source-text` | Missing stdlib functions needed |
| DSL-generated nodes match `buildCFG` for sequential code | Output equivalence on 5 simple fixtures | Significant divergence |

**Go/No-Go:** Proceed to Phase 2 only if all Phase 1 criteria pass.

### Phase 2 (Static Edge DSL)

| Criterion | Pass | Fail |
|-----------|------|------|
| All static edge types correct | TRUE_BRANCH, FALSE_BRANCH, SWITCH_CASE, TRY_BODY, CATCH, NEXT all match `buildCFG` | Some edges missing or incorrect |
| TypeScript test suite passes | 100% of existing CFG tests pass | Test failures |
| JS + Python DSL files written | Both DSLs cover all statement types | Incomplete coverage |

**Go/No-Go:** Proceed to Phase 3 only if TypeScript test suite is green and at least one other language DSL is in review.

### Phase 3 (Dynamic Scope)

| Criterion | Pass | Fail |
|-----------|------|------|
| BREAK routes to innermost enclosing loop | Test: nested loops, break in inner loop | BREAK goes to wrong loop |
| CONTINUE routes to innermost enclosing loop | Test: nested loops, continue in inner loop | CONTINUE goes to wrong loop |
| THROW routes to innermost enclosing catch | Test: nested try/catch, throw in inner try | THROW goes to wrong catch |
| Mixed nesting (loops + try/catch) correct | Test fixtures covering mixed nesting | Incorrect routing in mixed cases |

**Go/No-Go:** Proceed to Phase 4 only if all dynamic scope test cases pass.

### Phase 4 (Integration)

| Criterion | Pass | Fail |
|-----------|------|------|
| Integration tests pass | Old vs new pipeline produce equivalent CFGs | Non-equivalent output |
| All languages pass test suite | 15+ languages, 100% pass | Failures on any language |
| Performance acceptable | < 2x current latency on corpus | > 2x regression |
| AGENTS.md updated | New CFG approach documented | Missing documentation |

**Go/No-Go:** Phase 4 completion is the release gate.

### Phase 5 (Per-Language Rollout)

| Criterion | Pass | Fail |
|-----------|------|------|
| Each language passes CFG equivalence test | New DSL matches old `buildCFG` for language fixture suite | Non-equivalent CFGs |
| DSL file is reviewed and merged | PR reviewed, patterns consistent with other language DSLs | Inconsistent patterns |

---

## 7. Cost Estimate

### Person-Days by Phase

| Phase | Description | Person-Days |
|-------|-------------|-------------|
| Phase 1 | POC — install, 30-line DSL, validate | 2-3 |
| Phase 2 | Static edge DSL — all static edges, TypeScript + 2 other languages | 5 |
| Phase 3 | Custom Rust host functions — 3 functions, integration | 5 |
| Phase 4 | Integration layer, TypeScript wrapper, full test suite | 5 |
| Phase 5 | Per-language rollout (15+ languages, average 2 days each, 3 parallel) | 10-15 |
| **Total** | | **27-33** |

### Total: ~4-5 weeks of engineering time

For a single engineer: Phases 1-4 in ~3 weeks, Phase 5 (per-language) can be parallelized across team members.

---

## 8. References

| Reference | Link |
|-----------|------|
| tree-sitter-graph GitHub | https://github.com/tree-sitter/tree-sitter-graph |
| DSL Language Reference | https://docs.rs/tree-sitter-graph/0.12/tree_sitter_graph/reference/ |
| Standard Library Functions | https://docs.rs/tree-sitter-graph/0.12/tree_sitter_graph/reference/functions/ |
| cfg-builder.ts | `gitnexus/src/core/ingestion/dataflow/cfg-builder.ts` |
| tree-sitter-queries.ts | `gitnexus/src/core/ingestion/tree-sitter-queries.ts` |
| LLMDFA Assessment | `.omc/scientist/reports/llmdfa_assessment_report.md` |
| tree-sitter-graph Research | `.omc/scientist/reports/tree-sitter-graph-migration-report.md` |

---

## Appendix A: DSL Syntax Cheat Sheet

```graphlang
; Comment
(node_type) @capture { ... }           ; Match AST node, create stanza
node @var                                ; Create graph node, assign to scoped var
edge @from -> @to                        ; Directed edge
edge @from -> @to { type = "LABEL" }   ; Labeled edge
attr (@node) key = value                ; Attach attribute
let @var = (expr)                       ; Local binding
if some @var, none @other { ... }       ; Conditional
for item in @list { ... }              ; Iteration
(source-text @node)                     ; Stdlib: node source text
(named-child-index @node)               ; Stdlib: child's position
(node-type @node)                       ; Stdlib: AST node type string
print "debug message"                   ; Debug output
```

## Appendix B: Current cfg-builder.ts Line Counts

```
cfg-builder.ts: 788 lines total
├── Lines 1-37:      Type definitions (StmtNode, WalkState, imports)
├── Lines 39-122:    Classification sets (CONTROL_STMT_TYPES, BRANCH_TYPES,
│                    LOOP_TYPES, TERMINAL_STMT_TYPES, SIMPLE_STMT_TYPES,
│                    SKIP_TYPES) — ~80 lines
├── Lines 124-158:   isContainer() — ~30 lines, 20+ language-specific branches
├── Lines 161-174:   isStatementNode(), isImplicitSequencePoint() — ~15 lines
├── Lines 177-415:   walkNode() — ~240 lines, 6 major branches
│   ├── Lines 188-198:    return_statement handling
│   ├── Lines 200-213:    throw_statement + tryStack routing
│   ├── Lines 215-227:    break_statement + loopStack routing
│   ├── Lines 229-241:    continue_statement + loopStack routing
│   ├── Lines 243-268:    if_statement / conditional_expression
│   ├── Lines 271-296:    while/do_statement + loopStack push/pop
│   ├── Lines 299-322:    for/for_in/for_of + loopStack push/pop
│   ├── Lines 325-348:    switch_statement + case collection
│   ├── Lines 351-396:    try_statement + catch/finally
│   └── Lines 399-415:    simple statements + default recursion
├── Lines 417-445:   walkChildren, findChild, getNamedChild — ~30 lines
├── Lines 447-529:   collectIfBranches, collectSwitchCases — ~80 lines
├── Lines 531-633:   buildCFGFromStatements (deprecated) — ~100 lines
├── Lines 637-706:   buildCFG (main entry) — ~70 lines
└── Lines 708-786:   Helpers, function extraction, backwards-compat — ~80 lines
```

**Active CFG-building logic (replaced by tree-sitter-graph):** lines 124-529, ~400 lines.
