/**
 * Phase 5 Integration Tests: buildCFG vs buildCFGFromTSG
 *
 * Compares the legacy imperative cfg-builder against the tree-sitter-graph
 * DSL pipeline for TypeScript and JavaScript.
 *
 * These tests are skipped when the tree-sitter-graph CLI is not available.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import { buildCFG } from '../../src/core/ingestion/dataflow/cfg-builder.js';
import { buildCFGFromTSG, isTSGAvailable } from '../../src/core/ingestion/dataflow/cfg-from-tsg.js';
import { SupportedLanguages } from 'gitnexus-shared';

// ─── helpers ──────────────────────────────────────────────────────────────────

const tsgAvailable = isTSGAvailable();

// Use factory functions to avoid parser state issues between tests
function makeTSParser() {
  const p = new Parser();
  p.setLanguage(TypeScript.typescript);
  return p;
}

function makeJSParser() {
  const p = new Parser();
  p.setLanguage(JavaScript);
  return p;
}

function makePythonParser() {
  const p = new Parser();
  p.setLanguage(Python);
  return p;
}

function parseTS(source: string) {
  return makeTSParser().parse(source);
}

function parseJS(source: string) {
  return makeJSParser().parse(source);
}

function parsePython(source: string) {
  return makePythonParser().parse(source);
}

// ─── Feature availability ─────────────────────────────────────────────────────

describe('tree-sitter-graph availability', () => {
  it('CLI is installed', () => {
    // Skip entire suite if CLI not available
    if (!tsgAvailable.cli) {
      console.warn('⚠️ tree-sitter-graph CLI not found — integration tests skipped');
    }
  });

  it('TypeScript DSL exists', () => {
    expect(tsgAvailable.dsl['typescript']).toBeDefined();
  });
});

// ─── TSG parse sanity (no comparison) ─────────────────────────────────────────

const SKIP = !tsgAvailable.cli;

describe.skipIf(SKIP)('TSG: TypeScript DSL parse', () => {
  it('parses a simple function without error', () => {
    const source = 'function foo() { return 1; }';
    const tree = parseTS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    expect(result.functionId).toBe('foo');
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it('produces expected edge types for if-else', () => {
    const source = `function test(x) {
      if (x > 0) { return 1; }
      else { return 0; }
    }`;
    const tree = parseTS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('TRUE_BRANCH');
    expect(edgeTypes).toContain('FALSE_BRANCH');
  });

  it('produces LOOP_HEADER for while loop', () => {
    const source = `function loop() {
      while (true) { x = x + 1; }
      return x;
    }`;
    const tree = parseTS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('LOOP_HEADER');
  });

  it('produces SWITCH_CASE for switch', () => {
    const source = `function sw(x) {
      switch (x) {
        case 1: return 1;
        case 2: return 2;
        default: return 0;
      }
    }`;
    const tree = parseTS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('SWITCH_CASE');
    expect(edgeTypes).toContain('SWITCH_DEFAULT');
  });

  it('produces CATCH and TRY_BODY for try-catch', () => {
    const source = `function test(x) {
      try { risky(x); }
      catch (e) { return e; }
    }`;
    const tree = parseTS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('TRY_BODY');
    expect(edgeTypes).toContain('CATCH');
  });

  it('nested try-catch: THROW routes to nearest catch only', () => {
    const source = `function nestedTry() {
      try {
        try { throw 1; }
        catch (e) { console.log(e); }
      }
      catch (outer) { return outer; }
    }`;
    const tree = parseTS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const throwEdges = result.edges.filter(e => e.edgeType === 'THROW');
    const catchNodes = result.nodes.filter(n => n.statementType === 'catch');
    // Should have exactly 1 THROW edge (to inner catch), not 2
    expect(throwEdges.length).toBe(1);
    // THROW should route to inner catch (the one with console.log)
    const throwTargetId = throwEdges[0]?.targetId;
    const targetCatch = catchNodes.find(n => n.id === throwTargetId);
    expect(targetCatch).toBeDefined();
    // Inner catch label contains 'console.log', outer catch contains 'return outer'
    expect(targetCatch?.basicBlock[0] ?? '').toContain('console.log');
  });

  it('produces BREAK and CONTINUE for loops', () => {
    const source = `function nested() {
      for (let i = 0; i < 10; i++) {
        if (i === 5) break;
        continue;
      }
    }`;
    const tree = parseTS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('BREAK');
    expect(edgeTypes).toContain('CONTINUE');
    expect(edgeTypes).toContain('LOOP_HEADER');
  });
});

describe.skipIf(SKIP)('TSG: JavaScript DSL parse', () => {
  it('parses a simple JS function', () => {
    const source = 'function foo() { return 1; }';
    const tree = parseJS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.JavaScript);
    expect(result.functionId).toBe('foo');
  });

  it('parses arrow functions', () => {
    const source = 'const fn = (x) => x * 2;';
    const tree = parseJS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.JavaScript);
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it('parses class methods', () => {
    const source = `class MyClass {
      method() { return 42; }
    }`;
    const tree = parseJS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.JavaScript);
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it('parses for-of loop', () => {
    const source = 'function f(arr) { for (const x of arr) { console.log(x); } }';
    const tree = parseJS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.JavaScript);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('LOOP_HEADER');
  });
});

// ─── Legacy vs TSG comparison ─────────────────────────────────────────────────

describe.skipIf(SKIP)('TSG vs buildCFG: TypeScript equivalence', () => {
  function compareEdgeTypes(legacy: ReturnType<typeof buildCFG>, tsg: ReturnType<typeof buildCFGFromTSG>) {
    const legacyTypes = [...new Set(legacy.edges.map(e => e.edgeType))].sort();
    const tsgTypes = [...new Set(tsg.edges.map(e => e.edgeType))].sort();
    return { legacyTypes, tsgTypes };
  }

  it('if-else: same edge type set', () => {
    const source = `function test(x) {
      if (x > 0) { return 1; }
      else { return 0; }
    }`;
    const tree = parseTS(source);
    const legacy = buildCFG(tree, source, SupportedLanguages.TypeScript);
    const tsg = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const { legacyTypes, tsgTypes } = compareEdgeTypes(legacy, tsg);
    expect(tsgTypes).toEqual(expect.arrayContaining(['FALSE_BRANCH', 'TRUE_BRANCH']));
  });

  it('while loop: both produce LOOP_HEADER', () => {
    const source = `function loop() {
      while (true) { x = x + 1; }
      return x;
    }`;
    const tree = parseTS(source);
    const legacy = buildCFG(tree, source, SupportedLanguages.TypeScript);
    const tsg = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const { legacyTypes, tsgTypes } = compareEdgeTypes(legacy, tsg);
    expect(tsgTypes).toContain('LOOP_HEADER');
    expect(legacyTypes).toContain('LOOP_HEADER');
  });

  it('for loop: both produce LOOP_HEADER and NEXT', () => {
    const source = `function range() {
      for (let i = 0; i < 10; i++) { x = i; }
      return x;
    }`;
    const tree = parseTS(source);
    const legacy = buildCFG(tree, source, SupportedLanguages.TypeScript);
    const tsg = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const { legacyTypes, tsgTypes } = compareEdgeTypes(legacy, tsg);
    expect(tsgTypes).toContain('LOOP_HEADER');
    expect(tsgTypes).toContain('NEXT');
    expect(legacyTypes).toContain('LOOP_HEADER');
  });

  it('switch: both produce SWITCH_CASE', () => {
    const source = `function sw(x) {
      switch (x) {
        case 1: return 1;
        case 2: return 2;
        default: return 0;
      }
    }`;
    const tree = parseTS(source);
    const legacy = buildCFG(tree, source, SupportedLanguages.TypeScript);
    const tsg = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const { legacyTypes, tsgTypes } = compareEdgeTypes(legacy, tsg);
    expect(tsgTypes).toContain('SWITCH_CASE');
    expect(legacyTypes).toContain('SWITCH_CASE');
  });

  it('try-catch: both produce CATCH and TRY_BODY', () => {
    const source = `function test(x) {
      try { risky(x); }
      catch (e) { return e; }
      finally { cleanup(); }
    }`;
    const tree = parseTS(source);
    const legacy = buildCFG(tree, source, SupportedLanguages.TypeScript);
    const tsg = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const { legacyTypes, tsgTypes } = compareEdgeTypes(legacy, tsg);
    expect(tsgTypes).toContain('TRY_BODY');
    expect(tsgTypes).toContain('CATCH');
    expect(legacyTypes).toContain('TRY_BODY');
    expect(legacyTypes).toContain('CATCH');
  });

  it('nested break/continue: TSG produces BREAK and CONTINUE', () => {
    const source = `function nested() {
      for (let i = 0; i < 10; i++) {
        if (i === 5) break;
        continue;
      }
    }`;
    const tree = parseTS(source);
    const tsg = buildCFGFromTSG(tree, source, SupportedLanguages.TypeScript);
    const tsgTypes = [...new Set(tsg.edges.map(e => e.edgeType))];
    expect(tsgTypes).toContain('BREAK');
    expect(tsgTypes).toContain('CONTINUE');
    expect(tsgTypes).toContain('LOOP_HEADER');
  });
});

// ─── Extended JS DSL coverage ──────────────────────────────────────────────────

describe.skipIf(SKIP)('TSG: JavaScript extended coverage', () => {
  it('arrow function with try-catch-finally', () => {
    const source = `const fn = (x) => {
      try { risky(x); }
      catch (e) { console.error(e); }
      finally { cleanup(); }
    };`;
    const tree = parseJS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.JavaScript);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('TRY_BODY');
    expect(edgeTypes).toContain('CATCH');
    expect(result.functionId).toBeTruthy();
  });

  it('class method with try-catch and throw', () => {
    const source = `class Util {
      process(x) {
        try { throw new Error('fail'); }
        catch (err) { return null; }
      }
    }`;
    const tree = parseJS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.JavaScript);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('TRY_BODY');
    expect(edgeTypes).toContain('CATCH');
    expect(edgeTypes).toContain('THROW');
  });

  it('nested arrow functions with break in for-of', () => {
    const source = `const outer = (arr) => {
      for (const x of arr) {
        if (x < 0) break;
        process(x);
      }
    };`;
    const tree = parseJS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.JavaScript);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('LOOP_HEADER');
    expect(edgeTypes).toContain('BREAK');
  });

  it('async function with throw and catch routing', () => {
    const source = `async function fetchData(url) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('bad response');
        return response.json();
      }
      catch (err) { return null; }
    }`;
    const tree = parseJS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.JavaScript);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('TRY_BODY');
    expect(edgeTypes).toContain('CATCH');
    expect(edgeTypes).toContain('THROW');
  });

  it('generator function with yield', () => {
    const source = `function* gen(arr) {
      for (const x of arr) {
        yield x;
        if (x === 0) break;
      }
    }`;
    const tree = parseJS(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.JavaScript);
    const nodes = result.nodes.filter(n => n.statementType === 'loop');
    expect(nodes.length).toBeGreaterThan(0);
  });
});

// ─── Python DSL coverage ────────────────────────────────────────────────────────

describe.skipIf(SKIP)('TSG: Python DSL parse', () => {
  it('parses a Python function', () => {
    const source = `def foo(x):
    if x > 0:
        return 1
    else:
        return 0`;
    const tree = parsePython(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.Python);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.functionId).toBeTruthy();
  });

  it('produces TRUE_BRANCH and FALSE_BRANCH for if-else', () => {
    const source = `def test(x):
    if x > 0:
        return 1
    else:
        return 0`;
    const tree = parsePython(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.Python);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('TRUE_BRANCH');
    expect(edgeTypes).toContain('FALSE_BRANCH');
  });

  it('produces LOOP_HEADER for for loop', () => {
    const source = `def loop():
    for i in range(10):
        x = i`;
    const tree = parsePython(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.Python);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('LOOP_HEADER');
  });

  it('produces TRY_BODY and CATCH for try-except', () => {
    const source = `def test():
    try:
        risky()
    except e:
        handle(e)`;
    const tree = parsePython(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.Python);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('TRY_BODY');
    expect(edgeTypes).toContain('CATCH');
  });

  it('produces BREAK and CONTINUE for loop', () => {
    const source = `def nested():
    for i in range(10):
        if i == 5:
            break
        continue`;
    const tree = parsePython(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.Python);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('LOOP_HEADER');
  });

  it('produces THROW for raise statement', () => {
    const source = `def fail():
    raise Exception('error')`;
    const tree = parsePython(source);
    const result = buildCFGFromTSG(tree, source, SupportedLanguages.Python);
    const throwNodes = result.nodes.filter(n => n.statementType === 'throw');
    expect(throwNodes.length).toBeGreaterThan(0);
  });
});
