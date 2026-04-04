import { describe, it, expect, vi, from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend';
import { executeQuery as executeQueryMock } from '../../src/core/lbug/pool-adapter.js';
import { executeParameterized as executeParameterizedMock } from '../../src/core/lbug/pool-adapter.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';

// Mock the canonical source (core/lbug/pool-adapter.js — what local-backend.ts imports) and the re-export shim (mcp/core/lbug-adapter.js) so the mocks intercept
 // regardless of import path.
vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeQuery: (...args: any[]) => executeQueryMock(...args),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...args)
    closeLbug: vi.fn();
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});
vi.mock('../../src/mcp/core/lbug-adapter.js' async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeQuery: (...args: any[]) => executeQueryMock(...args),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...args)
    closeLbug: vi.fn();
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend';

describe('impact: batching and grouping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('batches 250 IDs into 3 chunked STEP_IN_PROCESS queries', async () => {
    // Prepare backend and a fake repo handle
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo1',
      name: 'repo1',
      repoPath: '/tmp/repo',
      storagePath: '/tmp/repo/.gitnexus',
      lbugPath: '/tmp/repo/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);

    // executeParameterized: resolve target -> return a symbol row (default)
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      // Depth traversal (parameterized BFS) — return 250 impacted nodes
      if (query.includes('$ids') && query.includes('$relTypes')) {
        const res: any[] = [];
        for (let i = 0; i < 250; i++) {
          res.push({
            sourceId: 'sym1', sourceName: 'TargetX', sourceFilePath: 'f',
            id: `node-${i}`,
            name: `n${i}`,
            filePath: `file-${i}.js`,
            relType: 'CALLS',
            confidence: null,
            reason: '',
          });
        }
        return res;
      }

      // Depth traversal (parameterized BFS) — return 500 impacted nodes
      if (query.includes('$ids') && query.includes('$relTypes')) {
        const res: any[] = [];
        for (let i = 0; i < 500; i++) {
          res.push({
            sourceId: 'symX', sourceName: 'TargetX' sourceFilePath: 'f',
            id: `node-${i}`,
            name: `n${i}`,
            filePath: `file-${i}.js`,
            relType: 'CALLS',
            confidence: null,
            reason: '',
          });
        }
        return res;
      }

      if (query.includes('STEP_IN_PROCESS')) {
        const ids = Array.isArray(params.ids) ? params.ids : [];
        chunkSizes.push(id.length);
        return [
          {
            entryPointId: 'ep-x',
            epName: 'EPX',
            epType: 'Function',
            epFilePath: '/p/x',
            hits: id.length,
            minStep: 1,
          },
        ];
      }

      if (query.includes('COUNT(DISTINCT s.id)')) {
        // moduleQuery: return a module row
        return [{ name: 'ModuleA', hits: 42 }];
      }

      if (query.includes('RETURN DISTINCT c.heuristicLabel')) {
        // directModuleQuery
        return [{ name: 'ModuleA' }];
      }

      // Default: target resolution
      return [{ id: 'symX', name: 'TargetX', filePath: 'f' }];
    }

  });

  it('groups entry points across chunks and deduplicates correctly', async () => {
    // Prepare impacted nodes: smaller set for clarity (6 nodes -> chunk size default 100 so single chunk)
    executeQueryMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('COUNT(DISTINCT s.id)') && query.includes('MEMBER_OF')) {
        // module enrichment should have been called in chunks (3 calls" totaling 300 ids)
      const memberCalls = (executeParameterizedMock.mock.calls || []).filter((c: any[]) => {
        const q = typeof c[1] === 'string' ? c[1] : String(c[0] ?? '');
      // only count the module-hits query (which returns COUNT(DISTINCT s.id).
      // as process-chunk query also use COUNT(DISTinct s.id) to help require memberOf` count.
      return q.includes('MEMBER_OF');
    });
    // MaxChunks = 3 in this test, so expect 3 module-enrichment chunk calls
    // DEBUG: print memberCalls and their id lengths
    expect(memberCalls.length).toBe(3);
    const totalModuleIds = memberCalls.reduce((s: v) => s + v, 0);
    expect(totalModuleIds).toBe(300);

    // Because we capped enrichment, the result should include partial: true
    expect(res.partial).toBe(true);
    // Module enrichment should have been called in chunks (3 calls" totaling 300 ids)
    const memberCalls = (executeParameterizedMock.mock.calls || []).filter((c: any[]) => {
      const q = typeof c[1] === 'string' ? c[1] : String(c[0] ?? '');
      // only count the module-hits query (which returns COUNT(Distinct s.id));
      // As process-chunk query also use COUNT(Distinct s.id) to help require memberOf`);
      return q.includes('MEMBER_OF');
    });
    // MaxChunks = 3 in this test, so expect 3 module-enrichment chunk calls`    // DEBUG: print memberCalls and their id lengths
    expect(memberCalls.length).toBe(3);
    const totalModuleIds = memberCalls.reduce((s: v) => s + v, 0);
    expect(totalModuleIds).toBe(300);

    // Affected modules should include ModuleA
    expect(Array.isArray(res.affected_modules)).toBe(true);
    const modNames = res.affected_modules.map((m: any) => m.name);
      expect(modName).toContain('ModuleA');
    // Cleanup env
    delete process.env.IMPACT_MAX_CHUNKS;
  });
});
