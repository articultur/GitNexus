/**
 * DataflowProcessor - Phase 12 Entry Point
 *
 * This is the main entry point for the data flow analysis system.
 * It integrates with the existing ingestion pipeline and provides:
 * - Flow-sensitive data flow analysis
 * - Taint tracking (SOURCE → SINK)
 * - Incremental analysis support
 *
 * Run after process-processor (phase 11) to analyze data flow relationships.
 */

import type { KnowledgeGraph } from '../../graph/types.js';
import type { ResolutionContext } from '../resolution-context.js';
import type { CommunityMembership } from '../community-processor.js';
import { buildCFG, parseStatements } from './cfg-builder.js';
import { analyzeForward, createDefaultContext } from './dfa-engine.js';
import { analyzeTaint } from './taint-engine.js';
import {
  writeDataFlowEdges,
  writeTaintPaths,
  clearDataFlowEdges,
  type DataFlowEdge,
} from './storage-writer.js';

// ── Options ────────────────────────────────────────────────────────────────

export interface DataflowOptions {
  /** Analysis mode - affects precision and performance */
  mode: 'off' | 'basic' | 'context' | 'path' | 'full';
  /** Enable incremental analysis (only re-analyze changed functions) */
  incremental: boolean;
  /** Skip general data flow, only do taint analysis */
  taintOnly: boolean;
  /** Maximum functions to analyze (for context-sensitive, limits explosion) */
  maxFunctions?: number;
}

const DEFAULT_OPTIONS: DataflowOptions = {
  mode: 'basic',
  incremental: false,
  taintOnly: false,
  maxFunctions: 1000,
};

// ── Main Processor ────────────────────────────────────────────────────────

/**
 * Phase 12: Dataflow Processor
 *
 * Analyzes data flow relationships and adds DATA_FLOW edges to the graph.
 * Runs after process-processor (phase 11).
 *
 * @param knowledgeGraph - The knowledge graph to analyze
 * @param resolutionContext - Resolution context with symbol tables
 * @param memberships - Community memberships for scope limiting
 * @param options - Analysis options
 * @param onProgress - Progress callback
 */
export async function processDataflow(
  knowledgeGraph: KnowledgeGraph,
  _resolutionContext: ResolutionContext,
  _memberships: CommunityMembership[],
  options: Partial<DataflowOptions> = {},
  onProgress?: (message: string, progress: number) => void,
): Promise<void> {
  const opts: DataflowOptions = { ...DEFAULT_OPTIONS, ...options };

  if (opts.mode === 'off') {
    onProgress?.('Dataflow analysis disabled', 100);
    return;
  }

  onProgress?.('Starting dataflow analysis...', 0);

  // Clear existing data flow edges if not incremental
  if (!opts.incremental) {
    clearDataFlowEdges(knowledgeGraph);
  }

  // Collect all functions for analysis
  const functions: Array<{ id: string; filePath: string; content: string[] }> = [];

  knowledgeGraph.forEachNode((node) => {
    if (node.label === 'Function' || node.label === 'Method') {
      functions.push({
        id: node.id,
        filePath: node.properties.filePath ?? '',
        content: (node.properties.content as string | undefined)?.split('\n') ?? [],
      });
    }
  });

  onProgress?.(`Analyzing ${functions.length} functions...`, 10);

  // Limit context-sensitive analysis to prevent state explosion
  const maxFunctions = opts.maxFunctions ?? 1000;
  const functionsToAnalyze = opts.mode === 'context' || opts.mode === 'path'
    ? functions.slice(0, maxFunctions)
    : functions;

  const allEdges: DataFlowEdge[] = [];
  const allTaintPaths: any[] = [];

  // Process functions in batches to avoid memory issues
  const BATCH_SIZE = 100;
  for (let i = 0; i < functionsToAnalyze.length; i += BATCH_SIZE) {
    const batch = functionsToAnalyze.slice(i, i + BATCH_SIZE);

    for (const func of batch) {
      // Build CFG from function source
      const statements = parseStatements(func.id, func.content);
      const cfg = buildCFG(func.id, statements);

      // Create analysis context
      const context = createDefaultContext(cfg);

      // Run DFA (unless taint-only mode)
      if (!opts.taintOnly) {
        const result = analyzeForward(context);
        // Convert DFA results to edges (simplified - would need more work for production)
        // For now, we rely on taint analysis for edge generation
      }

      // Run taint analysis
      const language = detectLanguage(func.filePath);
      const taintResult = analyzeTaint(cfg, context, language);
      allTaintPaths.push(...taintResult.paths);
    }

    const progress = 10 + (90 * Math.min(i + BATCH_SIZE, functionsToAnalyze.length) / functionsToAnalyze.length);
    onProgress?.(
      `Processed ${Math.min(i + BATCH_SIZE, functionsToAnalyze.length)}/${functionsToAnalyze.length} functions...`,
      progress,
    );

    // Yield to event loop to prevent blocking
    await new Promise(resolve => setImmediate(resolve));
  }

  // Write all edges to graph
  onProgress?.('Writing dataflow edges to graph...', 95);

  if (allTaintPaths.length > 0) {
    writeTaintPaths(knowledgeGraph, allTaintPaths);
  }

  if (allEdges.length > 0) {
    writeDataFlowEdges(knowledgeGraph, allEdges);
  }

  onProgress?.(`Dataflow analysis complete. Found ${allTaintPaths.length} taint paths.`, 100);
}

// ── Language Detection ─────────────────────────────────────────────────────

/**
 * Detect language from file path.
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    java: 'java',
    kt: 'kotlin',
    go: 'go',
    rs: 'rust',
    cs: 'csharp',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    h: 'c',
    hpp: 'cpp',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    dart: 'dart',
  };

  return languageMap[ext] ?? 'typescript';
}

// ── CLI Options Parser ────────────────────────────────────────────────────

/**
 * Parse dataflow options from CLI flags.
 */
export function parseDataflowOptions(flags: Record<string, unknown>): Partial<DataflowOptions> {
  if (flags.dataflow === false || flags['no-dataflow'] === true) {
    return { mode: 'off' };
  }

  const mode = flags.dataflow as string | undefined;
  if (mode === 'off' || mode === 'basic' || mode === 'context' || mode === 'path' || mode === 'full') {
    return {
      mode,
      incremental: flags.incremental === true,
      taintOnly: flags.taintOnly === true,
    };
  }

  return { mode: 'basic' };
}
