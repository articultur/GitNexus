import { describe, it, expect } from 'vitest';
import {
  RuleEngine,
  createEngine,
  buildRelationshipIndex,
} from '../../../src/core/detection/rule-engine.js';
import { DiffDetector } from '../../../src/core/detection/diff-detector.js';
import type { Rule, RuleContext } from '../../../src/core/detection/types.js';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

// ── Test fixtures ───────────────────────────────────────────────────────────

function makeNode(id: string, label: string, props: Record<string, any> = {}): GraphNode {
  return { id, label: label as any, properties: props };
}

function makeRel(id: string, source: string, target: string, type: string): GraphRelationship {
  return { id, sourceId: source, targetId: target, type: type as any, properties: {} };
}

function makeContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    node: makeNode('fn:1', 'Function', { name: 'test', filePath: 'test.ts' }),
    outgoingRelationships: [],
    incomingRelationships: [],
    outgoingTargets: new Map(),
    language: 'typescript',
    ...overrides,
  };
}

// ── Test rule factories ─────────────────────────────────────────────────────

const alwaysFire: Rule = {
  definition: {
    id: 'test:always',
    name: 'Always fires',
    description: 'Test rule that always returns a finding',
    severity: 'medium',
    confidence: 0.8,
    languages: ['*'],
    trigger: { nodeLabel: ['Function'] },
    missing: {},
  },
  evaluate: (ctx) => ({
    ruleId: 'test:always',
    message: `Found function: ${ctx.node.properties.name}`,
    symbolName: ctx.node.properties.name as string,
    symbolId: ctx.node.id,
    filePath: ctx.node.properties.filePath as string,
    severity: 'medium',
    confidence: 0.8,
    evidence: [],
  }),
};

const neverFire: Rule = {
  definition: {
    id: 'test:never',
    name: 'Never fires',
    description: 'Test rule that never returns a finding',
    severity: 'low',
    confidence: 0.5,
    languages: ['*'],
    trigger: {},
    missing: {},
  },
  evaluate: () => null,
};

const pythonOnly: Rule = {
  definition: {
    id: 'test:python-only',
    name: 'Python only',
    description: 'Only runs on Python',
    severity: 'high',
    confidence: 0.9,
    languages: ['python'],
    trigger: {},
    missing: {},
  },
  evaluate: (ctx) => ({
    ruleId: 'test:python-only',
    message: 'Python finding',
    symbolName: ctx.node.properties.name as string,
    symbolId: ctx.node.id,
    filePath: ctx.node.properties.filePath as string,
    severity: 'high',
    confidence: 0.9,
    evidence: [],
  }),
};

const throwsRule: Rule = {
  definition: {
    id: 'test:throws',
    name: 'Throws',
    description: 'Rule that throws during evaluation',
    severity: 'low',
    confidence: 0.1,
    languages: ['*'],
    trigger: {},
    missing: {},
  },
  evaluate: () => {
    throw new Error('Rule evaluation error');
  },
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RuleEngine', () => {
  it('registers and retrieves rules', () => {
    const engine = new RuleEngine();
    engine.register(alwaysFire);

    expect(engine.ruleCount).toBe(1);
    expect(engine.getRule('test:always')).toBe(alwaysFire);
    expect(engine.getRule('nonexistent')).toBeUndefined();
  });

  it('throws on duplicate rule id', () => {
    const engine = new RuleEngine();
    engine.register(alwaysFire);
    expect(() => engine.register(alwaysFire)).toThrow('Rule already registered: test:always');
  });

  it('unregisters rules', () => {
    const engine = new RuleEngine();
    engine.register(alwaysFire);
    expect(engine.unregister('test:always')).toBe(true);
    expect(engine.ruleCount).toBe(0);
    expect(engine.unregister('test:always')).toBe(false);
  });

  it('getRules returns all definitions', () => {
    const engine = new RuleEngine();
    engine.register(alwaysFire);
    engine.register(neverFire);

    const rules = engine.getRules();
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.id)).toContain('test:always');
    expect(rules.map((r) => r.id)).toContain('test:never');
  });

  it('evaluateNode returns findings from firing rules', () => {
    const engine = new RuleEngine();
    engine.register(alwaysFire);
    engine.register(neverFire);

    const ctx = makeContext();
    const results = engine.evaluateNode(ctx);

    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('test:always');
    expect(results[0].message).toContain('test');
  });

  it('evaluateNode filters by language', () => {
    const engine = new RuleEngine();
    engine.register(pythonOnly);

    // TypeScript — should not fire
    const tsCtx = makeContext({ language: 'typescript' });
    expect(engine.evaluateNode(tsCtx)).toHaveLength(0);

    // Python — should fire
    const pyCtx = makeContext({
      language: 'python',
      node: makeNode('fn:1', 'Function', { name: 'my_func', filePath: 'test.py' }),
    });
    expect(engine.evaluateNode(pyCtx)).toHaveLength(1);
  });

  it('evaluateNode skips rules that throw', () => {
    const engine = new RuleEngine();
    engine.register(throwsRule);
    engine.register(alwaysFire);

    const ctx = makeContext();
    const results = engine.evaluateNode(ctx);

    // throwsRule is skipped, alwaysFire still fires
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('test:always');
  });

  it('evaluateNode returns empty array when no rules fire', () => {
    const engine = new RuleEngine();
    engine.register(neverFire);

    const ctx = makeContext();
    expect(engine.evaluateNode(ctx)).toHaveLength(0);
  });

  it('evaluateGraph walks all nodes and collects findings', () => {
    const engine = new RuleEngine();
    engine.register(alwaysFire);

    const nodes = [
      makeNode('fn:1', 'Function', { name: 'alpha', filePath: 'a.ts' }),
      makeNode('fn:2', 'Function', { name: 'beta', filePath: 'b.ts' }),
    ];

    const results = engine.evaluateGraph(
      nodes,
      (nodeId) => ({ outgoing: [], incoming: [] }),
      (id) => nodes.find((n) => n.id === id),
    );

    expect(results).toHaveLength(2);
    expect(results[0].symbolName).toBe('alpha');
    expect(results[1].symbolName).toBe('beta');
  });

  it('evaluateGraph builds outgoing targets map', () => {
    const engine = new RuleEngine();

    let capturedTargets: Map<string, GraphNode> | undefined;

    const captureRule: Rule = {
      definition: {
        id: 'test:capture',
        name: 'Capture targets',
        description: '',
        severity: 'low',
        confidence: 0.5,
        languages: ['*'],
        trigger: {},
        missing: {},
      },
      evaluate: (ctx) => {
        capturedTargets = ctx.outgoingTargets;
        return null;
      },
    };
    engine.register(captureRule);

    const nodeA = makeNode('a', 'Function', { name: 'a', filePath: 'a.ts' });
    const nodeB = makeNode('b', 'Function', { name: 'b', filePath: 'b.ts' });
    const rel = makeRel('r1', 'a', 'b', 'CALLS');

    engine.evaluateGraph(
      [nodeA],
      (nodeId) => ({
        outgoing: nodeId === 'a' ? [rel] : [],
        incoming: [],
      }),
      (id) => (id === 'a' ? nodeA : id === 'b' ? nodeB : undefined),
    );

    expect(capturedTargets).toBeDefined();
    expect(capturedTargets!.get('r1')).toBe(nodeB);
  });
});

describe('createEngine', () => {
  it('creates engine with pre-loaded rules', () => {
    const engine = createEngine([alwaysFire, neverFire]);
    expect(engine.ruleCount).toBe(2);
    expect(engine.getRule('test:always')).toBeDefined();
    expect(engine.getRule('test:never')).toBeDefined();
  });
});

describe('buildRelationshipIndex', () => {
  it('indexes outgoing and incoming relationships', () => {
    const rels = [
      makeRel('r1', 'a', 'b', 'CALLS'),
      makeRel('r2', 'a', 'c', 'IMPORTS'),
      makeRel('r3', 'b', 'c', 'CALLS'),
    ];

    const idx = buildRelationshipIndex(rels);

    expect(idx.outgoing.get('a')).toHaveLength(2);
    expect(idx.outgoing.get('b')).toHaveLength(1);
    expect(idx.outgoing.get('c')).toBeUndefined();

    expect(idx.incoming.get('c')).toHaveLength(2);
    expect(idx.incoming.get('b')).toHaveLength(1);
    expect(idx.incoming.get('a')).toBeUndefined();
  });

  it('handles empty iterable', () => {
    const idx = buildRelationshipIndex([]);
    expect(idx.outgoing.size).toBe(0);
    expect(idx.incoming.size).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DiffDetector
// ══════════════════════════════════════════════════════════════════════════════

describe('DiffDetector', () => {
  const detector = new DiffDetector();

  it('detects added CALLS edge', () => {
    const baseNodes = [makeNode('a', 'Function', { name: 'alpha', filePath: 'a.ts' })];
    const headNodes = [
      makeNode('a', 'Function', { name: 'alpha', filePath: 'a.ts' }),
      makeNode('b', 'Function', { name: 'beta', filePath: 'b.ts' }),
    ];
    const headRels = [makeRel('r1', 'a', 'b', 'CALLS')];

    const changes = detector.detect(
      { nodes: baseNodes, relationships: [] },
      { nodes: headNodes, relationships: headRels },
    );

    expect(changes.length).toBeGreaterThanOrEqual(1);
    const callChange = changes.find(
      (c) => c.changeType === 'added_edge' && c.message.includes('calls'),
    );
    expect(callChange).toBeDefined();
    expect(callChange!.severity).toBe('medium');
  });

  it('detects removed CALLS edge', () => {
    const nodeA = makeNode('a', 'Function', { name: 'alpha', filePath: 'a.ts' });
    const nodeB = makeNode('b', 'Function', { name: 'beta', filePath: 'b.ts' });
    const baseRels = [makeRel('r1', 'a', 'b', 'CALLS')];

    const changes = detector.detect(
      { nodes: [nodeA, nodeB], relationships: baseRels },
      { nodes: [nodeA, nodeB], relationships: [] },
    );

    const removed = changes.find((c) => c.changeType === 'removed_edge');
    expect(removed).toBeDefined();
    expect(removed!.severity).toBe('high');
  });

  it('detects guard removal via content changes', () => {
    const nodeA = makeNode('a', 'Function', { name: 'alpha', filePath: 'a.ts' });
    const contentChanges = new Map<string, { before: string; after: string }>();
    contentChanges.set('a', {
      before: 'function alpha() { try { doWork(); } catch(e) { log(e); } }',
      after: 'function alpha() { doWork(); }',
    });

    const changes = detector.detect(
      { nodes: [nodeA], relationships: [] },
      { nodes: [nodeA], relationships: [] },
      contentChanges,
    );

    const guard = changes.find((c) => c.changeType === 'guard_removed');
    expect(guard).toBeDefined();
    expect(guard!.severity).toBe('high');
    expect(guard!.message).toContain('guard removed');
  });

  it('detects signature changes', () => {
    const baseNode = makeNode('a', 'Function', {
      name: 'alpha',
      parameterCount: 2,
      filePath: 'a.ts',
    });
    const headNode = makeNode('a', 'Function', {
      name: 'alpha',
      parameterCount: 3,
      filePath: 'a.ts',
    });

    const changes = detector.detect(
      { nodes: [baseNode], relationships: [] },
      { nodes: [headNode], relationships: [] },
    );

    const sig = changes.find((c) => c.changeType === 'signature_changed');
    expect(sig).toBeDefined();
    expect(sig!.message).toContain('parameter count');
  });

  it('returns empty for identical snapshots', () => {
    const nodeA = makeNode('a', 'Function', { name: 'alpha', filePath: 'a.ts' });
    const rel = makeRel('r1', 'a', 'b', 'CALLS');

    const changes = detector.detect(
      { nodes: [nodeA], relationships: [rel] },
      { nodes: [nodeA], relationships: [rel] },
    );

    expect(changes).toHaveLength(0);
  });

  it('returns empty for empty snapshots', () => {
    const changes = detector.detect(
      { nodes: [], relationships: [] },
      { nodes: [], relationships: [] },
    );
    expect(changes).toHaveLength(0);
  });
});
