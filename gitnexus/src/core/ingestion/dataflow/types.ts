/**
 * Dataflow type definitions for lattice-based data flow analysis.
 *
 * Key concepts:
 * - DataFlowEdgeType: Types of data flow relationships
 * - CFGNode: Control flow graph node
 * - DataFlowFact: Data flow fact with lattice value
 * - TaintPath: Complete SOURCE→SINK path with sanitizers
 */

// ── Edge Types ────────────────────────────────────────────────────────────────

export type DataFlowEdgeType =
  | 'DATA_FLOW'        // Direct assignment transfer: a = b
  | 'PROPAGATES'       // Function parameter propagation: f(a) → a inside f
  | 'RETURNS'          // Return value propagation: f() → result
  | 'TAINTED'          // Taint propagation: user_input → query
  | 'SANITIZES'        // Sanitization: sanitize(x) → x is clean
  | 'SINK_REACHABLE'   // Complete path reaching SINK
  | 'ALIASES';         // Alias: a = b, then a.x = 1 also affects b.x

export interface DataFlowProperties {
  sourceVariable?: string;
  targetVariable?: string;
  taintKind?: 'SOURCE' | 'SINK' | 'SANITIZER' | null;
  pathLength?: number;
  isPathSpecific?: boolean;
}

// ── Control Flow Graph ────────────────────────────────────────────────────────

export interface CFGNode {
  id: string;
  functionId: string;
  basicBlock: string[];
  predecessors: string[];
  successors: string[];
  isLoopHeader?: boolean;
  isBranch?: boolean;
}

// ── Lattice Values ────────────────────────────────────────────────────────────

/**
 * Lattice values for data flow analysis:
 *
 *         TOP (NAC - Not A Constant)
 *        /    |    \
 *   UNINIT   ...   ...
 *        \    |    /
 *      BOTTOM (CONSTANT) ... (TAINTED) ... (SANITIZED)
 *
 * NAC = No Information (Top) - most imprecise, joins all paths
 * UNINIT = Uninitialized (Bottom) - most precise, no value yet
 */
export type LatticeValue = 'UNINIT' | 'NAC' | 'CONSTANT' | 'TAINTED' | 'SANITIZED';

export interface DataFlowFact {
  nodeId: string;
  variable: string;
  latticeValue: LatticeValue;
  constraints?: PathConstraint[];
}

// ── Path Constraints (for path-sensitive analysis) ───────────────────────────

export interface PathConstraint {
  condition: string;
  variable: string;
  value: string;
}

// ── Taint Analysis ───────────────────────────────────────────────────────────

export interface TaintPath {
  source: TaintSource;
  sink: TaintSink;
  path: TaintStep[];
  sanitizers: Sanitizer[];
  confidence: number;
}

export interface TaintSource {
  nodeId: string;
  variable: string;
  kind: string;
  description: string;
}

export interface TaintSink {
  nodeId: string;
  variable: string;
  kind: string;
  description: string;
}

export interface TaintStep {
  from: string;
  to: string;
  operation: string;
}

export interface Sanitizer {
  nodeId: string;
  variable: string;
  description: string;
}
