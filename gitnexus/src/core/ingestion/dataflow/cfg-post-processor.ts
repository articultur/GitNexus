/**
 * cfg-post-processor.ts
 *
 * Post-processes tree-sitter-graph JSON output to resolve dynamic CFG edges:
 * 1. Sequential NEXT edges between statements (by source position)
 * 2. BREAK/CONTINUE routing to nearest enclosing loop header
 * 3. THROW routing to nearest enclosing catch clause
 * 4. CATCH edges from try_statement to catch_clause
 * 5. DYNAMIC_DISPATCH edges for performSelector-style dynamic calls
 *
 * TSG JSON format:
 * [
 *   {
 *     "id": number,
 *     "edges": [{ "sink": number, "attrs": { "type": { "type": "string", "string": "EDGE_TYPE" }, ... } }],
 *     "attrs": { "label": { "type": "string", "string": "..." }, "statementType": { ... }, ... }
 *   },
 *   ...
 * ]
 */

import type { CFGResult, CFGEdgeType } from './types.js';
import type { SyntaxNode } from 'tree-sitter';

export interface TSGAttr {
  type: 'string' | 'bool' | 'integer';
  string?: string;
  bool?: boolean;
  integer?: number;
}

export interface TSGNode {
  id: number;
  edges: Array<{
    sink: number;
    attrs: Record<string, TSGAttr>;
  }>;
  attrs: Record<string, TSGAttr>;
}

export interface CFGNode {
  id: number;
  label: string;
  statementType?: string;
  sourceText?: string;
  /** For message expressions: the method name */
  method?: string;
  /** For message expressions: the receiver expression */
  receiver?: string;
}

export interface CFGEdge {
  sourceId: number;
  targetId: number;
  type: string;
}

/** Extract string attribute value */
function getString(attrs: Record<string, TSGAttr>, key: string): string | undefined {
  const attr = attrs[key];
  if (attr?.type === 'string') return attr.string;
  return undefined;
}

/** Build flat node list and edge list */
export function parseTSGOutput(json: string): { nodes: CFGNode[]; edges: CFGEdge[] } {
  // TSG JSON is an array of nodes directly
  const graph: TSGNode[] = JSON.parse(json);

  // Deduplicate by label text (same source text = duplicate from overlapping stanza matches)
  // Prefer nodes with the most edges (captured by a more-specific stanza = more semantic info)
  // Ties: prefer nodes with statementType (more complete metadata)
  const bestByLabel = new Map<
    string,
    {
      id: number;
      label: string;
      statementType?: string;
      sourceText?: string;
      method?: string;
      receiver?: string;
      edgeCount: number;
    }
  >();
  for (const n of graph) {
    const label = getString(n.attrs, 'label') ?? '';
    const st = getString(n.attrs, 'statementType');
    const existing = bestByLabel.get(label);
    if (
      !existing ||
      n.edges.length > existing.edgeCount ||
      (n.edges.length === existing.edgeCount && st && !existing.statementType)
    ) {
      bestByLabel.set(label, {
        id: n.id,
        label,
        statementType: st,
        sourceText: getString(n.attrs, 'sourceText'),
        method: getString(n.attrs, 'method'),
        receiver: getString(n.attrs, 'receiver'),
        edgeCount: n.edges.length,
      });
    }
  }
  const nodes: CFGNode[] = [...bestByLabel.values()].map(({ edgeCount: _ec, ...rest }) => rest);

  const edges: CFGEdge[] = [];
  for (const node of graph) {
    for (const edge of node.edges) {
      const type = getString(edge.attrs, 'type') ?? 'NEXT';
      edges.push({ sourceId: node.id, targetId: edge.sink, type });
    }
  }

  return { nodes, edges };
}

/**
 * Add NEXT edges between consecutive statement nodes
 */
function addSequentialNextEdges(nodes: CFGNode[], edges: CFGEdge[]): CFGEdge[] {
  const newEdges = [...edges];
  const existingKeys = new Set(newEdges.map((e) => `${e.sourceId}|${e.targetId}`));

  // Filter to statement-level nodes (exclude structural ones)
  const statements = nodes.filter(
    (n) =>
      n.statementType &&
      !['loop', 'switch', 'try', 'case', 'default', 'block'].includes(n.statementType),
  );

  // Sort by source text to get execution order
  const sorted = [...statements].sort((a, b) => {
    // Extract just the label text for ordering
    const aText = a.label.replace(/\n/g, ' ').trim();
    const bText = b.label.replace(/\n/g, ' ').trim();
    return aText.localeCompare(bText);
  });

  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    const key = `${from.id}|${to.id}`;
    if (!existingKeys.has(key)) {
      newEdges.push({ sourceId: from.id, targetId: to.id, type: 'NEXT' });
      existingKeys.add(key);
    }
  }

  return newEdges;
}

/**
 * Resolve BREAK and CONTINUE edges to loop headers — PRECISE version using AST parent-walking.
 * For each break/continue, walks up the AST to find the innermost enclosing loop.
 */
function resolveBreakContinue(
  nodes: CFGNode[],
  edges: CFGEdge[],
  tree?: { rootNode: SyntaxNode },
): CFGEdge[] {
  const newEdges = [...edges];
  const existingKeys = new Set(newEdges.map((e) => `${e.sourceId}|${e.targetId}|${e.type}`));

  const loopNodes = nodes.filter((n) => n.statementType === 'loop');

  // Build AST → CFG label mapping by walking the tree
  const astLabelToNode = new Map<string, SyntaxNode>();
  if (tree) {
    walkAST(tree.rootNode, (node) => {
      const text = node.text;
      if (text) astLabelToNode.set(text, node);
    });
  }

  const breakNodes = nodes.filter((n) => n.statementType === 'break');
  const continueNodes = nodes.filter((n) => n.statementType === 'continue');

  for (const breakNode of breakNodes) {
    const targetLoop = tree ? findEnclosingLoopAST(breakNode.label, tree.rootNode) : null;
    if (targetLoop) {
      // Find the CFG loop node matching the enclosing AST loop.
      // DSL labels are the loop keyword (e.g. "for", "while") which is a prefix
      // of the full AST text (e.g. "for (let i = 0; ...)").
      const targetCFG = loopNodes.find((n) => targetLoop.text.startsWith(n.label));
      if (targetCFG) {
        const key = `${breakNode.id}|${targetCFG.id}|BREAK`;
        if (!existingKeys.has(key)) {
          newEdges.push({ sourceId: breakNode.id, targetId: targetCFG.id, type: 'BREAK' });
          existingKeys.add(key);
        }
      }
    }
  }

  for (const continueNode of continueNodes) {
    const targetLoop = tree ? findEnclosingLoopAST(continueNode.label, tree.rootNode) : null;
    if (targetLoop) {
      const targetCFG = loopNodes.find((n) => targetLoop.text.startsWith(n.label));
      if (targetCFG) {
        const key = `${continueNode.id}|${targetCFG.id}|CONTINUE`;
        if (!existingKeys.has(key)) {
          newEdges.push({ sourceId: continueNode.id, targetId: targetCFG.id, type: 'CONTINUE' });
          existingKeys.add(key);
        }
      }
    }
  }

  return newEdges;
}

/** Walk all nodes in an AST with depth limit to prevent stack overflow */
function walkAST(node: SyntaxNode, cb: (n: SyntaxNode) => void, depth = 0, maxDepth = 1000): void {
  if (depth > maxDepth) return;
  cb(node);
  for (const child of node.children) {
    walkAST(child, cb, depth + 1, maxDepth);
  }
}

/** Find the innermost enclosing loop for a break/continue statement */
function findEnclosingLoopAST(breakLabel: string, root: SyntaxNode): SyntaxNode | null {
  const LOOP_TYPES = new Set([
    'while_statement',
    'for_statement',
    'do_statement',
    'for_in_statement',
    'for_of_statement',
  ]);

  let targetLoop: SyntaxNode | null = null;

  const visitor = (node: SyntaxNode) => {
    if (
      node.text === breakLabel &&
      (node.type === 'break_statement' || node.type === 'continue_statement')
    ) {
      let current: SyntaxNode | null = node.parent;
      while (current) {
        if (LOOP_TYPES.has(current.type)) {
          targetLoop = current;
          return;
        }
        current = current.parent;
      }
    }
  };

  walkAST(root, visitor);
  return targetLoop;
}

/**
 * Find the nearest enclosing try statement for a throw node.
 * Walks up the AST parent chain to find the closest try_statement ancestor.
 */
function findEnclosingTry(throwLabel: string, root: SyntaxNode): SyntaxNode | null {
  let targetTry: SyntaxNode | null = null;
  const visitor = (node: SyntaxNode) => {
    if (node.text === throwLabel && node.type === 'throw_statement') {
      let current: SyntaxNode | null = node.parent;
      while (current) {
        if (current.type === 'try_statement') {
          targetTry = current;
          return;
        }
        current = current.parent;
      }
    }
  };
  walkAST(root, visitor);
  return targetTry;
}

/**
 * Find the nearest catch clause child of a try AST node.
 */
function findNearestCatchOfTry(tryNode: SyntaxNode): SyntaxNode | null {
  for (const child of tryNode.children) {
    if (child.type === 'catch_clause') return child;
  }
  return null;
}

/**
 * Resolve THROW edges to the nearest enclosing catch clause.
 * For nested try-catches, a throw inside the inner try routes to the inner catch.
 */
function resolveThrowEdges(
  nodes: CFGNode[],
  edges: CFGEdge[],
  tree?: { rootNode: SyntaxNode },
): CFGEdge[] {
  const newEdges = [...edges];
  const existingKeys = new Set(newEdges.map((e) => `${e.sourceId}|${e.targetId}|${e.type}`));

  const throwNodes = nodes.filter((n) => n.statementType === 'throw');
  const tryNodes = nodes.filter((n) => n.statementType === 'try');

  for (const throwNode of throwNodes) {
    const enclosingTry = tree ? findEnclosingTry(throwNode.label, tree.rootNode) : null;
    if (enclosingTry) {
      // Find the CFG try node matching the enclosing AST try
      const targetCFG = tryNodes.find((n) => enclosingTry.text.startsWith(n.label));
      if (targetCFG) {
        // Find nearest catch via AST
        const catchAST = findNearestCatchOfTry(enclosingTry);
        if (catchAST) {
          const catchCFG = nodes.find(
            (n) => n.statementType === 'catch' && catchAST.text.startsWith(n.label),
          );
          if (catchCFG) {
            const key = `${throwNode.id}|${catchCFG.id}|THROW`;
            if (!existingKeys.has(key)) {
              newEdges.push({ sourceId: throwNode.id, targetId: catchCFG.id, type: 'THROW' });
              existingKeys.add(key);
            }
          }
        }
      }
    }
  }

  return newEdges;
}

/**
 * Add CATCH edges from try to nearest catch clause.
 */
function resolveCatchEdges(
  nodes: CFGNode[],
  edges: CFGEdge[],
  tree?: { rootNode: SyntaxNode },
): CFGEdge[] {
  const newEdges = [...edges];
  const existingKeys = new Set(newEdges.map((e) => `${e.sourceId}|${e.targetId}|${e.type}`));

  const tryNodes = nodes.filter((n) => n.statementType === 'try');

  for (const tryNode of tryNodes) {
    // Find AST try node matching this CFG node
    let astTry: SyntaxNode | null = null;
    if (tree) {
      const visitor = (node: SyntaxNode) => {
        if (node.type === 'try_statement' && node.text.startsWith(tryNode.label)) {
          astTry = node;
        }
      };
      walkAST(tree.rootNode, visitor);
    }
    if (!astTry) continue;

    const catchAST = findNearestCatchOfTry(astTry);
    if (catchAST) {
      const catchCFG = nodes.find(
        (n) => n.statementType === 'catch' && catchAST.text.startsWith(n.label),
      );
      if (catchCFG) {
        const key = `${tryNode.id}|${catchCFG.id}|CATCH`;
        if (!existingKeys.has(key)) {
          newEdges.push({ sourceId: tryNode.id, targetId: catchCFG.id, type: 'CATCH' });
          existingKeys.add(key);
        }
      }
    }
  }

  return newEdges;
}

/**
 * Resolve DYNAMIC_DISPATCH edges for performSelector-style dynamic calls.
 *
 * Objective-C performSelector: and similar methods dynamically determine
 * the target method at runtime based on the selector argument. We create
 * DYNAMIC_DISPATCH edges from these call sites to indicate that control
 * flow cannot be statically determined.
 *
 * Detection criteria:
 * - statementType === "message" (ObjC message expression)
 * - method attribute starts with "performSelector"
 */
function resolveDynamicDispatch(nodes: CFGNode[], edges: CFGEdge[]): CFGEdge[] {
  const newEdges = [...edges];
  const existingKeys = new Set(newEdges.map((e) => `${e.sourceId}|${e.targetId}|${e.type}`));

  // Find performSelector message nodes
  const dynamicDispatchNodes = nodes.filter(
    (n) => n.statementType === 'message' && n.method && /^performSelector/.test(n.method),
  );

  for (const node of dynamicDispatchNodes) {
    // Create a self-referential DYNAMIC_DISPATCH edge to mark this node
    // as having dynamic dispatch. The target is the same node to indicate
    // "the target is undetermined at static analysis time".
    const key = `${node.id}|${node.id}|DYNAMIC_DISPATCH`;
    if (!existingKeys.has(key)) {
      newEdges.push({
        sourceId: node.id,
        targetId: node.id,
        type: 'DYNAMIC_DISPATCH',
      });
      existingKeys.add(key);
    }
  }

  return newEdges;
}

/**
 * Main post-processing pipeline
 */
export function postProcessTSGGraph(
  nodes: CFGNode[],
  edges: CFGEdge[],
  tree?: { rootNode: SyntaxNode },
): { nodes: CFGNode[]; edges: CFGEdge[] } {
  let resultEdges = edges;

  // 1. Add sequential NEXT edges
  resultEdges = addSequentialNextEdges(nodes, resultEdges);

  // 2. Resolve BREAK/CONTINUE to nearest enclosing loop (AST parent-walking when tree available)
  resultEdges = resolveBreakContinue(nodes, resultEdges, tree);

  // 3. Resolve THROW to nearest enclosing catch
  resultEdges = resolveThrowEdges(nodes, resultEdges, tree);

  // 4. Add CATCH edges to nearest catch
  resultEdges = resolveCatchEdges(nodes, resultEdges, tree);

  // 5. Add DYNAMIC_DISPATCH edges for performSelector-style calls
  resultEdges = resolveDynamicDispatch(nodes, resultEdges);

  return { nodes, edges: resultEdges };
}

/**
 * Convert to buildCFG-compatible CFGResult format
 */
export function tsgToCFGResult(
  nodes: CFGNode[],
  edges: CFGEdge[],
  functionId: string = 'anonymous',
): CFGResult {
  const preds = new Map<number, number[]>();
  const succs = new Map<number, number[]>();

  for (const e of edges) {
    if (!preds.has(e.targetId)) preds.set(e.targetId, []);
    if (!succs.has(e.sourceId)) succs.set(e.sourceId, []);
    preds.get(e.targetId)!.push(e.sourceId);
    succs.get(e.sourceId)!.push(e.targetId);
  }

  const cfgNodes = nodes.map((n, idx) => ({
    id: String(n.id),
    functionId,
    basicBlock: [n.label],
    predecessors: [...new Set(preds.get(n.id) || [])].map(String),
    successors: [...new Set(succs.get(n.id) || [])].map(String),
    statementType: n.statementType,
    blockNumber: idx,
  }));

  const cfgEdges = edges.map((e) => ({
    sourceId: String(e.sourceId),
    targetId: String(e.targetId),
    edgeType: e.type as CFGEdgeType,
  }));

  return { nodes: cfgNodes, edges: cfgEdges, functionId };
}
