/**
 * Detect changes tool — git-diff based impact analysis.
 * Uses line-level mapping for precise symbol detection and unified scoring.
 * Supports graceful degradation when diff exceeds buffer limits (ENOBUFS).
 */

import { executeParameterized } from '../../../core/lbug/pool-adapter.js';
import {
  logQueryError,
  type RepoHandle,
  computeImpactScore,
  createEvidenceBuilder,
  isTestFilePath,
  formatBytes,
  type DetectPrecision,
  type DegradedReason,
  type DegradationConfig,
} from './shared.js';
import {
  parseDiffWithDegradation,
  lineRangeOverlapsHunk,
  type DiffHunk,
  type DiffParseResult,
  type DiffParseOptions,
} from './git-diff-parser.js';

/** Change type classification for a symbol */
type ChangeType =
  | 'signature_change' // function/method signature affected
  | 'implementation_change' // body changed
  | 'doc_change' // only comments/docs
  | 'test_change' // in test file
  | 'meta_change'; // imports, exports, etc.

/**
 * Degraded mode response when diff exceeds buffer limits.
 * Returned instead of normal result when precision is symbol-level or file-level.
 */
export interface DegradedDetectResult {
  // Meta information
  truncated: true;
  precision: DetectPrecision;
  reason: DegradedReason;
  original_diff_size: number;

  // Statistics
  stats: {
    total_files: number;
    total_symbols: number;
    diff_size_bytes: number;
    diff_size_human: string;
  };

  // File-level information
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    oldPath?: string;

    // Symbol-level precision only
    symbols?: Array<{
      name: string;
      uid: string;
      type: string;
      line_start: number;
      line_end: number;
    }>;

    // Drill-down command
    drill_down?: {
      command: string;
      description: string;
    };
  }>;

  // User guidance
  suggestion: string;
  alternative_commands: string[];

  // Backward compatibility fields
  changed_files: string[];
  affected_symbols: Array<{ name: string; uid: string; file: string }>;
  execution_flows: [];
}

/**
 * Detect changes — git-diff based impact analysis.
 * Maps changed lines to indexed symbols, then finds affected processes.
 * Supports graceful degradation when diff exceeds buffer limits.
 */
export async function detectChangesTool(
  repo: RepoHandle,
  params: {
    scope?: string;
    base_ref?: string;
    /** When false, omit the `evidence` block from the response. Default: true */
    include_evidence?: boolean;
    /** When true, run bug detection rules on changed symbols. Default: false */
    enable_detection?: boolean;
    /** Maximum number of symbols to return per file. Default: 100 (was 20) */
    symbol_limit?: number;
    /** Filter to a specific file path for drill-down analysis */
    file?: string;
    /** Custom degradation thresholds */
    degradation_config?: DegradationConfig;
  },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);

  const scope = params.scope || 'unstaged';
  const include_evidence = params.include_evidence ?? true;
  const symbolLimit = params.symbol_limit ?? 100;

  // Validate scope
  const validScope = scope as 'unstaged' | 'staged' | 'all' | 'compare';
  if (!['unstaged', 'staged', 'all', 'compare'].includes(validScope)) {
    return { error: `Invalid scope: ${scope}. Must be one of: unstaged, staged, all, compare` };
  }

  // Build diff options with degradation support
  const diffOptions: DiffParseOptions = {
    repoPath: repo.repoPath,
    scope: validScope,
    baseRef: validScope === 'compare' ? params.base_ref : undefined,
    config: params.degradation_config,
    fileFilter: params.file,
  };

  // Get structured diff with degradation support
  let diffResult: DiffParseResult;
  try {
    diffResult = await parseDiffWithDegradation(diffOptions);
  } catch (err: any) {
    return { error: `Git diff failed: ${err.message}` };
  }

  // Handle degraded mode responses
  if (!diffResult.success || diffResult.precision !== 'normal') {
    return buildDegradedResponse(repo.id, diffResult, ensureInitialized, symbolLimit);
  }

  // Convert to DiffHunk format for backward compatibility with existing logic
  const diffHunks: DiffHunk[] = diffResult.files.map((file) => ({
    filePath: file.path,
    changeType: file.status,
    oldPath: file.oldPath,
    hunks: file.hunks || [],
  }));

  if (diffHunks.length === 0) {
    return {
      summary: {
        changed_count: 0,
        affected_count: 0,
        risk_level: 'none',
        message: 'No changes detected.',
      },
      changed_symbols: [],
      affected_processes: [],
    };
  }

  // Create evidence builder for structured evidence
  const evidenceBuilder = createEvidenceBuilder();
  evidenceBuilder.addExplanation(
    'Changed lines are mapped to indexed symbols via line range overlap, then expanded to processes through STEP_IN_PROCESS links.',
  );

  // Map changed hunks to indexed symbols with line-level precision
  const changedSymbols: Array<{
    id: string;
    name: string;
    type: string;
    filePath: string;
    change_type: ChangeType;
    changed_lines: Array<{ start: number; end: number }>;
    match_reason: string;
  }> = [];

  const fileMatches: Array<{
    filePath: string;
    changeType: DiffHunk['changeType'];
    hunks: number;
    symbols: any[];
  }> = [];

  // Track modules for scoring
  const affectedModules = new Set<string>();
  const allImpactedItems: Array<{
    depth: number;
    relationType: string;
    confidence: number;
    name: string;
  }> = [];

  for (const fileHunk of diffHunks) {
    const normalizedFile = fileHunk.filePath.replace(/\\/g, '/');

    // Extract module path (first two directory components or file name)
    const pathParts = normalizedFile.split('/');
    if (pathParts.length > 1) {
      affectedModules.add(pathParts.slice(0, 2).join('/'));
    } else {
      affectedModules.add(normalizedFile);
    }

    // Determine if this is a test file
    const isTestFile = isTestFilePath(normalizedFile);

    try {
      // Query symbols in the file that overlap with changed line ranges
      const symbols = await executeParameterized(
        repo.id,
        `
          MATCH (n)
          WHERE n.filePath CONTAINS $filePath
            AND n.startLine IS NOT NULL
            AND n.endLine IS NOT NULL
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath,
                 n.startLine AS startLine, n.endLine AS endLine, n.content AS content
          LIMIT $limit
        `,
        { filePath: normalizedFile, limit: symbolLimit },
      );

      const fileSymbols: any[] = [];
      const matchedSymbolIds = new Set<string>();

      for (const sym of symbols) {
        const id = sym.id || sym[0];
        const name = sym.name || sym[1];
        const type = sym.type || sym[2];
        const filePath = sym.filePath || sym[3];
        const startLine = sym.startLine || sym[4];
        const endLine = sym.endLine || sym[5];
        const content = sym.content || sym[6];

        // Find which hunks overlap with this symbol's line range
        const overlappingHunks = fileHunk.hunks.filter((hunk) =>
          lineRangeOverlapsHunk(startLine, endLine, hunk),
        );

        if (overlappingHunks.length === 0) {
          continue; // Symbol not affected by changes
        }

        // Compute changed line ranges
        const changedLines: Array<{ start: number; end: number }> = [];
        for (const hunk of overlappingHunks) {
          changedLines.push({ start: hunk.newStart, end: hunk.newEnd });
          // Track critical edges for evidence
          evidenceBuilder.addCriticalEdge(filePath, `${name}:${hunk.newStart}`, 'CONTAINS', 0.95);
        }

        // Classify change type
        const changeType = classifyChangeType(type, content, overlappingHunks, isTestFile);

        // Deduplicate symbols (may overlap multiple hunks)
        if (matchedSymbolIds.has(id)) {
          continue;
        }
        matchedSymbolIds.add(id);

        const symbolRecord = {
          id,
          name,
          type,
          filePath,
          change_type: changeType,
          changed_lines: changedLines,
          match_reason: `line range overlaps with ${overlappingHunks.length} hunk(s)`,
        };

        changedSymbols.push(symbolRecord);
        fileSymbols.push({
          id,
          name,
          type,
          change_type: changeType,
          changed_lines_count: changedLines.length,
        });

        // Add to impacted items for scoring
        allImpactedItems.push({
          depth: 1,
          relationType: 'CHANGED_IN',
          confidence: 0.95,
          name,
        });

        // Add path to evidence
        evidenceBuilder.addPath(
          { id: filePath, name: filePath },
          { id, name, filePath },
          'CHANGED_IN',
        );
      }

      fileMatches.push({
        filePath: normalizedFile,
        changeType: fileHunk.changeType,
        hunks: fileHunk.hunks.length,
        symbols: fileSymbols,
      });
    } catch (e) {
      logQueryError('detect-changes:file-symbols', e);
    }
  }

  // Find affected processes
  const affectedProcesses = new Map<
    string,
    {
      id: string;
      name: string;
      process_type: string | undefined;
      step_count: number | undefined;
      changed_steps: Array<{ symbol: string; step: number | undefined }>;
    }
  >();

  for (const sym of changedSymbols) {
    try {
      const procs = await executeParameterized(
        repo.id,
        `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.heuristicLabel AS label, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `,
        { nodeId: sym.id },
      );
      for (const proc of procs) {
        const pid = proc.pid || proc[0];
        if (!affectedProcesses.has(pid)) {
          affectedProcesses.set(pid, {
            id: pid,
            name: proc.label || proc[1],
            process_type: proc.processType || proc[2],
            step_count: proc.stepCount || proc[3],
            changed_steps: [],
          });
        }
        affectedProcesses.get(pid)!.changed_steps.push({
          symbol: sym.name,
          step: proc.step || proc[4],
        });

        // Add to evidence
        evidenceBuilder.addPath(
          { id: sym.id, name: sym.name, filePath: sym.filePath },
          { id: pid, name: proc.label || proc[1] },
          'STEP_IN_PROCESS',
        );
      }
    } catch (e) {
      logQueryError('detect-changes:process-lookup', e);
    }
  }

  const processCount = affectedProcesses.size;
  const moduleCount = affectedModules.size;
  const directCount = changedSymbols.length;
  const totalCount = directCount + processCount;

  // Use unified scoring
  const scoreResult = computeImpactScore({
    directCount,
    processCount,
    moduleCount,
    totalCount,
    impactedItems: allImpactedItems,
    direction: 'upstream', // detect changes is always upstream (what calls changed code)
  });

  // Map to lowercase risk for backward compatibility
  const risk = scoreResult.risk.toLowerCase() as 'low' | 'medium' | 'high' | 'critical';

  // Add confidence factors to evidence
  evidenceBuilder.addConfidenceFactor('line_level_mapping', 0.95);
  evidenceBuilder.addConfidenceFactor('hunk_overlap_detection', 0.9);
  evidenceBuilder.addConfidenceFactor('symbol_boundary_matching', 0.85);

  // ── Bug detection on changed symbols ────────────────────────────────
  let detection_findings: any[] | undefined;
  if (params.enable_detection && changedSymbols.length > 0) {
    try {
      const { RuleEngine } = await import('../../../core/detection/rule-engine.js');
      const { builtinRules } = await import('../../../core/detection/rules/index.js');
      const engine = new RuleEngine();
      for (const rule of builtinRules) engine.register(rule);

      const findings: any[] = [];
      for (const sym of changedSymbols) {
        // Fetch full node content for rule evaluation
        const rows = await executeParameterized(
          repo.id,
          `MATCH (n {id: $nodeId}) RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, n.filePath AS filePath, n.content AS content LIMIT 1`,
          { nodeId: sym.id },
        );
        if (!rows?.[0]?.content) continue;

        const row = rows[0];
        const ctx = {
          node: {
            id: row.id || row[0],
            label: (row.label || row[2]) as any,
            properties: {
              name: row.name || row[1],
              filePath: row.filePath || row[3],
              content: row.content || row[4],
            },
          },
          outgoingRelationships: [],
          incomingRelationships: [],
          outgoingTargets: new Map(),
          language: (row.filePath || row[3] || '').split('.').pop()?.toLowerCase() ?? '',
        };
        const results = engine.evaluateNode(ctx);
        findings.push(...results);
      }
      detection_findings = findings;
    } catch (e) {
      // Detection is best-effort — don't fail the whole detect_changes
      logQueryError('detect-changes:detection', e);
    }
  }

  // ── API Impact Hints (Phase 2b): detect Route nodes in changed files ────────
  // For any changed file that contains indexed Route nodes, surface lightweight
  // hints so callers can decide whether to invoke api_impact for full analysis.
  const apiImpactHints: Array<{
    route: string;
    handler_file: string;
    consumer_count: number;
    change_type: ChangeType;
    note: string;
  }> = [];

  if (changedSymbols.length > 0) {
    const changedFilePaths = [...new Set(changedSymbols.map((s) => s.filePath))];
    try {
      for (const fp of changedFilePaths) {
        const routeRows = await executeParameterized(
          repo.id,
          `
            MATCH (n:Route)
            WHERE n.filePath CONTAINS $filePath
            OPTIONAL MATCH (consumer)-[:CodeRelation {type: 'FETCHES'}]->(n)
            RETURN n.name AS route, n.filePath AS handlerFile, COUNT(DISTINCT consumer) AS consumerCount
            LIMIT 20
          `,
          { filePath: fp },
        ).catch(() => []);

        // Determine the most severe change_type in this file
        const fileSymbols = changedSymbols.filter((s) => s.filePath === fp);
        const SEVERITY: Record<ChangeType, number> = {
          signature_change: 4,
          implementation_change: 3,
          test_change: 1,
          meta_change: 2,
          doc_change: 0,
        };
        const worstChangeType = fileSymbols.reduce<ChangeType>(
          (worst, s) => (SEVERITY[s.change_type] > SEVERITY[worst] ? s.change_type : worst),
          'doc_change',
        );

        for (const row of routeRows) {
          const routeName = row.route ?? row[0];
          const handlerFile = row.handlerFile ?? row[1];
          const consumerCount = Number(row.consumerCount ?? row[2] ?? 0);
          if (!routeName) continue;
          apiImpactHints.push({
            route: routeName,
            handler_file: handlerFile ?? fp,
            consumer_count: consumerCount,
            change_type: worstChangeType,
            note:
              consumerCount > 0
                ? `${consumerCount} consumer(s) — run api_impact to check contract safety`
                : 'No known consumers — low risk, but verify route shape',
          });
        }
      }
    } catch (e) {
      logQueryError('detect-changes:api-impact-hints', e);
    }
  }

  // Build response with backward compatibility
  const changedFiles = diffHunks.map((h) => h.filePath);

  return {
    summary: {
      changed_count: changedSymbols.length,
      affected_count: processCount,
      changed_files: changedFiles.length,
      affected_modules: moduleCount,
      risk_level: risk,
      // New unified scoring
      score_v2: {
        score: scoreResult.score,
        risk: scoreResult.risk,
        confidence: scoreResult.confidence,
        score_breakdown: scoreResult.score_breakdown,
        top_contributors: scoreResult.top_contributors,
      },
      ...(detection_findings && { detection_count: detection_findings.length }),
      ...(apiImpactHints.length > 0 && { api_impact_hints_count: apiImpactHints.length }),
    },
    changed_symbols: changedSymbols,
    affected_processes: Array.from(affectedProcesses.values()),
    ...(apiImpactHints.length > 0 && { api_impact_hints: apiImpactHints }),
    ...(detection_findings && detection_findings.length > 0 && { detection_findings }),
    ...(include_evidence && {
      evidence: evidenceBuilder.build(),
      evidence_legacy: {
        explanation:
          'Changed files are matched to indexed symbols by file path, then expanded to processes through STEP_IN_PROCESS links.',
        changed_files: changedFiles,
        file_matches: fileMatches,
        process_matches: Array.from(affectedProcesses.values()),
      },
    }),
  };
}

/**
 * Classify the type of change based on symbol type, content, and hunks.
 */
function classifyChangeType(
  symbolType: string,
  content: string | undefined,
  hunks: DiffHunk['hunks'],
  isTestFile: boolean,
): ChangeType {
  // Test files always get test_change
  if (isTestFile) {
    return 'test_change';
  }

  // Check for meta changes (imports, exports, etc.)
  if (symbolType === 'Import' || symbolType === 'Export') {
    return 'meta_change';
  }

  // For functions, methods, classes - check if signature changed
  if (['Function', 'Method', 'Constructor'].includes(symbolType)) {
    // Heuristic: if first line of symbol is changed, likely signature
    const firstHunk = hunks[0];
    if (firstHunk) {
      // Check if first few lines (signature area) are affected
      const hasSignatureChange = firstHunk.lines.some(
        (line) =>
          line.type === 'removed' &&
          line.lineNumber <= 5 &&
          (line.content.includes('(') ||
            line.content.includes('function') ||
            line.content.includes('def ') ||
            line.content.includes('func ') ||
            line.content.includes('fn ')),
      );
      if (hasSignatureChange) {
        return 'signature_change';
      }
    }
    return 'implementation_change';
  }

  // Classes and interfaces
  if (['Class', 'Interface', 'Struct', 'Trait'].includes(symbolType)) {
    // Check for property/signature changes
    const hasSignatureChange = hunks.some((hunk) =>
      hunk.lines.some(
        (line) =>
          line.type === 'added' &&
          (line.content.trim().startsWith('public ') ||
            line.content.trim().startsWith('private ') ||
            line.content.trim().startsWith('def ') ||
            line.content.trim().startsWith('func ')),
      ),
    );
    if (hasSignatureChange) {
      return 'signature_change';
    }
    return 'implementation_change';
  }

  // Check for doc-only changes
  if (content) {
    const isDocOnly = hunks.every((hunk) =>
      hunk.lines.every(
        (line) =>
          line.type === 'context' ||
          line.content.trim().startsWith('*') ||
          line.content.trim().startsWith('//') ||
          line.content.trim().startsWith('#') ||
          line.content.trim().startsWith('"""') ||
          line.content.trim().startsWith("'''") ||
          line.content.trim().startsWith('/**') ||
          line.content.trim().startsWith('/*'),
      ),
    );
    if (isDocOnly) {
      return 'doc_change';
    }
  }

  // Default to implementation change
  return 'implementation_change';
}

/**
 * Build a degraded response when diff exceeds buffer limits.
 * Returns file-level or symbol-level information depending on precision.
 */
async function buildDegradedResponse(
  repoId: string,
  diffResult: DiffParseResult,
  ensureInitialized: (id: string) => Promise<void>,
  symbolLimit: number,
): Promise<DegradedDetectResult | { error: string }> {
  // Ensure LadybugDB is initialized for symbol queries
  await ensureInitialized(repoId);

  const totalFiles = diffResult.files.length;
  const diffSizeHuman = formatBytes(diffResult.diffSize);

  // Build suggestion based on precision
  let suggestion: string;
  let alternativeCommands: string[];

  if (diffResult.precision === 'symbol-level') {
    suggestion = `Diff too large for line-level analysis (${diffSizeHuman}). Showing all symbols in changed files. Use --file to analyze specific files.`;
    alternativeCommands = [
      'gitnexus detect_changes --file <path>  # Analyze a specific file',
      'gitnexus impact <symbol> --uid <uid>   # Check impact of a specific symbol',
    ];
  } else {
    suggestion = `Diff very large (${diffSizeHuman}). Showing file list only. Use --file to analyze specific files.`;
    alternativeCommands = [
      'gitnexus detect_changes --file <path>  # Analyze a specific file',
      'gitnexus impact <symbol> --uid <uid>   # Check impact of a specific symbol',
      'git log --oneline -20                   # See recent commits for context',
    ];
  }

  // Build file information
  const files: DegradedDetectResult['files'] = [];
  const affectedSymbols: Array<{ name: string; uid: string; file: string }> = [];
  let totalSymbols = 0;

  for (const file of diffResult.files) {
    const fileInfo: DegradedDetectResult['files'][number] = {
      path: file.path,
      status: file.status,
      oldPath: file.oldPath,
    };

    // For symbol-level precision, query symbols in each file
    if (diffResult.precision === 'symbol-level') {
      try {
        const symbols = await executeParameterized(
          repoId,
          `
            MATCH (n)
            WHERE n.filePath CONTAINS $filePath
              AND n.startLine IS NOT NULL
              AND n.endLine IS NOT NULL
            RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath,
                   n.startLine AS startLine, n.endLine AS endLine
            LIMIT $limit
          `,
          { filePath: file.path, limit: symbolLimit },
        );

        if (symbols.length > 0) {
          fileInfo.symbols = symbols.map((sym) => {
            const uid = sym.id || sym[0];
            const name = sym.name || sym[1];
            affectedSymbols.push({ name, uid, file: file.path });
            totalSymbols++;
            return {
              name,
              uid,
              type: sym.type || sym[2],
              line_start: sym.startLine || sym[4],
              line_end: sym.endLine || sym[5],
            };
          });

          // Add drill-down command for the first symbol
          if (fileInfo.symbols.length > 0) {
            const firstSym = fileInfo.symbols[0];
            fileInfo.drill_down = {
              command: `gitnexus impact ${firstSym.name} --uid ${firstSym.uid} --direction upstream`,
              description: `Analyze impact of ${firstSym.name} (exact match by UID)`,
            };
          }
        }
      } catch (e) {
        logQueryError('detect-changes:degraded-symbols', e);
      }
    }

    files.push(fileInfo);
  }

  return {
    truncated: true,
    precision: diffResult.precision,
    reason: diffResult.reason!,
    original_diff_size: diffResult.diffSize,
    stats: {
      total_files: totalFiles,
      total_symbols: totalSymbols,
      diff_size_bytes: diffResult.diffSize,
      diff_size_human: diffSizeHuman,
    },
    files,
    suggestion,
    alternative_commands: alternativeCommands,
    // Backward compatibility fields
    changed_files: diffResult.files.map((f) => f.path),
    affected_symbols: affectedSymbols,
    execution_flows: [],
  };
}
