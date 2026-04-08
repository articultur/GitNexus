/**
 * Bug Detection Module
 *
 * Re-exports the rule engine, types, and auto-registers built-in rules.
 */

export { RuleEngine, createEngine, buildRelationshipIndex } from './rule-engine.js';
export type { RelationshipIndex } from './rule-engine.js';
export { DiffDetector } from './diff-detector.js';
export type { RiskChange, ChangeType, RiskSeverity, GraphSnapshot } from './diff-detector.js';
export * from './types.js';
