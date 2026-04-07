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
  | 'DATA_FLOW' // Direct assignment transfer: a = b
  | 'PROPAGATES' // Function parameter propagation: f(a) → a inside f
  | 'RETURNS' // Return value propagation: f() → result
  | 'TAINTED' // Taint propagation: user_input → query
  | 'SANITIZES' // Sanitization: sanitize(x) → x is clean
  | 'SINK_REACHABLE' // Complete path reaching SINK
  | 'ALIASES' // Alias: a = b, then a.x = 1 also affects b.x
  | 'BOUNDARY_CROSS'; // Cross-language/cross-process boundary transfer

export type BoundaryType =
  | 'FFI_CALL' // FFI call (.node, ctypes, cgo, JNI)
  | 'IPC_SEND' // IPC send (postMessage, ipcRenderer.send)
  | 'IPC_RECEIVE' // IPC receive (onmessage, ipcMain.handle)
  | 'MEMORY_SHARED' // Shared memory (SharedArrayBuffer, ctypes pointers)
  | 'SANDBOX_ENTER' // Sandbox entry (contextBridge.exposeInMainWorld)
  | 'SANDBOX_EXIT' // Sandbox exit (eval, new Function)
  | 'DESERIALIZE' // Deserialization (pickle, unmarshal, JSON.parse)
  | 'PROCESS_SPAWN'; // Process spawn (child_process.spawn, Worker)

export interface DataFlowProperties {
  sourceVariable?: string;
  targetVariable?: string;
  taintKind?: 'SOURCE' | 'SINK' | 'SANITIZER' | null;
  pathLength?: number;
  isPathSpecific?: boolean;
  boundary?: BoundaryInfo;
}

export interface BoundaryInfo {
  boundaryType: BoundaryType;
  sourceZone: string;
  targetZone: string;
  preservedTaint: boolean;
}

export interface TrustZone {
  language: string;
  sandbox: boolean;
  privileges: 'full' | 'restricted' | 'minimal';
  defaultTaintModel: 'propagate' | 'isolated' | 'opaque';
}

export const ZONE_MAP: Record<string, TrustZone> = {
  nodejs: {
    language: 'nodejs',
    sandbox: false,
    privileges: 'full',
    defaultTaintModel: 'propagate',
  },
  'electron-main': {
    language: 'nodejs',
    sandbox: false,
    privileges: 'full',
    defaultTaintModel: 'propagate',
  },
  'electron-renderer': {
    language: 'javascript',
    sandbox: true,
    privileges: 'minimal',
    defaultTaintModel: 'isolated',
  },
  'electron-worker': {
    language: 'javascript',
    sandbox: false,
    privileges: 'full',
    defaultTaintModel: 'propagate',
  },
  python: {
    language: 'python',
    sandbox: false,
    privileges: 'full',
    defaultTaintModel: 'propagate',
  },
  'java-jvm': {
    language: 'java',
    sandbox: false,
    privileges: 'full',
    defaultTaintModel: 'propagate',
  },
  'android-art': {
    language: 'java',
    sandbox: true,
    privileges: 'restricted',
    defaultTaintModel: 'isolated',
  },
  'swift-native': {
    language: 'swift',
    sandbox: false,
    privileges: 'full',
    defaultTaintModel: 'propagate',
  },
  'go-runtime': {
    language: 'go',
    sandbox: false,
    privileges: 'full',
    defaultTaintModel: 'propagate',
  },
  dart: { language: 'dart', sandbox: false, privileges: 'full', defaultTaintModel: 'propagate' },
};

// ── Control Flow Graph ────────────────────────────────────────────────────────

/** Legacy CFG format used by dfa-engine and path-sensitive.
 *  @deprecated Use CFGResult (array-based) for new code. */
export interface CFG {
  functionId: string;
  nodes: Map<string, CFGNode>;
  entryNodeId: string;
  exitNodeId: string;
}

export type CFGEdgeType =
  | 'NEXT' // Sequential execution
  | 'TRUE_BRANCH' // If true branch
  | 'FALSE_BRANCH' // If false branch
  | 'LOOP_HEADER' // Loop header
  | 'BREAK' // Break statement
  | 'CONTINUE' // Continue statement
  | 'SWITCH_CASE' // Switch case
  | 'SWITCH_DEFAULT' // Switch default
  | 'TRY_BODY' // Try block
  | 'CATCH' // Catch block
  | 'THROW' // Throw
  | 'RETURN'; // Return

export interface CFGNode {
  id: string;
  functionId: string;
  basicBlock: string[]; // Statements in this basic block (for display)
  predecessors: string[];
  successors: string[];
  isLoopHeader?: boolean;
  isBranch?: boolean;
  // New fields for enhanced CFG
  blockNumber?: number; // Basic block number
  statementType?: string; // 'if' | 'while' | 'for' | etc.
  label?: string; // Display text
  astNode?: unknown; // SyntaxNode from tree-sitter
}

export interface CFGEdge {
  sourceId: string;
  targetId: string;
  edgeType: CFGEdgeType;
}

export interface CFGResult {
  nodes: CFGNode[];
  edges: CFGEdge[];
  functionId: string;
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

// ── Legacy text-based CFG types (for backwards compatibility) ────────────────────

export interface BasicBlock {
  id: string;
  statements: string[];
  startLine: number;
  endLine: number;
}

export type StatementType =
  | 'assignment' // x = expr
  | 'call' // function call (no assignment)
  | 'return' // return statement
  | 'if' // conditional branch
  | 'while' // while loop
  | 'for' // for loop
  | 'switch' // switch statement
  | 'throw' // throw statement
  | 'try' // try-catch block
  | 'label' // labeled statement
  | 'goto' // goto statement
  | 'enter' // function entry
  | 'exit'; // function exit

export interface ParsedStatement {
  type: StatementType;
  content: string;
  line: number;
}

export function splitIntoBasicBlocks(statements: string[]): BasicBlock[] {
  return statements.map((s, i) => ({
    id: `bb:${i}`,
    statements: [s],
    startLine: i,
    endLine: i,
  }));
}

export function parseStatements(_functionId: string, sourceLines: string[]): ParsedStatement[] {
  const statements: ParsedStatement[] = [];
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i].trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const type = inferStatementType(line);
    statements.push({ type, content: line, line: i + 1 });
  }
  return statements;
}

function inferStatementType(line: string): StatementType {
  if (line.startsWith('if ') || line.startsWith('if(')) return 'if';
  if (line.startsWith('while ') || line.startsWith('while(')) return 'while';
  if (line.startsWith('for ') || line.startsWith('for(')) return 'for';
  if (line.startsWith('switch ') || line.startsWith('switch(')) return 'switch';
  if (line.startsWith('return ')) return 'return';
  if (line.startsWith('throw ')) return 'throw';
  if (line.startsWith('try ') || line.startsWith('try{')) return 'try';
  if (line.match(/^\w+:$/)) return 'label';
  if (line === 'enter' || line === 'function entry') return 'enter';
  if (line === 'exit' || line === 'function exit') return 'exit';
  if (line.includes('(') && !line.includes('=')) return 'call';
  return 'assignment';
}

export function addCFGEdges(cfg: CFG, statements: ParsedStatement[]): CFG {
  const nodes = new Map(cfg.nodes);
  for (let i = 0; i < statements.length; i++) {
    const nodeId = `${cfg.functionId}:bb:${i}`;
    const node = nodes.get(nodeId);
    if (!node) continue;
    const stmt = statements[i];
    if (stmt.type === 'if') {
      if (i + 1 < statements.length) node.successors.push(`${cfg.functionId}:bb:${i + 1}`);
    } else if (stmt.type === 'while' || stmt.type === 'for') {
      node.successors = [nodeId];
      if (i + 1 < statements.length) node.successors.push(`${cfg.functionId}:bb:${i + 1}`);
    } else if (stmt.type === 'return' || stmt.type === 'throw') {
      node.successors = [];
    }
    nodes.set(nodeId, node);
  }
  return { ...cfg, nodes };
}
