/**
 * Query tool — process-grouped search (BM25 + semantic hybrid).
 */

import { executeParameterized, executeQuery } from '../../../core/lbug/pool-adapter.js';
import { logQueryError, VALID_NODE_LABELS, isTestFilePath } from './shared.js';
import type { RepoHandle } from './shared.js';

/**
 * Merge micro-flows that share the same entry point into aggregated high-level flows.
 *
 * When granularity is "high", processes sharing an entry point symbol are merged
 * into a single flow. Steps are deduplicated and sorted. The heuristicLabel is
 * derived from the entry point name to give a meaningful end-to-end description.
 */
export function aggregateProcesses(
  processes: Array<{
    id: string;
    summary: string;
    priority: number;
    symbol_count: number;
    process_type: string;
    step_count: number;
  }>,
  processSymbols: Array<{ id: string; process_id: string; step_index?: number; name: string; filePath: string; type?: string; startLine?: number; endLine?: number; module?: string; content?: string }>,
): { processes: typeof processes; process_symbols: typeof processSymbols } {
  // Group by entry point (first symbol in each process by step_index)
  const processFirstSymbol = new Map<string, { symbolId: string; symbolName: string }>();
  for (const sym of processSymbols) {
    if (sym.step_index === 1 || sym.step_index === 0) {
      processFirstSymbol.set(sym.process_id, { symbolId: sym.id, symbolName: sym.name });
    }
  }

  // Build entry-point → process IDs mapping
  const entryPointGroups = new Map<string, string[]>();
  for (const proc of processes) {
    const first = processFirstSymbol.get(proc.id);
    const key = first?.symbolId ?? proc.id; // fallback to process ID if no step-1 symbol
    if (!entryPointGroups.has(key)) entryPointGroups.set(key, []);
    entryPointGroups.get(key)!.push(proc.id);
  }

  // Only aggregate when multiple processes share an entry point
  const aggregated = new Map<string, {
    proc: typeof processes[0];
    symbolIds: Set<string>;
  }>();

  const usedProcessIds = new Set<string>();

  for (const [_entryKey, procIds] of entryPointGroups) {
    if (procIds.length <= 1) {
      // Single process — keep as-is
      continue;
    }

    // Merge: combine symbols, sum priority, use first process as template
    const procs = procIds.map((id) => processes.find((p) => p.id === id)!).filter(Boolean);
    if (procs.length === 0) continue;

    const mergedId = `flow_${procs[0].id}`;
    const mergedPriority = procs.reduce((sum, p) => sum + p.priority, 0);
    const totalSymbols = new Set<string>();
    for (const pid of procIds) {
      for (const sym of processSymbols) {
        if (sym.process_id === pid) totalSymbols.add(sym.id);
      }
    }

    // Build a meaningful label from the entry point
    const firstSym = processFirstSymbol.get(procs[0].id);
    const entryLabel = firstSym?.symbolName ?? procs[0].summary;
    const stepTotal = procs.reduce((sum, p) => sum + p.step_count, 0);

    aggregated.set(mergedId, {
      proc: {
        id: mergedId,
        summary: `Flow: ${entryLabel} (+${procs.length - 1} traces)`,
        priority: mergedPriority,
        symbol_count: totalSymbols.size,
        process_type: 'aggregated',
        step_count: stepTotal,
      },
      symbolIds: totalSymbols,
    });

    for (const pid of procIds) usedProcessIds.add(pid);
  }

  // Build final results: aggregated flows first, then unaggregated singletons
  const resultProcesses: typeof processes = [];
  const resultSymbols: typeof processSymbols = [];

  // Add aggregated flows
  for (const [mergedId, { proc, symbolIds }] of aggregated) {
    resultProcesses.push(proc);
    for (const sym of processSymbols) {
      if (symbolIds.has(sym.id)) {
        resultSymbols.push({ ...sym, process_id: mergedId });
      }
    }
  }

  // Add remaining singletons
  for (const proc of processes) {
    if (usedProcessIds.has(proc.id)) continue;
    resultProcesses.push(proc);
    for (const sym of processSymbols) {
      if (sym.process_id === proc.id) resultSymbols.push(sym);
    }
  }

  return { processes: resultProcesses, process_symbols: resultSymbols };
}

/**
 * Query tool — process-grouped search.
 *
 * 1. Hybrid search (BM25 + semantic) to find matching symbols
 * 2. Trace each match to its process(es) via STEP_IN_PROCESS
 * 3. Group by process, rank by aggregate relevance + internal cluster cohesion
 * 4. Return: { processes, process_symbols, definitions }
 */
export async function queryTool(
  repo: RepoHandle,
  params: {
    query: string;
    task_context?: string;
    goal?: string;
    limit?: number;
    max_symbols?: number;
    include_content?: boolean;
    method?: string;
    relevance_threshold?: number;
    granularity?: 'low' | 'high';
  },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  if (!params.query?.trim()) {
    return { error: 'query parameter is required and cannot be empty.' };
  }

  await ensureInitialized(repo.id);

  const processLimit = params.limit || 5;
  const maxSymbolsPerProcess = params.max_symbols || 10;
  const includeContent = params.include_content ?? false;
  const searchQuery = params.query.trim();
  const method = params.method ?? 'hybrid';
  const relevanceThreshold = params.relevance_threshold ?? 0;

  // Step 1: Run search based on method
  const searchLimit = processLimit * maxSymbolsPerProcess; // fetch enough raw results
  let bm25Results: any[] = [];
  let semanticResults: any[] = [];
  let ftsWarning: string | undefined;

  if (method === 'fulltext' || method === 'bm25') {
    const bm25SearchResult = await bm25SearchHelper(repo, searchQuery, searchLimit);
    bm25Results = bm25SearchResult.results;
    ftsWarning = bm25SearchResult.ftsWarning;
  } else if (method === 'vector' || method === 'semantic') {
    semanticResults = await semanticSearchHelper(repo, searchQuery, searchLimit);
  } else {
    // hybrid (default)
    const [bm25SearchResult, semResults] = await Promise.all([
      bm25SearchHelper(repo, searchQuery, searchLimit),
      semanticSearchHelper(repo, searchQuery, searchLimit),
    ]);
    bm25Results = bm25SearchResult.results;
    ftsWarning = bm25SearchResult.ftsWarning;
    semanticResults = semResults;
  }

  // Merge via reciprocal rank fusion
  const scoreMap = new Map<string, { score: number; data: any }>();

  for (let i = 0; i < bm25Results.length; i++) {
    const result = bm25Results[i];
    const key = result.nodeId || result.filePath;
    const rrfScore = 1 / (20 + i);
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(key, { score: rrfScore, data: result });
    }
  }

  for (let i = 0; i < semanticResults.length; i++) {
    const result = semanticResults[i];
    const key = result.nodeId || result.filePath;
    const rrfScore = 1 / (20 + i);
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(key, { score: rrfScore, data: result });
    }
  }

  const merged = Array.from(scoreMap.entries())
    .sort((a, b) => {
      // Primary: higher RRF score first
      const scoreDiff = b[1].score - a[1].score;
      if (scoreDiff !== 0) return scoreDiff;
      // Tiebreaker: non-test files rank above test files
      const aIsTest = isTestFilePath(a[1].data.filePath || '');
      const bIsTest = isTestFilePath(b[1].data.filePath || '');
      return aIsTest === bIsTest ? 0 : aIsTest ? 1 : -1;
    })
    .slice(0, searchLimit);

  // Filter by relevance threshold
  const thresholded =
    relevanceThreshold > 0 ? merged.filter(([, val]) => val.score >= relevanceThreshold) : merged;

  // Step 2: For each match with a nodeId, trace to process(es)
  const processMap = new Map<
    string,
    {
      id: string;
      label: string;
      heuristicLabel: string;
      processType: string;
      stepCount: number;
      totalScore: number;
      cohesionBoost: number;
      symbols: any[];
    }
  >();
  const definitions: any[] = []; // standalone symbols not in any process

  for (const [_, item] of thresholded) {
    const sym = item.data;
    if (!sym.nodeId) {
      // File-level results go to definitions
      definitions.push({
        name: sym.name,
        type: sym.type || 'File',
        filePath: sym.filePath,
      });
      continue;
    }

    // Find processes this symbol participates in
    let processRows: any[] = [];
    try {
      processRows = await executeParameterized(
        repo.id,
        `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `,
        { nodeId: sym.nodeId },
      );
    } catch (e) {
      logQueryError('query:process-lookup', e);
    }

    // Get cluster membership + cohesion (cohesion used as internal ranking signal)
    let cohesion = 0;
    let module: string | undefined;
    try {
      const cohesionRows = await executeParameterized(
        repo.id,
        `
          MATCH (n {id: $nodeId})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.cohesion AS cohesion, c.heuristicLabel AS module
          LIMIT 1
        `,
        { nodeId: sym.nodeId },
      );
      if (cohesionRows.length > 0) {
        cohesion = (cohesionRows[0].cohesion ?? cohesionRows[0][0]) || 0;
        module = cohesionRows[0].module ?? cohesionRows[0][1];
      }
    } catch (e) {
      logQueryError('query:cluster-info', e);
    }

    // Optionally fetch content
    let content: string | undefined;
    if (includeContent) {
      try {
        const contentRows = await executeParameterized(
          repo.id,
          `
            MATCH (n {id: $nodeId})
            RETURN n.content AS content
          `,
          { nodeId: sym.nodeId },
        );
        if (contentRows.length > 0) {
          content = contentRows[0].content ?? contentRows[0][0];
        }
      } catch (e) {
        logQueryError('query:content-fetch', e);
      }
    }

    const symbolEntry = {
      id: sym.nodeId,
      name: sym.name,
      type: sym.type,
      filePath: sym.filePath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      ...(module ? { module } : {}),
      ...(includeContent && content ? { content } : {}),
    };

    if (processRows.length === 0) {
      // Symbol not in any process — goes to definitions
      definitions.push(symbolEntry);
    } else {
      // Add to each process it belongs to
      for (const row of processRows) {
        const pid = row.pid ?? row[0];
        const label = row.label ?? row[1];
        const hLabel = row.heuristicLabel ?? row[2];
        const pType = row.processType ?? row[3];
        const stepCount = row.stepCount ?? row[4];
        const step = row.step ?? row[5];

        if (!processMap.has(pid)) {
          processMap.set(pid, {
            id: pid,
            label,
            heuristicLabel: hLabel,
            processType: pType,
            stepCount,
            totalScore: 0,
            cohesionBoost: 0,
            symbols: [],
          });
        }

        const proc = processMap.get(pid)!;
        proc.totalScore += item.score;
        proc.cohesionBoost = Math.max(proc.cohesionBoost, cohesion);
        proc.symbols.push({
          ...symbolEntry,
          process_id: pid,
          step_index: step,
        });
      }
    }
  }

  // Step 3: Rank processes by aggregate score + internal cohesion boost
  const rankedProcesses = Array.from(processMap.values())
    .map((p) => ({
      ...p,
      priority: p.totalScore + p.cohesionBoost * 0.1, // cohesion as subtle ranking signal
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, processLimit);

  // Step 4: Build response
  const processes = rankedProcesses.map((p) => ({
    id: p.id,
    summary: p.heuristicLabel || p.label,
    priority: Math.round(p.priority * 1000) / 1000,
    symbol_count: p.symbols.length,
    process_type: p.processType,
    step_count: p.stepCount,
  }));

  const processSymbols = rankedProcesses.flatMap((p) =>
    p.symbols.slice(0, maxSymbolsPerProcess).map((s) => ({
      ...s,
      // remove internal fields
    })),
  );

  // Deduplicate process_symbols by id
  const seen = new Set<string>();
  const dedupedSymbols = processSymbols.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  // Step 5: Apply flow aggregation when granularity is "high"
  const granularity = params.granularity ?? 'low';
  if (granularity === 'high' && processes.length > 1) {
    const aggregated = aggregateProcesses(processes, dedupedSymbols);
    return {
      processes: aggregated.processes,
      process_symbols: aggregated.process_symbols,
      definitions: definitions.slice(0, 20),
      ...(ftsWarning ? { warning: ftsWarning } : {}),
    };
  }

  return {
    processes,
    process_symbols: dedupedSymbols,
    definitions: definitions.slice(0, 20), // cap standalone definitions
    ...(ftsWarning ? { warning: ftsWarning } : {}),
  };
}

/**
 * BM25 keyword search helper - uses LadybugDB FTS for always-fresh results
 */
async function bm25SearchHelper(
  repo: RepoHandle,
  query: string,
  limit: number,
): Promise<{ results: any[]; ftsUsed: boolean; ftsWarning?: string }> {
  const { searchFTSFromLbug, getFTSHealthWarning } =
    await import('../../../core/search/bm25-index.js');
  let bm25Results;
  try {
    bm25Results = await searchFTSFromLbug(query, limit, repo.id);
  } catch (err: any) {
    console.error('GitNexus: BM25/FTS search failed (FTS indexes may not exist) -', err.message);
    return {
      results: [],
      ftsUsed: false,
      ftsWarning:
        'FTS indexes missing or unavailable - keyword search degraded. Run: gitnexus analyze --force to rebuild indexes.',
    };
  }

  const ftsResponse = bm25Results as any;
  const ftsUsed = ftsResponse.ftsAvailable !== false;
  const ftsWarning = getFTSHealthWarning(ftsResponse);
  const bm25List: any[] = ftsResponse.results ?? bm25Results;

  const results: any[] = [];

  for (const bm25Result of bm25List) {
    const fullPath = bm25Result.filePath;
    try {
      const symbols = await executeParameterized(
        repo.id,
        `
          MATCH (n)
          WHERE n.filePath = $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
          LIMIT 3
        `,
        { filePath: fullPath },
      );

      if (symbols.length > 0) {
        for (const sym of symbols) {
          results.push({
            nodeId: sym.id || sym[0],
            name: sym.name || sym[1],
            type: sym.type || sym[2],
            filePath: sym.filePath || sym[3],
            startLine: sym.startLine || sym[4],
            endLine: sym.endLine || sym[5],
            bm25Score: bm25Result.score,
          });
        }
      } else {
        const fileName = fullPath.split('/').pop() || fullPath;
        results.push({
          name: fileName,
          type: 'File',
          filePath: bm25Result.filePath,
          bm25Score: bm25Result.score,
        });
      }
    } catch (e) {
      logQueryError('bm25Search:symbol-lookup', e);
      const fileName = fullPath.split('/').pop() || fullPath;
      results.push({
        name: fileName,
        type: 'File',
        filePath: bm25Result.filePath,
        bm25Score: bm25Result.score,
      });
    }
  }

  return { results, ftsUsed, ftsWarning };
}

/**
 * Semantic vector search helper
 */
async function semanticSearchHelper(
  repo: RepoHandle,
  query: string,
  limit: number,
): Promise<any[]> {
  try {
    // Check if embedding table exists before loading the model (avoids heavy model init when embeddings are off)
    const tableCheck = await executeQuery(
      repo.id,
      `MATCH (e:CodeEmbedding) RETURN COUNT(*) AS cnt LIMIT 1`,
    );
    if (!tableCheck.length || (tableCheck[0].cnt ?? tableCheck[0][0]) === 0) return [];

    const { embedQuery, getEmbeddingDims } = await import('../../core/embedder.js');
    const queryVec = await embedQuery(query);
    const dims = getEmbeddingDims();
    const queryVecStr = `[${queryVec.join(',')}]`;

    const vectorQuery = `
        CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 
          CAST(${queryVecStr} AS FLOAT[${dims}]), ${limit})
        YIELD node AS emb, distance
        WITH emb, distance
        WHERE distance < 0.25
        RETURN emb.nodeId AS nodeId, distance
        ORDER BY distance
      `;

    const embResults = await executeQuery(repo.id, vectorQuery);

    if (embResults.length === 0) return [];

    const results: any[] = [];

    for (const embRow of embResults) {
      const nodeId = embRow.nodeId ?? embRow[0];
      const distance = embRow.distance ?? embRow[1];

      const labelEndIdx = nodeId.indexOf(':');
      const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';

      // Validate label against known node types to prevent Cypher injection
      if (!VALID_NODE_LABELS.has(label)) continue;

      try {
        const nodeQuery =
          label === 'File'
            ? `MATCH (n:File {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`
            : `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;

        const nodeRows = await executeParameterized(repo.id, nodeQuery, { nodeId });
        if (nodeRows.length > 0) {
          const nodeRow = nodeRows[0];
          results.push({
            nodeId,
            name: nodeRow.name ?? nodeRow[0] ?? '',
            type: label,
            filePath: nodeRow.filePath ?? nodeRow[1] ?? '',
            distance,
            startLine: label !== 'File' ? (nodeRow.startLine ?? nodeRow[2]) : undefined,
            endLine: label !== 'File' ? (nodeRow.endLine ?? nodeRow[3]) : undefined,
          });
        }
      } catch (e) {
        logQueryError('semanticSearch:node-lookup', e);
      }
    }

    return results;
  } catch {
    // Expected when embeddings are disabled — silently fall back to BM25-only
    return [];
  }
}
