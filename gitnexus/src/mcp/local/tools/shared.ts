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
