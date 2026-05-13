/**
 * Phase: dataflow
 *
 * Phase 13 — runs after processes phase to perform data flow analysis
 * and taint tracking.
 *
 * @deps    processes (needs all symbol nodes and call edges in the graph)
 * @writes  graph (DATA_FLOW, TAINTED, PROPAGATES, RETURNS edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import type { ProcessesOutput } from './processes.js';
import { processDataflow, type DataflowOptions } from '../dataflow/index.js';

export interface DataflowOutput {
  /** DATA_FLOW edges created */
  readonly edgesCreated: number;
  /** Taint paths found (SOURCE → SINK) */
  readonly taintPaths: number;
  /** Analysis mode used */
  readonly mode: 'base' | 'full' | 'off';
  /** True if analysis ran, false if skipped or disabled */
  readonly ran: boolean;
}

const DEFAULT_OUTPUT: DataflowOutput = {
  edgesCreated: 0,
  taintPaths: 0,
  mode: 'off',
  ran: false,
};

function getDataflowMode(): DataflowOptions['mode'] {
  const mode = process.env.GITNEXUS_DATAFLOW_MODE ?? 'base';
  if (mode === 'off') return 'off';
  if (mode === 'full') return 'full';
  return 'base';
}

function getIncremental(): boolean {
  return process.env.GITNEXUS_DATAFLOW_INCREMENTAL === 'true';
}

export const dataflowPhase: PipelinePhase<DataflowOutput> = {
  name: 'dataflow',
  deps: ['processes'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<DataflowOutput> {
    const mode = getDataflowMode();

    if (mode === 'off') {
      ctx.onProgress({
        phase: 'dataflow',
        percent: 100,
        message: 'Dataflow analysis disabled (GITNEXUS_DATAFLOW_MODE=off)',
      });
      return { ...DEFAULT_OUTPUT, mode: 'off' };
    }

    const processesOutput = deps.get('processes');
    if (!processesOutput) {
      ctx.onProgress({
        phase: 'dataflow',
        percent: 100,
        message: 'Dataflow skipped: processes phase did not run',
      });
      return { ...DEFAULT_OUTPUT, mode };
    }

    const processesResult = processesOutput.output as ProcessesOutput;

    ctx.onProgress({
      phase: 'dataflow',
      percent: 0,
      message: `Starting dataflow analysis (mode: ${mode})...`,
    });

    const options: Partial<DataflowOptions> = {
      mode,
      incremental: getIncremental(),
      repoPath: ctx.repoPath,
    };

    await processDataflow(
      ctx.graph,
      undefined, // resolutionContext - legacy, unused
      undefined, // memberships - legacy, unused
      options,
      (message, percent) => {
        ctx.onProgress({
          phase: 'dataflow',
          percent,
          message,
        });
      },
    );

    ctx.onProgress({
      phase: 'dataflow',
      percent: 100,
      message: `Dataflow analysis complete (mode: ${mode})`,
    });

    return {
      edgesCreated: 0, // processDataflow writes directly to graph
      taintPaths: 0,
      mode,
      ran: true,
    };
  },
};
