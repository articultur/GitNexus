/**
 * Unit Tests: mcp/local/tools/query
 *
 * Covers queryTool validation, empty-result handling, RRF merge,
 * process grouping, and definitions fallback.
 * All external I/O (BM25 search, DB, embedder) is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryTool } from '../../src/mcp/local/tools/query.js';
import type { RepoHandle } from '../../src/mcp/local/tools/shared.js';

// ─── Mock externals ───────────────────────────────────────────────────────

const mockSearchFTSFromLbug = vi.fn();
const mockExecuteParameterized = vi.fn();
const mockExecuteQuery = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: (...args: any[]) => mockExecuteParameterized(...args),
  executeQuery: (...args: any[]) => mockExecuteQuery(...args),
}));

// bm25SearchHelper does: await import('../../../core/search/bm25-index.js')
vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: (...args: any[]) => mockSearchFTSFromLbug(...args),
  getFTSHealthWarning: (response: any) => {
    if (response?.ftsAvailable === false) {
      return 'FTS indexes missing or unavailable - keyword search degraded. Run: gitnexus analyze --force to rebuild indexes.';
    }
    if (response?.ftsComplete === false || response?.missingIndexes?.length) {
      return 'FTS indexes partially missing - keyword search may miss results. Run: gitnexus analyze --force to rebuild indexes.';
    }
    return undefined;
  },
}));

// semanticSearchHelper does: await import('../../core/embedder.js')
vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────

const REPO: RepoHandle = {
  id: 'test-repo',
  name: 'test-repo',
  repoPath: '/repo',
  storagePath: '/storage',
  lbugPath: '/lbug',
  indexedAt: '2026-01-01',
  lastCommit: 'abc123',
};

const ensureInit = vi.fn().mockResolvedValue(undefined);

/** Helper: BM25 result row (file-level). */
function makeBM25Row(filePath: string, score = 1.0) {
  return { filePath, score, ftsUsed: true };
}

/** Helper: symbol DB row returned by executeParameterized. */
function makeSymbolRow(id: string, name: string, filePath: string) {
  return { id, name, type: 'Function', filePath, startLine: 1, endLine: 10 };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureInit.mockResolvedValue(undefined);
  // Default: no embeddings available
  mockExecuteQuery.mockResolvedValue([]);
  // Default: BM25 returns nothing
  mockSearchFTSFromLbug.mockResolvedValue({ results: [], ftsAvailable: true });
  // Default: all DB queries return empty
  mockExecuteParameterized.mockResolvedValue([]);
});

// ─── Parameter validation ─────────────────────────────────────────────────

describe('queryTool — parameter validation', () => {
  it('returns error for empty string query', async () => {
    const result = await queryTool(REPO, { query: '' }, ensureInit);

    expect(result).toHaveProperty('error');
    expect(String(result.error)).toMatch(/query.*required|required.*query/i);
  });

  it('returns error for whitespace-only query', async () => {
    const result = await queryTool(REPO, { query: '   ' }, ensureInit);

    expect(result).toHaveProperty('error');
  });
});

// ─── Empty results ────────────────────────────────────────────────────────

describe('queryTool — empty graph', () => {
  it('returns processes=[] and definitions=[] when nothing found', async () => {
    const result = await queryTool(REPO, { query: 'auth login' }, ensureInit);

    expect(result).toHaveProperty('processes');
    expect(result.processes).toEqual([]);
    expect(result).toHaveProperty('definitions');
    expect(result.definitions).toEqual([]);
  });

  it('returns process_symbols=[] when nothing found', async () => {
    const result = await queryTool(REPO, { query: 'auth' }, ensureInit);

    expect(result.process_symbols).toEqual([]);
  });
});

// ─── Symbols without process (→ definitions) ─────────────────────────────

describe('queryTool — definitions fallback', () => {
  it('puts symbols with no process association into definitions', async () => {
    const filePath = 'src/auth/login.ts';
    const symId = 'Function:src/auth/login.ts/handleLogin';

    // BM25 returns one file hit
    mockSearchFTSFromLbug.mockResolvedValue({
      results: [makeBM25Row(filePath)],
      ftsAvailable: true,
    });
    // Symbol lookup for that file
    mockExecuteParameterized
      .mockResolvedValueOnce([makeSymbolRow(symId, 'handleLogin', filePath)])
      // Process lookup for symbolId → none
      .mockResolvedValueOnce([])
      // Cohesion lookup → none
      .mockResolvedValueOnce([]);

    const result = await queryTool(REPO, { query: 'login handler' }, ensureInit);

    expect(result.definitions.length).toBeGreaterThan(0);
    const def = result.definitions.find((d: any) => d.name === 'handleLogin');
    expect(def).toBeDefined();
    expect(result.processes).toHaveLength(0);
  });
});

// ─── Symbols with process (→ processes group) ─────────────────────────────

describe('queryTool — process grouping', () => {
  it('groups symbols that belong to a process into processes', async () => {
    const filePath = 'src/auth/login.ts';
    const symId = 'Function:src/auth/login.ts/handleLogin';
    const procId = 'proc:loginFlow';

    mockSearchFTSFromLbug.mockResolvedValue({
      results: [makeBM25Row(filePath)],
      ftsAvailable: true,
    });
    mockExecuteParameterized
      .mockResolvedValueOnce([makeSymbolRow(symId, 'handleLogin', filePath)]) // symbol lookup
      .mockResolvedValueOnce([
        {
          // process lookup
          pid: procId,
          label: 'loginFlow',
          heuristicLabel: 'Login Flow',
          processType: 'HTTP',
          stepCount: 3,
          step: 1,
        },
      ])
      .mockResolvedValueOnce([]); // cohesion → empty

    const result = await queryTool(REPO, { query: 'login' }, ensureInit);

    expect(result.processes.length).toBeGreaterThan(0);
    expect(result.processes[0].id).toBe(procId);
    expect(result.process_symbols.length).toBeGreaterThan(0);
  });

  it('does not duplicate a symbol across multiple process appearances', async () => {
    const filePath = 'src/auth/login.ts';
    const symId = 'Function:src/auth/login.ts/handleLogin';

    mockSearchFTSFromLbug.mockResolvedValue({
      results: [
        makeBM25Row(filePath, 1.5),
        // Same file listed again with slightly lower score (should be merged by RRF)
      ],
      ftsAvailable: true,
    });
    mockExecuteParameterized
      .mockResolvedValueOnce([makeSymbolRow(symId, 'handleLogin', filePath)])
      .mockResolvedValueOnce([
        {
          pid: 'p1',
          label: 'Login',
          heuristicLabel: 'Login',
          processType: 'HTTP',
          stepCount: 2,
          step: 1,
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await queryTool(REPO, { query: 'login' }, ensureInit);

    // process_symbols should have each id at most once
    const ids = result.process_symbols.map((s: any) => s.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });
});

// ─── FTS unavailability warning ───────────────────────────────────────────

describe('queryTool — FTS degraded warning', () => {
  it('does NOT include warning when FTS works', async () => {
    // ftsUsed=true means FTS was available
    mockSearchFTSFromLbug.mockResolvedValue({
      results: [{ ...makeBM25Row('src/foo.ts'), ftsUsed: true }],
      ftsAvailable: true,
    });
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await queryTool(REPO, { query: 'foo' }, ensureInit);

    expect(result.warning).toBeUndefined();
  });

  it('does NOT crash when BM25 search throws', async () => {
    mockSearchFTSFromLbug.mockRejectedValue(new Error('FTS index missing'));

    const result = await queryTool(REPO, { query: 'foo' }, ensureInit);

    // Should gracefully degrade to empty results, not throw
    expect(result).toHaveProperty('processes');
    expect(result).toHaveProperty('definitions');
  });

  it('includes warning when only some FTS indexes are available', async () => {
    mockSearchFTSFromLbug.mockResolvedValue({
      results: [],
      ftsAvailable: true,
      ftsComplete: false,
      missingIndexes: ['Method.method_fts'],
      ftsIndexStatus: [],
    });

    const result = await queryTool(REPO, { query: 'foo' }, ensureInit);

    expect(result.warning).toMatch(/partially missing/);
  });
});

// ─── method parameter ─────────────────────────────────────────────────────

describe('queryTool — method selection', () => {
  it('still returns valid structure with method=bm25', async () => {
    const result = await queryTool(REPO, { query: 'foo', method: 'bm25' }, ensureInit);

    expect(result).toHaveProperty('processes');
    expect(result).toHaveProperty('definitions');
  });

  it('still returns valid structure with method=vector', async () => {
    // Embeddings not available (executeQuery returns empty cnt)
    const result = await queryTool(REPO, { query: 'foo', method: 'vector' }, ensureInit);

    expect(result).toHaveProperty('processes');
    expect(result).toHaveProperty('definitions');
  });
});

// ─── limit parameter ─────────────────────────────────────────────────────

  describe('queryTool — limit/max_symbols options', () => {
    it('respects limit param and returns at most N processes', async () => {
      const result = await queryTool(REPO, { query: 'test', limit: 3 }, ensureInit);
      expect(result.processes.length).toBeLessThanOrEqual(3);
    });
  });

  // ─── granularity parameter ────────────────────────────────────────────────

  describe('queryTool — granularity parameter', () => {
    it('defaults to low granularity (no aggregation)', async () => {
      // Low granularity is the default; just verify the function runs without error
      const result = await queryTool(REPO, { query: 'app lifecycle' }, ensureInit);
      expect(result).toHaveProperty('processes');
      expect(result).toHaveProperty('definitions');
      // With no data, both should be empty
      expect(result.processes).toHaveLength(0);
    });
  });

  // ─── aggregateProcesses (pure function unit tests) ────────────────────────

  describe('aggregateProcesses', () => {
    it('merges two processes sharing the same entry point symbol', async () => {
      const { aggregateProcesses } = await import('../../src/mcp/local/tools/query.js');

      // Both processes share the same entry point symbol (same symbol ID 's1' at step 1)
      const processes = [
        { id: 'p1', summary: 'Create Config', priority: 1, symbol_count: 2, process_type: 'Lifecycle', step_count: 2 },
        { id: 'p2', summary: 'Create Logger', priority: 1, symbol_count: 1, process_type: 'Lifecycle', step_count: 1 },
      ];
      const symbols = [
        { id: 's1', process_id: 'p1', step_index: 1, name: 'onCreate', filePath: 'src/app.ts' },
        { id: 's2', process_id: 'p1', step_index: 2, name: 'initConfig', filePath: 'src/app.ts' },
        { id: 's1', process_id: 'p2', step_index: 1, name: 'onCreate', filePath: 'src/app.ts' },
      ];

      const result = aggregateProcesses(processes, symbols);

      expect(result.processes).toHaveLength(1);
      expect(result.processes[0].process_type).toBe('aggregated');
      expect(result.processes[0].summary).toMatch(/onCreate/);
      expect(result.processes[0].step_count).toBe(3); // 2+1
    });

    it('leaves single-entry-point processes unchanged', async () => {
      const { aggregateProcesses } = await import('../../src/mcp/local/tools/query.js');

      const processes = [
        { id: 'p1', summary: 'Solo Flow', priority: 1, symbol_count: 2, process_type: 'HTTP', step_count: 3 },
      ];
      const symbols = [
        { id: 's1', process_id: 'p1', step_index: 1, name: 'uniqueEntry', filePath: 'src/solo.ts' },
        { id: 's2', process_id: 'p1', step_index: 2, name: 'nextStep', filePath: 'src/solo.ts' },
      ];

      const result = aggregateProcesses(processes, symbols);

      expect(result.processes).toHaveLength(1);
      expect(result.processes[0].process_type).not.toBe('aggregated');
    });

    it('keeps processes with different entry points separate', async () => {
      const { aggregateProcesses } = await import('../../src/mcp/local/tools/query.js');

      const processes = [
        { id: 'p1', summary: 'OnCreate', priority: 1, symbol_count: 1, process_type: 'Lifecycle', step_count: 1 },
        { id: 'p2', summary: 'OnDestroy', priority: 1, symbol_count: 1, process_type: 'Lifecycle', step_count: 1 },
      ];
      const symbols = [
        { id: 's1', process_id: 'p1', step_index: 1, name: 'onCreate', filePath: 'src/app.ts' },
        { id: 's2', process_id: 'p2', step_index: 1, name: 'onDestroy', filePath: 'src/app.ts' },
      ];

      const result = aggregateProcesses(processes, symbols);

      expect(result.processes).toHaveLength(2);
      expect(result.processes.every((p: any) => p.process_type !== 'aggregated')).toBe(true);
    });

    it('falls back to process ID when entry symbol has no step_index 0/1', async () => {
      const { aggregateProcesses } = await import('../../src/mcp/local/tools/query.js');

      const processes = [
        { id: 'p1', summary: 'A', priority: 1, symbol_count: 1, process_type: 'A', step_count: 1 },
        { id: 'p2', summary: 'B', priority: 1, symbol_count: 1, process_type: 'B', step_count: 1 },
      ];
      // No step_index 0 or 1 → each process keeps its own entry point key
      const symbols = [
        { id: 's1', process_id: 'p1', step_index: 2, name: 'middle', filePath: 'src/a.ts' },
        { id: 's2', process_id: 'p2', step_index: 3, name: 'end', filePath: 'src/b.ts' },
      ];

      const result = aggregateProcesses(processes, symbols);

      // Without step_index 0/1, entry point key falls back to pid
      // Since p1 and p2 are different, no aggregation occurs
      expect(result.processes).toHaveLength(2);
    });
  });
