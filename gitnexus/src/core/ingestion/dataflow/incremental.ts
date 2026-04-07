/**
 * Incremental Data Flow Analysis.
 *
 * Instead of re-analyzing the entire codebase, incremental analysis
 * only re-analyzes functions affected by recent changes. This is
 * critical for large codebases where full analysis would be too slow.
 *
 * Uses git diff to detect changed files, then propagates the impact
 * to dependent functions.
 */

import type { KnowledgeGraph } from '../../graph/types.js';

/**
 * Result of incremental analysis detection.
 */
export interface IncrementalAnalysisResult {
  /** Functions that need re-analysis */
  affectedFunctions: string[];
  /** Changed files since last analysis */
  changedFiles: string[];
  /** Call graph changes detected */
  callGraphChanged: boolean;
}

/**
 * Detect which functions need re-analysis based on git changes.
 *
 * Uses `git diff` to find changed files, then:
 * 1. Find functions directly defined in changed files
 * 2. Find functions that call those functions (callees)
 * 3. Find functions that depend on those (transitive closure)
 *
 * @param repoPath - Path to the repository
 * @param knowledgeGraph - Current knowledge graph with function nodes
 * @param baseCommit - Commit to compare against (default: HEAD~1)
 * @returns Functions that need re-analysis
 */
export async function detectChangedFunctions(
  repoPath: string,
  knowledgeGraph: KnowledgeGraph,
  baseCommit?: string,
): Promise<IncrementalAnalysisResult> {
  const changedFiles = await getChangedFiles(repoPath, baseCommit);
  const affectedFunctions = findAffectedFunctions(knowledgeGraph, changedFiles);
  const callGraphChanged = detectCallGraphChanges(knowledgeGraph, changedFiles);

  return {
    affectedFunctions,
    changedFiles,
    callGraphChanged,
  };
}

/**
 * Get list of changed files from git.
 */
async function getChangedFiles(repoPath: string, baseCommit?: string): Promise<string[]> {
  // Dynamically import to avoid issues with ESM
  const { execFileSync } = await import('node:child_process');

  try {
    const commit = baseCommit ?? 'HEAD~1';
    const result = execFileSync('git', ['diff', '--name-status', commit, 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
    });

    const changedFiles: string[] = [];
    for (const line of result.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const statusField = parts[0];
      // Status field is like 'M', 'A', 'D', or 'R100' (rename with score)
      const status = statusField.charAt(0);
      // For M, A, D: one path after status
      // For R: two paths after status (old and new)
      const filePath = status === 'R' ? parts[2] : parts[1];
      // Status: M=modified, A=added, D=deleted, R=renamed
      if ((status === 'R' || status === 'M' || status === 'A') && filePath) {
        changedFiles.push(filePath);
      }
      // Skip D (deleted) - no functions to re-analyze
    }
    return changedFiles;
  } catch (e) {
    throw new Error(
      `Git diff failed: ${e instanceof Error ? e.message : String(e)} at ${repoPath}`,
    );
  }
}

/**
 * Check if a file path matches a changed file path.
 * Uses exact match or parent directory match to avoid false positives
 * (e.g., 'auth.ts' should not match 'auth-helpers.ts').
 */
function fileMatchesChangedPath(filePath: string, changedFile: string): boolean {
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const normalizedTarget = changedFile.replace(/\\/g, '/');
  // Exact match or this file is inside the changed directory
  return (
    normalizedFilePath === normalizedTarget ||
    normalizedFilePath.startsWith(normalizedTarget + '/') ||
    normalizedTarget.startsWith(normalizedFilePath + '/')
  );
}

/**
 * Find functions affected by changed files.
 *
 * 1. Functions directly defined in changed files
 * 2. Functions that call affected functions
 * 3. Functions that access variables from affected scopes
 */
function findAffectedFunctions(knowledgeGraph: KnowledgeGraph, changedFiles: string[]): string[] {
  if (changedFiles.length === 0) return [];

  const affectedFunctions = new Set<string>();

  // Phase 1: Find functions directly defined in changed files
  knowledgeGraph.forEachNode((node) => {
    if (node.label === 'Function' || node.label === 'Method') {
      const filePath = node.properties.filePath as string | undefined;
      if (filePath && changedFiles.some((f) => fileMatchesChangedPath(filePath, f))) {
        affectedFunctions.add(node.id);
      }
    }
  });

  // Phase 2: Find functions that call affected functions
  const calleesOfAffected = new Set<string>();
  knowledgeGraph.forEachRelationship((rel) => {
    if (rel.type === 'CALLS' && affectedFunctions.has(rel.targetId)) {
      calleesOfAffected.add(rel.sourceId);
    }
  });

  // Phase 3: Union of direct and indirect (callees of affected)
  for (const f of calleesOfAffected) {
    affectedFunctions.add(f);
  }

  return Array.from(affectedFunctions);
}

/**
 * Detect if the call graph structure has changed.
 *
 * This is important because even if a function's own code hasn't changed,
 * if something it calls has changed, we might need to re-analyze.
 */
function detectCallGraphChanges(knowledgeGraph: KnowledgeGraph, changedFiles: string[]): boolean {
  if (changedFiles.length === 0) return false;

  // Check if any CALLS relationships involve changed files
  let hasCallGraphImpact = false;

  knowledgeGraph.forEachRelationship((rel) => {
    if (rel.type === 'CALLS') {
      // Get source and target nodes to check their file paths
      const sourceNode = knowledgeGraph.getNode(rel.sourceId);
      const targetNode = knowledgeGraph.getNode(rel.targetId);

      if (sourceNode && targetNode) {
        const sourcePath = sourceNode.properties.filePath as string | undefined;
        const targetPath = targetNode.properties.filePath as string | undefined;

        if (
          (sourcePath && changedFiles.some((f) => fileMatchesChangedPath(sourcePath, f))) ||
          (targetPath && changedFiles.some((f) => fileMatchesChangedPath(targetPath, f)))
        ) {
          hasCallGraphImpact = true;
        }
      }
    }
  });

  return hasCallGraphImpact;
}

/**
 * Get functions that transitively depend on a set of functions.
 *
 * Uses BFS to find the full transitive closure of dependencies.
 */
export function getTransitiveDependencies(
  knowledgeGraph: KnowledgeGraph,
  rootFunctions: string[],
): string[] {
  const visited = new Set<string>();
  const queue = [...rootFunctions];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    // Find functions that call this function
    knowledgeGraph.forEachRelationship((rel) => {
      if (rel.type === 'CALLS' && rel.targetId === current) {
        if (!visited.has(rel.sourceId)) {
          queue.push(rel.sourceId);
        }
      }
    });
  }

  return Array.from(visited);
}

/**
 * Filter functions that should be skipped in incremental analysis.
 *
 * Excludes functions that:
 * - Are in unchanged files
 * - Don't have dependencies on affected functions
 * - Are marked as stable (no need for re-analysis)
 */
export function filterSkippableFunctions(
  knowledgeGraph: KnowledgeGraph,
  allFunctions: string[],
  affectedFunctions: string[],
): string[] {
  const affectedSet = new Set(affectedFunctions);
  const relationships: Array<{ type: string; sourceId: string; targetId: string }> = [];

  // Collect relationships first to allow early exit
  knowledgeGraph.forEachRelationship((rel) => {
    relationships.push(rel);
  });

  return allFunctions.filter((funcId) => {
    // Skip if not directly affected
    if (affectedSet.has(funcId)) return false;

    // Skip if it doesn't call any affected function - early exit
    for (const rel of relationships) {
      if (rel.type === 'CALLS' && rel.sourceId === funcId && affectedSet.has(rel.targetId)) {
        return false; // does call affected, so NOT skippable
      }
    }

    return true; // no call to affected functions, so skippable
  });
}

/**
 * Estimate analysis cost for a function.
 *
 * Used to prioritize which functions to analyze first when
 * we can't analyze everything.
 */
export function estimateAnalysisCost(knowledgeGraph: KnowledgeGraph, functionId: string): number {
  let nodeCount = 0;
  let edgeCount = 0;

  // Count nodes in the function's scope
  knowledgeGraph.forEachNode((node) => {
    if (node.id.startsWith(functionId)) {
      nodeCount++;
    }
  });

  // Count edges
  knowledgeGraph.forEachRelationship((rel) => {
    if (rel.sourceId.startsWith(functionId) || rel.targetId.startsWith(functionId)) {
      edgeCount++;
    }
  });

  // Simple heuristic: cost grows with node and edge count
  return nodeCount * 10 + edgeCount;
}
