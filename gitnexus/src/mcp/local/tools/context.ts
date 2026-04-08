/**
 * Context tool — 360-degree symbol view with categorized refs.
 * Explore tool — legacy backwards-compatible cluster/process/symbol exploration.
 */

import { executeParameterized } from '../../../core/lbug/pool-adapter.js';
import { logQueryError } from './shared.js';
import type { RepoHandle } from './shared.js';

/**
 * Context tool — 360-degree symbol view with categorized refs.
 * Disambiguation when multiple symbols share a name.
 * UID-based direct lookup. No cluster in output.
 */
export async function contextTool(
  repo: RepoHandle,
  params: {
    name?: string;
    uid?: string;
    file_path?: string;
    include_content?: boolean;
    /** When false, omit the `evidence` block from the response. Default: true */
    include_evidence?: boolean;
  },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);

  const { name, uid, file_path, include_content, include_evidence = true } = params;

  if (!name && !uid) {
    return { error: 'Either "name" or "uid" parameter is required.' };
  }

  // Step 1: Find the symbol
  let symbols: any[];

  if (uid) {
    symbols = await executeParameterized(
      repo.id,
      `
        MATCH (n {id: $uid})
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
        LIMIT 1
      `,
      { uid },
    );
  } else {
    // Support dot-separated "Class.method" syntax for disambiguation (like ContactUtil.getDisplayName)
    const dotIdx = name!.lastIndexOf('.');
    const parentClassName = dotIdx > 0 ? name!.substring(0, dotIdx) : undefined;
    const baseName = dotIdx > 0 ? name!.substring(dotIdx + 1) : name!;

    let query: string;
    let queryParams: Record<string, any>;

    if (parentClassName) {
      // Resolve via Class membership edge — matches both Method (Java) and Function (Kotlin) nodes.
      // LadybugDB stores HAS_METHOD/HAS_PROPERTY as r.type on CodeRelation edges.
      // Use two MATCHes with OR to avoid the IN-list bug on relationship properties.
      query = `
          MATCH (parent:\`Class\`)-[r:CodeRelation]->(n)
          WHERE parent.name = $parentClassName AND n.name = $baseName AND r.type = 'HAS_METHOD'
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
          LIMIT 10
        UNION ALL
          MATCH (parent:\`Class\`)-[r:CodeRelation]->(n)
          WHERE parent.name = $parentClassName AND n.name = $baseName AND r.type = 'HAS_PROPERTY'
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
          LIMIT 10
        `;
      queryParams = { parentClassName, baseName };
    } else if (file_path) {
      query = `
          MATCH (n) WHERE n.name = $symName AND n.filePath CONTAINS $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
          LIMIT 10
        `;
      queryParams = { symName: name!, filePath: file_path };
    } else {
      query = `
          MATCH (n) WHERE n.name = $symName
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
          LIMIT 10
        `;
      queryParams = { symName: name! };
    }

    symbols = await executeParameterized(repo.id, query, queryParams);
  }

  if (symbols.length === 0) {
    return { error: `Symbol '${name || uid}' not found` };
  }

  // Step 2: Disambiguation
  let resolvedLabel = '';
  if (symbols.length > 1 && !uid) {
    const hasAmbiguousType = symbols.some((s: any) => {
      const t = s.type || s[2] || '';
      return t === '' || t === 'Constructor';
    });
    if (hasAmbiguousType) {
      const candidateIds = symbols.map((s: any) => s.id || s[0]).filter(Boolean);
      const PREFER_LABELS = ['Class', 'Interface'];
      let preferred: any = null;
      for (const label of PREFER_LABELS) {
        const match = await executeParameterized(
          repo.id,
          `
            MATCH (n:\`${label}\`) WHERE n.id IN $candidateIds RETURN n.id AS id LIMIT 1
          `,
          { candidateIds },
        ).catch(() => []);
        if (match.length > 0) {
          preferred = symbols.find((s: any) => (s.id || s[0]) === (match[0].id || match[0][0]));
          if (preferred) {
            resolvedLabel = label;
            break;
          }
        }
      }
      if (preferred) symbols = [preferred];
    }
  }

  if (symbols.length > 1 && !uid) {
    return {
      status: 'ambiguous',
      message: `Found ${symbols.length} symbols matching '${name}'. Use uid or file_path to disambiguate.`,
      candidates: symbols.map((s: any) => ({
        uid: s.id || s[0],
        name: s.name || s[1],
        kind: s.type || s[2],
        filePath: s.filePath || s[3],
        line: s.startLine || s[4],
      })),
    };
  }

  // Step 3: Build full context
  const sym = symbols[0];
  const symId = sym.id || sym[0];

  // Categorized incoming refs
  const incomingRows = await executeParameterized(
    repo.id,
    `
      MATCH (caller)-[r:CodeRelation]->(n {id: $symId})
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
      RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind,
             r.confidence AS confidence, r.reason AS reason, caller.startLine AS startLine, caller.endLine AS endLine
      LIMIT 30
    `,
    { symId },
  );

  // Fix #480: Class/Interface nodes have no direct CALLS/IMPORTS edges —
  // those point to Constructor and File nodes respectively.
  const symRawType = sym.type || sym[2] || '';
  let isClassLike = resolvedLabel === 'Class' || resolvedLabel === 'Interface';
  if (!isClassLike && symRawType === '') {
    try {
      const typeCheck = await executeParameterized(
        repo.id,
        `
          MATCH (n:Class) WHERE n.id = $symId RETURN 'Class' AS label LIMIT 1
          UNION ALL
          MATCH (n:Interface) WHERE n.id = $symId RETURN 'Interface' AS label LIMIT 1
        `,
        { symId },
      );
      isClassLike = typeCheck.length > 0;
    } catch (e) {
      logQueryError('context:class-type-check', e);
    }
  } else if (!isClassLike) {
    isClassLike = symRawType === 'Class' || symRawType === 'Interface';
  }

  if (isClassLike) {
    try {
      // Run both incoming-ref queries in parallel — they are independent.
      const [ctorIncoming, fileIncoming] = await Promise.all([
        executeParameterized(
          repo.id,
          `
            MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            MATCH (caller)-[r:CodeRelation]->(ctor)
            WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'ACCESSES']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind,
                   r.confidence AS confidence, r.reason AS reason, caller.startLine AS startLine, caller.endLine AS endLine
            LIMIT 30
          `,
          { symId },
        ),
        executeParameterized(
          repo.id,
          `
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            MATCH (caller)-[r:CodeRelation]->(f)
            WHERE r.type IN ['CALLS', 'IMPORTS']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind,
                   r.confidence AS confidence, r.reason AS reason, caller.startLine AS startLine, caller.endLine AS endLine
            LIMIT 30
          `,
          { symId },
        ),
      ]);

      const seenKeys = new Set(
        incomingRows.map((r: any) => `${r.relType || r[0]}:${r.uid || r[1]}`),
      );
      for (const r of [...ctorIncoming, ...fileIncoming]) {
        const key = `${r.relType || r[0]}:${r.uid || r[1]}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          incomingRows.push(r);
        }
      }
    } catch (e) {
      logQueryError('context:class-incoming-expansion', e);
    }
  }

  // Categorized outgoing refs
  const outgoingRows = await executeParameterized(
    repo.id,
    `
      MATCH (n {id: $symId})-[r:CodeRelation]->(target)
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
      RETURN r.type AS relType, target.id AS uid, target.name AS name, target.filePath AS filePath, labels(target)[0] AS kind,
             r.confidence AS confidence, r.reason AS reason, target.startLine AS startLine, target.endLine AS endLine
      LIMIT 30
    `,
    { symId },
  );

  // Process participation
  let processRows: any[] = [];
  try {
    processRows = await executeParameterized(
      repo.id,
      `
        MATCH (n {id: $symId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        RETURN p.id AS pid, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      `,
      { symId },
    );
  } catch (e) {
    logQueryError('context:process-participation', e);
  }

  // Helper to categorize refs
  const categorize = (rows: any[]) => {
    const cats: Record<string, any[]> = {};
    for (const row of rows) {
      const relType = (row.relType || row[0] || '').toLowerCase();
      const entry = {
        uid: row.uid || row[1],
        name: row.name || row[2],
        filePath: row.filePath || row[3],
        kind: row.kind || row[4],
        confidence: row.confidence ?? row[5] ?? null,
        reason: row.reason ?? row[6] ?? '',
        startLine: row.startLine ?? row[7] ?? null,
        endLine: row.endLine ?? row[8] ?? null,
      };
      if (!cats[relType]) cats[relType] = [];
      cats[relType].push(entry);
    }
    return cats;
  };

  const incoming = categorize(incomingRows);
  const outgoing = categorize(outgoingRows);
  const relationEvidence = [...incomingRows, ...outgoingRows].map((row: any) => ({
    relationType: row.relType || row[0],
    uid: row.uid || row[1],
    name: row.name || row[2],
    filePath: row.filePath || row[3],
    kind: row.kind || row[4],
    confidence: row.confidence ?? row[5] ?? null,
    reason: row.reason ?? row[6] ?? '',
    startLine: row.startLine ?? row[7] ?? null,
    endLine: row.endLine ?? row[8] ?? null,
  }));
  const relationConfidences = relationEvidence
    .map((row) => row.confidence)
    .filter((value): value is number => typeof value === 'number');

  // Method/Function/Constructor enrichment: fetch method-specific properties
  const symKind = isClassLike ? resolvedLabel || 'Class' : sym.type || sym[2];
  const isMethodLike = symKind === 'Method' || symKind === 'Function' || symKind === 'Constructor';
  let methodMetadata: Record<string, unknown> | undefined;
  if (isMethodLike) {
    try {
      const metaRows = await executeParameterized(
        repo.id,
        `
          MATCH (n {id: $symId})
          RETURN n.visibility AS visibility, n.isStatic AS isStatic, n.isAbstract AS isAbstract,
                 n.isFinal AS isFinal, n.isVirtual AS isVirtual, n.isOverride AS isOverride,
                 n.isAsync AS isAsync, n.isPartial AS isPartial, n.returnType AS returnType,
                 n.parameterCount AS parameterCount, n.isVariadic AS isVariadic,
                 n.requiredParameterCount AS requiredParameterCount,
                 n.parameterTypes AS parameterTypes, n.annotations AS annotations
          LIMIT 1
        `,
        { symId },
      );
      if (metaRows.length > 0) {
        const row = metaRows[0];
        const meta: Record<string, unknown> = {};
        // Only include defined properties to distinguish "not applicable" from "not enriched"
        for (const key of Object.keys(row)) {
          const val = row[key];
          if (val !== null && val !== undefined) meta[key] = val;
        }
        if (Object.keys(meta).length > 0) methodMetadata = meta;
      }
    } catch {
      /* method metadata unavailable — omit silently */
    }
  }

  return {
    status: 'found',
    symbol: {
      uid: sym.id || sym[0],
      name: sym.name || sym[1],
      kind: symKind,
      filePath: sym.filePath || sym[3],
      startLine: sym.startLine || sym[4],
      endLine: sym.endLine || sym[5],
      ...(include_content && (sym.content || sym[6]) ? { content: sym.content || sym[6] } : {}),
      ...(methodMetadata ? { methodMetadata } : {}),
    },
    incoming,
    outgoing,
    processes: processRows.map((r: any) => ({
      id: r.pid || r[0],
      name: r.label || r[1],
      step_index: r.step || r[2],
      step_count: r.stepCount || r[3],
    })),
    ...(include_evidence && {
      evidence: {
        explanation:
          'Incoming and outgoing references are backed by direct CodeRelation edges; process entries are backed by STEP_IN_PROCESS edges.',
        relation_count: relationEvidence.length,
        process_count: processRows.length,
        confidence:
          relationConfidences.length > 0
            ? {
                min: Math.min(...relationConfidences),
                max: Math.max(...relationConfidences),
                average:
                  Math.round(
                    (relationConfidences.reduce((sum, value) => sum + value, 0) /
                      relationConfidences.length) *
                      100,
                  ) / 100,
              }
            : null,
        supporting_relations: relationEvidence,
        processes: processRows.map((r: any) => ({
          id: r.pid || r[0],
          name: r.label || r[1],
          step_index: r.step || r[2],
          step_count: r.stepCount || r[3],
        })),
      },
    }),
  };
}

/**
 * Legacy explore — kept for backwards compatibility with resources.ts.
 * Routes cluster/process types to direct graph queries.
 */
export async function exploreTool(
  repo: RepoHandle,
  params: { name: string; type: 'symbol' | 'cluster' | 'process' },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);
  const { name, type } = params;

  if (type === 'symbol') {
    return contextTool(repo, { name }, ensureInitialized);
  }

  if (type === 'cluster') {
    const clusters = await executeParameterized(
      repo.id,
      `
        MATCH (c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
      `,
      { clusterName: name },
    );
    if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

    const rawClusters = clusters.map((c: any) => ({
      id: c.id || c[0],
      label: c.label || c[1],
      heuristicLabel: c.heuristicLabel || c[2],
      cohesion: c.cohesion || c[3],
      symbolCount: c.symbolCount || c[4],
    }));

    let totalSymbols = 0,
      weightedCohesion = 0;
    for (const c of rawClusters) {
      const s = c.symbolCount || 0;
      totalSymbols += s;
      weightedCohesion += (c.cohesion || 0) * s;
    }

    const members = await executeParameterized(
      repo.id,
      `
        MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
        WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
        RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
        LIMIT 30
      `,
      { clusterName: name },
    );

    return {
      cluster: {
        id: rawClusters[0].id,
        label: rawClusters[0].heuristicLabel || rawClusters[0].label,
        heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
        cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
        symbolCount: totalSymbols,
        subCommunities: rawClusters.length,
      },
      members: members.map((m: any) => ({
        name: m.name || m[0],
        type: m.type || m[1],
        filePath: m.filePath || m[2],
      })),
    };
  }

  if (type === 'process') {
    const processes = await executeParameterized(
      repo.id,
      `
        MATCH (p:Process)
        WHERE p.label = $processName OR p.heuristicLabel = $processName
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        LIMIT 1
      `,
      { processName: name },
    );
    if (processes.length === 0) return { error: `Process '${name}' not found` };

    const proc = processes[0];
    const procId = proc.id || proc[0];
    const steps = await executeParameterized(
      repo.id,
      `
        MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
        RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
        ORDER BY r.step
      `,
      { procId },
    );

    return {
      process: {
        id: procId,
        label: proc.label || proc[1],
        heuristicLabel: proc.heuristicLabel || proc[2],
        processType: proc.processType || proc[3],
        stepCount: proc.stepCount || proc[4],
      },
      steps: steps.map((s: any) => ({
        step: s.step || s[3],
        name: s.name || s[0],
        type: s.type || s[1],
        filePath: s.filePath || s[2],
      })),
    };
  }

  return { error: 'Invalid type. Use: symbol, cluster, or process' };
}
