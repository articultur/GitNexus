/**
 * Overview tool — repo summary, clusters, processes.
 * Also exports aggregateClusters and formatCypherAsMarkdown utilities.
 */

import { executeParameterized, executeQuery } from '../../../core/lbug/pool-adapter.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { isLanguageAvailable } from '../../../core/tree-sitter/parser-loader.js';
import { logQueryError } from './shared.js';
import type { RepoHandle, CodebaseContext, RepoOverview } from './shared.js';

/**
 * Aggregate same-named clusters: group by heuristicLabel, sum symbols,
 * weighted-average cohesion, filter out tiny clusters (<5 symbols).
 * Raw communities stay intact in LadybugDB for Cypher queries.
 */
export function aggregateClusters(clusters: any[]): any[] {
  const groups = new Map<
    string,
    { ids: string[]; totalSymbols: number; weightedCohesion: number; largest: any }
  >();

  for (const c of clusters) {
    const rawLabel = c.heuristicLabel || c.label || 'Unknown';
    // Strip numeric suffix added by label deduplication (e.g. "Ingestion-2" → "Ingestion")
    const label = rawLabel.replace(/-\d+$/, '');
    const symbols = c.symbolCount || 0;
    const cohesion = c.cohesion || 0;
    const existing = groups.get(label);

    if (!existing) {
      groups.set(label, {
        ids: [c.id],
        totalSymbols: symbols,
        weightedCohesion: cohesion * symbols,
        largest: c,
      });
    } else {
      existing.ids.push(c.id);
      existing.totalSymbols += symbols;
      existing.weightedCohesion += cohesion * symbols;
      if (symbols > (existing.largest.symbolCount || 0)) {
        existing.largest = c;
      }
    }
  }

  return Array.from(groups.entries())
    .map(([label, g]) => ({
      id: g.largest.id,
      label,
      heuristicLabel: label,
      symbolCount: g.totalSymbols,
      cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
      subCommunities: g.ids.length,
    }))
    .filter((c) => c.symbolCount >= 5)
    .sort((a, b) => b.symbolCount - a.symbolCount);
}

/**
 * Format raw Cypher result rows as a markdown table for LLM readability.
 * Falls back to raw result if rows aren't tabular objects.
 */
export function formatCypherAsMarkdown(result: any): any {
  if (!Array.isArray(result) || result.length === 0) return result;

  const firstRow = result[0];
  if (typeof firstRow !== 'object' || firstRow === null) return result;

  const keys = Object.keys(firstRow);
  if (keys.length === 0) return result;

  const header = '| ' + keys.join(' | ') + ' |';
  const separator = '| ' + keys.map(() => '---').join(' | ') + ' |';
  const dataRows = result.map(
    (row: any) =>
      '| ' +
      keys
        .map((k) => {
          const v = row[k];
          if (v === null || v === undefined) return '';
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        })
        .join(' | ') +
      ' |',
  );

  return {
    markdown: [header, separator, ...dataRows].join('\n'),
    row_count: result.length,
  };
}

export async function overviewTool(
  repo: RepoHandle,
  params: { showClusters?: boolean; showProcesses?: boolean; limit?: number },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);

  const limit = params.limit || 20;
  const result: any = {
    repo: repo.name,
    repoPath: repo.repoPath,
    stats: repo.stats,
    indexedAt: repo.indexedAt,
    lastCommit: repo.lastCommit,
  };

  if (params.showClusters !== false) {
    try {
      // Fetch more raw communities than the display limit so aggregation has enough data
      const rawLimit = Math.max(limit * 5, 200);
      const clusters = await executeParameterized(
        repo.id,
        `
          MATCH (c:Community)
          RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
          ORDER BY c.symbolCount DESC
          LIMIT $limit
        `,
        { limit: rawLimit },
      );
      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0],
        label: c.label || c[1],
        heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3],
        symbolCount: c.symbolCount || c[4],
      }));
      result.clusters = aggregateClusters(rawClusters).slice(0, limit);
    } catch (e) {
      logQueryError('overview:clusters', e);
      result.clusters = [];
    }
  }

  if (params.showProcesses !== false) {
    try {
      const processes = await executeParameterized(
        repo.id,
        `
          MATCH (p:Process)
          RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
          ORDER BY p.stepCount DESC
          LIMIT $limit
        `,
        { limit },
      );
      result.processes = processes.map((p: any) => ({
        id: p.id || p[0],
        label: p.label || p[1],
        heuristicLabel: p.heuristicLabel || p[2],
        processType: p.processType || p[3],
        stepCount: p.stepCount || p[4],
      }));
    } catch (e) {
      logQueryError('overview:processes', e);
      result.processes = [];
    }
  }

  return result;
}

export async function queryRepoOverviewTool(
  repo: RepoHandle,
  context: CodebaseContext | null,
  ensureInitialized: (id: string) => Promise<void>,
): Promise<RepoOverview> {
  await ensureInitialized(repo.id);

  const ctx: CodebaseContext = context || {
    projectName: repo.name,
    stats: {
      fileCount: repo.stats?.files || 0,
      functionCount: repo.stats?.nodes || 0,
      communityCount: repo.stats?.communities || 0,
      processCount: repo.stats?.processes || 0,
    },
  };

  const [fileImportCycles, oversizedSymbols, crossModuleEdges, topIncoming, topOutgoing] =
    await Promise.all([
      executeQuery(
        repo.id,
        `
          MATCH (a:File)-[:CodeRelation {type: 'IMPORTS'}]->(b:File)
          MATCH (b)-[:CodeRelation {type: 'IMPORTS'}]->(a)
          WHERE a.id < b.id
          RETURN COUNT(*) AS count
        `,
      ).catch(() => []),
      executeQuery(
        repo.id,
        `
          MATCH (n)
          WHERE labels(n)[0] IN ['Function', 'Method', 'Class']
            AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL
            AND (
              (labels(n)[0] IN ['Function', 'Method'] AND (n.endLine - n.startLine + 1) >= 80)
              OR (labels(n)[0] = 'Class' AND (n.endLine - n.startLine + 1) >= 200)
            )
          RETURN COUNT(*) AS count
        `,
      ).catch(() => []),
      executeQuery(
        repo.id,
        `
          MATCH (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(c1:Community)
          MATCH (a)-[r:CodeRelation]->(b)
          MATCH (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(c2:Community)
          WHERE r.type IN ['CALLS', 'IMPORTS'] AND c1.id <> c2.id
          RETURN COUNT(DISTINCT r) AS count
        `,
      ).catch(() => []),
      executeQuery(
        repo.id,
        `
          MATCH (src)-[r:CodeRelation]->(n)
          WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
          RETURN n.name AS name, n.filePath AS filePath, COUNT(*) AS count
          ORDER BY count DESC
          LIMIT 5
        `,
      ).catch(() => []),
      executeQuery(
        repo.id,
        `
          MATCH (n)-[r:CodeRelation]->(dst)
          WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
          RETURN n.name AS name, n.filePath AS filePath, COUNT(*) AS count
          ORDER BY count DESC
          LIMIT 5
        `,
      ).catch(() => []),
    ]);

  const optionalParsers = new Set<string>([
    SupportedLanguages.Kotlin,
    SupportedLanguages.Swift,
    SupportedLanguages.Dart,
    SupportedLanguages.ObjectiveC,
  ]);

  const languages: RepoOverview['coverage']['languages'] = Object.values(SupportedLanguages).map(
    (language) => {
      const parserMode: 'tree-sitter' | 'standalone' =
        language === SupportedLanguages.Cobol ? 'standalone' : 'tree-sitter';
      const parserAvailable =
        parserMode === 'standalone' ? true : isLanguageAvailable(language as SupportedLanguages);
      let note: string | undefined;
      if (language === SupportedLanguages.Cobol) {
        note = 'Regex-based standalone processor';
      } else if (!parserAvailable && optionalParsers.has(language)) {
        note = 'Optional native parser not installed';
      }
      return {
        language,
        parserMode,
        parserAvailable,
        status: (parserMode === 'standalone'
          ? 'standalone'
          : parserAvailable
            ? 'available'
            : 'unavailable') as 'available' | 'unavailable' | 'standalone',
        ...(note ? { note } : {}),
      };
    },
  );

  const availableParserCount = languages.filter(
    (lang) => lang.status === 'available' || lang.status === 'standalone',
  ).length;
  const parserCoverageRatio = availableParserCount / Math.max(languages.length, 1);

  return {
    context: ctx,
    maintainability: {
      fileImportCycles: fileImportCycles[0]?.count ?? fileImportCycles[0]?.[0] ?? 0,
      oversizedSymbols: oversizedSymbols[0]?.count ?? oversizedSymbols[0]?.[0] ?? 0,
      crossModuleEdges: crossModuleEdges[0]?.count ?? crossModuleEdges[0]?.[0] ?? 0,
      hotspots: {
        incoming: topIncoming.map((row: any) => ({
          name: row.name ?? row[0] ?? 'unknown',
          filePath: row.filePath ?? row[1] ?? '',
          count: row.count ?? row[2] ?? 0,
        })),
        outgoing: topOutgoing.map((row: any) => ({
          name: row.name ?? row[0] ?? 'unknown',
          filePath: row.filePath ?? row[1] ?? '',
          count: row.count ?? row[2] ?? 0,
        })),
      },
    },
    coverage: {
      parserCoverage: {
        available: availableParserCount,
        total: languages.length,
      },
      languages,
      blindSpots: [
        'Variable-level data flow is not yet modeled end-to-end.',
        'Path-sensitive control-flow reasoning is partial.',
        'Security rule execution and taint propagation are not productized in MCP outputs.',
        'Parser availability can reduce language coverage on optional native grammars.',
      ],
      analysisConfidence:
        parserCoverageRatio >= 0.85 ? 'high' : parserCoverageRatio >= 0.65 ? 'medium' : 'low',
    },
  };
}
