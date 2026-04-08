/**
 * Bug Detection — Rule DSL Types
 *
 * Defines the rule schema for the missing-code detection engine.
 * Rules describe patterns where code *should* exist but doesn't
 * (missing guards, unchecked returns, leaked resources).
 */

import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

// ── Severity ────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low';

// ── Language Scope ──────────────────────────────────────────────────────────

export type LanguageScope =
  | '*' // All languages
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'kotlin'
  | 'go'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'objc'
  | 'swift'
  | 'ruby'
  | 'php'
  | 'dart';

// ── Rule Patterns ───────────────────────────────────────────────────────────

/**
 * A pattern that matches a code structure in the graph.
 * Uses graph node/relationship properties and labels.
 */
export interface PatternMatcher {
  /** Node labels to match (Function, Method, etc.) */
  nodeLabel?: string[];
  /** Relationship types that must be present (e.g., CALLS to a known-failing function) */
  hasRelationships?: {
    type: string;
    targetLabel?: string;
    targetNamePattern?: string; // regex
  }[];
  /** Relationship types that must be absent (e.g., no if/try guard) */
  missingRelationships?: {
    type: string;
    targetLabel?: string;
    targetNamePattern?: string;
  }[];
  /** Node property conditions (e.g., content contains a pattern) */
  propertyConditions?: {
    property: string;
    operator: 'contains' | 'not_contains' | 'matches' | 'equals';
    value: string;
  }[];
}

// ── Rule Definition ─────────────────────────────────────────────────────────

export interface RuleDefinition {
  /** Unique rule identifier (e.g., "detection:missing-guard") */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this rule detects and why it matters */
  description: string;
  /** Severity if triggered */
  severity: Severity;
  /** Default confidence (0-1) when triggered */
  confidence: number;
  /** Languages this rule applies to */
  languages: LanguageScope[];
  /** Pattern that identifies trigger points */
  trigger: PatternMatcher;
  /** Pattern that, if absent, indicates a bug */
  missing: PatternMatcher;
  /** How to extract evidence from a match */
  evidenceExtractor?: EvidenceExtractor;
}

// ── Evidence ────────────────────────────────────────────────────────────────

export interface Evidence {
  /** What was found (e.g., "file open call without try/finally") */
  description: string;
  /** Symbol that triggered the rule */
  symbolId: string;
  symbolName: string;
  /** File path */
  filePath: string;
  /** Line range if available */
  lineRange?: { start: number; end: number };
  /** Related symbols (e.g., the function being called without a guard) */
  relatedSymbols?: Array<{
    id: string;
    name: string;
    relationship: string;
  }>;
}

// ── Detection Result ────────────────────────────────────────────────────────

export interface DetectionResult {
  /** Which rule triggered */
  ruleId: string;
  /** Human-readable message */
  message: string;
  /** Symbol where the issue was found */
  symbolName: string;
  symbolId: string;
  /** File path */
  filePath: string;
  /** Severity level */
  severity: Severity;
  /** Confidence (0-1), may differ from rule default based on context */
  confidence: number;
  /** Evidence supporting this finding */
  evidence: Evidence[];
}

// ── Rule Function Types ─────────────────────────────────────────────────────

/**
 * Context provided to a rule during evaluation.
 * Contains the subgraph relevant to the symbol being checked.
 */
export interface RuleContext {
  /** The node being analyzed */
  node: GraphNode;
  /** All relationships where this node is the source */
  outgoingRelationships: GraphRelationship[];
  /** All relationships where this node is the target */
  incomingRelationships: GraphRelationship[];
  /** Resolved target nodes for outgoing relationships (keyed by relationship id) */
  outgoingTargets: Map<string, GraphNode>;
  /** Language detected from file path */
  language: string;
}

/**
 * Custom evidence extractor — allows rules to produce rich evidence
 * beyond the default pattern-matching approach.
 */
export type EvidenceExtractor = (ctx: RuleContext) => Evidence[];

// ── Rule Registration ───────────────────────────────────────────────────────

/**
 * A rule ready for the engine — wraps the definition with an evaluate function.
 */
export interface Rule {
  definition: RuleDefinition;
  evaluate: (ctx: RuleContext) => DetectionResult | null;
}
