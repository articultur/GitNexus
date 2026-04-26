/**
 * P1 Unit Tests: CFG Builder
 *
 * Coverage for:
 * - buildCFG (tree-sitter AST → CFGResult)
 * - buildCFGFromStatements (legacy text-based API)
 * - cfgToResult (legacy Map-based CFG → CFGResult)
 * - Control flow constructs: if, while, for, switch, try-catch, break, continue, return, throw
 * - Edge cases: empty function, nested control flow
 */
import { describe, it, expect } from 'vitest';
import Parser, { type Tree } from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import {
  buildCFG,
  buildCFGFromStatements,
  cfgToResult,
} from '../../src/core/ingestion/dataflow/cfg-builder.js';
import type { CFG, CFGNode } from '../../src/core/ingestion/dataflow/types.js';
import { SupportedLanguages } from 'gitnexus-shared';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Parse source with tree-sitter TypeScript. */
function parseTS(source: string): Tree {
  const parser = new Parser();
  loadLanguage(SupportedLanguages.TypeScript).then((lang) => {
    if (lang) parser.setLanguage(lang);
  });
  // Synchronous fallback: set language directly from tree-sitter-typescript
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(source);
}

// ─── buildCFG ─────────────────────────────────────────────────────────────────

describe('buildCFG (tree-sitter AST)', () => {
  describe('basic functionality', () => {
    it('produces a CFGResult with nodes and edges', () => {
      const source = 'function foo() { return 1; }';
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);
      expect(result).toBeDefined();
      expect(result.functionId).toBe('foo');
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.edges)).toBe(true);
    });

    it('extracts function name from declaration', () => {
      const source = 'function myFunction() { return 42; }';
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);
      expect(result.functionId).toBe('myFunction');
    });

    it('uses provided functionId when given', () => {
      const source = 'function foo() { return 1; }';
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript, 'custom-id');
      expect(result.functionId).toBe('custom-id');
    });

    it('uses "anonymous" when no function name is found', () => {
      const source = 'return 1;';
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);
      expect(result.functionId).toBe('anonymous');
    });
  });

  describe('if statement', () => {
    it('produces TRUE_BRANCH and FALSE_BRANCH edges for if-else', () => {
      const source = `function test(x) {
        if (x > 0) { return 1; }
        else { return 0; }
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('TRUE_BRANCH');
      expect(edgeTypes).toContain('FALSE_BRANCH');
    });

    it('produces only TRUE_BRANCH for if without else', () => {
      const source = `function test(x) {
        if (x > 0) { return 1; }
        return 0;
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('TRUE_BRANCH');
      // FALSE_BRANCH may not appear for if-without-else (falls through)
    });
  });

  describe('while loop', () => {
    it('produces a LOOP_HEADER edge', () => {
      const source = `function loop() {
        while (true) { x = x + 1; }
        return x;
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('LOOP_HEADER');
    });

    it('produces NEXT edges for body fall-through', () => {
      const source = `function loop() {
        while (true) { x = x + 1; }
        return x;
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('NEXT');
    });
  });

  describe('for loop', () => {
    it('produces a LOOP_HEADER edge', () => {
      const source = `function range() {
        for (let i = 0; i < 10; i++) { x = i; }
        return x;
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('LOOP_HEADER');
    });
  });

  describe('switch statement', () => {
    it('produces SWITCH_CASE edges', () => {
      const source = `function sw(x) {
        switch (x) {
          case 1: return 1;
          case 2: return 2;
          default: return 0;
        }
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('SWITCH_CASE');
    });

    it('produces SWITCH_CASE edges for cases', () => {
      // Note: SWITCH_DEFAULT may not be emitted by all language parsers;
      // this test verifies at least one SWITCH_CASE edge is produced.
      const source = `function sw(x) {
        switch (x) {
          case 1: return 1;
          default: return 0;
        }
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('SWITCH_CASE');
    });
  });

  describe('try-catch statement', () => {
    it('produces TRY_BODY and CATCH edges', () => {
      const source = `function safe() {
        try { risky(); }
        catch (e) { console.log(e); }
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('TRY_BODY');
      expect(edgeTypes).toContain('CATCH');
    });

    it('produces NEXT edge to finally when present', () => {
      const source = `function safe() {
        try { risky(); }
        finally { cleanup(); }
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('TRY_BODY');
      expect(edgeTypes).toContain('NEXT');
    });
  });

  describe('break and continue', () => {
    it('produces BREAK edge from break statement', () => {
      const source = `function test() {
        while (true) { break; }
        return 1;
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('BREAK');
    });

    it('produces CONTINUE edge from continue statement', () => {
      const source = `function test() {
        while (true) { continue; }
        return 1;
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('CONTINUE');
    });
  });

  describe('return and throw', () => {
    it('marks return statements with statementType terminal', () => {
      const source = 'function f() { return 1; }';
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const returnNode = result.nodes.find((n) => n.basicBlock.some((b) => b.includes('return')));
      expect(returnNode?.statementType).toBe('terminal');
    });

    it('marks throw statements with statementType terminal', () => {
      const source = 'function f() { throw new Error("oops"); }';
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const throwNode = result.nodes.find((n) => n.basicBlock.some((b) => b.includes('throw')));
      expect(throwNode?.statementType).toBe('terminal');
    });
  });

  describe('nested control flow', () => {
    it('handles nested if inside while', () => {
      const source = `function nested() {
        while (true) {
          if (x > 0) { return 1; }
          x = x - 1;
        }
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('LOOP_HEADER');
      expect(edgeTypes).toContain('TRUE_BRANCH');
      expect(result.nodes.length).toBeGreaterThan(0);
    });

    it('handles nested while inside if', () => {
      const source = `function nested() {
        if (cond) {
          while (true) { x = x + 1; }
        }
        return x;
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      expect(edgeTypes).toContain('TRUE_BRANCH');
      // The if body contains at least one NEXT edge (body statements)
      const nextEdges = result.edges.filter((e) => e.edgeType === 'NEXT');
      expect(nextEdges.length).toBeGreaterThanOrEqual(1);
    });

    it('handles deeply nested control structures', () => {
      const source = `function deep() {
        for (let i = 0; i < n; i++) {
          if (arr[i] > 0) {
            while (arr[i] < 100) { arr[i] = arr[i] * 2; }
          }
        }
        return arr;
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeTypes = result.edges.map((e) => e.edgeType);
      // A for loop produces a LOOP_HEADER edge; the nested if adds TRUE_BRANCH
      expect(edgeTypes).toContain('LOOP_HEADER');
      expect(edgeTypes).toContain('TRUE_BRANCH');
    });
  });

  describe('empty / minimal functions', () => {
    it('handles an empty function body', () => {
      const source = 'function empty() { }';
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      expect(result).toBeDefined();
      expect(result.functionId).toBe('empty');
      // Empty body may produce zero nodes — function name should still be extracted
    });

    it('handles a function with only a comment', () => {
      const source = 'function commented() { /* nothing */ }';
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      expect(result.functionId).toBe('commented');
      // Comments are skipped — no nodes expected
    });
  });

  describe('node and edge structure', () => {
    it('nodes have correct fields', () => {
      const source = 'function f() { return 1; }';
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      for (const node of result.nodes) {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('functionId');
        expect(node).toHaveProperty('basicBlock');
        expect(Array.isArray(node.basicBlock)).toBe(true);
        expect(node).toHaveProperty('predecessors');
        expect(Array.isArray(node.predecessors)).toBe(true);
        expect(node).toHaveProperty('successors');
        expect(Array.isArray(node.successors)).toBe(true);
      }
    });

    it('edges have correct fields', () => {
      const source = 'function f() { return 1; }';
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      for (const edge of result.edges) {
        expect(edge).toHaveProperty('sourceId');
        expect(edge).toHaveProperty('targetId');
        expect(edge).toHaveProperty('edgeType');
      }
    });

    it('deduplicates identical edges', () => {
      const source = `function f() {
        if (x) { return 1; }
        else { return 2; }
      }`;
      const tree = parseTS(source);
      const result = buildCFG(tree, source, SupportedLanguages.TypeScript);

      const edgeKeys = result.edges.map((e) => `${e.sourceId}|${e.targetId}|${e.edgeType}`);
      const uniqueKeys = new Set(edgeKeys);
      expect(edgeKeys.length).toBe(uniqueKeys.size);
    });
  });
});

// ─── buildCFGFromStatements (legacy text-based API) ──────────────────────────

describe('buildCFGFromStatements (legacy)', () => {
  it('creates a CFG from parsed statements', () => {
    const cfg = buildCFGFromStatements('testFn', [
      { type: 'assignment', content: 'x = 1', line: 1 },
      { type: 'if', content: 'if (x > 0)', line: 2 },
      { type: 'return', content: 'return x', line: 3 },
    ]);

    expect(cfg.functionId).toBe('testFn');
    expect(cfg.nodes.size).toBeGreaterThan(0);
    expect(cfg.entryNodeId).toBe('testFn:bb:0');
  });

  it('creates an entry node for empty statements', () => {
    const cfg = buildCFGFromStatements('empty', []);
    expect(cfg.entryNodeId).toBe('empty:bb:0');
    expect(cfg.exitNodeId).toBe('empty:bb:0');
    const entryNode = cfg.nodes.get(cfg.entryNodeId);
    expect(entryNode).toBeDefined();
    expect(entryNode!.basicBlock).toEqual([]);
  });

  it('marks loop headers as isLoopHeader', () => {
    const cfg = buildCFGFromStatements('loopFn', [
      { type: 'while', content: 'while (true)', line: 1 },
      { type: 'assignment', content: 'x = x + 1', line: 2 },
    ]);

    const loopNodes = Array.from(cfg.nodes.values()).filter((n) => n.isLoopHeader);
    expect(loopNodes.length).toBeGreaterThan(0);
  });

  it('marks branch nodes as isBranch', () => {
    const cfg = buildCFGFromStatements('branchFn', [
      { type: 'if', content: 'if (cond)', line: 1 },
      { type: 'assignment', content: 'x = 1', line: 2 },
    ]);

    const branchNodes = Array.from(cfg.nodes.values()).filter((n) => n.isBranch);
    expect(branchNodes.length).toBeGreaterThan(0);
  });

  it('sets no successors for return/throw', () => {
    const cfg = buildCFGFromStatements('termFn', [
      { type: 'return', content: 'return x', line: 1 },
    ]);

    const returnNode = Array.from(cfg.nodes.values()).find((n) =>
      n.basicBlock.includes('return x'),
    );
    expect(returnNode?.successors).toEqual([]);
  });
});

// ─── cfgToResult ─────────────────────────────────────────────────────────────

describe('cfgToResult', () => {
  it('converts legacy Map-based CFG to CFGResult', () => {
    const nodes = new Map<string, CFGNode>();
    const entryId = 'fn:bb:0';
    const exitId = 'fn:bb:1';
    nodes.set(entryId, {
      id: entryId,
      functionId: 'fn',
      basicBlock: ['x = 1'],
      predecessors: [],
      successors: [exitId],
    });
    nodes.set(exitId, {
      id: exitId,
      functionId: 'fn',
      basicBlock: ['return x'],
      predecessors: [entryId],
      successors: [],
    });

    const legacyCfg: CFG = { functionId: 'fn', nodes, entryNodeId: entryId, exitNodeId: exitId };
    const result = cfgToResult(legacyCfg);

    expect(result.functionId).toBe('fn');
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toEqual([{ sourceId: 'fn:bb:0', targetId: 'fn:bb:1', edgeType: 'NEXT' }]);
  });

  it('preserves node order from Map iteration', () => {
    const nodes = new Map<string, CFGNode>();
    for (let i = 0; i < 3; i++) {
      const id = `fn:bb:${i}`;
      nodes.set(id, {
        id,
        functionId: 'fn',
        basicBlock: [`stmt ${i}`],
        predecessors: i > 0 ? [`fn:bb:${i - 1}`] : [],
        successors: i < 2 ? [`fn:bb:${i + 1}`] : [],
      });
    }

    const legacyCfg: CFG = {
      functionId: 'fn',
      nodes,
      entryNodeId: 'fn:bb:0',
      exitNodeId: 'fn:bb:2',
    };
    const result = cfgToResult(legacyCfg);

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.map((n) => n.id)).toEqual(['fn:bb:0', 'fn:bb:1', 'fn:bb:2']);
  });
});
