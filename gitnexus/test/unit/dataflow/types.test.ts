/**
 * Unit tests for dataflow types
 */
import { describe, it, expect } from 'vitest';
import type {
  DataFlowEdgeType,
  LatticeValue,
  CFGNode,
  DataFlowFact,
  TaintPath,
  TaintSource,
  TaintSink,
  Sanitizer,
} from '../../../../src/core/ingestion/dataflow/types';

describe('Dataflow Types', () => {
  describe('LatticeValue', () => {
    it('should have valid lattice values', () => {
      const validValues: LatticeValue[] = ['UNINIT', 'NAC', 'CONSTANT', 'TAINTED', 'SANITIZED'];
      validValues.forEach(v => expect(typeof v).toBe('string'));
    });

    it('should have exactly 5 lattice values', () => {
      const values: LatticeValue[] = ['UNINIT', 'NAC', 'CONSTANT', 'TAINTED', 'SANITIZED'];
      expect(values.length).toBe(5);
    });
  });

  describe('DataFlowEdgeType', () => {
    it('should have valid edge types', () => {
      const validTypes: DataFlowEdgeType[] = [
        'DATA_FLOW', 'PROPAGATES', 'RETURNS', 'TAINTED',
        'SANITIZES', 'SINK_REACHABLE', 'ALIASES'
      ];
      expect(validTypes.length).toBe(7);
    });

    it('should cover all expected edge types', () => {
      const edgeTypes: DataFlowEdgeType[] = [
        'DATA_FLOW',
        'PROPAGATES',
        'RETURNS',
        'TAINTED',
        'SANITIZES',
        'SINK_REACHABLE',
        'ALIASES',
      ];
      edgeTypes.forEach(t => expect(typeof t).toBe('string'));
    });
  });

  describe('CFGNode', () => {
    it('should create valid CFG node', () => {
      const node: CFGNode = {
        id: 'func1:bb:0',
        functionId: 'func1',
        basicBlock: ['x = user_input()', 'return x'],
        predecessors: [],
        successors: ['func1:bb:1'],
      };
      expect(node.id).toBe('func1:bb:0');
      expect(node.functionId).toBe('func1');
      expect(node.basicBlock.length).toBe(2);
    });

    it('should track predecessors and successors', () => {
      const node: CFGNode = {
        id: 'func1:bb:1',
        functionId: 'func1',
        basicBlock: ['y = x'],
        predecessors: ['func1:bb:0'],
        successors: ['func1:bb:2'],
      };
      expect(node.predecessors).toContain('func1:bb:0');
      expect(node.successors).toContain('func1:bb:2');
    });

    it('should identify loop headers and branches', () => {
      const loopNode: CFGNode = {
        id: 'func1:bb:0',
        functionId: 'func1',
        basicBlock: ['while (cond)'],
        predecessors: ['func1:bb:2'],
        successors: ['func1:bb:1', 'func1:bb:2'],
        isLoopHeader: true,
        isBranch: false,
      };
      expect(loopNode.isLoopHeader).toBe(true);
      expect(loopNode.isBranch).toBe(false);
    });
  });

  describe('DataFlowFact', () => {
    it('should create valid data flow fact', () => {
      const fact: DataFlowFact = {
        nodeId: 'func1:bb:0',
        variable: 'x',
        latticeValue: 'TAINTED',
      };
      expect(fact.nodeId).toBe('func1:bb:0');
      expect(fact.variable).toBe('x');
      expect(fact.latticeValue).toBe('TAINTED');
    });

    it('should support path constraints', () => {
      const fact: DataFlowFact = {
        nodeId: 'func1:bb:1',
        variable: 'y',
        latticeValue: 'CONSTANT',
        constraints: [
          { condition: 'x > 0', variable: 'x', value: 'positive' },
        ],
      };
      expect(fact.constraints).toBeDefined();
      expect(fact.constraints!.length).toBe(1);
    });
  });

  describe('TaintPath', () => {
    it('should create valid taint path', () => {
      const source: TaintSource = {
        nodeId: 'func1:bb:0',
        variable: 'user_input',
        kind: 'ts-env',
        description: 'Environment variable',
      };

      const sink: TaintSink = {
        nodeId: 'func1:bb:2',
        variable: 'query',
        kind: 'ts-sink:query',
        description: 'SQL query execution',
      };

      const sanitizer: Sanitizer = {
        nodeId: 'func1:bb:1',
        variable: 'escaped',
        description: 'HTML escape',
      };

      const path: TaintPath = {
        source,
        sink,
        path: [
          { from: 'func1:bb:0', to: 'func1:bb:1', operation: 'propagate' },
          { from: 'func1:bb:1', to: 'func1:bb:2', operation: 'propagate' },
        ],
        sanitizers: [sanitizer],
        confidence: 0.8,
      };

      expect(path.source.kind).toBe('ts-env');
      expect(path.sink.kind).toBe('ts-sink:query');
      expect(path.path.length).toBe(2);
      expect(path.confidence).toBe(0.8);
    });
  });
});
