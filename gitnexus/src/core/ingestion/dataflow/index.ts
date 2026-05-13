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

import { readFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { ResolutionContext } from '../model/resolution-context.js';
import type { CommunityMembership } from '../community-processor.js';
import { buildCFGFromStatements, cfgToResult, parseStatements } from './cfg-builder.js';
import { buildCFGFromTSG, isTSGAvailable } from './cfg-from-tsg.js';
import { analyzeForward, createDefaultContext } from './dfa-engine.js';
import { analyzeTaint } from './taint-engine.js';
import { analyzePathSensitive, type PathSensitiveResult } from './path-sensitive.js';
import { detectChangedFunctions, getTransitiveDependencies } from './incremental.js';
import type { LatticeValue } from './types.js';
import { loadParser, isLanguageAvailable } from '../../tree-sitter/parser-loader.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import type { SupportedLanguages } from 'gitnexus-shared';
import {
  writeDataFlowEdges,
  writeTaintPaths,
  writeCFGEdges,
  clearDataFlowEdges,
  type DataFlowEdge,
} from './storage-writer.js';
import type { TaintPath } from './types.js';

// ── Options ────────────────────────────────────────────────────────────────

export interface DataflowOptions {
  /** Analysis mode - affects precision and performance */
  mode: 'off' | 'base' | 'full';
  /** Enable incremental analysis (only re-analyze changed functions) */
  incremental: boolean;
  /** Skip general data flow, only do taint analysis */
  taintOnly: boolean;
  /** Maximum functions to analyze (for context-sensitive, limits explosion) */
  maxFunctions?: number;
  /** Repository path for incremental analysis (required when incremental=true) */
  repoPath?: string;
}

const DEFAULT_OPTIONS: DataflowOptions = {
  mode: 'base',
  incremental: false,
  taintOnly: false,
  maxFunctions: 1000,
};

// ── Path-Sensitive Result Conversion ─────────────────────────────────────

/**
 * Convert path-sensitive result to merged lattice facts.
 * Takes the most precise value for each variable at each node across all paths.
 */
function convertPathSensitiveResult(
  pathResult: PathSensitiveResult,
): Map<string, Map<string, LatticeValue>> {
  const merged = new Map<string, Map<string, LatticeValue>>();
  for (const [_pathId, nodeFacts] of pathResult.paths) {
    for (const [nodeId, variableFacts] of nodeFacts) {
      if (!merged.has(nodeId)) merged.set(nodeId, new Map());
      const existing = merged.get(nodeId)!;
      for (const [variable, value] of variableFacts) {
        const current = existing.get(variable);
        if (!current || valuePriority(current) < valuePriority(value)) {
          existing.set(variable, value);
        }
      }
    }
  }
  return merged;
}

/**
 * Priority for lattice value merge decisions (higher = more precise).
 */
function valuePriority(v: LatticeValue): number {
  const priorities: Record<LatticeValue, number> = {
    CONSTANT: 4,
    TAINTED: 3,
    SANITIZED: 3,
    NAC: 2,
    UNINIT: 1,
  };
  return priorities[v] ?? 0;
}

// ── CFG Result Conversion ─────────────────────────────────────────────────

import type { CFGResult } from './types.js';

/**
 * Convert CFGResult (array-based, from buildCFG) to CFG (Map-based).
 * The DFA engine expects the legacy Map-based format.
 */
function convertCFGResultToCFG(result: CFGResult): import('./types.js').CFG {
  const nodes = new Map<string, import('./types.js').CFGNode>();
  for (const node of result.nodes) {
    nodes.set(node.id, node);
  }
  // entryNodeId: use first node's id as the entry point
  const entryNodeId = result.nodes[0]?.id ?? `${result.functionId}:bb:0`;
  return {
    functionId: result.functionId,
    nodes,
    entryNodeId,
    exitNodeId: result.nodes[result.nodes.length - 1]?.id ?? entryNodeId,
  };
}

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
  _resolutionContext?: ResolutionContext,
  _memberships?: CommunityMembership[],
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
      const startLine = (node.properties.startLine as number | undefined) ?? 1;
      const endLine = (node.properties.endLine as number | undefined) ?? startLine;
      functions.push({
        id: node.id,
        filePath: node.properties.filePath ?? '',
        content: readSourceFile(
          node.properties.filePath ?? '',
          opts.repoPath ?? '',
          startLine,
          endLine,
        ),
      });
    }
  });

  onProgress?.(`Analyzing ${functions.length} functions...`, 10);

  // Filter to affected functions in incremental mode
  let functionsToAnalyze = functions;
  if (opts.incremental && opts.repoPath) {
    try {
      const { affectedFunctions, changedFiles } = await detectChangedFunctions(
        opts.repoPath,
        knowledgeGraph,
      );
      if (changedFiles.length === 0) {
        onProgress?.('No changes detected, skipping dataflow analysis', 100);
        return; // Exit early, nothing to do
      }
      const transitiveDeps = getTransitiveDependencies(knowledgeGraph, affectedFunctions);
      const affectedSet = new Set([...affectedFunctions, ...transitiveDeps]);
      functionsToAnalyze = functions.filter((f) => affectedSet.has(f.id));
      onProgress?.(`Incremental: analyzing ${functionsToAnalyze.length} affected functions`, 10);
    } catch (e) {
      throw new Error(`Incremental analysis failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Limit analysis to prevent state explosion (only 'full' mode benefits from limiting)
  const maxFunctions = opts.maxFunctions ?? 1000;
  functionsToAnalyze =
    opts.mode === 'full' ? functionsToAnalyze.slice(0, maxFunctions) : functionsToAnalyze;

  // Build mapping from CFG node ID to graph Function node ID
  // CFG nodes are like "Function:/path:funcName:bb:0", graph nodes like "Function:/path:funcName"
  // We map CFG node IDs to the parent Function node by stripping ":bb:N" suffix
  const cfgToGraphNode = new Map<string, string>();
  for (const func of functions) {
    // CFG nodes are func.id + ":bb:N", map them back to func.id
    cfgToGraphNode.set(func.id + ':bb:0', func.id);
    cfgToGraphNode.set(func.id + ':bb:', func.id); // Will be used as prefix
  }

  const allEdges: DataFlowEdge[] = [];
  const allTaintPaths: TaintPath[] = [];

  function mapCfgNodeToGraphNode(cfgNodeId: string): string | null {
    // First try exact match
    if (cfgToGraphNode.has(cfgNodeId)) {
      return cfgToGraphNode.get(cfgNodeId)!;
    }
    // Then try prefix match: check if any stored prefix matches the start of cfgNodeId
    const colonBBIndex = cfgNodeId.lastIndexOf(':bb:');
    if (colonBBIndex > 0) {
      const funcId = cfgNodeId.substring(0, colonBBIndex);
      // Check if this funcId has a prefix mapping
      if (cfgToGraphNode.has(funcId + ':bb:')) {
        return funcId;
      }
    }
    return null;
  }

  // Probe TSG availability once (check CLI + DSL files)
  let tsgAvailable: { cli: boolean; dsl: Record<string, boolean> } | null = null;
  try {
    tsgAvailable = isTSGAvailable();
  } catch {
    /* TSG not installed */
  }

  const useTSG = tsgAvailable !== null && tsgAvailable.cli;
  const parser = useTSG ? await loadParser() : null;

  // Process functions in batches to avoid memory issues
  const BATCH_SIZE = 100;
  for (let i = 0; i < functionsToAnalyze.length; i += BATCH_SIZE) {
    const batch = functionsToAnalyze.slice(i, i + BATCH_SIZE);

    for (const func of batch) {
      const lang = detectLanguage(func.filePath) as SupportedLanguages;
      // Build CFG from function source (tree-sitter if language is available, else legacy)
      let cfg: import('./types.js').CFG;
      if (useTSG && isLanguageAvailable(lang) && tsgAvailable?.dsl[lang.toLowerCase()]) {
        try {
          const { loadLanguage } = await import('../../tree-sitter/parser-loader.js');
          await loadLanguage(lang);
          const source = func.content.join('\n');
          const tree = parseSourceSafe(parser!, source);
          const cfgResult = buildCFGFromTSG({ rootNode: tree.rootNode }, source, lang, func.id);
          cfg = convertCFGResultToCFG(cfgResult);
        } catch (err) {
          // TSG failed — fall through to legacy
          const statements = parseStatements(func.id, func.content);
          cfg = buildCFGFromStatements(func.id, statements);
        }
      } else {
        const statements = parseStatements(func.id, func.content);
        cfg = buildCFGFromStatements(func.id, statements);
      }

      // Create analysis context
      const context = createDefaultContext(cfg);

      // Run DFA (unless taint-only mode)
      if (!opts.taintOnly) {
        let resultFacts: Map<string, Map<string, LatticeValue>>;

        if (opts.mode === 'full') {
          // Path-sensitive analysis: tracks values per-path, more precise
          const pathResult = analyzePathSensitive(cfg, 10, 1000);
          resultFacts = convertPathSensitiveResult(pathResult);
        } else {
          // Standard flow-sensitive analysis
          const result = analyzeForward(context);
          resultFacts = result.facts;
        }

        let edgesCreated = 0;
        for (const [nodeId, nodeFacts] of resultFacts) {
          const cfgNode = cfg.nodes.get(nodeId);
          if (!cfgNode || cfgNode.id === cfg.entryNodeId) continue;
          for (const [variable, value] of nodeFacts) {
            if (value === 'UNINIT' || value === 'NAC') continue;
            for (const predId of cfgNode.predecessors) {
              const predFacts = resultFacts.get(predId);
              // Create edge for data flow from predecessor to current node
              const graphSourceId = mapCfgNodeToGraphNode(predId);
              const graphTargetId = mapCfgNodeToGraphNode(nodeId);
              if (graphSourceId && graphTargetId) {
                allEdges.push({
                  sourceId: graphSourceId,
                  targetId: graphTargetId,
                  type: 'DATA_FLOW',
                  properties: {
                    sourceVariable: variable,
                    targetVariable: variable,
                    confidence: 0.8,
                    reason: `DFA: ${variable} = ${value} (from ${predId} → ${nodeId})`,
                  },
                });
                edgesCreated++;
              }
            }
          }
        }
      }

      // Run taint analysis
      const taintResult = analyzeTaint(cfg, context, lang);
      allTaintPaths.push(...(taintResult.paths as TaintPath[]));
    }

    const progress =
      10 + (90 * Math.min(i + BATCH_SIZE, functionsToAnalyze.length)) / functionsToAnalyze.length;
    onProgress?.(
      `Processed ${Math.min(i + BATCH_SIZE, functionsToAnalyze.length)}/${functionsToAnalyze.length} functions...`,
      progress,
    );

    // Yield to event loop to prevent blocking
    await new Promise((resolve) => setImmediate(resolve));
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

// ── Source File Reader ──────────────────────────────────────────────────────

/**
 * Read source file and return as line array.
 * Resolves relative paths against repoPath.
 */
function readSourceFile(
  filePath: string,
  repoPath: string,
  startLine?: number,
  endLine?: number,
): string[] {
  try {
    const absPath = isAbsolute(filePath) ? filePath : join(repoPath, filePath);
    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    if (startLine == null || endLine == null) return lines;
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    return lines.slice(start, end);
  } catch {
    return [];
  }
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
  // Map deprecated mode names to new names
  const modeAliasMap: Record<string, string> = {
    basic: 'base',
    context: 'base',
    path: 'base',
  };
  const mappedMode = modeAliasMap[mode ?? ''] ?? mode;
  if (mappedMode === 'off' || mappedMode === 'base' || mappedMode === 'full') {
    return {
      mode: mappedMode,
      incremental: flags.incremental === true,
      taintOnly: flags.taintOnly === true,
    };
  }

  return { mode: 'base' };
}

// ── CFG Construction ────────────────────────────────────────────────────────

/**
 * Phase 12 (CFG): Build Control Flow Graphs for all functions and write CFG_EDGE edges.
 *
 * Routes to buildCFGFromTSG (tree-sitter-graph DSL) when available,
 * falling back to the legacy buildCFGFromStatements (text-based).
 *
 * @param knowledgeGraph - The knowledge graph
 * @param onProgress - Progress callback
 */
export async function processCFG(
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
): Promise<void> {
  onProgress?.('Building control flow graphs...', 0);

  const functions: Array<{ id: string; filePath: string; content: string[] }> = [];

  knowledgeGraph.forEachNode((node) => {
    if (node.label === 'Function' || node.label === 'Method') {
      functions.push({
        id: node.id,
        filePath: node.properties.filePath ?? '',
        content: readSourceFile(node.properties.filePath ?? '', ''),
      });
    }
  });

  // Probe TSG availability once (check CLI + DSL files)
  let tsgAvailable: { cli: boolean; dsl: Record<string, boolean> } | null = null;
  try {
    tsgAvailable = isTSGAvailable();
  } catch {
    /* TSG not installed */
  }

  const useTSG = tsgAvailable !== null && tsgAvailable.cli;
  const parser = useTSG ? await loadParser() : null;

  onProgress?.(`Building CFGs for ${functions.length} functions...`, 10);

  const BATCH_SIZE = 100;
  for (let i = 0; i < functions.length; i += BATCH_SIZE) {
    const batch = functions.slice(i, i + BATCH_SIZE);

    for (const func of batch) {
      const lang = detectLanguage(func.filePath) as SupportedLanguages;
      const source = func.content.join('\n');

      if (useTSG && isLanguageAvailable(lang) && tsgAvailable?.dsl[lang.toLowerCase()]) {
        try {
          const { loadLanguage } = await import('../../tree-sitter/parser-loader.js');
          await loadLanguage(lang);
          const tree = parseSourceSafe(parser!, source);
          const cfgResult = buildCFGFromTSG({ rootNode: tree.rootNode }, source, lang, func.id);
          writeCFGEdges(knowledgeGraph, cfgResult);
          continue;
        } catch (err) {
          // TSG failed (CLI error, parse error, etc.) — fall through to legacy
          // console.warn(`TSG failed for ${func.id}, falling back:`, err);
        }
      }
      // Legacy path
      const statements = parseStatements(func.id, func.content);
      const cfg = buildCFGFromStatements(func.id, statements);
      writeCFGEdges(knowledgeGraph, cfgToResult(cfg));
    }

    const progress = 10 + (90 * Math.min(i + BATCH_SIZE, functions.length)) / functions.length;
    onProgress?.(
      `CFG: ${Math.min(i + BATCH_SIZE, functions.length)}/${functions.length} functions...`,
      progress,
    );

    await new Promise((resolve) => setImmediate(resolve));
  }

  onProgress?.(`CFG construction complete. ${functions.length} functions processed.`, 100);
}
