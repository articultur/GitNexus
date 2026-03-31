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

import type { CFGNode, DataFlowFact, LatticeValue } from './types.js';
import { join, propagate, isTainted, isSanitized } from './lattice.js';
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
  const visited = new Set<string>();

  // Initialize entry node with UNINIT for all variables
  const entryFacts = new Map<string, LatticeValue>();
  entryFacts.set('__entry__', 'UNINIT');
  facts.set(cfg.entryNodeId, entryFacts);
  worklist.add(cfg.entryNodeId);

  while (worklist.size > 0) {
    // Pop a node from worklist (using Set iterator)
    const nodeId = worklist.values().next().value!;
    worklist.delete(nodeId);
    visited.add(nodeId);

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
    }

    // Add successors to worklist if facts changed
    if (changed) {
      for (const succId of node.successors) {
        if (!visited.has(succId)) {
          worklist.add(succId);
        }
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
  context: DFAContext
): Map<string, LatticeValue> {
  const outFacts = new Map(inFacts);

  for (const stmt of node.basicBlock) {
    // Handle assignment: x = expr
    const assignMatch = stmt.match(/^(\w+)\s*=\s*(.+)$/);
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
        const resultVar = stmt.match(/^(\w+)\s*=/)?.[1];
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
  context: DFAContext
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
  context: DFAContext
): { taintSources: string[]; taintSinks: string[]; sanitizedVariables: string[] } {
  const taintSources: string[] = [];
  const taintSinks: string[] = [];
  const sanitizedVariables: string[] = [];

  for (const [nodeId, nodeFacts] of facts) {
    for (const [variable, value] of nodeFacts) {
      if (isTainted(value)) {
        taintSources.push(`${nodeId}:${variable}`);
      }
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
    sanitizers: new Set(['sanitize', 'escape', 'htmlEscape', 'encodeForHTML', 'encodeForURL', 'trim']),
    sinks: new Set(['execute', 'eval', 'exec', 'execSync', 'query', 'sql']),
  };
}
