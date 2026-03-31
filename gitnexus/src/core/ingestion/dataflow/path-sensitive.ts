/**
 * Path-Sensitive Data Flow Analysis.
 *
 * Unlike flow-sensitive analysis which joins values at branch points,
 * path-sensitive analysis tracks values SEPARATELY for each path through
 * conditionals. This provides more precise results at the cost of
 * potentially exponential analysis time.
 *
 * This is used when mode === 'path' or mode === 'full'.
 */

import type { CFG, BasicBlock } from './cfg-builder.js';
import type { DataFlowFact, PathConstraint, LatticeValue } from './types.js';

/**
 * Result of path-sensitive analysis.
 */
export interface PathSensitiveResult {
  /** Map of pathId -> (nodeId -> variable -> value) facts */
  paths: Map<string, Map<string, Map<string, LatticeValue>>>;
  /** Map of nodeId -> constraints that apply at that point */
  constraints: Map<string, PathConstraint[]>;
  /** Number of paths analyzed (for reporting) */
  pathCount: number;
}

/**
 * Path-sensitive analysis using symbolic execution.
 *
 * Tracks values separately for each distinct path through conditionals.
 * When a branch is encountered, both paths are explored with their
 * respective path constraints (assumptions).
 *
 * @param cfg - Control flow graph to analyze
 * @param maxDepth - Maximum depth to prevent exponential explosion
 * @param maxPaths - Maximum number of paths to analyze
 * @returns Path-sensitive analysis results
 */
export function analyzePathSensitive(
  cfg: CFG,
  maxDepth: number = 10,
  maxPaths: number = 1000,
): PathSensitiveResult {
  const paths = new Map<string, Map<string, Map<string, LatticeValue>>>();
  const constraints = new Map<string, PathConstraint[]>();
  let pathCount = 0;

  /**
   * Traverse a single path through the CFG.
   */
  function traverse(
    nodeId: string,
    pathId: string,
    facts: Map<string, LatticeValue>,
    pathConstraints: PathConstraint[],
    depth: number,
  ): void {
    // Stop conditions
    if (pathCount >= maxPaths) return;
    if (depth > maxDepth) return;

    const node = cfg.nodes.get(nodeId);
    if (!node) return;

    // Store facts for this path
    if (!paths.has(pathId)) {
      paths.set(pathId, new Map());
    }
    // Clone facts for this path (path-specific copy)
    const pathFacts = new Map(facts);
    paths.get(pathId)!.set(nodeId, new Map(pathFacts));

    // Store constraints at this node
    if (pathConstraints.length > 0) {
      constraints.set(nodeId, [...pathConstraints]);
    }

    // Check if this is a branch node
    if (node.isBranch) {
      // For branches, we explore both paths but with different constraints
      const branchConstraints = extractConstraintsFromNode(node, pathConstraints);

      for (const succ of node.successors) {
        // Check if successor indicates true/false branch
        if (succ.includes('true') || succ.includes('false')) {
          const isThenBranch = succ.includes('true');
          const newConstraints = isThenBranch
            ? [...branchConstraints.thenConstraints]
            : [...branchConstraints.elseConstraints];

          traverse(succ, `${pathId}:${isThenBranch ? 'T' : 'F'}`, pathFacts, newConstraints, depth + 1);
        } else {
          // Fallback: explore without constraint differentiation
          traverse(succ, `${pathId}:${succ}`, pathFacts, pathConstraints, depth + 1);
        }
      }
    } else if (node.successors.length > 0) {
      // Continue along single path
      for (const succ of node.successors) {
        traverse(succ, pathId, pathFacts, pathConstraints, depth + 1);
      }
    }

    pathCount++;
  }

  // Start from entry node
  traverse(cfg.entryNodeId, 'root', new Map(), [], 0);

  return { paths, constraints, pathCount };
}

/**
 * Extract path constraints from a branch node.
 */
function extractConstraintsFromNode(
  node: { basicBlock: string[]; isBranch?: boolean },
  existingConstraints: PathConstraint[],
): { thenConstraints: PathConstraint[]; elseConstraints: PathConstraint[] } {
  // Parse the condition from the basic block content
  // This is a simplified implementation
  const condition = node.basicBlock[0] ?? '';

  // Extract variable from condition (simplified)
  const varMatch = condition.match(/(\w+)\s*(===|!==|==|!=|<|>|<=|>=)/);
  const valueMatch = condition.match(/(?:===|!==|==|!=)\s*(\w+)/);

  if (varMatch && valueMatch) {
    const variable = varMatch[1];
    const value = valueMatch[1];
    const operator = varMatch[2];

    // Then branch: variable == value (condition is true)
    const thenConstraint: PathConstraint = {
      condition: `${variable} ${operator} ${value}`,
      variable,
      value,
    };

    // Else branch: variable != value (negated condition)
    const elseConstraint: PathConstraint = {
      condition: `${variable} ${negateOperator(operator)} ${value}`,
      variable,
      value,
    };

    return {
      thenConstraints: [...existingConstraints, thenConstraint],
      elseConstraints: [...existingConstraints, elseConstraint],
    };
  }

  // If we can't parse, both branches get the same constraints
  return {
    thenConstraints: existingConstraints,
    elseConstraints: existingConstraints,
  };
}

/**
 * Negate a comparison operator for else-branch constraints.
 */
function negateOperator(op: string): string {
  const negationMap: Record<string, string> = {
    '===': '!==',
    '!==': '===',
    '==': '!=',
    '!=': '==',
    '<': '>=',
    '>': '<=',
    '<=': '>',
    '>=': '<',
  };
  return negationMap[op] ?? op;
}

/**
 * Check if a value satisfies the path constraints.
 *
 * @param value - Lattice value to check
 * @param constraints - Path constraints to validate against
 * @returns true if value satisfies all constraints
 */
export function satisfiesConstraints(
  value: LatticeValue,
  constraints: PathConstraint[],
): boolean {
  // Simplified: in a real implementation, we would evaluate
  // the symbolic constraints against the concrete value
  if (value === 'UNINIT') return false;
  if (constraints.length === 0) return true;
  // For now, we accept CONSTANT and SANITIZED as satisfying constraints
  return value === 'CONSTANT' || value === 'SANITIZED';
}

/**
 * Merge path-specific facts at a join point.
 *
 * When multiple paths converge (e.g., after an if-else), we need
 * to merge the facts from each path using the lattice join operation.
 */
export function mergePathFacts(
  pathFacts: Map<string, LatticeValue>[],
  join: (a: LatticeValue, b: LatticeValue) => LatticeValue,
): Map<string, LatticeValue> {
  if (pathFacts.length === 0) return new Map();
  if (pathFacts.length === 1) return new Map(pathFacts[0]);

  const result = new Map<string, LatticeValue>();
  const allVariables = new Set<string>();

  // Collect all variables from all paths
  for (const facts of pathFacts) {
    for (const [variable] of facts) {
      allVariables.add(variable);
    }
  }

  // Join each variable across paths
  for (const variable of allVariables) {
    let value: LatticeValue = 'UNINIT';
    for (const facts of pathFacts) {
      const pathValue = facts.get(variable) ?? 'UNINIT';
      value = join(value, pathValue);
    }
    result.set(variable, value);
  }

  return result;
}
