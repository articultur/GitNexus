/**
 * Lattice theory implementation for data flow analysis.
 *
 * Lattice ordering:
 *
 *         TOP (NAC - Not A Constant)
 *        /    |    \
 *   UNINIT   ...   ...
 *        \    |    /
 *      BOTTOM (CONSTANT) ... (TAINTED) ... (SANITIZED)
 *
 * NAC = No Information (Top) - most imprecise, joins all paths
 * UNINIT = Uninitialized (Bottom) - most precise, no value yet
 *
 * Key operations:
 * - join(a, b): Least upper bound (LUB) - combines facts from different paths
 * - meet(a, b): Greatest lower bound (GLB) - intersection of facts
 * - propagate(value): Transfer function for assignments
 */

import type { LatticeValue } from './types.js';

/**
 * Lattice order mapping for comparison.
 * Higher number = higher in lattice (more imprecise).
 */
export const LATTICE_ORDER: Record<LatticeValue, number> = {
  UNINIT: 0, // BOTTOM - lowest, most precise
  CONSTANT: 1,
  SANITIZED: 2,
  TAINTED: 2, // TAINTED and SANITIZED are at same level
  NAC: 3, // TOP - highest, most imprecise
};

/**
 * Join (Least Upper Bound) - combines facts from different paths.
 * Used at merge points (e.g., after if/else branches).
 *
 * Rules:
 * - UNINIT join x = x (UNINIT is bottom)
 * - NAC join x = NAC (NAC is top)
 * - Same value join same value = same value
 * - Different non-bottom/non-top values join = NAC (lost precision)
 */
export function join(a: LatticeValue, b: LatticeValue): LatticeValue {
  if (a === 'UNINIT') return b;
  if (b === 'UNINIT') return a;
  if (a === 'NAC' || b === 'NAC') return 'NAC';
  if (a === 'CONSTANT' && b === 'CONSTANT') return 'CONSTANT';
  // Same taint/sanitized value joins to itself
  if (a === b) return a;
  // TAINTED | SANITIZED → NAC (lost precision when merged)
  return 'NAC';
}

/**
 * Meet (Greatest Lower Bound) - intersection of facts.
 * Used when we need both conditions to hold simultaneously.
 *
 * Rules:
 * - NAC meet x = x (NAC is top)
 * - UNINIT meet x = UNINIT (UNINIT is bottom)
 * - Same value meet same value = same value
 * - Different values meet = NAC (inconsistent)
 */
export function meet(a: LatticeValue, b: LatticeValue): LatticeValue {
  if (a === 'NAC') return b;
  if (b === 'NAC') return a;
  if (a === 'UNINIT' || b === 'UNINIT') return 'UNINIT';
  if (a === b) return a;
  // CONSTANT meet TAINTED = NAC (inconsistent)
  return 'NAC';
}

/**
 * Check if lattice value a is less than or equal to b.
 * Returns true if a is more precise than b.
 */
export function isLessOrEqual(a: LatticeValue, b: LatticeValue): boolean {
  return LATTICE_ORDER[a] <= LATTICE_ORDER[b];
}

/**
 * Check if a value is tainted (has taint from untrusted source).
 */
export function isTainted(value: LatticeValue): boolean {
  return value === 'TAINTED';
}

/**
 * Check if a value has been sanitized (cleaned of taint).
 */
export function isSanitized(value: LatticeValue): boolean {
  return value === 'SANITIZED';
}

/**
 * Check if a value is NAC (No Information / Unknown).
 */
export function isNAC(value: LatticeValue): boolean {
  return value === 'NAC';
}

/**
 * Check if a value is uninitialized.
 */
export function isUninit(value: LatticeValue): boolean {
  return value === 'UNINIT';
}

/**
 * Propagate lattice value through assignment (transfer function).
 *
 * Rules:
 * - UNINIT propagates as UNINIT (not yet assigned)
 * - NAC propagates as NAC (unknown value)
 * - CONSTANT propagates as CONSTANT (known value)
 * - TAINTED and SANITIZED propagate as themselves
 */
export function propagate(value: LatticeValue): LatticeValue {
  if (value === 'UNINIT') return 'UNINIT';
  if (value === 'NAC') return 'NAC';
  if (value === 'CONSTANT') return 'CONSTANT';
  // TAINTED and SANITIZED propagate unchanged
  return value;
}

/**
 * Meet with flow sensitivity - for if/else branches.
 *
 * At a branch point, both paths are analyzed independently.
 * After the branch, the values are joined (using flowSensitiveMeet).
 *
 * Example:
 *   if (cond) { x = source() } else { x = sanitize(y) }
 *   then branch: x = TAINTED, else branch: x = SANITIZED
 *   after if: join(TAINTED, SANITIZED) = NAC
 */
export function flowSensitiveMeet(thenValue: LatticeValue, elseValue: LatticeValue): LatticeValue {
  return join(thenValue, elseValue);
}

/**
 * Get the bottom value (UNINIT).
 */
export function bottom(): LatticeValue {
  return 'UNINIT';
}

/**
 * Get the top value (NAC).
 */
export function top(): LatticeValue {
  return 'NAC';
}
