/**
 * Graph traversal tools — shortest path, get code, API impact analysis.
 */

import { executeParameterized } from '../../../core/lbug/pool-adapter.js';
import { logQueryError, VALID_NODE_LABELS } from './shared.js';
import type { RepoHandle } from './shared.js';
import { fetchRoutesWithConsumers, fetchLinkedFlowsBatch } from './route-tools.js';

// ─── Private helper ──────────────────────────────────────────────────────────

async function resolvePathNodes(repoId: string, nodeIds: string[]): Promise<any[]> {
  const results: any[] = [];
  for (const nodeId of nodeIds) {
    const label = nodeId.includes(':') ? nodeId.split(':')[0] : 'Unknown';
    if (!VALID_NODE_LABELS.has(label)) continue;
    try {
      const rows = await executeParameterized(
        repoId,
        `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine LIMIT 1`,
        { nodeId },
      );
      if (rows.length > 0) {
        const r = rows[0];
        results.push({
          uid: r.id ?? r[0],
          name: r.name ?? r[1],
          kind: label,
          filePath: r.filePath ?? r[2],
          startLine: r.startLine ?? r[3] ?? null,
          endLine: r.endLine ?? r[4] ?? null,
        });
      }
    } catch (e) {
      logQueryError('resolvePathNodes', e);
    }
  }
  return results;
}

// ─── Exported tool functions ─────────────────────────────────────────────────

/**
 * Shortest path between two nodes via BFS on CodeRelation edges.
 */
export async function shortestPathTool(
  repo: RepoHandle,
  params: {
    source_id: string;
    target_id: string;
    max_hops?: number;
    relation_types?: string[];
  },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);

  const { source_id, target_id, max_hops = 5, relation_types } = params;

  if (!source_id || !target_id) {
    return { error: 'source_id and target_id are required.' };
  }

  const relTypes =
    relation_types && relation_types.length > 0
      ? relation_types
      : [
          'CALLS',
          'IMPORTS',
          'EXTENDS',
          'IMPLEMENTS',
          'HAS_METHOD',
          'HAS_PROPERTY',
          'OVERRIDES',
          'ACCESSES',
          'DATA_FLOW',
        ];

  type BFSEntry = {
    nodeId: string;
    path: string[];
    edges: { sourceId: string; targetId: string; type: string; confidence: number | null }[];
  };
  const visited = new Set<string>();
  const queue: BFSEntry[] = [];

  queue.push({ nodeId: source_id, path: [source_id], edges: [] });
  visited.add(source_id);

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.path.length > max_hops) continue;

    if (current.nodeId === target_id) {
      const nodeDetails = await resolvePathNodes(repo.id, current.path);
      return {
        nodes: nodeDetails,
        edges: current.edges,
        hop_count: current.path.length - 1,
      };
    }

    const expandQuery = `
      MATCH (n {id: $nodeId})-[r:CodeRelation]->(target)
      WHERE r.type IN $relTypes AND NOT target.id IN $visited
      RETURN target.id AS targetId, r.type AS relType, r.confidence AS confidence
    `;

    try {
      const rows = await executeParameterized(repo.id, expandQuery, {
        nodeId: current.nodeId,
        relTypes,
        visited: Array.from(visited),
      });

      for (const row of rows) {
        const nextId: string = row.targetId ?? row[0];
        if (visited.has(nextId)) continue;
        visited.add(nextId);

        queue.push({
          nodeId: nextId,
          path: [...current.path, nextId],
          edges: [
            ...current.edges,
            {
              sourceId: current.nodeId,
              targetId: nextId,
              type: row.relType ?? row[1],
              confidence: row.confidence ?? row[2] ?? null,
            },
          ],
        });
      }
    } catch (e) {
      logQueryError('shortestPath:expand', e);
    }
  }

  return {
    nodes: [],
    edges: [],
    hop_count: -1,
    message: `No path found between ${source_id} and ${target_id} within ${max_hops} hops.`,
  };
}

/**
 * Standalone get_code tool — retrieve source code from a node's file span.
 */
export async function getCodeTool(
  repo: RepoHandle,
  params: {
    uid?: string;
    name?: string;
    file_path?: string;
  },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);

  const { uid, name, file_path } = params;

  if (!uid && !name) {
    return { error: 'uid or name parameter is required.' };
  }

  if (uid) {
    const label = uid.includes(':') ? uid.split(':')[0] : 'Unknown';
    if (!VALID_NODE_LABELS.has(label)) {
      return { error: `Invalid UID format: unknown label "${label}"` };
    }
    try {
      const rows = await executeParameterized(
        repo.id,
        `MATCH (n:\`${label}\` {id: $uid}) RETURN n.id AS id, n.name AS name, labels(n)[0] AS kind, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content LIMIT 1`,
        { uid },
      );
      if (rows.length === 0) {
        return { error: `Node ${uid} not found` };
      }
      const r = rows[0];
      return {
        uid: r.id ?? r[0],
        name: r.name ?? r[1],
        kind: r.kind ?? label,
        filePath: r.filePath ?? r[3],
        startLine: r.startLine ?? r[4],
        endLine: r.endLine ?? r[5],
        content: r.content ?? r[6] ?? null,
      };
    } catch (e) {
      logQueryError('getCode:uid-lookup', e);
      return { error: `Failed to fetch node: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  let whereClause = 'WHERE n.name = $symName';
  const queryParams: Record<string, string> = { symName: name! };

  if (file_path) {
    whereClause += ' AND n.filePath CONTAINS $filePath';
    queryParams.filePath = file_path;
  }

  try {
    const rows = await executeParameterized(
      repo.id,
      `MATCH (n) ${whereClause} RETURN n.id AS id, n.name AS name, labels(n)[0] AS kind, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content LIMIT 1`,
      queryParams,
    );
    if (rows.length === 0) {
      return {
        error: `No symbol found matching "${name}"${file_path ? ` in ${file_path}` : ''}`,
      };
    }
    const r = rows[0];
    return {
      uid: r.id ?? r[0],
      name: r.name ?? r[1],
      kind: r.kind ?? r[2],
      filePath: r.filePath ?? r[3],
      startLine: r.startLine ?? r[4],
      endLine: r.endLine ?? r[5],
      content: r.content ?? r[6] ?? null,
    };
  } catch (e) {
    logQueryError('getCode:name-lookup', e);
    return { error: `Failed to fetch symbol: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function apiImpactTool(
  repo: RepoHandle,
  params: { route?: string; file?: string },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);

  if (!params.route && !params.file) {
    return { error: 'Either "route" or "file" parameter is required.' };
  }

  // If file is provided but route is not, look up the route by file path
  let routeFilter = '';
  const queryParams: Record<string, string> = {};

  if (params.route) {
    routeFilter = `AND n.name CONTAINS $route`;
    queryParams.route = params.route;
  } else if (params.file) {
    routeFilter = `AND n.filePath CONTAINS $file`;
    queryParams.file = params.file;
  }

  const routes = await fetchRoutesWithConsumers(repo.id, routeFilter, queryParams);

  if (routes.length === 0) {
    const target = params.route || params.file;
    return { error: `No routes found matching "${target}".` };
  }

  const flowMap = await fetchLinkedFlowsBatch(
    repo.id,
    routes.map((r) => r.id),
  );

  // Count how many routes share the same handler file (for middleware partial detection)
  const routeCountByHandler = new Map<string, number>();
  for (const r of routes) {
    if (r.filePath) {
      routeCountByHandler.set(r.filePath, (routeCountByHandler.get(r.filePath) ?? 0) + 1);
    }
  }

  const results = routes.map((r) => {
    // Keys already normalized by fetchRoutesWithConsumers (quotes stripped)
    const responseKeys = r.responseKeys ?? [];
    const errorKeys = r.errorKeys ?? [];
    const allKnownKeys = new Set([...responseKeys, ...errorKeys]);

    // Build consumer list with mismatch detection
    const consumers = r.consumers.map((c) => ({
      name: c.name,
      file: c.filePath,
      accesses: c.accessedKeys ?? [],
      ...(c.fetchCount && c.fetchCount > 1
        ? {
            attributionNote: `This file fetches ${c.fetchCount} routes — accessed keys may belong to a different route.`,
          }
        : {}),
    }));

    // Detect mismatches: consumer accesses keys not in response shape
    const mismatches: Array<{
      consumer: string;
      field: string;
      reason: string;
      confidence: 'high' | 'low';
    }> = [];
    if (allKnownKeys.size > 0) {
      for (const c of r.consumers) {
        if (!c.accessedKeys) continue;
        const isMultiFetch = (c.fetchCount ?? 1) > 1;
        for (const key of c.accessedKeys) {
          if (!allKnownKeys.has(key)) {
            mismatches.push({
              consumer: c.filePath,
              field: key,
              reason: 'accessed but not in response shape',
              confidence: isMultiFetch ? 'low' : 'high',
            });
          }
        }
      }
    }

    const flows = flowMap.get(r.id) || [];
    const consumerCount = r.consumers.length;

    // Risk level heuristic
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    if (consumerCount >= 10) {
      riskLevel = 'HIGH';
    } else if (consumerCount >= 4) {
      riskLevel = 'MEDIUM';
    } else {
      riskLevel = 'LOW';
    }
    // Bump up one level if mismatches exist
    if (mismatches.length > 0) {
      if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
      else if (riskLevel === 'MEDIUM') riskLevel = 'HIGH';
    }

    const warning =
      consumerCount > 0
        ? `Changing response shape will affect ${consumerCount} component${consumerCount === 1 ? '' : 's'}`
        : undefined;

    // Flag when middleware was detected but handler exports multiple HTTP methods
    // (middleware chain may only reflect one export)
    const middlewareArr = r.middleware || [];
    const handlerRouteCount = r.filePath ? (routeCountByHandler.get(r.filePath) ?? 1) : 1;
    const middlewarePartial = middlewareArr.length > 0 && handlerRouteCount > 1;

    return {
      route: r.name,
      handler: r.filePath,
      responseShape: {
        success: responseKeys,
        error: errorKeys,
      },
      middleware: middlewareArr,
      ...(middlewarePartial
        ? {
            middlewareDetection: 'partial' as const,
            middlewareNote:
              'Middleware captured from first HTTP method export only — other methods in this handler may use different middleware chains.',
          }
        : {}),
      consumers,
      ...(mismatches.length > 0 ? { mismatches } : {}),
      executionFlows: flows,
      impactSummary: {
        directConsumers: consumerCount,
        affectedFlows: flows.length,
        riskLevel,
        ...(warning ? { warning } : {}),
      },
    };
  });

  // If a single route was targeted, return it directly (not wrapped in array)
  if (results.length === 1) {
    return results[0];
  }

  return { routes: results, total: results.length };
}
