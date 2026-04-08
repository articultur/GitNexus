/**
 * Shared utilities, types, and constants used across local backend tool modules.
 */

import type { RegistryEntry } from '../../../storage/repo-manager.js';

export interface RepoHandle {
  id: string; // unique key = repo name (basename)
  name: string;
  repoPath: string;
  storagePath: string;
  lbugPath: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RegistryEntry['stats'];
}

/** Shared params for impact analysis methods */
export interface ImpactParams {
  target: string;
  direction: 'upstream' | 'downstream';
  maxDepth?: number;
  relationTypes?: string[];
  includeTests?: boolean;
  minConfidence?: number;
  /** When false, omit the `evidence` block from the response. Default: true */
  include_evidence?: boolean;
  /** When true, include source code content for each impacted symbol. */
  include_content?: boolean;
  /** File path to filter impact results to a specific file. */
  file_path?: string;
}

/**
 * Quick test-file detection for filtering impact results.
 * Matches common test file patterns across all supported languages.
 */
export function isTestFilePath(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.includes('__tests__/') ||
    p.includes('__mocks__/') ||
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/testing/') ||
    p.includes('/fixtures/') ||
    p.endsWith('_test.go') ||
    p.endsWith('_test.py') ||
    p.endsWith('_spec.rb') ||
    p.endsWith('_test.rb') ||
    p.includes('/spec/') ||
    p.includes('/test_') ||
    p.includes('/conftest.')
  );
}

/** Valid LadybugDB node labels for safe Cypher query construction */
export const VALID_NODE_LABELS = new Set([
  'File',
  'Folder',
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Community',
  'Process',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
  'Route',
  'Tool',
]);

/** Valid relation types for impact analysis filtering */
export const VALID_RELATION_TYPES = new Set([
  'CALLS',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'METHOD_OVERRIDES',
  'OVERRIDES', // Legacy alias — dual-read for pre-rename indexes
  'METHOD_IMPLEMENTS',
  'ACCESSES',
  'HANDLES_ROUTE',
  'FETCHES',
  'HANDLES_TOOL',
  'ENTRY_POINT_OF',
  'WRAPS',
  'DATA_FLOW',
  'TAINTED',
  'SINK_REACHABLE',
  'PROPAGATES',
  'RETURNS',
  'SANITIZES',
  'ALIASES',
]);

/**
 * Per-relation-type confidence floor for impact analysis.
 */
export const IMPACT_RELATION_CONFIDENCE: Readonly<Record<string, number>> = {
  CALLS: 0.9,
  IMPORTS: 0.9,
  EXTENDS: 0.85,
  IMPLEMENTS: 0.85,
  METHOD_OVERRIDES: 0.85,
  METHOD_IMPLEMENTS: 0.85,
  HAS_METHOD: 0.95,
  HAS_PROPERTY: 0.95,
  ACCESSES: 0.8,
  CONTAINS: 0.95,
  DATA_FLOW: 0.75,
  TAINTED: 0.7,
  SINK_REACHABLE: 0.7,
  PROPAGATES: 0.75,
  RETURNS: 0.85,
  SANITIZES: 0.7,
  ALIASES: 0.8,
};

/**
 * Return the confidence floor for a given relation type.
 * Falls back to 0.5 for unknown types so they are not silently elevated.
 */
export const confidenceForRelType = (relType: string | undefined): number =>
  IMPACT_RELATION_CONFIDENCE[relType ?? ''] ?? 0.5;

/** Filter and normalize relation types for impact analysis. Returns defaults if none survive. */
export const filterRelationTypes = (raw?: string[]): string[] => {
  const filtered = raw && raw.length > 0 ? raw.filter((t) => VALID_RELATION_TYPES.has(t)) : [];
  return filtered.length > 0 ? filtered : ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
};

/** Structured error logging for query failures — replaces empty catch blocks */
export function logQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`GitNexus [${context}]: ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Impact Scoring Model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of the unified impact scoring calculation.
 * Used by both impact.ts and detect.ts tools for consistent risk assessment.
 */
export interface ImpactScoreResult {
  /** Overall impact score normalized to 0-100 */
  score: number;
  /** Risk level derived from score thresholds */
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Confidence in the score based on data completeness (0-1) */
  confidence: number;
  /** Top contributing factors to the score (max 5) */
  top_contributors: Array<{
    symbol: string;
    contribution: number;
    reason: string;
  }>;
  /** Breakdown of score components */
  score_breakdown: {
    direct_impact: number;
    process_impact: number;
    module_impact: number;
    total_impact: number;
  };
}

/**
 * Input item for computing top contributors.
 * Represents a single impacted symbol with its metadata.
 */
export interface ImpactedItem {
  /** Depth in the impact graph (1 = direct, 2+ = transitive) */
  depth: number;
  /** Type of relationship (e.g., CALLS, IMPORTS) */
  relationType: string;
  /** Confidence of the relationship (0-1) */
  confidence: number;
  /** Symbol name */
  name: string;
}

/**
 * Compute a unified impact score for use across impact analysis tools.
 *
 * The scoring formula uses weighted dimensions:
 * - directCount: weight 2.0 (direct callers/importers are most impactful)
 * - processCount: weight 1.5 (affected processes indicate flow disruption)
 * - moduleCount: weight 1.0 (module spread indicates architectural impact)
 * - totalCount: weight 0.5 with logarithmic scaling (captures blast radius)
 *
 * Risk thresholds:
 * - score >= 80: CRITICAL
 * - score >= 50: HIGH
 * - score >= 25: MEDIUM
 * - score < 25: LOW
 *
 * @param params - Input parameters for score computation
 * @returns Normalized impact score result with risk level and breakdown
 */
export function computeImpactScore(params: {
  directCount: number;
  processCount: number;
  moduleCount: number;
  totalCount: number;
  impactedItems?: ImpactedItem[];
  direction?: 'upstream' | 'downstream';
}): ImpactScoreResult {
  const { directCount, processCount, moduleCount, totalCount, impactedItems, direction } = params;

  // Weights for each dimension
  const WEIGHTS = {
    direct: 2.0,
    process: 1.5,
    module: 1.0,
    total: 0.5,
  };

  // Calculate raw scores for each dimension
  // Direct impact: linear scaling, capped at 50 for normalization
  const directRaw = Math.min(directCount * WEIGHTS.direct, 50);
  const direct_impact = directRaw;

  // Process impact: linear scaling, capped at 30 for normalization
  const processRaw = Math.min(processCount * WEIGHTS.process, 30);
  const process_impact = processRaw;

  // Module impact: linear scaling, capped at 20 for normalization
  const moduleRaw = Math.min(moduleCount * WEIGHTS.module, 20);
  const module_impact = moduleRaw;

  // Total impact: logarithmic scaling to handle large blast radii gracefully
  // log1p(totalCount) * weight * scaling factor to fit 0-100 range
  const totalRaw = Math.log1p(totalCount) * WEIGHTS.total * 10;
  const total_impact = Math.min(totalRaw, 30);

  // Normalize to 0-100 scale
  // Max possible raw score is 50 + 30 + 20 + 30 = 130
  const rawSum = direct_impact + process_impact + module_impact + total_impact;
  const score = Math.min(Math.round((rawSum / 130) * 100), 100);

  // Determine risk level based on thresholds
  let risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  if (score >= 80) {
    risk = 'CRITICAL';
  } else if (score >= 50) {
    risk = 'HIGH';
  } else if (score >= 25) {
    risk = 'MEDIUM';
  } else {
    risk = 'LOW';
  }

  // Calculate confidence based on data completeness
  // - Base confidence starts at 0.5 (counts alone give moderate confidence)
  // - If impactedItems provided, boost confidence up to 1.0 based on:
  //   - Number of items with depth=1 (direct impacts are well-understood)
  //   - Average confidence of relationships
  let confidence = 0.5;
  const top_contributors: ImpactScoreResult['top_contributors'] = [];

  if (impactedItems && impactedItems.length > 0) {
    // Count items by depth
    const directItems = impactedItems.filter((item) => item.depth === 1);
    const hasDirectItems = directItems.length > 0;

    // Calculate average confidence
    const avgConfidence =
      impactedItems.reduce((sum, item) => sum + item.confidence, 0) / impactedItems.length;

    // Confidence boost: up to 0.4 for having detailed item data
    // - 0.2 for having direct items (got the blast radius right)
    // - 0.2 * avgConfidence for relationship quality
    const directBoost = hasDirectItems ? 0.2 : 0;
    const qualityBoost = 0.2 * avgConfidence;
    confidence = Math.min(0.5 + directBoost + qualityBoost, 1.0);

    // Calculate top contributors
    // Contribution formula: weighted by depth and confidence
    // - Depth 1 items contribute more (direct impact means WILL BREAK)
    // - Higher confidence relationships contribute more
    const contributorScores = new Map<string, { score: number; reason: string }>();

    for (const item of impactedItems) {
      const depthWeight = item.depth === 1 ? 1.0 : item.depth === 2 ? 0.5 : 0.25;
      const contribution = depthWeight * item.confidence * WEIGHTS.direct;

      // Get existing score or create new entry
      const existing = contributorScores.get(item.name);
      if (existing) {
        existing.score += contribution;
      } else {
        // Build reason string
        let reason: string;
        if (item.depth === 1) {
          reason =
            direction === 'upstream'
              ? `Direct caller via ${item.relationType}`
              : `Direct callee via ${item.relationType}`;
        } else if (item.depth === 2) {
          reason =
            direction === 'upstream'
              ? `Indirect caller (depth ${item.depth}) via ${item.relationType}`
              : `Indirect callee (depth ${item.depth}) via ${item.relationType}`;
        } else {
          reason = `Transitive dependency (depth ${item.depth}) via ${item.relationType}`;
        }

        contributorScores.set(item.name, { score: contribution, reason });
      }
    }

    // Sort by contribution and take top 5
    const sortedContributors = Array.from(contributorScores.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 5);

    for (const [symbol, data] of sortedContributors) {
      top_contributors.push({
        symbol,
        contribution: Math.round(data.score * 100) / 100,
        reason: data.reason,
      });
    }
  }

  return {
    score,
    risk,
    confidence: Math.round(confidence * 100) / 100,
    top_contributors,
    score_breakdown: {
      direct_impact: Math.round(direct_impact * 100) / 100,
      process_impact: Math.round(process_impact * 100) / 100,
      module_impact: Math.round(module_impact * 100) / 100,
      total_impact: Math.round(total_impact * 100) / 100,
    },
  };
}

// =============================================================================
// StandardEvidence Schema and Types
// =============================================================================

/** A single path segment in evidence, showing a relationship between two symbols */
export interface EvidencePath {
  from: { id: string; name: string; filePath?: string };
  to: { id: string; name: string; filePath?: string };
  relation: string;
}

/** A critical edge that significantly contributes to confidence scoring */
export interface EvidenceCriticalEdge {
  source: string;
  target: string;
  type: string;
  confidence: number;
}

/** Standardized evidence structure used by all impact analysis tools */
export interface StandardEvidence {
  explanation: string;
  paths: EvidencePath[];
  critical_edges: EvidenceCriticalEdge[];
  confidence_breakdown: Record<string, number>;
  exclusions?: string[];
}

/** Builder interface for incrementally constructing StandardEvidence */
export interface EvidenceBuilder {
  addExplanation(text: string): void;
  addPath(from: EvidencePath['from'], to: EvidencePath['to'], relation: string): void;
  addCriticalEdge(source: string, target: string, type: string, confidence: number): void;
  addConfidenceFactor(factor: string, value: number): void;
  addExclusion(reason: string): void;
  build(): StandardEvidence;
}

/**
 * Factory function to create an EvidenceBuilder instance.
 * The builder accumulates data incrementally, deduplicates paths and edges,
 * calculates overall confidence from breakdown, and generates explanation if not provided.
 */
export function createEvidenceBuilder(): EvidenceBuilder {
  let explanation = '';
  const paths: EvidencePath[] = [];
  const criticalEdges: EvidenceCriticalEdge[] = [];
  const confidenceBreakdown: Record<string, number> = {};
  const exclusions: string[] = [];

  // Helper to create a unique key for path deduplication
  const pathKey = (from: EvidencePath['from'], to: EvidencePath['to'], relation: string): string =>
    `${from.id}|${to.id}|${relation}`;

  // Helper to create a unique key for edge deduplication
  const edgeKey = (source: string, target: string, type: string): string =>
    `${source}|${target}|${type}`;

  // Track seen keys for deduplication
  const seenPaths = new Set<string>();
  const seenEdges = new Set<string>();

  return {
    addExplanation(text: string): void {
      // Append to existing explanation with proper spacing
      if (explanation) {
        explanation += ' ' + text;
      } else {
        explanation = text;
      }
    },

    addPath(from: EvidencePath['from'], to: EvidencePath['to'], relation: string): void {
      const key = pathKey(from, to, relation);
      if (!seenPaths.has(key)) {
        seenPaths.add(key);
        paths.push({ from, to, relation });
      }
    },

    addCriticalEdge(source: string, target: string, type: string, confidence: number): void {
      const key = edgeKey(source, target, type);
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        criticalEdges.push({ source, target, type, confidence });
      }
    },

    addConfidenceFactor(factor: string, value: number): void {
      // Clamp confidence value to valid range [0, 1]
      confidenceBreakdown[factor] = Math.max(0, Math.min(1, value));
    },

    addExclusion(reason: string): void {
      if (!exclusions.includes(reason)) {
        exclusions.push(reason);
      }
    },

    build(): StandardEvidence {
      // Generate auto-explanation if none was provided
      if (!explanation) {
        const edgeCount = criticalEdges.length;
        const pathCount = paths.length;

        if (pathCount === 0 && edgeCount === 0) {
          explanation = 'No direct impact paths found.';
        } else if (pathCount > 0 && edgeCount === 0) {
          explanation = `Found ${pathCount} impact path${pathCount === 1 ? '' : 's'} via relationship analysis.`;
        } else if (pathCount === 0 && edgeCount > 0) {
          explanation = `Found ${edgeCount} critical edge${edgeCount === 1 ? '' : 's'} indicating potential impact.`;
        } else {
          explanation = `Found ${pathCount} impact path${pathCount === 1 ? '' : 's'} and ${edgeCount} critical edge${edgeCount === 1 ? '' : 's'}.`;
        }
      }

      // Build the result object
      const result: StandardEvidence = {
        explanation,
        paths: [...paths],
        critical_edges: [...criticalEdges],
        confidence_breakdown: { ...confidenceBreakdown },
      };

      // Only include exclusions if there are any
      if (exclusions.length > 0) {
        result.exclusions = [...exclusions];
      }

      return result;
    },
  };
}
