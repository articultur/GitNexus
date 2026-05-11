/**
 * Unit tests for Storage Writer
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  writeDataFlowEdges,
  writeTaintPaths,
  clearDataFlowEdges,
  getDataFlowEdges,
  getTaintedEdges,
  getSinkReachableEdges,
  type DataFlowEdge,
} from '../../../src/core/ingestion/dataflow/storage-writer';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';

describe('Storage Writer', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;

  beforeEach(() => {
    graph = createKnowledgeGraph();
  });

  describe('writeDataFlowEdges', () => {
    it('should write DATA_FLOW edge', () => {
      const edges: DataFlowEdge[] = [
        {
          sourceId: 'Function:f1',
          targetId: 'Function:f2',
          type: 'DATA_FLOW',
          properties: {
            confidence: 1.0,
            reason: 'x = y, y = f1()',
          },
        },
      ];

      writeDataFlowEdges(graph, edges);

      const relationships = graph.relationships;
      expect(relationships.length).toBe(1);
      expect(relationships[0].type).toBe('DATA_FLOW');
      expect(relationships[0].sourceId).toBe('Function:f1');
      expect(relationships[0].targetId).toBe('Function:f2');
    });

    it('should write PROPAGATES edge', () => {
      const edges: DataFlowEdge[] = [
        {
          sourceId: 'Function:processInput',
          targetId: 'Variable:x',
          type: 'PROPAGATES',
          properties: {
            sourceVariable: 'x',
            targetVariable: 'result',
            confidence: 0.9,
            reason: 'Parameter propagation',
          },
        },
      ];

      writeDataFlowEdges(graph, edges);

      const relationships = graph.relationships;
      expect(relationships[0].type).toBe('PROPAGATES');
    });

    it('should write multiple edges', () => {
      const edges: DataFlowEdge[] = [
        {
          sourceId: 'Function:f1',
          targetId: 'Function:f2',
          type: 'DATA_FLOW',
          properties: { confidence: 1.0, reason: 'test1' },
        },
        {
          sourceId: 'Function:f2',
          targetId: 'Function:f3',
          type: 'DATA_FLOW',
          properties: { confidence: 0.9, reason: 'test2' },
        },
      ];

      writeDataFlowEdges(graph, edges);

      expect(graph.relationshipCount).toBe(2);
    });

    it('should write RETURNS edge', () => {
      const edges: DataFlowEdge[] = [
        {
          sourceId: 'Function:getValue',
          targetId: 'Variable:result',
          type: 'RETURNS',
          properties: {
            confidence: 1.0,
            reason: 'return x',
          },
        },
      ];

      writeDataFlowEdges(graph, edges);

      const relationships = graph.relationships;
      expect(relationships[0].type).toBe('RETURNS');
    });

    it('should write SANITIZES edge', () => {
      const edges: DataFlowEdge[] = [
        {
          sourceId: 'Function:sanitize',
          targetId: 'Variable:x',
          type: 'SANITIZES',
          properties: {
            confidence: 1.0,
            reason: 'sanitize(x)',
          },
        },
      ];

      writeDataFlowEdges(graph, edges);

      const relationships = graph.relationships;
      expect(relationships[0].type).toBe('SANITIZES');
    });
  });

  describe('writeTaintPaths', () => {
    it('should write TAINED edges for taint path', () => {
      const paths = [
        {
          source: {
            nodeId: 'Function:getInput',
            variable: 'x',
            kind: 'ts-env',
            description: 'env',
          },
          sink: {
            nodeId: 'Function:exec',
            variable: 'sql',
            kind: 'ts-sink:query',
            description: 'sql',
          },
          path: [
            { from: 'Function:getInput', to: 'Function:process', operation: 'propagate' },
            { from: 'Function:process', to: 'Function:exec', operation: 'propagate' },
          ],
          sanitizers: [],
          confidence: 1.0,
        },
      ];

      writeTaintPaths(graph, paths);

      // 2 TAINED edges for the path
      const taintedEdges = getTaintedEdges(graph);
      expect(taintedEdges.length).toBe(2);
    });

    it('should write SINK_REACHABLE edge when path reaches sink', () => {
      const paths = [
        {
          source: {
            nodeId: 'Function:getInput',
            variable: 'x',
            kind: 'ts-env',
            description: 'env',
          },
          sink: {
            nodeId: 'Function:exec',
            variable: 'sql',
            kind: 'ts-sink:query',
            description: 'sql',
          },
          path: [{ from: 'Function:getInput', to: 'Function:exec', operation: 'direct' }],
          sanitizers: [],
          confidence: 1.0,
        },
      ];

      writeTaintPaths(graph, paths);

      const sinkEdges = getSinkReachableEdges(graph);
      expect(sinkEdges.length).toBe(1);
      expect(sinkEdges[0].type).toBe('SINK_REACHABLE');
    });
  });

  describe('clearDataFlowEdges', () => {
    it('should remove all data flow edges', () => {
      // Write some edges
      writeDataFlowEdges(graph, [
        {
          sourceId: 'Function:f1',
          targetId: 'Function:f2',
          type: 'DATA_FLOW',
          properties: { confidence: 1.0, reason: 'test' },
        },
      ]);

      expect(graph.relationshipCount).toBe(1);

      clearDataFlowEdges(graph);

      expect(graph.relationshipCount).toBe(0);
    });

    it('should not remove non-dataflow edges', () => {
      // Write a data flow edge
      writeDataFlowEdges(graph, [
        {
          sourceId: 'Function:f1',
          targetId: 'Function:f2',
          type: 'DATA_FLOW',
          properties: { confidence: 1.0, reason: 'test' },
        },
      ]);

      // Add a non-dataflow relationship directly
      graph.addRelationship({
        id: 'CALLS:f1->f2',
        sourceId: 'Function:f1',
        targetId: 'Function:f2',
        type: 'CALLS',
        confidence: 1.0,
        reason: 'function call',
      });

      expect(graph.relationshipCount).toBe(2);

      clearDataFlowEdges(graph);

      // Only the DATA_FLOW edge should be removed
      expect(graph.relationshipCount).toBe(1);
      expect(graph.relationships[0].type).toBe('CALLS');
    });
  });

  describe('getDataFlowEdges', () => {
    it('should return only data flow edges', () => {
      // Add data flow edge
      writeDataFlowEdges(graph, [
        {
          sourceId: 'Function:f1',
          targetId: 'Function:f2',
          type: 'DATA_FLOW',
          properties: { confidence: 1.0, reason: 'test' },
        },
      ]);

      // Add non-dataflow relationship
      graph.addRelationship({
        id: 'CALLS:f1->f2',
        sourceId: 'Function:f1',
        targetId: 'Function:f2',
        type: 'CALLS',
        confidence: 1.0,
        reason: 'function call',
      });

      const dataFlowEdges = getDataFlowEdges(graph);

      expect(dataFlowEdges.length).toBe(1);
      expect(dataFlowEdges[0].type).toBe('DATA_FLOW');
    });
  });
});
