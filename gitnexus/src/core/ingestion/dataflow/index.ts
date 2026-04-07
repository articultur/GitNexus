/**
 * Phase 12: Dataflow Analysis
 *
 * Stub implementation — full dataflow analysis (taint tracking, data propagation,
 * sink reachability) is planned for a future release.
 */
import type { createKnowledgeGraph } from '../../graph/graph.js';
import type { createResolutionContext } from '../resolution-context.js';
import type { CommunityMembership } from '../community-processor.js';

export interface DataflowOptions {
  /** Analysis mode. 'off' disables dataflow entirely (default). */
  mode?: 'off' | 'basic' | 'full';
  /** Maximum number of hops for taint propagation. Default: 5. */
  maxDepth?: number;
}

/**
 * Run dataflow analysis on the knowledge graph.
 *
 * Populates DATA_FLOW, TAINTED, SINK_REACHABLE, PROPAGATES, RETURNS,
 * SANITIZES, and ALIASES edges in the graph.
 *
 * @param graph - The knowledge graph to analyse and mutate.
 * @param ctx - Resolution context holding symbol/import maps.
 * @param memberships - Community membership assignments from Phase 5.
 * @param options - Dataflow configuration.
 * @param onProgress - Progress callback (message, 0-100 percent).
 */
export async function processDataflow(
  _graph: ReturnType<typeof createKnowledgeGraph>,
  _ctx: ReturnType<typeof createResolutionContext>,
  _memberships: CommunityMembership[],
  _options: Partial<DataflowOptions> | undefined,
  _onProgress: (message: string, progress: number) => void,
): Promise<void> {
  // Stub: dataflow analysis not yet implemented.
}
