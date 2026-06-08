/**
 * Pipeline orchestrator — dependency-ordered ingestion pipeline.
 *
 * The pipeline is composed of named phases with explicit dependencies.
 * Each phase is defined in its own file under `pipeline-phases/`.
 * The runner in `pipeline-phases/runner.ts` executes phases in
 * topological order, passing typed outputs from upstream phases as
 * inputs to downstream phases.
 *
 * To add a new phase:
 * 1. Create a new file in `pipeline-phases/` following the pattern
 * 2. Export it from `pipeline-phases/index.ts`
 * 3. Add it to the `ALL_PHASES` array below
 *
 * See ARCHITECTURE.md for the full phase dependency diagram.
 */

import { createKnowledgeGraph } from '../graph/graph.js';
import { type PipelineProgress } from 'gitnexus-shared';
import { PipelineResult } from '../../types/pipeline.js';
import {
  runPipeline,
  getPhaseOutput,
  scanPhase,
  structurePhase,
  markdownPhase,
  cobolPhase,
  parsePhase,
  routesPhase,
  toolsPhase,
  ormPhase,
  crossFilePhase,
  scopeResolutionPhase,
  pruneLocalSymbolsPhase,
  mroPhase,
  communitiesPhase,
  processesPhase,
  dataflowPhase,
  type ScopeResolutionOutput,
  type PipelinePhase,
  type CommunitiesOutput,
  type ProcessesOutput,
} from './pipeline-phases/index.js';

export interface PipelineOptions {
  /**
   * Skip MRO, community detection, and process extraction for faster test runs.
   * The `pruneLocalSymbols` phase still runs — it is graph construction (it cleans
   * up inert local symbols), not graph analysis — so set `keepLocalValueSymbols`
   * to retain those nodes under `skipGraphPhases`.
   */
  skipGraphPhases?: boolean;
  /** Force sequential parsing (no worker pool). Useful for testing the sequential path. */
  skipWorkers?: boolean;
  /** Skip dataflow analysis phase (Phase 13). */
  skipDataflow?: boolean;
  /**
   * @internal Test-only override for worker-pool gating thresholds.
   * When unset, production defaults apply (15 files OR 512 KB total bytes).
   * Setting either field lowers the corresponding threshold so small test
   * fixtures can still exercise the worker-pool path. Do not use from
   * production call sites.
   */
  workerThresholdsForTest?: {
    minFiles?: number;
    minBytes?: number;
  };
  workerUrlForTest?: URL;
  parseCache?: import('../../storage/parse-cache.js').ParseCache;
  workerPoolSize?: number;
  parseChunkConcurrency?: number;
  chunkByteBudget?: number;
  /**
   * Keep inert block-local value symbols (Const/Variable/Static) that the
   * `pruneLocalSymbols` phase would otherwise drop. Mirrors the
   * `GITNEXUS_KEEP_LOCAL_VALUE_SYMBOLS` env var, but threaded per-call so
   * long-running hosts (eval-server, MCP daemon) can opt out without leaking
   * `process.env` state across invocations. When undefined, the env var decides.
   */
  keepLocalValueSymbols?: boolean;
}

// ── Phase registry ─────────────────────────────────────────────────────────

/**
 * All pipeline phases with their dependency relationships.
 *
 * Phase dependency graph:
 *
 *   scan → structure → [markdown, cobol] → parse → [routes, tools, orm]
 *     → crossFile → scopeResolution → pruneLocalSymbols
 *     → mro → communities → processes
 *
 * To add a new phase: create a file in pipeline-phases/, export the phase
 * object, and `.register()` it at the appropriate position below. Opt-in
 * phases pass an `enabledWhen` predicate (issue #2080 phase-registry seam) —
 * the legacy `if (!skipGraphPhases)` guard is now expressed that way on the
 * three graph phases, with no change in behaviour.
 *
 * Exported for the parity test (`pipeline-phase-registry.test.ts`), which
 * asserts the produced list is byte-identical to the legacy array for every
 * options combination.
 */
export function buildPhaseList(options?: PipelineOptions): PipelinePhase[] {
  const phases: PipelinePhase[] = [
    scanPhase,
    structurePhase,
    markdownPhase,
    cobolPhase,
    parsePhase,
    routesPhase,
    toolsPhase,
    ormPhase,
    crossFilePhase,
    scopeResolutionPhase,
    pruneLocalSymbolsPhase,
  ];

  if (!options?.skipGraphPhases) {
    phases.push(mroPhase, communitiesPhase, processesPhase);
    if (!options?.skipDataflow) {
      phases.push(dataflowPhase);
    }
  }

  return phases;
}

// ── Pipeline orchestrator ─────────────────────────────────────────────────

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  const pipelineStart = Date.now();

  const phases = buildPhaseList(options);

  const results = await runPipeline(phases, {
    repoPath,
    graph,
    onProgress,
    options,
    pipelineStart,
  });

  // Extract final results for the PipelineResult contract
  const { totalFiles, usedWorkerPool } = getPhaseOutput<{
    totalFiles: number;
    usedWorkerPool: boolean;
  }>(results, 'parse');

  let communityResult: CommunitiesOutput['communityResult'] | undefined;
  let processResult: ProcessesOutput['processResult'] | undefined;
  const resolutionOutcomes = getPhaseOutput<ScopeResolutionOutput>(
    results,
    'scopeResolution',
  ).resolutionOutcomes;

  if (!options?.skipGraphPhases) {
    communityResult = getPhaseOutput<CommunitiesOutput>(results, 'communities').communityResult;
    processResult = getPhaseOutput<ProcessesOutput>(results, 'processes').processResult;
  }

  onProgress({
    phase: 'complete',
    percent: 100,
    message:
      communityResult && processResult
        ? `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes detected.`
        : 'Graph complete! (graph phases skipped)',
    stats: {
      filesProcessed: totalFiles,
      totalFiles,
      nodesCreated: graph.nodeCount,
    },
  });

  return {
    graph,
    repoPath,
    totalFileCount: totalFiles,
    communityResult,
    processResult,
    resolutionOutcomes,
    usedWorkerPool,
  };
};
