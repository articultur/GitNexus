/**
 * Test-impact analysis — find test files that cover changed symbols.
 */

import { executeParameterized } from '../../../core/lbug/pool-adapter.js';
import { logQueryError, isTestFilePath } from './shared.js';
import type { RepoHandle } from './shared.js';

export async function testImpactTool(
  repo: RepoHandle,
  params: {
    target?: string;
    changes?: string[];
    scope?: string;
    base_ref?: string;
    maxDepth?: number;
    minConfidence?: number;
  },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);

  const maxDepth = params.maxDepth ?? 5;
  const minConfidence = params.minConfidence ?? 0;

  // ── Step 1: Collect seed node IDs ──────────────────────────────────────
  const seedIds: string[] = [];
  const seedSymbols: Array<{ id: string; name: string; filePath: string }> = [];

  const addNodeRows = (rows: any[]): void => {
    for (const r of rows) {
      const id: string = r.id ?? r[0] ?? '';
      const name: string = r.name ?? r[1] ?? '';
      const fp: string = r.filePath ?? r[2] ?? '';
      if (id && !seedIds.includes(id)) {
        seedIds.push(id);
        seedSymbols.push({ id, name, filePath: fp });
      }
    }
  };

  if (params.target) {
    // Treat as file-path hint when it contains path separators or extension dots
    const looksLikePath =
      params.target.includes('/') || params.target.includes('\\') || params.target.includes('.');
    const rows = await executeParameterized(
      repo.id,
      looksLikePath
        ? `MATCH (n) WHERE n.filePath CONTAINS $target
           RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT 50`
        : `MATCH (n) WHERE n.name = $target
           RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT 10`,
      { target: params.target },
    ).catch(() => []);
    addNodeRows(rows);
  } else if (params.changes && params.changes.length > 0) {
    for (const sym of params.changes) {
      const rows = await executeParameterized(
        repo.id,
        `MATCH (n) WHERE n.name = $sym
         RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT 5`,
        { sym },
      ).catch(() => []);
      addNodeRows(rows);
    }
  } else if (params.scope) {
    const { execFileSync } = await import('child_process');
    let diffArgs: string[];
    switch (params.scope) {
      case 'staged':
        diffArgs = ['diff', '--staged', '--name-only'];
        break;
      case 'all':
        diffArgs = ['diff', 'HEAD', '--name-only'];
        break;
      case 'compare':
        if (!params.base_ref) return { error: 'base_ref is required for "compare" scope' };
        diffArgs = ['diff', params.base_ref, '--name-only'];
        break;
      default: // 'unstaged'
        diffArgs = ['diff', '--name-only'];
    }
    let changedFiles: string[];
    try {
      const output = execFileSync('git', diffArgs, { cwd: repo.repoPath, encoding: 'utf-8' });
      changedFiles = output
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);
    } catch (err: any) {
      return { error: `Git diff failed: ${err.message}` };
    }
    for (const file of changedFiles) {
      const normalizedFile = file.replace(/\\/g, '/');
      // Skip test files themselves — we want files that TEST the changed files
      if (isTestFilePath(normalizedFile)) continue;
      const rows = await executeParameterized(
        repo.id,
        `MATCH (n) WHERE n.filePath CONTAINS $filePath
         RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT 20`,
        { filePath: normalizedFile },
      ).catch(() => []);
      addNodeRows(rows);
    }
  } else {
    return { error: 'Provide target, changes, or scope to identify which symbols changed.' };
  }

  if (seedIds.length === 0) {
    return {
      test_files: [],
      total_test_files: 0,
      seed_symbols: [],
      summary:
        'No indexed symbols found for the given input. Run `npx gitnexus analyze` to refresh the index.',
    };
  }

  // ── Step 2: BFS upstream (CALLS + IMPORTS) to find test callers ──────────
  const TRAVERSAL_TYPES = [
    'CALLS',
    'IMPORTS',
    'EXTENDS',
    'IMPLEMENTS',
    'METHOD_OVERRIDES',
    'OVERRIDES',
    'METHOD_IMPLEMENTS',
  ];
  const relTypeFilter = TRAVERSAL_TYPES.map((t) => `r.type = '${t}'`).join(' OR ');

  const visited = new Set<string>(seedIds);
  let frontier = [...seedIds];

  // Map: test file path → collected hit info
  const testFileMap = new Map<
    string,
    {
      hit_symbols: Array<{ id: string; name: string; kind: string; depth: number }>;
      min_depth: number;
    }
  >();

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    try {
      const related = await executeParameterized(
        repo.id,
        `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN $ids AND (${relTypeFilter}) AND r.confidence >= $minConf
         RETURN caller.id AS id, caller.name AS name, labels(caller)[0] AS kind, caller.filePath AS filePath`,
        { ids: frontier, minConf: minConfidence },
      ).catch(() => []);

      for (const rel of related) {
        const relId: string = rel.id ?? rel[0] ?? '';
        const name: string = rel.name ?? rel[1] ?? '';
        const kind: string = rel.kind ?? rel[2] ?? '';
        const filePath: string = rel.filePath ?? rel[3] ?? '';

        if (!relId || visited.has(relId)) continue;
        visited.add(relId);
        nextFrontier.push(relId);

        if (filePath && isTestFilePath(filePath)) {
          if (!testFileMap.has(filePath)) {
            testFileMap.set(filePath, { hit_symbols: [], min_depth: depth });
          }
          const entry = testFileMap.get(filePath)!;
          entry.min_depth = Math.min(entry.min_depth, depth);
          entry.hit_symbols.push({ id: relId, name, kind, depth });
        }
      }
    } catch (e) {
      logQueryError('test-impact:bfs', e);
      break;
    }
    frontier = nextFrontier;
  }

  // ── Step 3: Build sorted output ──────────────────────────────────────────
  const testFiles = Array.from(testFileMap.entries())
    .map(([path, info]) => ({
      path,
      hit_symbols: info.hit_symbols,
      hit_count: info.hit_symbols.length,
      min_depth: info.min_depth,
    }))
    .sort((a, b) => a.min_depth - b.min_depth || b.hit_count - a.hit_count);

  return {
    test_files: testFiles,
    total_test_files: testFiles.length,
    seed_symbols: seedSymbols,
    summary:
      testFiles.length === 0
        ? `No test files found that cover the changed symbols (BFS depth ${maxDepth}).`
        : `Found ${testFiles.length} test file(s) covering ${seedSymbols.length} changed symbol(s). Run these first: ${testFiles
            .slice(0, 3)
            .map((f) => f.path)
            .join(', ')}.`,
  };
}
