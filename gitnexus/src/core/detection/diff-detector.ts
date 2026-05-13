/**
 * Diff-Based Bug Detection
 *
 * Compares base vs head graph snapshots to detect risky changes:
 * - Added/removed CALLS edges (new dependencies or broken callers)
 * - Guard condition changes (removed error handling)
 * - Signature changes (parameters, return types)
 *
 * The caller provides two snapshots of graph data (nodes + relationships)
 * for the same file scope. DiffDetector identifies risk changes between them.
 */

import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

// ── Types ───────────────────────────────────────────────────────────────────

export type ChangeType =
  | 'added_edge' // New CALLS/IMPORTS edge — new dependency introduced
  | 'removed_edge' // Edge removed — caller may break
  | 'guard_removed' // Error handling removed from function content
  | 'signature_changed'; // Function/method signature changed

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface RiskChange {
  /** Symbol that changed */
  symbolId: string;
  symbolName: string;
  filePath: string;
  /** What changed */
  changeType: ChangeType;
  /** How risky */
  severity: RiskSeverity;
  /** Human-readable explanation */
  message: string;
  /** Supporting evidence */
  evidence: {
    /** Edge or property that changed */
    description: string;
    /** Before value (null if new) */
    before?: string;
    /** After value (null if removed) */
    after?: string;
  };
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function edgeKey(rel: GraphRelationship): string {
  return `${rel.sourceId}--${rel.type}-->${rel.targetId}`;
}

/** Build map from node id to node */
function nodeMap(nodes: Iterable<GraphNode>): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  for (const n of nodes) m.set(n.id, n);
  return m;
}

type EdgeKey = string;

/** Build map from edge key to relationship */
function edgeMap(rels: Iterable<GraphRelationship>): Map<EdgeKey, GraphRelationship> {
  const m = new Map<EdgeKey, GraphRelationship>();
  for (const r of rels) m.set(edgeKey(r), r);
  return m;
}

/** Determine severity based on edge type and direction */
function classifyEdgeChange(
  rel: GraphRelationship,
  change: 'added' | 'removed',
  nodeLookup: Map<string, GraphNode>,
): { severity: RiskSeverity; message: string } {
  const sourceNode = nodeLookup.get(rel.sourceId);
  const targetNode = nodeLookup.get(rel.targetId);
  const sourceName = sourceNode?.properties.name ?? rel.sourceId;
  const targetName = targetNode?.properties.name ?? rel.targetId;

  if (rel.type === 'CALLS') {
    if (change === 'removed') {
      return {
        severity: 'high',
        message: `${sourceName} no longer calls ${targetName} — callers may expect this behavior`,
      };
    }
    return {
      severity: 'medium',
      message: `${sourceName} now calls ${targetName} — new dependency introduced`,
    };
  }

  if (rel.type === 'IMPORTS') {
    return {
      severity: change === 'removed' ? 'high' : 'low',
      message: `${sourceName} ${change === 'removed' ? 'removed' : 'added'} import to ${targetName}`,
    };
  }

  return {
    severity: 'low',
    message: `${rel.type} edge ${change} between ${sourceName} and ${targetName}`,
  };
}

// ── Guard change detection ──────────────────────────────────────────────────

const GUARD_PATTERNS: RegExp[] = [
  /\btry\s*\{/,
  /\bcatch\s*\(/,
  /\.catch\s*\(/,
  /\bfinally\s*\{/,
  /\bwith\s+open\b/,
  /\bdefer\s+/,
];

/**
 * Detect if guard conditions were removed between two versions of content.
 * Returns descriptions of removed guards.
 */
function detectGuardRemoval(
  beforeContent: string,
  afterContent: string,
  functionName: string,
): Array<{ description: string; before: string; after: string }> {
  const results: Array<{ description: string; before: string; after: string }> = [];

  for (const pattern of GUARD_PATTERNS) {
    const hadBefore = pattern.test(beforeContent);
    const hasAfter = pattern.test(afterContent);
    if (hadBefore && !hasAfter) {
      const guardName = pattern.source
        .replace(/\\b/g, '')
        .replace(/\\s\*/g, ' ')
        .replace(/\\/g, '');
      results.push({
        description: `${functionName}: ${guardName} guard removed`,
        before: `had ${guardName}`,
        after: 'guard removed',
      });
    }
  }

  return results;
}

// ── Signature change detection ──────────────────────────────────────────────

/**
 * Detect signature changes by comparing parameterCount or name changes.
 */
function detectSignatureChange(
  beforeNode: GraphNode,
  afterNode: GraphNode,
): Array<{ description: string; before: string; after: string }> {
  const results: Array<{ description: string; before: string; after: string }> = [];
  const bp = beforeNode.properties;
  const ap = afterNode.properties;

  // Parameter count change
  if (bp.parameterCount !== undefined && ap.parameterCount !== undefined) {
    if (bp.parameterCount !== ap.parameterCount) {
      results.push({
        description: `${bp.name ?? beforeNode.id}: parameter count changed`,
        before: `${bp.parameterCount} params`,
        after: `${ap.parameterCount} params`,
      });
    }
  }

  // Name change (rename)
  if (bp.name && ap.name && bp.name !== ap.name) {
    results.push({
      description: `Symbol renamed`,
      before: bp.name,
      after: ap.name,
    });
  }

  return results;
}

// ── DiffDetector ────────────────────────────────────────────────────────────

export class DiffDetector {
  /**
   * Compare two graph snapshots and detect risk changes.
   *
   * @param base - The base (before) snapshot
   * @param head - The head (after) snapshot
   * @param contentChanges - Optional: map of symbolId -> { before, after } content for guard detection
   * @returns Array of risk changes
   */
  detect(
    base: GraphSnapshot,
    head: GraphSnapshot,
    contentChanges?: Map<string, { before: string; after: string }>,
  ): RiskChange[] {
    const changes: RiskChange[] = [];

    const headNodeLookup = nodeMap(head.nodes);
    const baseNodeLookup = nodeMap(base.nodes);
    const allNodeLookup = new Map([...baseNodeLookup, ...headNodeLookup]);

    const baseEdges = edgeMap(base.relationships);
    const headEdges = edgeMap(head.relationships);

    // ── Edge changes ───────────────────────────────────────────────────

    // Added edges
    for (const [key, rel] of headEdges) {
      if (!baseEdges.has(key)) {
        const { severity, message } = classifyEdgeChange(rel, 'added', allNodeLookup);
        const sourceNode = allNodeLookup.get(rel.sourceId);
        changes.push({
          symbolId: rel.sourceId,
          symbolName: sourceNode?.properties.name ?? rel.sourceId,
          filePath: sourceNode?.properties.filePath ?? '',
          changeType: 'added_edge',
          severity,
          message,
          evidence: {
            description: `New ${rel.type} edge`,
            after: `${rel.sourceId} → ${rel.targetId}`,
          },
        });
      }
    }

    // Removed edges
    for (const [key, rel] of baseEdges) {
      if (!headEdges.has(key)) {
        const { severity, message } = classifyEdgeChange(rel, 'removed', allNodeLookup);
        const sourceNode = allNodeLookup.get(rel.sourceId);
        changes.push({
          symbolId: rel.sourceId,
          symbolName: sourceNode?.properties.name ?? rel.sourceId,
          filePath: sourceNode?.properties.filePath ?? '',
          changeType: 'removed_edge',
          severity,
          message,
          evidence: {
            description: `Removed ${rel.type} edge`,
            before: `${rel.sourceId} → ${rel.targetId}`,
          },
        });
      }
    }

    // ── Guard removal ──────────────────────────────────────────────────

    if (contentChanges) {
      for (const [symbolId, { before, after }] of contentChanges) {
        const node = allNodeLookup.get(symbolId);
        if (!node) continue;

        const guardChanges = detectGuardRemoval(before, after, node.properties.name ?? symbolId);
        for (const gc of guardChanges) {
          changes.push({
            symbolId,
            symbolName: node.properties.name ?? symbolId,
            filePath: node.properties.filePath ?? '',
            changeType: 'guard_removed',
            severity: 'high',
            message: gc.description,
            evidence: gc,
          });
        }
      }
    }

    // ── Signature changes ──────────────────────────────────────────────

    for (const [id, headNode] of headNodeLookup) {
      const baseNode = baseNodeLookup.get(id);
      if (!baseNode) continue;

      const sigChanges = detectSignatureChange(baseNode, headNode);
      for (const sc of sigChanges) {
        changes.push({
          symbolId: id,
          symbolName: headNode.properties.name ?? id,
          filePath: headNode.properties.filePath ?? '',
          changeType: 'signature_changed',
          severity: 'medium',
          message: sc.description,
          evidence: sc,
        });
      }
    }

    return changes;
  }
}
