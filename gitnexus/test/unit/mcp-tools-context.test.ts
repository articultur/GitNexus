/**
 * Unit Tests: mcp/local/tools/context
 *
 * Covers contextTool guard conditions, disambiguated symbol lookup,
 * and exploreTool routing for cluster / process / symbol / invalid type.
 * All LadybugDB calls are mocked via vi.mock so no real DB is required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { contextTool, exploreTool } from '../../src/mcp/local/tools/context.js';
import type { RepoHandle } from '../../src/mcp/local/tools/shared.js';

// ─── Mock pool-adapter ────────────────────────────────────────────────────

const mockExecuteParameterized = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: (...args: any[]) => mockExecuteParameterized(...args),
  executeQuery: vi.fn().mockResolvedValue([]),
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

/** A single known symbol row (named-property form). */
function makeSymRow(overrides: Record<string, any> = {}) {
  return {
    id: 'Function:src/foo.ts/myFunc',
    name: 'myFunc',
    type: 'Function',
    filePath: 'src/foo.ts',
    startLine: 10,
    endLine: 25,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureInit.mockResolvedValue(undefined);
});

// ─── contextTool — parameter validation ──────────────────────────────────

describe('contextTool — parameter validation', () => {
  it('returns error when neither name nor uid is provided', async () => {
    const result = await contextTool(REPO, {}, ensureInit);

    expect(result).toHaveProperty('error');
    expect(String(result.error)).toMatch(/name.*uid|uid.*name/i);
  });

  it('returns error when symbol is not found by name', async () => {
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await contextTool(REPO, { name: 'NonExistentFunc' }, ensureInit);

    expect(result).toHaveProperty('error');
    expect(String(result.error)).toMatch(/NonExistentFunc/);
  });

  it('returns error when symbol is not found by uid', async () => {
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await contextTool(REPO, { uid: 'Function:src/nope.ts/ghost' }, ensureInit);

    expect(result).toHaveProperty('error');
  });
});

// ─── contextTool — single result ─────────────────────────────────────────

describe('contextTool — single symbol result', () => {
  beforeEach(() => {
    // symbol lookup → one row
    // incomingRows → empty, outgoingRows → empty, processRows → empty
    mockExecuteParameterized
      .mockResolvedValueOnce([makeSymRow()]) // symbol lookup
      .mockResolvedValue([]); // all subsequent queries (incoming, outgoing, process)
  });

  it('returns result with callers, callees, processes keys', async () => {
    const result = await contextTool(REPO, { name: 'myFunc' }, ensureInit);

    expect(result).toHaveProperty('symbol');
    expect(result).toHaveProperty('incoming');
    expect(result).toHaveProperty('outgoing');
    expect(result).toHaveProperty('processes');
  });

  it('symbol block contains id, name, kind, filePath', async () => {
    const result = await contextTool(REPO, { name: 'myFunc' }, ensureInit);

    expect(result.symbol).toMatchObject({
      uid: 'Function:src/foo.ts/myFunc',
      name: 'myFunc',
    });
    expect(result.symbol).toHaveProperty('filePath');
  });

  it('includes evidence block by default', async () => {
    const result = await contextTool(REPO, { name: 'myFunc' }, ensureInit);

    expect(result).toHaveProperty('evidence');
  });

  it('omits evidence block when include_evidence=false', async () => {
    const result = await contextTool(REPO, { name: 'myFunc', include_evidence: false }, ensureInit);

    expect(result).not.toHaveProperty('evidence');
  });
});

// ─── contextTool — uid-based lookup ──────────────────────────────────────

describe('contextTool — uid lookup', () => {
  it('resolves symbol via uid and returns result', async () => {
    const uid = 'Function:src/foo.ts/myFunc';
    mockExecuteParameterized.mockResolvedValueOnce([makeSymRow({ id: uid })]).mockResolvedValue([]);

    const result = await contextTool(REPO, { uid }, ensureInit);

    expect(result.symbol.uid).toBe(uid);
  });
});

// ─── contextTool — ambiguous resolution ──────────────────────────────────

describe('contextTool — ambiguous symbols', () => {
  it('returns ambiguous status when multiple symbols share a name and no uid/file_path', async () => {
    const sym1 = makeSymRow({ id: 'Function:src/a.ts/foo', filePath: 'src/a.ts' });
    const sym2 = makeSymRow({ id: 'Function:src/b.ts/foo', filePath: 'src/b.ts' });
    // First call: symbol lookup returns 2 hits
    // Second call (class type disambiguation): empty
    mockExecuteParameterized.mockResolvedValueOnce([sym1, sym2]).mockResolvedValue([]);

    const result = await contextTool(REPO, { name: 'foo' }, ensureInit);

    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
  });
});

// ─── exploreTool ─────────────────────────────────────────────────────────

describe('exploreTool — invalid type', () => {
  it('returns error for unknown type', async () => {
    const result = await exploreTool(REPO, { name: 'anything', type: 'bogus' as any }, ensureInit);

    expect(result).toHaveProperty('error');
    expect(String(result.error)).toMatch(/invalid type/i);
  });
});

describe('exploreTool — symbol type', () => {
  it('delegates to contextTool for type=symbol', async () => {
    // symbol not found — contextTool returns error
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await exploreTool(REPO, { name: 'myFunc', type: 'symbol' }, ensureInit);

    // contextTool was called and produced an error (symbol not found)
    expect(result).toHaveProperty('error');
  });
});

describe('exploreTool — cluster type', () => {
  it('returns error when cluster not found', async () => {
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await exploreTool(REPO, { name: 'AuthModule', type: 'cluster' }, ensureInit);

    expect(result).toHaveProperty('error');
    expect(String(result.error)).toMatch(/AuthModule/);
  });

  it('returns cluster + members when cluster exists', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([
        {
          id: 'c1',
          label: 'AuthModule',
          heuristicLabel: 'AuthModule',
          cohesion: 0.7,
          symbolCount: 12,
        },
      ]) // cluster query
      .mockResolvedValueOnce([{ name: 'login', type: 'Function', filePath: 'src/auth.ts' }]); // members query

    const result = await exploreTool(REPO, { name: 'AuthModule', type: 'cluster' }, ensureInit);

    expect(result).toHaveProperty('cluster');
    expect(result).toHaveProperty('members');
    expect(result.cluster.label).toBe('AuthModule');
  });
});

describe('exploreTool — process type', () => {
  it('returns error when process not found', async () => {
    mockExecuteParameterized.mockResolvedValue([]);

    const result = await exploreTool(REPO, { name: 'loginFlow', type: 'process' }, ensureInit);

    expect(result).toHaveProperty('error');
    expect(String(result.error)).toMatch(/loginFlow/);
  });

  it('returns process + steps when process exists', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([
        {
          id: 'p1',
          label: 'loginFlow',
          heuristicLabel: 'Login Flow',
          processType: 'HTTP',
          stepCount: 3,
        },
      ]) // process lookup
      .mockResolvedValueOnce([
        { name: 'validateCredentials', type: 'Function', filePath: 'src/auth.ts', step: 1 },
        { name: 'createSession', type: 'Function', filePath: 'src/session.ts', step: 2 },
      ]); // steps query

    const result = await exploreTool(REPO, { name: 'loginFlow', type: 'process' }, ensureInit);

    expect(result).toHaveProperty('process');
    expect(result).toHaveProperty('steps');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].step).toBe(1);
  });
});
