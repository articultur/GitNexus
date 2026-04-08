/**
 * Test-impact analysis — find test files that cover changed symbols.
 *
 * Returns a three-layer priority classification:
 * - must_run: depth=1 AND covers signature/implementation changes
 * - should_run: depth<=3 OR same module strong relation
 * - can_skip: deep chains (depth>3), pure doc changes, weak relation chains
 */

import { executeParameterized } from '../../../core/lbug/pool-adapter.js';
import {
  logQueryError,
  isTestFilePath,
  createEvidenceBuilder,
  type StandardEvidence,
} from './shared.js';
import type { RepoHandle } from './shared.js';
import { getDiffHunks, lineRangeOverlapsHunk } from './git-diff-parser.js';

// =============================================================================
// Three-Layer Priority Types
// =============================================================================

/** A single test recommendation with priority classification */
interface TestRecommendation {
  test_file: string;
  test_name?: string;
  reason: string;
  confidence: number;
  covered_symbols: string[];
  evidence?: StandardEvidence;
}

/** Result structure with three-layer priority classification */
interface TestImpactResult {
  must_run: TestRecommendation[];
  should_run: TestRecommendation[];
  can_skip: TestRecommendation[];
  summary: {
    must_run_count: number;
    should_run_count: number;
    can_skip_count: number;
    total_tests: number;
  };
  // Legacy fields for backward compatibility
  test_files?: Array<{
    path: string;
    hit_symbols: Array<{ id: string; name: string; kind: string; depth: number }>;
    hit_count: number;
    min_depth: number;
  }>;
  total_test_files?: number;
  seed_symbols?: Array<{ id: string; name: string; filePath: string }>;
  suggested_tests?: string[];
  summary_text?: string;
  error?: string;
}

// =============================================================================
// Priority Classification
// =============================================================================

/** Change types that indicate signature/implementation modifications */
const SIGNATURE_CHANGE_TYPES = new Set([
  'signature_change',
  'implementation_change',
  'parameter_change',
  'return_type_change',
  'visibility_change',
  'breaking_change',
]);

/** Change types that are documentation-only */
const DOC_CHANGE_TYPES = new Set(['doc_change', 'comment_change', 'whitespace_change']);

/**
 * Classify a test into one of three priority levels based on impact characteristics.
 *
 * Priority rules:
 * - must_run: depth=1 AND covers signature/implementation changes (WILL BREAK)
 * - should_run: depth<=3 OR same module strong relation (LIKELY AFFECTED)
 * - can_skip: deep chains (depth>3), pure doc changes, weak relation chains (LOW RISK)
 */
function classifyTestPriority(params: {
  depth: number;
  changeTypes: Set<string>;
  sameModule: boolean;
  confidence: number;
}): 'must_run' | 'should_run' | 'can_skip' {
  const { depth, changeTypes, sameModule, confidence } = params;

  // Check if there are any signature/implementation changes
  const changeTypesArray = Array.from(changeTypes);
  const hasSignatureChange = changeTypesArray.some((t) => SIGNATURE_CHANGE_TYPES.has(t));
  const isDocOnly = changeTypes.size > 0 && changeTypesArray.every((t) => DOC_CHANGE_TYPES.has(t));

  // must_run: Direct caller (depth=1) with signature changes
  if (depth === 1 && hasSignatureChange) {
    return 'must_run';
  }

  // can_skip: Deep chains or doc-only changes
  if (depth > 3 || isDocOnly || (depth > 2 && confidence < 0.7)) {
    return 'can_skip';
  }

  // should_run: depth<=3 OR same module with strong relation
  if (depth <= 3 || (sameModule && confidence >= 0.8)) {
    return 'should_run';
  }

  // Default to can_skip for weak relation chains
  return 'can_skip';
}

/**
 * Generate a human-readable reason for the priority classification.
 */
function buildPriorityReason(
  priority: 'must_run' | 'should_run' | 'can_skip',
  depth: number,
  changeTypes: Set<string>,
  sameModule: boolean,
  confidence: number,
): string {
  const changeTypesArray = Array.from(changeTypes);
  const hasSignatureChange = changeTypesArray.some((t) => SIGNATURE_CHANGE_TYPES.has(t));
  const isDocOnly = changeTypes.size > 0 && changeTypesArray.every((t) => DOC_CHANGE_TYPES.has(t));

  switch (priority) {
    case 'must_run':
      return `Direct caller (depth=1) covering ${
        hasSignatureChange ? 'signature/implementation' : 'critical'
      } changes. This test WILL BREAK if changes are incorrect.`;

    case 'should_run':
      if (sameModule && confidence >= 0.8) {
        return `Same-module test with strong relation (confidence=${confidence.toFixed(2)}). Likely affected by changes.`;
      }
      return `Indirect dependency at depth ${depth}. Test may reveal integration issues.`;

    case 'can_skip':
      if (depth > 3) {
        return `Deep dependency chain (depth=${depth}>3). Low risk of immediate breakage.`;
      }
      if (isDocOnly) {
        return 'Covers documentation-only changes. Unlikely to affect behavior.';
      }
      return `Weak relation chain (confidence=${confidence.toFixed(2)} < 0.7 at depth ${depth}). Low priority.`;
  }
}

export async function testImpactTool(
  repo: RepoHandle,
  params: {
    target?: string;
    changes?: string[];
    scope?: string;
    base_ref?: string;
    maxDepth?: number;
    minConfidence?: number;
    /** Include full evidence for each test recommendation. Default: true */
    include_evidence?: boolean;
  },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<TestImpactResult> {
  await ensureInitialized(repo.id);

  const maxDepth = params.maxDepth ?? 5;
  const minConfidence = params.minConfidence ?? 0;
  const includeEvidence = params.include_evidence ?? true;

  // ── Step 1: Collect seed node IDs ──────────────────────────────────────
  const seedIds: string[] = [];
  const seedSymbols: Array<{ id: string; name: string; filePath: string }> = [];

  const addNodeRows = (rows: any[]): void => {
    for (const r of rows) {
      const id: string = r.id ?? r[0] ?? '';
      const name: string = r.name ?? r[1] ?? '';
      const fp: string = r.filePath ?? r[2] ?? '';
      if (id && !seedIds.includes(id)) {
        seedIds.push(id);
        seedSymbols.push({ id, name, filePath: fp });
      }
    }
  };

  if (params.target) {
    // Treat as file-path hint when it contains path separators or extension dots
    const looksLikePath =
      params.target.includes('/') || params.target.includes('\\') || params.target.includes('.');
    const rows = await executeParameterized(
      repo.id,
      looksLikePath
        ? `MATCH (n) WHERE n.filePath CONTAINS $target
           RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT 50`
        : `MATCH (n) WHERE n.name = $target
           RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT 10`,
      { target: params.target },
    ).catch(() => []);
    addNodeRows(rows);
  } else if (params.changes && params.changes.length > 0) {
    for (const sym of params.changes) {
      const rows = await executeParameterized(
        repo.id,
        `MATCH (n) WHERE n.name = $sym
         RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT 5`,
        { sym },
      ).catch(() => []);
      addNodeRows(rows);
    }
  } else if (params.scope) {
    // Use hunk-level mapping via getDiffHunks (aligns with detect.ts for precision)
    const validScope = params.scope as 'unstaged' | 'staged' | 'all' | 'compare';
    if (!['unstaged', 'staged', 'all', 'compare'].includes(validScope)) {
      return {
        error: `Invalid scope: ${params.scope}. Must be one of: unstaged, staged, all, compare`,
      } as any;
    }
    let scopeDiffHunks: Awaited<ReturnType<typeof getDiffHunks>>;
    try {
      scopeDiffHunks = await getDiffHunks(
        repo.repoPath,
        validScope,
        validScope === 'compare' ? params.base_ref : undefined,
      );
    } catch (err: any) {
      return { error: `Git diff failed: ${err.message}` } as any;
    }

    for (const fileHunk of scopeDiffHunks) {
      const normalizedFile = fileHunk.filePath.replace(/\\/g, '/');
      // Skip test files themselves — we want files that TEST the changed files
      if (isTestFilePath(normalizedFile)) continue;

      // Query symbols with line ranges so we can do hunk-level overlap filtering
      const symbols = await executeParameterized(
        repo.id,
        `MATCH (n)
         WHERE n.filePath CONTAINS $filePath
           AND n.startLine IS NOT NULL
           AND n.endLine IS NOT NULL
         RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
                n.startLine AS startLine, n.endLine AS endLine
         LIMIT 50`,
        { filePath: normalizedFile },
      ).catch(() => []);

      for (const sym of symbols) {
        const id: string = sym.id ?? sym[0] ?? '';
        const name: string = sym.name ?? sym[1] ?? '';
        const fp: string = sym.filePath ?? sym[2] ?? '';
        const startLine: number = sym.startLine ?? sym[3];
        const endLine: number = sym.endLine ?? sym[4];

        // Only seed symbols whose line range overlaps with a changed hunk
        const overlaps = fileHunk.hunks.some((hunk) =>
          lineRangeOverlapsHunk(startLine, endLine, hunk),
        );
        if (!overlaps) continue;

        if (id && !seedIds.includes(id)) {
          seedIds.push(id);
          seedSymbols.push({ id, name, filePath: fp });
        }
      }
    }
  } else {
    return { error: 'Provide target, changes, or scope to identify which symbols changed.' } as any;
  }

  if (seedIds.length === 0) {
    return {
      must_run: [],
      should_run: [],
      can_skip: [],
      summary: {
        must_run_count: 0,
        should_run_count: 0,
        can_skip_count: 0,
        total_tests: 0,
      },
      test_files: [],
      total_test_files: 0,
      seed_symbols: [],
      suggested_tests: [],
      summary_text:
        'No indexed symbols found for the given input. Run `npx gitnexus analyze` to refresh the index.',
    } as any;
  }

  // Get seed symbol modules for same-module detection
  const seedModules = new Set(
    seedSymbols.map((s) => {
      const parts = s.filePath.split('/');
      return parts.length > 1 ? parts.slice(0, -1).join('/') : s.filePath;
    }),
  );

  // ── Step 2: BFS upstream (CALLS + IMPORTS) to find test callers ──────────
  const TRAVERSAL_TYPES = [
    'CALLS',
    'IMPORTS',
    'EXTENDS',
    'IMPLEMENTS',
    'METHOD_OVERRIDES',
    'OVERRIDES',
    'METHOD_IMPLEMENTS',
  ];
  const relTypeFilter = TRAVERSAL_TYPES.map((t) => `r.type = '${t}'`).join(' OR ');

  const visited = new Set<string>(seedIds);
  let frontier = [...seedIds];

  // Enhanced test file tracking with full metadata
  interface TestHitInfo {
    hit_symbols: Array<{
      id: string;
      name: string;
      kind: string;
      depth: number;
      confidence: number;
      relationType: string;
    }>;
    min_depth: number;
    max_confidence: number;
    same_module: boolean;
    change_types: Set<string>;
  }

  const testFileMap = new Map<string, TestHitInfo>();

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    try {
      const related = await executeParameterized(
        repo.id,
        `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN $ids AND (${relTypeFilter}) AND r.confidence >= $minConf
         RETURN caller.id AS id, caller.name AS name, labels(caller)[0] AS kind, caller.filePath AS filePath, r.type AS relationType, r.confidence AS confidence`,
        { ids: frontier, minConf: minConfidence },
      ).catch(() => []);

      for (const rel of related) {
        const relId: string = rel.id ?? rel[0] ?? '';
        const name: string = rel.name ?? rel[1] ?? '';
        const kind: string = rel.kind ?? rel[2] ?? '';
        const filePath: string = rel.filePath ?? rel[3] ?? '';
        const relationType: string = rel.relationType ?? rel[4] ?? 'CALLS';
        const confidence: number = rel.confidence ?? rel[5] ?? 0.9;

        if (!relId || visited.has(relId)) continue;
        visited.add(relId);
        nextFrontier.push(relId);

        if (filePath && isTestFilePath(filePath)) {
          // Check if test is in same module as any seed symbol
          const testModule = filePath.split('/').slice(0, -1).join('/');
          const sameModule = seedModules.has(testModule);

          if (!testFileMap.has(filePath)) {
            testFileMap.set(filePath, {
              hit_symbols: [],
              min_depth: depth,
              max_confidence: confidence,
              same_module: sameModule,
              change_types: new Set(),
            });
          }
          const entry = testFileMap.get(filePath)!;
          entry.min_depth = Math.min(entry.min_depth, depth);
          entry.max_confidence = Math.max(entry.max_confidence, confidence);
          entry.same_module = entry.same_module || sameModule;
          entry.hit_symbols.push({ id: relId, name, kind, depth, confidence, relationType });

          // Infer change types from relation type and depth
          if (depth === 1 && (relationType === 'CALLS' || relationType === 'IMPORTS')) {
            entry.change_types.add('signature_change');
          } else if (relationType === 'EXTENDS' || relationType === 'IMPLEMENTS') {
            entry.change_types.add('implementation_change');
          }
        }
      }
    } catch (e) {
      logQueryError('test-impact:bfs', e);
      break;
    }
    frontier = nextFrontier;
  }

  // ── Step 3: Classify tests into priority tiers ─────────────────────────────────
  const mustRun: TestRecommendation[] = [];
  const shouldRun: TestRecommendation[] = [];
  const canSkip: TestRecommendation[] = [];

  for (const [testFile, info] of Array.from(testFileMap.entries())) {
    const priority = classifyTestPriority({
      depth: info.min_depth,
      changeTypes: info.change_types,
      sameModule: info.same_module,
      confidence: info.max_confidence,
    });

    const reason = buildPriorityReason(
      priority,
      info.min_depth,
      info.change_types,
      info.same_module,
      info.max_confidence,
    );

    const coveredSymbols = info.hit_symbols.map((s) => s.name);

    const recommendation: TestRecommendation = {
      test_file: testFile,
      reason,
      confidence: info.max_confidence,
      covered_symbols: coveredSymbols,
    };

    // Build evidence if requested
    if (includeEvidence) {
      const builder = createEvidenceBuilder();
      builder.addExplanation(reason);
      builder.addConfidenceFactor('max_relation_confidence', info.max_confidence);
      builder.addConfidenceFactor('same_module', info.same_module ? 1.0 : 0.0);
      builder.addConfidenceFactor(
        'min_depth',
        1.0 - Math.min(info.min_depth / maxDepth, 1.0) * 0.5,
      );

      // Add paths showing the coverage chain
      for (const hit of info.hit_symbols) {
        builder.addPath(
          { id: hit.id, name: hit.name },
          { id: 'seed', name: 'changed symbol' },
          hit.relationType,
        );
        builder.addCriticalEdge(hit.id, 'seed', hit.relationType, hit.confidence);
      }

      recommendation.evidence = builder.build();
    }

    switch (priority) {
      case 'must_run':
        mustRun.push(recommendation);
        break;
      case 'should_run':
        shouldRun.push(recommendation);
        break;
      case 'can_skip':
        canSkip.push(recommendation);
        break;
    }
  }

  // Sort each tier by confidence (descending) then depth (ascending)
  const sortByConfidence = (a: TestRecommendation, b: TestRecommendation) =>
    b.confidence - a.confidence;

  mustRun.sort(sortByConfidence);
  shouldRun.sort(sortByConfidence);
  canSkip.sort(sortByConfidence);

  // ── Step 4: Build legacy output for backward compatibility ─────────────────────────────
  const testFiles = Array.from(testFileMap.entries())
    .map(([path, info]) => ({
      path,
      hit_symbols: info.hit_symbols.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        depth: s.depth,
      })),
      hit_count: info.hit_symbols.length,
      min_depth: info.min_depth,
    }))
    .sort((a, b) => a.min_depth - b.min_depth || b.hit_count - a.hit_count);

  const suggestedTests = [...mustRun, ...shouldRun, ...canSkip].map((r) => r.test_file);

  // Build summary text
  const summaryText =
    testFiles.length === 0
      ? `No test files found that cover the changed symbols (BFS depth ${maxDepth}).`
      : `Found ${testFiles.length} test file(s) covering ${
          seedSymbols.length
        } changed symbol(s). Priority breakdown: ${mustRun.length} must-run, ${
          shouldRun.length
        } should-run, ${canSkip.length} can-skip.${
          mustRun.length > 0
            ? ` Run these first: ${mustRun
                .slice(0, 3)
                .map((f) => f.test_file)
                .join(', ')}.`
            : ''
        }`;

  return {
    // New three-layer priority output
    must_run: mustRun,
    should_run: shouldRun,
    can_skip: canSkip,
    summary: {
      must_run_count: mustRun.length,
      should_run_count: shouldRun.length,
      can_skip_count: canSkip.length,
      total_tests: testFileMap.size,
    },
    // Legacy fields for backward compatibility
    test_files: testFiles,
    total_test_files: testFiles.length,
    seed_symbols: seedSymbols,
    suggested_tests: suggestedTests,
    summary_text: summaryText,
  };
}
