/**
 * Impact analysis tools — BFS-based impact traversal.
 *
 * Supports adaptive layered output for large result sets:
 * - Full mode: complete output for small results (≤400 items)
 * - Transition mode: hybrid output for medium results (400-600 items)
 * - Layered mode: paginated output for large results (>600 items)
 */

import { executeParameterized } from '../../../core/lbug/pool-adapter.js';
import {
  logQueryError,
  VALID_RELATION_TYPES,
  IMPACT_RELATION_CONFIDENCE,
  confidenceForRelType,
  isTestFilePath,
  computeImpactScore,
  createEvidenceBuilder,
  getImpactOutputMode,
  IMPACT_SCALE_CONFIGS,
  IMPACT_THRESHOLDS,
  MAX_TRAVERSAL_NODES,
} from './shared.js';
import type { ImpactParams, RepoHandle, ImpactedItem } from './shared.js';

// Simple in-memory snapshot cache for pagination consistency
// Key: snapshot_id, Value: { impacted: any[], grouped: Record<number, any[]>, timestamp: number }
const snapshotCache = new Map<
  string,
  {
    impacted: any[];
    grouped: Record<number, any[]>;
    timestamp: number;
  }
>();

// Clean up snapshots older than 5 minutes
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of snapshotCache.entries()) {
    if (now - data.timestamp > SNAPSHOT_TTL_MS) {
      snapshotCache.delete(id);
    }
  }
}, 60000);

export async function impactTool(
  repo: RepoHandle,
  params: ImpactParams,
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  try {
    return await impactImpl(repo, params, ensureInitialized);
  } catch (err: any) {
    // Return structured error instead of crashing (#321)
    return {
      error: (err instanceof Error ? err.message : String(err)) || 'Impact analysis failed',
      target: { name: params.target },
      direction: params.direction,
      impactedCount: 0,
      risk: 'UNKNOWN',
      suggestion: 'The graph query failed — try gitnexus context <symbol> as a fallback',
    };
  }
}

async function impactImpl(
  repo: RepoHandle,
  params: ImpactParams,
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);

  const { target, direction } = params;
  const include_evidence = params.include_evidence ?? true;
  const maxDepth = params.maxDepth || 3;
  // Map legacy relation type names before filtering (backward compat for OVERRIDES → METHOD_OVERRIDES)
  const mappedRelTypes = params.relationTypes?.flatMap((t: string) =>
    t === 'OVERRIDES' ? ['OVERRIDES', 'METHOD_OVERRIDES'] : [t],
  );
  const rawRelTypes =
    mappedRelTypes && mappedRelTypes.length > 0
      ? mappedRelTypes.filter((t: string) => VALID_RELATION_TYPES.has(t))
      : [
          'CALLS',
          'IMPORTS',
          'EXTENDS',
          'IMPLEMENTS',
          'METHOD_OVERRIDES',
          'OVERRIDES',
          'METHOD_IMPLEMENTS',
        ];
  const relationTypes =
    rawRelTypes.length > 0
      ? rawRelTypes
      : [
          'CALLS',
          'IMPORTS',
          'EXTENDS',
          'IMPLEMENTS',
          'METHOD_OVERRIDES',
          'OVERRIDES',
          'METHOD_IMPLEMENTS',
        ];
  const includeTests = params.includeTests ?? false;
  const minConfidence = params.minConfidence ?? 0;
  const include_content = params.include_content ?? false;

  // New parameters for adaptive layered output
  const detailMode = params.detail ?? 'auto';
  const pagination = params.page;
  const snapshotId = params.snapshot_id;

  // Resolve target by name, preferring Class/Interface over Constructor
  let sym: any = null;
  let symType = '';

  // Support dot-separated "Class.method" syntax for disambiguation
  let targetName = target;
  let parentClassName: string | undefined;
  const dotIdx = target.lastIndexOf('.');
  if (dotIdx > 0) {
    parentClassName = target.substring(0, dotIdx);
    targetName = target.substring(dotIdx + 1);
  }

  // Try exact ID match first (handles "Method:SDWebImage/.../dataTask" style IDs)
  const isQualified = target.includes('/') || target.includes(':');
  if (isQualified) {
    try {
      const idRows = await executeParameterized(
        repo.id,
        `MATCH (n {id: $target}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT 1`,
        { target },
      );
      if (idRows.length > 0) {
        sym = idRows[0];
      }
    } catch (e) {
      logQueryError('impact:target-resolution-id', e);
    }
  }

  if (!sym) {
    try {
      const methodArm = parentClassName
        ? `
        UNION ALL
        MATCH (parent:\`Class\`)-[r:CodeRelation]->(n)
        WHERE parent.name = $parentClassName AND n.name = $targetName AND r.type = 'HAS_METHOD'
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 0 AS priority LIMIT 1`
        : '';

      const rows = await executeParameterized(
        repo.id,
        `
        MATCH (n:\`Class\`) WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 0 AS priority LIMIT 1
        UNION ALL
        MATCH (n:\`Interface\`) WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 1 AS priority LIMIT 1
        UNION ALL
        MATCH (n:\`Function\`) WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 2 AS priority LIMIT 1
        UNION ALL
        MATCH (n:\`Method\`) WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 3 AS priority LIMIT 1
        UNION ALL
        MATCH (n:\`Constructor\`) WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath, 4 AS priority LIMIT 1
        ${methodArm}
      `,
        { targetName, parentClassName },
      ).catch(() => []);

      if (rows.length > 0) {
        const best = rows.reduce((a: any, b: any) =>
          (a.priority ?? a[3] ?? 99) <= (b.priority ?? b[3] ?? 99) ? a : b,
        );
        sym = best;
        const priorityToLabel = ['Class', 'Interface', 'Function', 'Method', 'Constructor'];
        symType = priorityToLabel[best.priority ?? best[3]] ?? '';
      }
    } catch (e) {
      logQueryError('impact:target-resolution-labeled', e);
    }
  }

  // Fall back to unlabeled match for any other node type
  if (!sym) {
    const rows = await executeParameterized(
      repo.id,
      `
        MATCH (n)
        WHERE n.name = $targetName
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath
        LIMIT 1
      `,
      { targetName },
    );
    if (rows.length > 0) sym = rows[0];
  }

  if (!sym) return { error: `Target '${target}' not found` };

  return runImpactBFS(repo, sym, symType, direction, {
    maxDepth,
    relationTypes,
    includeTests,
    minConfidence,
    include_evidence,
    include_content,
    file_path: params.file_path,
    // New parameters for adaptive output
    detailMode,
    pagination,
    snapshotId,
  });
}

/**
 * Shared BFS traversal for impact analysis (name-resolved or UID-resolved symbol).
 *
 * Supports adaptive layered output for large result sets:
 * - Full mode: complete output for small results (≤400 items)
 * - Transition mode: hybrid output for medium results (400-600 items)
 * - Layered mode: paginated output for large results (>600 items)
 */
export async function runImpactBFS(
  repo: RepoHandle,
  sym: any,
  symType: string,
  direction: 'upstream' | 'downstream',
  opts: {
    maxDepth: number;
    relationTypes: string[];
    includeTests: boolean;
    minConfidence: number;
    include_evidence: boolean;
    include_content: boolean;
    file_path?: string;
    // New parameters for adaptive output
    detailMode?: 'auto' | 'summary' | 'full';
    pagination?: { depth: number; offset?: number; limit?: number };
    snapshotId?: string;
  },
): Promise<any> {
  const {
    maxDepth,
    relationTypes,
    includeTests,
    minConfidence,
    include_evidence,
    include_content,
    file_path,
    detailMode = 'auto',
    pagination,
    snapshotId,
  } = opts;
  const effectiveMinConf = minConfidence > 0 ? minConfidence : 0;

  const symId = sym.id || sym[0];

  const impacted: any[] = [];
  const visited = new Set<string>([symId]);
  let frontier = [symId];
  let traversalComplete = true;

  // Fix #480: For Java (and other JVM) Class/Interface nodes, CALLS edges
  // point to Constructor nodes and IMPORTS edges point to File nodes — not
  // the Class/Interface itself. Seed the frontier with the Constructor(s)
  // and owning File so the BFS traversal finds those edges naturally.
  if (symType === 'Class' || symType === 'Interface') {
    try {
      const [ctorRows, fileRows] = await Promise.all([
        executeParameterized(
          repo.id,
          `
            MATCH (n)-[hm:CodeRelation]->(c:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            RETURN c.id AS id, c.name AS name, labels(c)[0] AS type, c.filePath AS filePath
          `,
          { symId },
        ),
        executeParameterized(
          repo.id,
          `
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            RETURN f.id AS id, f.name AS name, labels(f)[0] AS type, f.filePath AS filePath
          `,
          { symId },
        ),
      ]);

      for (const r of ctorRows) {
        const rid = r.id || r[0];
        if (rid && !visited.has(rid)) {
          visited.add(rid);
          frontier.push(rid);
        }
      }
      for (const r of fileRows) {
        const rid = r.id || r[0];
        if (rid && !visited.has(rid)) {
          visited.add(rid);
          frontier.push(rid);
        }
      }
    } catch (e) {
      logQueryError('impact:class-node-expansion', e);
    }
  }

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    // Computation truncation: stop if we've exceeded max traversal nodes
    if (visited.size >= MAX_TRAVERSAL_NODES) {
      traversalComplete = false;
      break;
    }

    const nextFrontier: string[] = [];

    const relTypeFilter = relationTypes.map((t) => `r.type = '${t}'`).join(' OR ');

    const filePathCondition = file_path
      ? ` AND (n.filePath CONTAINS $filePath OR caller.filePath CONTAINS $filePath)`
      : '';

    const baseQuery =
      direction === 'upstream'
        ? `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN $ids AND (${relTypeFilter}) AND r.confidence >= $minConf${filePathCondition} RETURN n.id AS sourceId, n.name AS sourceName, n.filePath AS sourceFilePath, caller.id AS id, caller.name AS name, labels(caller)[0] AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence, r.reason AS reason`
        : `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN $ids AND (${relTypeFilter}) AND r.confidence >= $minConf RETURN n.id AS sourceId, n.name AS sourceName, n.filePath AS sourceFilePath, callee.id AS id, callee.name AS name, labels(callee)[0] AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence, r.reason AS reason`;

    try {
      const related = await executeParameterized(repo.id, baseQuery, {
        ids: frontier,
        relTypes: relationTypes,
        minConf: effectiveMinConf,
        ...(file_path ? { filePath: file_path } : {}),
      });

      for (const rel of related) {
        // Computation truncation: stop adding items if we've exceeded max
        if (visited.size >= MAX_TRAVERSAL_NODES) {
          traversalComplete = false;
          break;
        }

        const relId = rel.id || rel[1];
        const filePath = rel.filePath || rel[4] || '';

        if (!includeTests && isTestFilePath(filePath)) continue;

        if (!visited.has(relId)) {
          visited.add(relId);
          nextFrontier.push(relId);
          const storedConfidence = rel.confidence ?? rel[6];
          const relationType = rel.relType || rel[5];
          const effectiveConfidence =
            typeof storedConfidence === 'number' && storedConfidence > 0
              ? storedConfidence
              : confidenceForRelType(relationType);
          impacted.push({
            depth,
            id: relId,
            name: rel.name || rel[4],
            type: rel.type || rel[5],
            filePath,
            relationType,
            confidence: effectiveConfidence,
            reason: rel.reason ?? rel[9] ?? '',
            source: {
              id: rel.sourceId || rel[0],
              name: rel.sourceName || rel[1],
              filePath: rel.sourceFilePath || rel[2],
            },
          });
        }
      }

      // Break outer loop if computation truncated
      if (!traversalComplete && visited.size >= MAX_TRAVERSAL_NODES) {
        break;
      }
    } catch (e) {
      logQueryError('impact:depth-traversal', e);
      traversalComplete = false;
      break;
    }

    frontier = nextFrontier;
  }

  const grouped: Record<number, any[]> = {};
  for (const item of impacted) {
    if (!grouped[item.depth]) grouped[item.depth] = [];
    grouped[item.depth].push(item);
  }

  // ── Enrichment: affected processes, modules, risk ──────────────
  const directCount = (grouped[1] || []).length;
  let affectedProcesses: any[] = [];
  let affectedModules: any[] = [];

  if (impacted.length > 0) {
    const CHUNK_SIZE = 100;
    const MAX_CHUNKS = parseInt(process.env.IMPACT_MAX_CHUNKS || '10', 10);

    const entryPointMap = new Map<
      string,
      {
        name: string;
        type: string;
        filePath: string;
        affected_process_count: number;
        total_hits: number;
        earliest_broken_step: number;
      }
    >();

    const processToEntryPoint = new Map<string, string>();
    const processesMissingMinStep = new Set<string>();

    let chunksProcessed = 0;
    for (
      let i = 0;
      i < impacted.length && chunksProcessed < MAX_CHUNKS;
      i += CHUNK_SIZE, chunksProcessed++
    ) {
      const chunk = impacted.slice(i, i + CHUNK_SIZE);
      const ids = chunk.map((item) => String(item.id ?? ''));

      try {
        const rows = await executeParameterized(
          repo.id,
          `
            MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
            WHERE s.id IN $ids
            WITH p, COUNT(DISTINCT s.id) AS hits, MIN(r.step) AS minStep
            OPTIONAL MATCH (ep {id: p.entryPointId})
            RETURN p.id AS pId, p.heuristicLabel AS name, p.processType AS processType,
                   p.entryPointId AS entryPointId, hits, minStep, p.stepCount AS stepCount,
                   ep.name AS epName, labels(ep)[0] AS epType, ep.filePath AS epFilePath
          `,
          { ids },
        ).catch(() => []);

        for (const row of rows) {
          const pId = row.pId ?? row[0];
          const epId = row.entryPointId ?? row[3] ?? row.pId ?? row[0];
          if (pId) processToEntryPoint.set(String(pId), String(epId));

          const epNameRaw = row.epName ?? row[7] ?? row.name ?? row[1] ?? 'unknown';
          const epName =
            typeof epNameRaw === 'string' && epNameRaw.trim().length > 0
              ? epNameRaw.trim()
              : 'unknown';

          const epTypeRaw = row.epType ?? row[8] ?? '';
          const epType =
            typeof epTypeRaw === 'string' && epTypeRaw.trim().length > 0
              ? epTypeRaw.trim()
              : 'Function';

          const epFilePath = row.epFilePath ?? row[9] ?? '';
          const hits = row.hits ?? row[4] ?? 0;
          const minStep = row.minStep ?? row[5];
          if (minStep === null || minStep === undefined) {
            if (pId) processesMissingMinStep.add(String(pId));
          }
          if (!entryPointMap.has(epId)) {
            entryPointMap.set(epId, {
              name: epName,
              type: epType,
              filePath: epFilePath,
              affected_process_count: 0,
              total_hits: 0,
              earliest_broken_step: Infinity,
            });
          }
          const ep = entryPointMap.get(epId)!;
          ep.affected_process_count += 1;
          ep.total_hits += hits;
          ep.earliest_broken_step = Math.min(ep.earliest_broken_step, minStep ?? Infinity);
        }
      } catch (e) {
        logQueryError('impact:process-chunk', e);
      }
    }

    if (processesMissingMinStep.size > 0) {
      try {
        const pIds = Array.from(processesMissingMinStep);
        const allImpactedIds = impacted.map((it) => String(it.id ?? ''));
        const missingRows = await executeParameterized(
          repo.id,
          `
            MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
            WHERE p.id IN $pIds AND s.id IN $ids
            RETURN p.id AS pid, MIN(r.step) AS minStep
          `,
          { pIds, ids: allImpactedIds },
        ).catch(() => []);

        for (const mr of missingRows) {
          const pid = mr.pid ?? mr[0];
          const minStep = mr.minStep ?? mr[1];
          const epId = processToEntryPoint.get(String(pid));
          if (!epId) continue;
          const ep = entryPointMap.get(epId);
          if (!ep) continue;
          if (typeof minStep === 'number') {
            ep.earliest_broken_step = Math.min(ep.earliest_broken_step, minStep);
          }
        }
      } catch (e) {
        logQueryError('impact:process-chunk-backfill', e);
      }
    }

    if (chunksProcessed * CHUNK_SIZE < impacted.length) {
      traversalComplete = false;
    }

    affectedProcesses = Array.from(entryPointMap.values())
      .map((ep) => ({
        ...ep,
        earliest_broken_step: ep.earliest_broken_step === Infinity ? null : ep.earliest_broken_step,
      }))
      .sort((a, b) => b.total_hits - a.total_hits);

    // ── Module enrichment ──────────────────────────────────────────
    const maxItems = Math.min(impacted.length, MAX_CHUNKS * CHUNK_SIZE);
    const cappedImpacted = impacted.slice(0, maxItems);
    const allIdsArr = cappedImpacted.map((i: any) => String(i.id ?? ''));
    const d1Items = (grouped[1] || []).slice(0, maxItems);
    const d1IdsArr = d1Items.map((i: any) => String(i.id ?? ''));

    const moduleHitsMap = new Map<string, number>();
    const directModuleSet = new Set<string>();

    const runModuleChunk = async (idsChunk: string[]) => {
      if (!idsChunk || idsChunk.length === 0) return;
      try {
        const rows = await executeParameterized(
          repo.id,
          `
            MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
            WHERE s.id IN $ids
            RETURN c.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits
            ORDER BY hits DESC
            LIMIT 20
          `,
          { ids: idsChunk },
        ).catch(() => []);

        for (const r of rows) {
          const name = r.name ?? r[0] ?? null;
          const hits = (r.hits ?? r[1]) || 0;
          if (!name) continue;
          moduleHitsMap.set(name, (moduleHitsMap.get(name) || 0) + hits);
        }
      } catch (e) {
        logQueryError('impact:module-chunk', e);
      }
    };

    for (let i = 0; i < allIdsArr.length; i += CHUNK_SIZE) {
      const chunkIds = allIdsArr.slice(i, i + CHUNK_SIZE);
      await runModuleChunk(chunkIds);
    }

    const runDirectModuleChunk = async (idsChunk: string[]) => {
      if (!idsChunk || idsChunk.length === 0) return;
      try {
        const rows = await executeParameterized(
          repo.id,
          `
            MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
            WHERE s.id IN $ids
            RETURN DISTINCT c.heuristicLabel AS name
          `,
          { ids: idsChunk },
        ).catch(() => []);
        for (const r of rows) {
          const name = r.name ?? r[0] ?? null;
          if (name) directModuleSet.add(name);
        }
      } catch (e) {
        logQueryError('impact:direct-module-chunk', e);
      }
    };

    for (let i = 0; i < d1IdsArr.length; i += CHUNK_SIZE) {
      const chunkIds = d1IdsArr.slice(i, i + CHUNK_SIZE);
      await runDirectModuleChunk(chunkIds);
    }

    const moduleRows = Array.from(moduleHitsMap.entries())
      .map(([name, hits]) => ({ name, hits }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 20);

    const directModuleRows = Array.from(directModuleSet).map((name) => ({ name }));

    const directModuleNameSet = new Set(directModuleRows.map((r: any) => r.name || r[0]));
    affectedModules = moduleRows.map((r: any) => {
      const name = r.name ?? r[0];
      const hits = r.hits ?? r[1] ?? 0;
      return {
        name,
        hits,
        impact: directModuleNameSet.has(name) ? 'direct' : 'indirect',
      };
    });
  }

  // Batch-fetch source content for impacted symbols when requested
  const contentMap = new Map<string, string>();
  if (include_content && impacted.length > 0) {
    const maxContentItems = Math.min(impacted.length, 1000);
    for (let i = 0; i < maxContentItems; i += 100) {
      const chunkIds = impacted
        .slice(i, Math.min(i + 100, maxContentItems))
        .map((it: any) => String(it.id ?? ''));
      try {
        const contentRows = await executeParameterized(
          repo.id,
          `MATCH (n) WHERE n.id IN $ids AND n.content IS NOT NULL
           RETURN n.id AS id, n.content AS content`,
          { ids: chunkIds },
        ).catch(() => []);
        for (const row of contentRows) {
          const id = row.id ?? row[0];
          const content = row.content ?? row[1];
          if (id && content) contentMap.set(String(id), content);
        }
      } catch (e) {
        logQueryError('impact:content-fetch', e);
      }
    }
  }

  // Unified risk scoring using computeImpactScore
  const processCount = affectedProcesses.length;
  const moduleCount = affectedModules.length;

  // Prepare impacted items for top contributor calculation
  const impactedItems: ImpactedItem[] = impacted.map((item) => ({
    depth: item.depth,
    relationType: item.relationType,
    confidence: item.confidence,
    name: item.name,
  }));

  const scoreResult = computeImpactScore({
    directCount,
    processCount,
    moduleCount,
    totalCount: impacted.length,
    impactedItems,
    direction,
  });

  // Build StandardEvidence using createEvidenceBuilder (Sub C: 4-tool coverage)
  const evidenceBuilder = createEvidenceBuilder();
  evidenceBuilder.addExplanation(
    'Impact is computed by breadth-first traversal over graph relations from the target symbol using the selected relation types.',
  );
  for (const item of impacted) {
    evidenceBuilder.addPath(
      {
        id: String(item.source?.id ?? ''),
        name: item.source?.name ?? '',
        filePath: item.source?.filePath,
      },
      { id: String(item.id ?? ''), name: item.name ?? '', filePath: item.filePath },
      item.relationType,
    );
    // Add critical edges for direct high-confidence impacts
    if (item.depth === 1 && item.confidence >= 0.8) {
      evidenceBuilder.addCriticalEdge(
        String(item.source?.id ?? ''),
        String(item.id ?? ''),
        item.relationType,
        item.confidence,
      );
    }
  }
  evidenceBuilder.addConfidenceFactor('bfs_traversal', scoreResult.confidence);
  evidenceBuilder.addConfidenceFactor('relation_coverage', relationTypes.length > 0 ? 0.9 : 0.5);
  if (!traversalComplete) {
    evidenceBuilder.addExclusion('BFS truncated: maxDepth or chunk limit reached');
  }

  // ── Adaptive Layered Output ────────────────────────────────────────────────
  // Determine output mode based on result count and user preference
  const { mode, scale } = getImpactOutputMode(impacted.length, detailMode);
  const scaleConfig = IMPACT_SCALE_CONFIGS[scale];

  // Handle pagination request for layered mode
  if (pagination && snapshotId) {
    const cached = snapshotCache.get(snapshotId);
    if (cached) {
      const { depth, offset = 0, limit = 100 } = pagination;
      const depthItems = cached.grouped[depth] || [];
      const paginatedItems = depthItems.slice(offset, offset + limit);

      return {
        _version: 2,
        _mode: 'layered',
        _scale: scale,
        _info: {
          snapshot_id: snapshotId,
          depth,
          offset,
          limit,
          total_at_depth: depthItems.length,
          has_more: offset + limit < depthItems.length,
        },
        items: paginatedItems,
      };
    }
    // Snapshot expired or invalid, continue with fresh query
  }

  // Generate snapshot ID for large results
  let newSnapshotId: string | undefined;
  if (mode === 'layered' && impacted.length > IMPACT_THRESHOLDS.TRANSITION_MAX) {
    newSnapshotId = `snap_${symId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    snapshotCache.set(newSnapshotId, {
      impacted,
      grouped,
      timestamp: Date.now(),
    });
  }

  // Build base result object (common to all modes)
  const baseResult = {
    target: {
      id: symId,
      name: sym.name || sym[1],
      type: symType,
      filePath: sym.filePath || sym[2],
    },
    direction,
    impactedCount: impacted.length,
    risk: scoreResult.risk,
    score_v2: {
      score: scoreResult.score,
      risk: scoreResult.risk,
      confidence: scoreResult.confidence,
      top_contributors: scoreResult.top_contributors,
      score_breakdown: scoreResult.score_breakdown,
    },
    ...(!traversalComplete && { partial: true }),
    summary: {
      direct: directCount,
      processes_affected: processCount,
      modules_affected: moduleCount,
    },
    affected_processes: affectedProcesses,
    affected_modules: affectedModules,
  };

  // ── Mode-specific output formatting ──────────────────────────────────────
  if (mode === 'full') {
    // Full mode: complete output for small results
    return {
      _version: 2,
      _mode: 'full',
      _scale: scale,
      ...baseResult,
      byDepth: grouped,
      ...(include_evidence &&
        scaleConfig.includeEvidence && {
          evidence: evidenceBuilder.build(),
          evidence_legacy: {
            explanation:
              'Impact is computed by breadth-first traversal over graph relations from the target symbol using the selected relation types.',
            relation_types: relationTypes,
            traversal: impacted.map((item) => ({
              depth: item.depth,
              relationType: item.relationType,
              confidence: item.confidence,
              reason: item.reason,
              from: item.source,
              to: {
                id: item.id,
                name: item.name,
                filePath: item.filePath,
                type: item.type,
                ...(include_content &&
                  scaleConfig.includeContent &&
                  contentMap.has(String(item.id)) && { content: contentMap.get(String(item.id)) }),
              },
            })),
          },
        }),
    };
  }

  if (mode === 'transition') {
    // Transition mode: hybrid output for medium results
    // - Include full byDepth but truncate each depth level
    // - Include evidence but limit paths
    const truncatedByDepth: Record<number, any[]> = {};
    for (const [depth, items] of Object.entries(grouped)) {
      truncatedByDepth[Number(depth)] = items.slice(0, scaleConfig.maxItemsPerDepth);
    }

    return {
      _version: 2,
      _mode: 'transition',
      _scale: scale,
      _info: {
        truncated: true,
        max_items_per_depth: scaleConfig.maxItemsPerDepth,
      },
      ...baseResult,
      byDepth: truncatedByDepth,
      ...(include_evidence && {
        evidence: evidenceBuilder.build(),
        evidence_legacy: {
          explanation:
            'Impact is computed by breadth-first traversal over graph relations from the target symbol using the selected relation types.',
          relation_types: relationTypes,
          traversal: impacted.slice(0, 500).map((item) => ({
            depth: item.depth,
            relationType: item.relationType,
            confidence: item.confidence,
            reason: item.reason,
            from: item.source,
            to: {
              id: item.id,
              name: item.name,
              filePath: item.filePath,
              type: item.type,
            },
          })),
        },
      }),
    };
  }

  // Layered mode: paginated output for large results
  // Return depth summary with pagination hints
  const depthSummary: Record<number, { count: number; sample: any[] }> = {};
  for (const [depth, items] of Object.entries(grouped)) {
    const depthNum = Number(depth);
    if (depthNum <= scaleConfig.maxDepthLayers) {
      depthSummary[depthNum] = {
        count: items.length,
        sample: items.slice(0, 5).map((item: any) => ({
          name: item.name,
          type: item.type,
          filePath: item.filePath,
          relationType: item.relationType,
        })),
      };
    }
  }

  // Include first page of depth 1 by default
  const firstPageItems = (grouped[1] || []).slice(0, scaleConfig.itemsPerPage);

  return {
    _version: 2,
    _mode: 'layered',
    _scale: scale,
    _info: {
      snapshot_id: newSnapshotId,
      total_depths: Object.keys(grouped).length,
      max_depth_available: scaleConfig.maxDepthLayers,
      items_per_page: scaleConfig.itemsPerPage,
      pagination_hint: `Use page={{depth: N, offset: 0, limit: ${scaleConfig.itemsPerPage}}} with snapshot_id to paginate`,
    },
    ...baseResult,
    depth_summary: depthSummary,
    // Include first page of depth 1 for convenience
    items: firstPageItems,
    // Omit full byDepth and evidence for layered mode
  };
}

/**
 * UID-based impact for cross-repo fan-out. Same result shape as `impact`.
 * Returns null if the repo is unknown, the UID is missing, or analysis fails.
 */
export async function impactByUidTool(
  repoId: string,
  uid: string,
  direction: 'upstream' | 'downstream',
  opts: {
    maxDepth: number;
    relationTypes: string[];
    minConfidence: number;
    includeTests: boolean;
    include_evidence?: boolean;
    include_content?: boolean;
    // New parameters for adaptive output
    detailMode?: 'auto' | 'summary' | 'full';
    pagination?: { depth: number; offset?: number; limit?: number };
    snapshotId?: string;
  },
  ensureInitialized: (id: string) => Promise<void>,
  getRepo: (id: string) => RepoHandle | undefined,
  refreshRepos: () => Promise<void>,
): Promise<any | null> {
  try {
    await refreshRepos();
    await ensureInitialized(repoId);
  } catch (e) {
    logQueryError('impactByUid:init', e);
    return null;
  }

  const repo = getRepo(repoId);
  if (!repo) return null;

  const dir: 'upstream' | 'downstream' = direction === 'downstream' ? 'downstream' : 'upstream';

  let rows: any[];
  try {
    rows = await executeParameterized(
      repoId,
      `MATCH (n) WHERE n.id = $uid
       RETURN n.id AS id, n.name AS name, n.filePath AS filePath, labels(n)[0] AS type
       LIMIT 1`,
      { uid },
    );
  } catch (e) {
    logQueryError('impactByUid:uid-lookup', e);
    return null;
  }
  if (!rows?.length) return null;

  const sym = rows[0];
  const labelRaw = sym.type ?? sym[3];
  const symType = typeof labelRaw === 'string' && labelRaw.trim().length > 0 ? labelRaw.trim() : '';

  // Map legacy relation type names (backward compat for OVERRIDES → METHOD_OVERRIDES)
  const mappedRelTypes = opts.relationTypes?.flatMap((t: string) =>
    t === 'OVERRIDES' ? ['OVERRIDES', 'METHOD_OVERRIDES'] : [t],
  );
  const rawRelTypes =
    mappedRelTypes && mappedRelTypes.length > 0
      ? mappedRelTypes.filter((t: string) => VALID_RELATION_TYPES.has(t))
      : [
          'CALLS',
          'IMPORTS',
          'EXTENDS',
          'IMPLEMENTS',
          'METHOD_OVERRIDES',
          'OVERRIDES',
          'METHOD_IMPLEMENTS',
        ];
  const relationTypes =
    rawRelTypes.length > 0
      ? rawRelTypes
      : [
          'CALLS',
          'IMPORTS',
          'EXTENDS',
          'IMPLEMENTS',
          'METHOD_OVERRIDES',
          'OVERRIDES',
          'METHOD_IMPLEMENTS',
        ];

  try {
    return await runImpactBFS(repo, sym, symType, dir, {
      maxDepth: opts.maxDepth,
      relationTypes,
      includeTests: opts.includeTests ?? false,
      minConfidence: opts.minConfidence,
      include_evidence: opts.include_evidence ?? true,
      include_content: opts.include_content ?? false,
      // New parameters for adaptive output
      detailMode: opts.detailMode,
      pagination: opts.pagination,
      snapshotId: opts.snapshotId,
    });
  } catch (e) {
    logQueryError('impactByUid:bfs', e);
    return null;
  }
}

// Re-export IMPACT_RELATION_CONFIDENCE used by other modules
export { IMPACT_RELATION_CONFIDENCE };
