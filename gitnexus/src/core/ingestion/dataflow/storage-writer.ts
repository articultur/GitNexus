/**
 * Storage Writer for Data Flow Edges.
 *
 * Writes data flow analysis results (DATA_FLOW, PROPAGATES, RETURNS, TAINED, etc.)
 * to the knowledge graph. Edges are stored in a separate layer, not mixed with
 * existing CALLS edges.
 */

import type { TaintPath } from './types.js';
import type { DataFlowEdgeType, CFGResult } from './types.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import { generateId } from '../../../lib/utils.js';
import type { GraphRelationship, RelationshipType } from 'gitnexus-shared';

// ── Data Flow Edge ─────────────────────────────────────────────────────────

export interface DataFlowEdge {
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  properties: {
    sourceVariable?: string;
    targetVariable?: string;
    taintKind?: 'SOURCE' | 'SINK' | 'SANITIZER' | null;
    confidence: number;
    reason: string;
    pathLength?: number;
    isPathSpecific?: boolean;
  };
}

// ── Storage Writer ────────────────────────────────────────────────────────

/**
 * Write data flow edges to the knowledge graph.
 *
 * Edges are stored in a separate layer using the type property,
 * keeping data flow relationships distinct from CALLS edges.
 *
 * @param graph - Knowledge graph to write to
 * @param edges - Array of data flow edges to write
 */
export function writeDataFlowEdges(
  graph: KnowledgeGraph,
  edges: DataFlowEdge[]
): void {
  const errors: Error[] = [];

  for (const edge of edges) {
    const relationship: GraphRelationship = {
      id: generateId(edge.type, `${edge.sourceId}->${edge.targetId}`),
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      type: edge.type,
      confidence: edge.properties.confidence,
      reason: edge.properties.reason,
      step: edge.properties.pathLength,
    };

    try {
      graph.addRelationship(relationship);
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (errors.length > 0) {
    const msg = errors.length === 1
      ? `writeDataFlowEdges: ${errors[0].message}`
      : `writeDataFlowEdges: ${errors.length} errors (first: ${errors[0].message})`;
    throw new Error(msg);
  }
}

/**
 * Write taint paths as TAINED edges.
 *
 * Each step in the path becomes a TAINED edge.
 * If the path reaches a sink, a SINK_REACHABLE edge is also added.
 *
 * @param graph - Knowledge graph to write to
 * @param paths - Array of taint paths to write
 */
export function writeTaintPaths(
  graph: KnowledgeGraph,
  paths: TaintPath[]
): void {
  for (const path of paths) {
    // Write TAINED edge for each step in the path
    for (const step of path.path) {
      const edge: DataFlowEdge = {
        sourceId: step.from,
        targetId: step.to,
        type: 'TAINTED',
        properties: {
          taintKind: null,
          confidence: path.confidence,
          reason: `Taint path: ${path.source.kind} → ${path.sink.kind}`,
          pathLength: path.path.length,
          isPathSpecific: path.path.length > 1,
        },
      };

      writeDataFlowEdges(graph, [edge]);
    }

    // Write SINK_REACHABLE for paths that reach a sink
    if (path.sink) {
      const sinkEdge: DataFlowEdge = {
        sourceId: path.source.nodeId,
        targetId: path.sink.nodeId,
        type: 'SINK_REACHABLE',
        properties: {
          taintKind: 'SINK',
          confidence: path.confidence,
          reason: `Taint reaches sink: ${path.sink.kind}`,
          pathLength: path.path.length,
          isPathSpecific: true,
        },
      };

      writeDataFlowEdges(graph, [sinkEdge]);
    }
  }
}

/**
 * Clear all data flow edges from the graph.
 *
 * Used when re-running analysis to remove stale edges.
 *
 * @param graph - Knowledge graph to clear edges from
 */
export function clearDataFlowEdges(graph: KnowledgeGraph): void {
  const dataFlowTypes: DataFlowEdgeType[] = [
    'DATA_FLOW',
    'PROPAGATES',
    'RETURNS',
    'TAINTED',
    'SANITIZES',
    'SINK_REACHABLE',
    'ALIASES',
  ];

  const edgesToRemove: string[] = [];

  graph.forEachRelationship((rel) => {
    if (dataFlowTypes.includes(rel.type as DataFlowEdgeType)) {
      edgesToRemove.push(rel.id);
    }
  });

  for (const edgeId of edgesToRemove) {
    graph.removeRelationship(edgeId);
  }
}

/**
 * Get all data flow edges from the graph.
 *
 * @param graph - Knowledge graph to query
 * @returns Array of data flow edges
 */
export function getDataFlowEdges(graph: KnowledgeGraph): GraphRelationship[] {
  const dataFlowTypes: DataFlowEdgeType[] = [
    'DATA_FLOW',
    'PROPAGATES',
    'RETURNS',
    'TAINTED',
    'SANITIZES',
    'SINK_REACHABLE',
    'ALIASES',
  ];

  const edges: GraphRelationship[] = [];

  graph.forEachRelationship((rel) => {
    if (dataFlowTypes.includes(rel.type as DataFlowEdgeType)) {
      edges.push(rel);
    }
  });

  return edges;
}

/**
 * Get all tainted edges from the graph.
 *
 * @param graph - Knowledge graph to query
 * @returns Array of TAINED edges
 */
export function getTaintedEdges(graph: KnowledgeGraph): GraphRelationship[] {
  const edges: GraphRelationship[] = [];

  graph.forEachRelationship((rel) => {
    if (rel.type === 'TAINTED') {
      edges.push(rel);
    }
  });

  return edges;
}

/**
 * Get all sink-reachable edges from the graph.
 *
 * @param graph - Knowledge graph to query
 * @returns Array of SINK_REACHABLE edges
 */
export function getSinkReachableEdges(graph: KnowledgeGraph): GraphRelationship[] {
  const edges: GraphRelationship[] = [];

  graph.forEachRelationship((rel) => {
    if (rel.type === 'SINK_REACHABLE') {
      edges.push(rel);
    }
  });

  return edges;
}

// ── CFG Edge ────────────────────────────────────────────────────────────────

/**
 * Write CFG edges to the knowledge graph.
 *
 * @param graph - Knowledge graph to write to
 * @param cfg - CFG result containing nodes and edges
 */
export function writeCFGEdges(graph: KnowledgeGraph, cfg: CFGResult): void {
  for (const edge of cfg.edges) {
    graph.addRelationship({
      id: generateId('CFG_EDGE', `${edge.sourceId}->${edge.targetId}`),
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      type: 'CFG_EDGE',
      confidence: 1.0,
      reason: `cfg-${edge.edgeType}`,
    });
  }
}
