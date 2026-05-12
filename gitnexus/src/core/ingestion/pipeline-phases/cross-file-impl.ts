/**
 * Cross-file binding propagation — extracted from pipeline.ts.
 *
 * Seeds downstream files with resolved type bindings from upstream exports.
 * Files are processed in topological import order so upstream bindings
 * are available when downstream files are re-resolved.
 *
 * @module
 */

import {
  processCalls,
  type ExportedTypeMap,
} from '../call-processor.js';
import type { createResolutionContext } from '../model/resolution-context.js';
import { createASTCache } from '../ast-cache.js';
import { type PipelineProgress, getLanguageFromFilename } from 'gitnexus-shared';
import { readFileContents } from '../filesystem-walker.js';
import { isLanguageAvailable } from '../../tree-sitter/parser-loader.js';
import { extractReturnTypeName } from '../type-extractors/shared.js';
import { yieldToEventLoop } from '../utils/event-loop.js';
import { topologicalLevelSort } from '../utils/graph-sort.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import { isDev } from '../utils/env.js';

import { logger } from '../../logger.js';
/** Max AST trees to keep in LRU cache for cross-file binding propagation. */
const AST_CACHE_CAP = 50;

/** Minimum percentage of files that must benefit from cross-file seeding. */
const CROSS_FILE_SKIP_THRESHOLD = 0.03;
/** Hard cap on files re-processed during cross-file propagation. */
const MAX_CROSS_FILE_REPROCESS = 2000;
/** Progress window reserved for live cross-file re-resolution updates. */
const CROSS_FILE_PROGRESS_START = 82;
const CROSS_FILE_PROGRESS_ACTIVE_END = 92;
const CROSS_FILE_PROGRESS_END = 93;
/** Frequency for progress refreshes and event-loop yields in the hot loop. */
const CROSS_FILE_PROGRESS_INTERVAL = 20;
const CROSS_FILE_YIELD_INTERVAL = 20;

type NamedImportBindingMap = ReadonlyMap<
  string,
  ReadonlyMap<string, { sourcePath: string; exportedName: string }>
>;

type ReturnTypeLookup = {
  lookupExactFull(filePath: string, name: string): { returnType?: string } | undefined;
};

function buildImportedReturnInfo(
  filePath: string,
  namedImportMap: NamedImportBindingMap,
  symbolTable: ReturnTypeLookup,
): {
  importedReturns: ReadonlyMap<string, string>;
  importedRawReturns: ReadonlyMap<string, string>;
} {
  const importedReturns = new Map<string, string>();
  const importedRawReturns = new Map<string, string>();
  const fileImports = namedImportMap.get(filePath);
  if (!fileImports) return { importedReturns, importedRawReturns };

  for (const [localName, binding] of fileImports) {
    const returnType = symbolTable.lookupExactFull(binding.sourcePath, binding.exportedName)
      ?.returnType;
    if (!returnType) continue;
    importedRawReturns.set(localName, returnType);
    const simpleReturn = extractReturnTypeName(returnType);
    if (simpleReturn) importedReturns.set(localName, simpleReturn);
  }

  return { importedReturns, importedRawReturns };
}

/**
 * Cross-file binding propagation.
 * Returns the number of files re-processed.
 */
export async function runCrossFileBindingPropagation(
  graph: KnowledgeGraph,
  ctx: ReturnType<typeof createResolutionContext>,
  parseExportedTypeMap: ReadonlyMap<string, ReadonlyMap<string, string>>,
  allPathSet: ReadonlySet<string>,
  totalFiles: number,
  repoPath: string,
  pipelineStart: number,
  onProgress: (progress: PipelineProgress) => void,
): Promise<number> {
  if (parseExportedTypeMap.size === 0 || ctx.namedImportMap.size === 0) return 0;

  // Build a local mutable working copy. Per-file re-resolution below mutates
  // this map (each `processCalls` writes that file's exports back into it so
  // later iterations in the same level/loop can resolve transitive bindings).
  // Owning a local copy here keeps `ParseOutput.exportedTypeMap` truly
  // read-only at the phase boundary — no cast, no shared-mutable handoff.
  const exportedTypeMap: ExportedTypeMap = new Map();
  for (const [fp, exports] of parseExportedTypeMap) {
    exportedTypeMap.set(fp, new Map(exports));
  }

  const { levels, cycleCount } = topologicalLevelSort(ctx.importMap);

  if (isDev && cycleCount > 0) {
    logger.info(`🔄 ${cycleCount} files in import cycles (processed last in undefined order)`);
  }

  let filesWithGaps = 0;
  const gapThreshold = Math.max(1, Math.ceil(totalFiles * CROSS_FILE_SKIP_THRESHOLD));
  outer: for (const level of levels) {
    for (const filePath of level) {
      const imports = ctx.namedImportMap.get(filePath);
      if (!imports) continue;
      for (const [, binding] of imports) {
        const upstream = exportedTypeMap.get(binding.sourcePath);
        if (upstream?.has(binding.exportedName)) {
          filesWithGaps++;
          break;
        }
        const def = ctx.model.symbols.lookupExactFull(binding.sourcePath, binding.exportedName);
        if (def?.returnType) {
          filesWithGaps++;
          break;
        }
      }
      if (filesWithGaps >= gapThreshold) break outer;
    }
  }

  const gapRatio = totalFiles > 0 ? filesWithGaps / totalFiles : 0;
  if (gapRatio < CROSS_FILE_SKIP_THRESHOLD && filesWithGaps < gapThreshold) {
    if (isDev) {
      logger.info(
        `⏭️ Cross-file re-resolution skipped (${filesWithGaps}/${totalFiles} files, ${(gapRatio * 100).toFixed(1)}% < ${CROSS_FILE_SKIP_THRESHOLD * 100}% threshold)`,
      );
    }
    return 0;
  }

  // Intentionally reports `phase: 'parsing'` rather than a separate
  // 'crossFile' phase: cross-file re-resolution is logically a continuation of
  // the parsing/resolution work and is bucketed under "parsing" in any
  // telemetry that groups events by phase name. Kept consistent with the
  // upstream `parse` phase's progress events so the UI shows one continuous
  // progress segment instead of a phase flicker. If a future change splits
  // this out into its own phase, also rename `parse-impl.ts` per-chunk
  // progress events accordingly.
  onProgress({
    phase: 'parsing',
    percent: CROSS_FILE_PROGRESS_START,
    message: `Cross-file type propagation (${filesWithGaps}+ files)...`,
    detail: `0/${Math.max(1, Math.min(MAX_CROSS_FILE_REPROCESS, filesWithGaps))} files reprocessed`,
    stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
  });

  let crossFileResolved = 0;
  let estimatedCandidates = 0;
  let lastProgressPercent = CROSS_FILE_PROGRESS_START;
  const crossFileStart = Date.now();
  const astCache = createASTCache(AST_CACHE_CAP);

  const reportCrossFileProgress = (detail?: string, forcePercent?: number): void => {
    const denominator = Math.min(
      MAX_CROSS_FILE_REPROCESS,
      Math.max(1, filesWithGaps, estimatedCandidates, crossFileResolved),
    );
    const computedPercent =
      CROSS_FILE_PROGRESS_START +
      Math.floor(
        (Math.min(crossFileResolved, denominator) / denominator) *
          (CROSS_FILE_PROGRESS_ACTIVE_END - CROSS_FILE_PROGRESS_START),
      );
    const percent = Math.min(
      forcePercent ?? CROSS_FILE_PROGRESS_ACTIVE_END,
      Math.max(lastProgressPercent, forcePercent ?? computedPercent),
    );
    lastProgressPercent = percent;
    onProgress({
      phase: 'parsing',
      percent,
      message: `Cross-file type propagation (${filesWithGaps}+ files)...`,
      detail: detail ?? `${crossFileResolved}/${denominator} files reprocessed`,
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });
  };

  for (const level of levels) {
    const levelCandidates: {
      filePath: string;
      seeded: Map<string, string>;
      importedReturns: ReadonlyMap<string, string>;
      importedRawReturns: ReadonlyMap<string, string>;
    }[] = [];
    for (const filePath of level) {
      if (crossFileResolved + levelCandidates.length >= MAX_CROSS_FILE_REPROCESS) break;
      const imports = ctx.namedImportMap.get(filePath);
      if (!imports) continue;

      const seeded = new Map<string, string>();
      for (const [localName, binding] of imports) {
        const upstream = exportedTypeMap.get(binding.sourcePath);
        if (upstream) {
          const type = upstream.get(binding.exportedName);
          if (type) seeded.set(localName, type);
        }
      }

      const { importedReturns, importedRawReturns } = buildImportedReturnInfo(
        filePath,
        ctx.namedImportMap,
        ctx.model.symbols,
      );
      if (seeded.size === 0 && importedReturns.size === 0) continue;
      if (!allPathSet.has(filePath)) continue;

      const lang = getLanguageFromFilename(filePath);
      if (!lang || !isLanguageAvailable(lang)) continue;

      levelCandidates.push({ filePath, seeded, importedReturns, importedRawReturns });
    }

    if (levelCandidates.length === 0) continue;
    estimatedCandidates = Math.min(
      MAX_CROSS_FILE_REPROCESS,
      estimatedCandidates + levelCandidates.length,
    );

    const levelPaths = levelCandidates.map((c) => c.filePath);
    const contentMap = await readFileContents(repoPath, levelPaths);

    for (const { filePath, seeded, importedReturns, importedRawReturns } of levelCandidates) {
      const content = contentMap.get(filePath);
      if (!content) continue;

      const reFile = [{ path: filePath, content }];
      const bindings = new Map<string, ReadonlyMap<string, string>>();
      if (seeded.size > 0) bindings.set(filePath, seeded);

      const importedReturnTypesMap = new Map<string, ReadonlyMap<string, string>>();
      if (importedReturns.size > 0) {
        importedReturnTypesMap.set(filePath, importedReturns);
      }

      const importedRawReturnTypesMap = new Map<string, ReadonlyMap<string, string>>();
      if (importedRawReturns.size > 0) {
        importedRawReturnTypesMap.set(filePath, importedRawReturns);
      }

      await processCalls(
        graph,
        reFile,
        astCache,
        ctx,
        undefined,
        exportedTypeMap,
        bindings.size > 0 ? bindings : undefined,
        importedReturnTypesMap.size > 0 ? importedReturnTypesMap : undefined,
        importedRawReturnTypesMap.size > 0 ? importedRawReturnTypesMap : undefined,
      );
      crossFileResolved++;
      if (
        crossFileResolved % CROSS_FILE_PROGRESS_INTERVAL === 0 ||
        crossFileResolved === estimatedCandidates ||
        crossFileResolved >= MAX_CROSS_FILE_REPROCESS
      ) {
        reportCrossFileProgress();
      }
      if (crossFileResolved % CROSS_FILE_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    if (crossFileResolved >= MAX_CROSS_FILE_REPROCESS) {
      if (isDev)
        logger.info(`⚠️ Cross-file re-resolution capped at ${MAX_CROSS_FILE_REPROCESS} files`);
      break;
    }
  }

  astCache.clear();
  reportCrossFileProgress(`${crossFileResolved} files reprocessed`, CROSS_FILE_PROGRESS_END);

  if (isDev) {
    const elapsed = Date.now() - crossFileStart;
    const totalElapsed = Date.now() - pipelineStart;
    const reResolutionPct = totalElapsed > 0 ? ((elapsed / totalElapsed) * 100).toFixed(1) : '0';
    logger.info(
      `🔗 Cross-file re-resolution: ${crossFileResolved} candidates re-processed` +
        ` in ${elapsed}ms (${reResolutionPct}% of total ingestion time so far)`,
    );
  }

  return crossFileResolved;
}
