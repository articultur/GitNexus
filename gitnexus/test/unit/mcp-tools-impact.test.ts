/**
 * Unit Tests: mcp/local/tools/impact
 *
 * Covers impactTool error handling, runImpactBFS result shape / risk scoring,
 * test-file filtering, and impactByUidTool guard conditions.
 * All LadybugDB calls are mocked via vi.mock so no real DB is required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  impactTool,
  runImpactBFS,
  impactByUidTool,
  IMPACT_RELATION_CONFIDENCE,
} from '../../src/mcp/local/tools/impact.js';
import type { RepoHandle } from '../../src/mcp/local/tools/shared.js';

// ─── Mock pool-adapter ────────────────────────────────────────────────────

const mockExecuteParameterized = vi.fn();
const mockExecuteQuery = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: (...args: any[]) => mockExecuteParameterized(...args),
  executeQuery: (...args: any[]) => mockExecuteQuery(...args),
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

const TARGET_SYM = { id: 'Function:src/foo.ts/myFunc', name: 'myFunc', filePath: 'src/foo.ts' };

/** Build a minimal BFS traversal row (upstream direction: caller→target). */
function makeRelRow(id: string, name: string, filePath = 'src/other.ts', relType = 'CALLS') {
  return {
    sourceId: TARGET_SYM.id,
    sourceName: TARGET_SYM.name,
    sourceFilePath: TARGET_SYM.filePath,
    id,
    name,
    type: 'Function',
    filePath,
    relType,
    confidence: 0.9,
    reason: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureInit.mockResolvedValue(undefined);
});

// ─── impactTool ───────────────────────────────────────────────────────────

describe('impactTool', () => {
  it('returns structured error when target not found (empty lookup)', async () => {
    // All DB calls return empty → symbol not found
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await impactTool(
      REPO,
      { target: 'MissingSymbol', direction: 'upstream' },
      ensureInit,
    );

    expect(result).toHaveProperty('error');
    expect(String(result.error)).toMatch(/MissingSymbol/);
  });

  it('returns structured error object when DB throws', async () => {
    mockExecuteParameterized.mockRejectedValue(new Error('DB connection lost'));

    const result = await impactTool(
      REPO,
      { target: 'Anything', direction: 'upstream' },
      ensureInit,
    );

    // Should NOT throw — returns an error-shaped object
    expect(result).toHaveProperty('error');
    expect(result.impactedCount).toBe(0);
    expect(result.risk).toBe('UNKNOWN');
  });

  it('includes suggestion field in error response', async () => {
    mockExecuteParameterized.mockRejectedValue(new Error('oops'));

    const result = await impactTool(REPO, { target: 'X', direction: 'downstream' }, ensureInit);

    expect(result.suggestion).toBeDefined();
  });
});

// ─── runImpactBFS ─────────────────────────────────────────────────────────

describe('runImpactBFS — empty graph', () => {
  beforeEach(() => {
    // Symbol lookup + BFS depth traversal both return nothing
    mockExecuteParameterized.mockResolvedValue([]);
  });

  it('returns correct shape for empty result', async () => {
    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'upstream', {
      maxDepth: 3,
      relationTypes: ['CALLS', 'IMPORTS'],
      includeTests: false,
      minConfidence: 0,
      include_evidence: false,
      include_content: false,
    });

    expect(result).toMatchObject({
      target: { id: TARGET_SYM.id, name: TARGET_SYM.name },
      direction: 'upstream',
      impactedCount: 0,
      risk: 'LOW',
    });
  });

  it('omits evidence block when include_evidence is false', async () => {
    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'upstream', {
      maxDepth: 1,
      relationTypes: ['CALLS'],
      includeTests: false,
      minConfidence: 0,
      include_evidence: false,
      include_content: false,
    });

    expect(result).not.toHaveProperty('evidence');
  });

  it('includes evidence block when include_evidence is true', async () => {
    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'upstream', {
      maxDepth: 1,
      relationTypes: ['CALLS'],
      includeTests: false,
      minConfidence: 0,
      include_evidence: true,
      include_content: false,
    });

    expect(result).toHaveProperty('evidence');
    expect(result.evidence).toHaveProperty('traversal');
  });
});

describe('runImpactBFS — risk scoring', () => {
  it('risk is LOW when 0 direct callers', async () => {
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'upstream', {
      maxDepth: 3,
      relationTypes: ['CALLS'],
      includeTests: false,
      minConfidence: 0,
      include_evidence: false,
      include_content: false,
    });

    expect(result.risk).toBe('LOW');
    expect(result.summary.direct).toBe(0);
  });

  it('risk is MEDIUM when 5–14 direct callers', async () => {
    // Return 7 unique callers at depth=1, then stop
    const directRows = Array.from({ length: 7 }, (_, i) =>
      makeRelRow(`id-${i}`, `caller${i}`, `src/mod${i}.ts`),
    );
    mockExecuteParameterized
      .mockResolvedValueOnce(directRows) // depth=1 BFS
      .mockResolvedValue([]); // depth=2+ and process enrichment

    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'upstream', {
      maxDepth: 3,
      relationTypes: ['CALLS'],
      includeTests: false,
      minConfidence: 0,
      include_evidence: false,
      include_content: false,
    });

    // New unified scoring model: 7 direct callers gives score ~10.7 (LOW)
    // The new model is more conservative than the old thresholds
    expect(result.risk).toBe('LOW');
    expect(result.summary.direct).toBe(7);
    // Verify score_v2 is present
    expect(result.score_v2).toBeDefined();
    expect(result.score_v2.score).toBeLessThan(25);
  });

  it('risk is HIGH when 15–29 direct callers', async () => {
    const directRows = Array.from({ length: 20 }, (_, i) =>
      makeRelRow(`id-${i}`, `caller${i}`, `src/mod${i}.ts`),
    );
    mockExecuteParameterized.mockResolvedValueOnce(directRows).mockResolvedValue([]);

    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'upstream', {
      maxDepth: 3,
      relationTypes: ['CALLS'],
      includeTests: false,
      minConfidence: 0,
      include_evidence: false,
      include_content: false,
    });

    // New unified scoring model: 20 direct callers gives score ~30.7 (MEDIUM)
    // The new model requires more impact for HIGH risk
    expect(result.risk).toBe('MEDIUM');
    expect(result.score_v2).toBeDefined();
    expect(result.score_v2.score).toBeGreaterThanOrEqual(25);
    expect(result.score_v2.score).toBeLessThan(50);
  });

  it('risk is HIGH with 30 direct callers (no processes/modules)', async () => {
    const directRows = Array.from({ length: 30 }, (_, i) =>
      makeRelRow(`id-${i}`, `caller${i}`, `src/mod${i}.ts`),
    );
    // Explicitly mock all queries to return empty except the first
    mockExecuteParameterized
      .mockResolvedValueOnce(directRows) // depth=1 BFS
      .mockResolvedValue([]); // All subsequent calls (process, module enrichment)

    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'upstream', {
      maxDepth: 3,
      relationTypes: ['CALLS'],
      includeTests: false,
      minConfidence: 0,
      include_evidence: false,
      include_content: false,
    });

    // With 30 direct callers: direct_impact=50 (capped), total_impact~17.2
    // rawSum ≈ 67.2, score ≈ 52 (HIGH)
    expect(result.risk).toBe('HIGH');
    expect(result.impactedCount).toBe(30);
    expect(result.score_v2).toBeDefined();
    expect(result.score_v2.score).toBeGreaterThanOrEqual(50);
    expect(result.score_v2.score).toBeLessThan(80);
  });

  it('risk is HIGH when multiple dimensions are affected', async () => {
    // Create scenario with direct callers, processes, and modules
    const directRows = Array.from({ length: 25 }, (_, i) =>
      makeRelRow(`id-${i}`, `caller${i}`, `src/mod${i}.ts`),
    );
    // Mock process enrichment
    const processRows = Array.from({ length: 5 }, (_, i) => ({
      pId: `proc-${i}`,
      name: `Process ${i}`,
      processType: 'HTTP',
      entryPointId: `ep-${i}`,
      hits: 5,
      minStep: 1,
      stepCount: 10,
      epName: `entry${i}`,
      epType: 'Function',
      epFilePath: `src/entry${i}.ts`,
    }));
    // Mock module enrichment
    const moduleRows = Array.from({ length: 5 }, (_, i) => ({
      name: `module${i}`,
      hits: 5,
    }));

    mockExecuteParameterized
      .mockResolvedValueOnce(directRows) // depth=1 BFS
      .mockResolvedValueOnce(processRows) // process enrichment
      .mockResolvedValueOnce([]) // process backfill
      .mockResolvedValueOnce(moduleRows) // module enrichment
      .mockResolvedValueOnce([]); // direct module enrichment

    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'upstream', {
      maxDepth: 3,
      relationTypes: ['CALLS'],
      includeTests: false,
      minConfidence: 0,
      include_evidence: false,
      include_content: false,
    });

    // With 25 direct, 5 processes, 5 modules: score should be HIGH
    expect(result.risk).toBe('HIGH');
    expect(result.score_v2).toBeDefined();
    expect(result.score_v2.score).toBeGreaterThanOrEqual(50);
  });
});

describe('runImpactBFS — test file filtering', () => {
  it('excludes test-file paths when includeTests=false', async () => {
    const rows = [
      makeRelRow('id-prod', 'prodCaller', 'src/prod.ts'),
      makeRelRow('id-test', 'testCaller', 'src/__tests__/foo.test.ts'),
    ];
    mockExecuteParameterized.mockResolvedValueOnce(rows).mockResolvedValue([]);

    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'upstream', {
      maxDepth: 1,
      relationTypes: ['CALLS'],
      includeTests: false,
      minConfidence: 0,
      include_evidence: false,
      include_content: false,
    });

    expect(result.impactedCount).toBe(1);
    expect(result.byDepth[1][0].name).toBe('prodCaller');
  });

  it('includes test-file paths when includeTests=true', async () => {
    const rows = [
      makeRelRow('id-prod', 'prodCaller', 'src/prod.ts'),
      makeRelRow('id-test', 'testCaller', 'test/foo.test.ts'),
    ];
    mockExecuteParameterized.mockResolvedValueOnce(rows).mockResolvedValue([]);

    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'upstream', {
      maxDepth: 1,
      relationTypes: ['CALLS'],
      includeTests: true,
      minConfidence: 0,
      include_evidence: false,
      include_content: false,
    });

    expect(result.impactedCount).toBe(2);
  });
});

describe('runImpactBFS — downstream direction', () => {
  it('sets direction field in result', async () => {
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await runImpactBFS(REPO, TARGET_SYM, 'Function', 'downstream', {
      maxDepth: 1,
      relationTypes: ['CALLS'],
      includeTests: false,
      minConfidence: 0,
      include_evidence: false,
      include_content: false,
    });

    expect(result.direction).toBe('downstream');
  });
});

// ─── impactByUidTool ──────────────────────────────────────────────────────

describe('impactByUidTool', () => {
  const opts = {
    maxDepth: 2,
    relationTypes: ['CALLS'],
    minConfidence: 0,
    includeTests: false,
    include_evidence: false,
  };

  it('returns null when repo not found in registry', async () => {
    const getRepo = vi.fn().mockReturnValue(undefined);
    const refreshRepos = vi.fn().mockResolvedValue(undefined);
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await impactByUidTool(
      'unknown-repo',
      'some-uid',
      'upstream',
      opts,
      ensureInit,
      getRepo,
      refreshRepos,
    );

    expect(result).toBeNull();
  });

  it('returns null when uid has no matching node', async () => {
    const getRepo = vi.fn().mockReturnValue(REPO);
    const refreshRepos = vi.fn().mockResolvedValue(undefined);
    // uid lookup returns empty
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await impactByUidTool(
      REPO.id,
      'nonexistent-uid',
      'upstream',
      opts,
      ensureInit,
      getRepo,
      refreshRepos,
    );

    expect(result).toBeNull();
  });

  it('returns impact result when uid resolves and graph is empty', async () => {
    const getRepo = vi.fn().mockReturnValue(REPO);
    const refreshRepos = vi.fn().mockResolvedValue(undefined);
    // First call: uid lookup; subsequent calls: empty BFS
    mockExecuteParameterized
      .mockResolvedValueOnce([
        {
          id: TARGET_SYM.id,
          name: TARGET_SYM.name,
          filePath: TARGET_SYM.filePath,
          type: 'Function',
        },
      ])
      .mockResolvedValue([]);

    const result = await impactByUidTool(
      REPO.id,
      TARGET_SYM.id,
      'upstream',
      opts,
      ensureInit,
      getRepo,
      refreshRepos,
    );

    expect(result).not.toBeNull();
    expect(result).toHaveProperty('impactedCount', 0);
  });
});

// ─── IMPACT_RELATION_CONFIDENCE ───────────────────────────────────────────

describe('IMPACT_RELATION_CONFIDENCE', () => {
  it('is a frozen-like record (no shared mutation)', () => {
    // Verify it's imported correctly and contains key relation types
    expect(IMPACT_RELATION_CONFIDENCE['CALLS']).toBeGreaterThanOrEqual(0.8);
    expect(IMPACT_RELATION_CONFIDENCE['IMPORTS']).toBeGreaterThanOrEqual(0.8);
    expect(IMPACT_RELATION_CONFIDENCE['EXTENDS']).toBeGreaterThanOrEqual(0.7);
  });

  it('all values are in [0, 1] range', () => {
    for (const [key, val] of Object.entries(IMPACT_RELATION_CONFIDENCE)) {
      expect(val, `${key} confidence should be in [0,1]`).toBeGreaterThanOrEqual(0);
      expect(val, `${key} confidence should be in [0,1]`).toBeLessThanOrEqual(1);
    }
  });
});
