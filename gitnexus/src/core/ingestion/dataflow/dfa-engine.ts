/**
 * Data Flow Analysis (DFA) Engine.
 *
 * Implements forward data flow analysis using the worklist algorithm.
 * The analysis propagates lattice values through the CFG to determine
 * the data flow facts at each program point.
 *
 * Key concepts:
 * - Worklist algorithm: Iterates until fixpoint (no more changes)
 * - Transfer function: Maps in-facts to out-facts for each node
 * - Join operation: Combines facts from multiple predecessors
 */

import type { CFGNode, LatticeValue, CFGResult } from './types.js';
import { join, propagate, isSanitized } from './lattice.js';
import type { CFG } from './cfg-builder.js';

// ── Context Types ───────────────────────────────────────────────────────────

export interface DFAContext {
  cfg: CFG;
  /** Variable name -> type mapping */
  symbolTable: Map<string, string>;
  /** Function -> list of functions it calls */
  callsGraph: Map<string, string[]>;
  /** Variable -> variable it was assigned to (for tracking assignments) */
  assignments: Map<string, string>;
  /** Known taint sources (function names or patterns) */
  taintSources?: Set<string>;
  /** Known sanitizer functions */
  sanitizers?: Set<string>;
  /** Known sink functions */
  sinks?: Set<string>;
}

export interface AnalysisResult {
  /** nodeId -> variable -> lattice value */
  facts: Map<string, Map<string, LatticeValue>>;
  /** List of taint source locations */
  taintSources: string[];
  /** List of taint sink locations */
  taintSinks: string[];
  /** List of variables that are sanitized */
  sanitizedVariables: string[];
}

// ── Analysis Engine ────────────────────────────────────────────────────────

/**
 * Perform forward data flow analysis using the worklist algorithm.
 *
 * @param context - DFA context including CFG and configuration
 * @returns Analysis result with facts at each node
 *
 * Algorithm:
 * 1. Initialize entry node with UNINIT for all variables
 * 2. Put entry node on worklist
 * 3. While worklist not empty:
 *    a. Pop node from worklist
 *    b. Compute in-facts from predecessors (join all)
 *    c. Apply transfer function to get out-facts
 *    d. If out-facts changed, add successors to worklist
 * 4. Return facts map
 */
export function analyzeForward(context: DFAContext): AnalysisResult {
  const { cfg } = context;
  const facts = new Map<string, Map<string, LatticeValue>>();
  const worklist = new Set<string>();

  // Initialize entry node with UNINIT for all variables
  const entryFacts = new Map<string, LatticeValue>();
  entryFacts.set('__entry__', 'UNINIT');
  facts.set(cfg.entryNodeId, entryFacts);
  worklist.add(cfg.entryNodeId);

  while (worklist.size > 0) {
    // Pop a node from worklist (using Set iterator)
    const nodeId = worklist.values().next().value!;
    worklist.delete(nodeId);

    const node = cfg.nodes.get(nodeId);
    if (!node) continue;

    // Get facts from predecessors (join all)
    const inFacts = new Map<string, LatticeValue>();

    if (node.predecessors.length === 0) {
      // Entry node - use initialized facts
      const entryFactsForNode = facts.get(cfg.entryNodeId);
      if (entryFactsForNode) {
        for (const [varName, value] of entryFactsForNode) {
          inFacts.set(varName, value);
        }
      }
    } else {
      // Join facts from all predecessors
      for (const predId of node.predecessors) {
        const predFacts = facts.get(predId);
        if (predFacts) {
          for (const [varName, value] of predFacts) {
            const existing = inFacts.get(varName);
            inFacts.set(varName, existing ? join(existing, value) : value);
          }
        }
      }
    }

    // Apply transfer function
    const outFacts = transfer(node, inFacts, context);

    // Compare with existing out facts
    const existingOut = facts.get(nodeId);
    let changed = false;

    if (!existingOut) {
      facts.set(nodeId, outFacts);
      changed = true;
    } else {
      for (const [varName, value] of outFacts) {
        const existing = existingOut.get(varName);
        if (!existing || join(existing, value) !== existing) {
          existingOut.set(varName, existing ? join(existing, value) : value);
          changed = true;
        }
      }
      // Check for keys removed from outFacts (variables no longer defined)
      for (const varName of existingOut.keys()) {
        if (!outFacts.has(varName)) {
          changed = true;
          break;
        }
      }
    }

    // Add successors to worklist if facts changed
    if (changed) {
      for (const succId of node.successors) {
        worklist.add(succId);
      }
    }
  }

  // Extract taint sources, sinks, and sanitizers from results
  const { taintSources, taintSinks, sanitizedVariables } = extractTaintInfo(facts, context);

  return { facts, taintSources, taintSinks, sanitizedVariables };
}

/**
 * Transfer function: computes out-facts from in-facts.
 *
 * For each statement in the basic block:
 * - Assignment: propagate RHS value to LHS variable
 * - Call: track parameter passing
 * - Return: track return value
 */
function transfer(
  node: CFGNode,
  inFacts: Map<string, LatticeValue>,
  context: DFAContext,
): Map<string, LatticeValue> {
  const outFacts = new Map(inFacts);

  for (const stmt of node.basicBlock) {
    // Handle assignment: x = expr OR const/let/var x = expr
    const assignMatch = stmt.match(/^(?:(?:const|let|var)\s+)?(\w+)\s*=\s*(.+)$/);
    if (assignMatch) {
      const [, lhs, rhs] = assignMatch;
      const rhsValue = computeRHSValue(rhs, outFacts, context);
      outFacts.set(lhs, propagate(rhsValue));
      // Track assignment for alias analysis
      context.assignments.set(lhs, rhs);
    }

    // Handle function calls that might be sanitizers or sources
    const callMatch = stmt.match(/(\w+)\s*\((.*)\)/);
    if (callMatch) {
      const [, funcName, args] = callMatch;

      // Check if it's a taint source
      if (context.taintSources?.has(funcName)) {
        // Function call result is tainted
        const resultVar = stmt.match(/^(?:(?:const|let|var)\s+)?(\w+)\s*=/)?.[1];
        if (resultVar) {
          outFacts.set(resultVar, 'TAINTED');
        }
      }

      // Check if it's a sanitizer
      if (context.sanitizers?.has(funcName)) {
        // Parse arguments and mark as sanitized
        const argVars = args.split(',').map((a: string) => a.trim());
        for (const arg of argVars) {
          outFacts.set(arg, 'SANITIZED');
        }
      }
    }
  }

  return outFacts;
}

/**
 * Compute the lattice value for the RHS of an assignment.
 */
function computeRHSValue(
  rhs: string,
  facts: Map<string, LatticeValue>,
  context: DFAContext,
): LatticeValue {
  // Check if RHS is a known tainted source
  if (context.taintSources) {
    for (const source of context.taintSources) {
      if (rhs.includes(source)) {
        return 'TAINTED';
      }
    }
  }

  // Check if RHS is a known sanitizer
  if (context.sanitizers) {
    for (const sanitize of context.sanitizers) {
      if (rhs.includes(sanitize)) {
        return 'SANITIZED';
      }
    }
  }

  // Check if RHS is a previously assigned variable
  const assignedVar = rhs.match(/^\w+$/)?.[0];
  if (assignedVar && facts.has(assignedVar)) {
    return facts.get(assignedVar)!;
  }

  // Check if RHS contains a function call that returns a value
  if (rhs.includes('(')) {
    // Assume function calls return constants unless they're known sources/sanitizers
    return 'CONSTANT';
  }

  // Literal value
  if (rhs.match(/^['"0-9]/)) {
    return 'CONSTANT';
  }

  // Default to NAC (unknown)
  return 'NAC';
}

/**
 * Extract taint sources, sinks, and sanitized variables from analysis results.
 */
function extractTaintInfo(
  facts: Map<string, Map<string, LatticeValue>>,
  context: DFAContext,
): { taintSources: string[]; taintSinks: string[]; sanitizedVariables: string[] } {
  const taintSources: string[] = [];
  const taintSinks: string[] = [];
  const sanitizedVariables: string[] = [];

  // Track which nodes have taint sources
  const seenTaintSourceNodes = new Set<string>();

  for (const [nodeId, nodeFacts] of facts) {
    // Check if this node contains an actual taint source call
    const node = context.cfg.nodes.get(nodeId);
    if (node) {
      for (const stmt of node.basicBlock) {
        const callMatch = stmt.match(/(\w+)\s*\((.*)\)/);
        if (callMatch) {
          const [, funcName] = callMatch;
          if (context.taintSources?.has(funcName)) {
            const key = `${nodeId}:${funcName}`;
            if (!seenTaintSourceNodes.has(key)) {
              seenTaintSourceNodes.add(key);
              taintSources.push(key);
            }
          }
        }
      }
    }

    for (const [variable, value] of nodeFacts) {
      if (isSanitized(value)) {
        sanitizedVariables.push(`${nodeId}:${variable}`);
      }
    }
  }

  return { taintSources, taintSinks, sanitizedVariables };
}

/**
 * Extract taint sources from analysis results.
 */
export function extractTaintSources(result: AnalysisResult): string[] {
  return result.taintSources;
}

/**
 * Extract taint sinks from analysis results.
 */
export function extractTaintSinks(result: AnalysisResult): string[] {
  return result.taintSinks;
}

/**
 * Create a default DFA context with standard taint sources and sinks.
 */
export function createDefaultContext(cfg: CFG): DFAContext {
  return {
    cfg,
    symbolTable: new Map(),
    callsGraph: new Map(),
    assignments: new Map(),
    taintSources: new Set(['userInput', 'getenv', 'getParameter', 'request', 'ARGV', 'ENV']),
    sanitizers: new Set([
      'sanitize',
      'escape',
      'htmlEscape',
      'encodeForHTML',
      'encodeForURL',
      'trim',
    ]),
    sinks: new Set(['execute', 'eval', 'exec', 'execSync', 'query', 'sql']),
  };
}

// ── Reaching Definitions Analysis (RDA) ──────────────────────────────────────

/**
 * Reaching Definitions Analysis table.
 * Maps each CFG node to its definition and use sets.
 */
export interface RDATable {
  [nodeId: string]: {
    def: Set<string>; // Variables defined at this node
    use: Set<string>; // Variables used at this node
  };
}

/**
 * Compute the Reaching Definitions Analysis for a CFG.
 *
 * RDA determines, for each program point, which variable definitions
 * (assignments) may reach that point without being overwritten.
 *
 * Algorithm (fixed-point iteration):
 * 1. Initialize: GEN = statements in node, KILL = vars overwritten by node
 * 2. Initialize RD_IN[entry] = empty set
 * 3. Iterate until fixpoint:
 *    RD_IN[n] = UNION of RD_OUT of all predecessors
 *    RD_OUT[n] = GEN | (RD_IN[n] - KILL)
 *
 * @param cfg - CFGResult from cfg-builder
 * @returns RDATable mapping each node to its def/use sets
 */
export function computeRDA(cfg: CFGResult): RDATable {
  const nodeMap = new Map<string, CFGNode>();
  for (const node of cfg.nodes) {
    nodeMap.set(node.id, node);
  }

  // Build node index for quick predecessor lookup
  const predMap = new Map<string, string[]>();
  const succMap = new Map<string, string[]>();
  for (const node of cfg.nodes) {
    predMap.set(node.id, []);
    succMap.set(node.id, []);
  }
  for (const edge of cfg.edges) {
    predMap.get(edge.targetId)?.push(edge.sourceId);
    succMap.get(edge.sourceId)?.push(edge.targetId);
  }

  // Initialize GEN and KILL sets for each node
  // GEN(node): variables DEFINED (assigned) in this node
  // KILL(node): variables that this node OVERWRITES (definitions of same var in other nodes)
  const genMap = new Map<string, Set<string>>();
  const killMap = new Map<string, Set<string>>();

  // First pass: collect all definitions per variable across the function
  const varToDefNodes = new Map<string, Set<string>>();
  for (const node of cfg.nodes) {
    for (const stmt of node.basicBlock) {
      const assignMatch = stmt.match(/^(\w+)\s*=\s*(.+)$/);
      if (assignMatch) {
        const [, lhs] = assignMatch;
        if (!varToDefNodes.has(lhs)) {
          varToDefNodes.set(lhs, new Set());
        }
        varToDefNodes.get(lhs)!.add(node.id);
      }
    }
  }

  // Second pass: compute GEN and KILL for each node
  for (const node of cfg.nodes) {
    const gen = new Set<string>();
    const kill = new Set<string>();

    for (const stmt of node.basicBlock) {
      // x = expr → x is defined (GEN), expr vars are used (already tracked by stmt)
      const assignMatch = stmt.match(/^(\w+)\s*=\s*(.+)$/);
      if (assignMatch) {
        const [, lhs] = assignMatch;
        gen.add(lhs);
        // KILL: all other definitions of this variable in the same function
        const defNodes = varToDefNodes.get(lhs);
        if (defNodes) {
          for (const defNodeId of defNodes) {
            if (defNodeId !== node.id) {
              kill.add(`${lhs}:${defNodeId}`);
            }
          }
        }
      }
    }

    genMap.set(node.id, gen);
    killMap.set(node.id, kill);
  }

  // Initialize RD_IN and RD_OUT
  // RD_IN[n] = set of definitions reaching node n
  // RD_OUT[n] = set of definitions leaving node n
  const rdIn = new Map<string, Set<string>>();
  const rdOut = new Map<string, Set<string>>();

  for (const node of cfg.nodes) {
    rdIn.set(node.id, new Set());
    rdOut.set(node.id, new Set());
  }

  // Entry node has no reaching definitions
  rdIn.set(cfg.functionId, new Set());
  rdOut.set(cfg.functionId, new Set());

  // Fixed-point iteration
  let changed = true;
  let iterations = 0;
  const MAX_ITERATIONS = 1000; // Safety guard

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;

    for (const node of cfg.nodes) {
      // RD_IN[n] = UNION of RD_OUT of all predecessors
      const preds = predMap.get(node.id) ?? [];
      const newRdIn = new Set<string>();

      if (preds.length === 0) {
        // Entry node - no reaching definitions from predecessors
        newRdIn.clear();
      } else {
        for (const predId of preds) {
          const predOut = rdOut.get(predId);
          if (predOut) {
            for (const def of predOut) {
              newRdIn.add(def);
            }
          }
        }
      }

      // Check if RD_IN changed
      const oldRdIn = rdIn.get(node.id)!;
      if (oldRdIn.size !== newRdIn.size || ![...newRdIn].every((d) => oldRdIn.has(d))) {
        changed = true;
        rdIn.set(node.id, newRdIn);
      }

      // RD_OUT[n] = GEN | (RD_IN[n] - KILL)
      const currentRdIn = rdIn.get(node.id)!;
      const gen = genMap.get(node.id)!;
      const kill = killMap.get(node.id)!;
      const newRdOut = new Set<string>();

      // Start with GEN
      for (const g of gen) {
        newRdOut.add(g);
      }

      // Add RD_IN[n] minus KILL
      for (const def of currentRdIn) {
        // KILL is currently empty for simplicity; extend if needed
        if (!kill.has(def)) {
          newRdOut.add(def);
        }
      }

      // Check if RD_OUT changed
      const oldRdOut = rdOut.get(node.id)!;
      if (oldRdOut.size !== newRdOut.size || ![...newRdOut].every((d) => oldRdOut.has(d))) {
        changed = true;
        rdOut.set(node.id, newRdOut);
      }
    }
  }

  // Build RDATable: def = GEN (definitions produced here), use = variables used here
  const rdaTable: RDATable = {};

  for (const node of cfg.nodes) {
    const use = new Set<string>();
    for (const stmt of node.basicBlock) {
      // Extract variables used on RHS of assignments
      const assignMatch = stmt.match(/^(\w+)\s*=\s*(.+)$/);
      if (assignMatch) {
        const [, _lhs, rhs] = assignMatch;
        // Find all variable references in RHS
        const varMatches = rhs.matchAll(/\b([a-zA-Z_]\w*)\b/g);
        for (const match of varMatches) {
          use.add(match[1]);
        }
      } else {
        // For non-assignment statements, extract all variable names
        const varMatches = stmt.matchAll(/\b([a-zA-Z_]\w*)\b/g);
        for (const match of varMatches) {
          use.add(match[1]);
        }
      }
    }

    rdaTable[node.id] = {
      def: genMap.get(node.id) ?? new Set(),
      use,
    };
  }

  return rdaTable;
}
