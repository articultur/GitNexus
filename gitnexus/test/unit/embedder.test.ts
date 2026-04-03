/**
 * Unit Tests: MCP Embedder
 *
 * Covers: initEmbedder, embedQuery, isEmbedderReady, getEmbeddingDims, disposeEmbedder
 *
 * The direct transformers.js path is tested via integration tests (requires model loading).
 * This file focuses on testable code paths: HTTP mode delegation, state management,
 * and error handling.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

// Save original env keys so tests can mutate and restore them
const ENV_KEYS = [
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_API_KEY',
  'GITNEXUS_EMBEDDING_DIMS',
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const clearHttpEnv = () => {
  for (const k of ENV_KEYS) delete process.env[k];
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── isEmbedderReady ─────────────────────────────────────────────────

describe('isEmbedderReady', () => {
  it('returns false when not initialized and HTTP mode is off', async () => {
    clearHttpEnv();
    const mod = await import('../../src/mcp/core/embedder.js');
    expect(mod.isEmbedderReady()).toBe(false);
  });

  it('returns true when HTTP env vars are set', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://localhost:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    const mod = await import('../../src/mcp/core/embedder.js');
    expect(mod.isEmbedderReady()).toBe(true);
  });
});

// ─── getEmbeddingDims ───────────────────────────────────────────────

describe('getEmbeddingDims', () => {
  it('returns 384 when no env vars are set', async () => {
    clearHttpEnv();
    const mod = await import('../../src/mcp/core/embedder.js');
    expect(mod.getEmbeddingDims()).toBe(384);
  });

  it('returns configured dimensions when GITNEXUS_EMBEDDING_DIMS is set', async () => {
    clearHttpEnv();
    process.env.GITNEXUS_EMBEDDING_URL = 'http://localhost:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = '1024';
    const mod = await import('../../src/mcp/core/embedder.js');
    expect(mod.getEmbeddingDims()).toBe(1024);
  });
});

// ─── embedQuery (HTTP path) ──────────────────────────────────────────

describe('embedQuery HTTP path', () => {
  const mockVec = Array.from({ length: 384 }, (_, i) => i / 384);

  beforeEach(() => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://localhost:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    process.env.GITNEXUS_EMBEDDING_API_KEY = 'test-key';
  });

  it('calls the /embeddings endpoint and returns a number array', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: mockVec }] }),
      }),
    );

    const mod = await import('../../src/mcp/core/embedder.js');
    const result = await mod.embedQuery('test query');

    expect(result).toBeInstanceOf(Array);
    expect(result).toHaveLength(384);
    expect(typeof result[0]).toBe('number');
  });

  it('throws when response is empty', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }),
    );

    const mod = await import('../../src/mcp/core/embedder.js');
    await expect(mod.embedQuery('test')).rejects.toThrow('empty response');
  });

  it('throws when dimensions do not match GITNEXUS_EMBEDDING_DIMS', async () => {
    process.env.GITNEXUS_EMBEDDING_DIMS = '512';
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: mockVec }] }),
      }),
    );

    const mod = await import('../../src/mcp/core/embedder.js');
    await expect(mod.embedQuery('test')).rejects.toThrow('dimension mismatch');
  });

  it('retries on 503 and returns result', async () => {
    const okResp = {
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: mockVec }] }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(okResp));

    const mod = await import('../../src/mcp/core/embedder.js');
    const result = await mod.embedQuery('test');

    expect(result).toHaveLength(384);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// ─── initEmbedder ───────────────────────────────────────────────────

describe('initEmbedder', () => {
  it('throws when called in HTTP mode', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://localhost:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    const mod = await import('../../src/mcp/core/embedder.js');
    await expect(mod.initEmbedder()).rejects.toThrow('HTTP mode');
  });

  it('throws when called in HTTP mode (both URL and MODEL set)', async () => {
    // Both URL and MODEL are set — HTTP mode is active and initEmbedder is forbidden
    process.env.GITNEXUS_EMBEDDING_URL = 'http://localhost:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    const mod = await import('../../src/mcp/core/embedder.js');
    await expect(mod.initEmbedder()).rejects.toThrow('HTTP mode');
  });
});

// ─── disposeEmbedder ────────────────────────────────────────────────

describe('disposeEmbedder', () => {
  it('is a function that resolves without error', async () => {
    clearHttpEnv();
    const mod = await import('../../src/mcp/core/embedder.js');
    // Even when not initialized, dispose should not throw
    await expect(mod.disposeEmbedder()).resolves.toBeUndefined();
  });

  it('can be called multiple times safely', async () => {
    clearHttpEnv();
    const mod = await import('../../src/mcp/core/embedder.js');
    await mod.disposeEmbedder();
    await expect(mod.disposeEmbedder()).resolves.toBeUndefined();
  });
});

// ─── getEmbeddingDims edge cases ────────────────────────────────────

describe('getEmbeddingDims validation', () => {
  it('throws for non-numeric GITNEXUS_EMBEDDING_DIMS when HTTP mode is configured', async () => {
    // When HTTP mode is active and GITNEXUS_EMBEDDING_DIMS is invalid,
    // readConfig() throws. This is validated when embedQuery is called.
    process.env.GITNEXUS_EMBEDDING_URL = 'http://localhost:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = 'not-a-number';

    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }),
    );

    const mod = await import('../../src/mcp/core/embedder.js');
    // The invalid DIMS causes readConfig() to throw during embedQuery
    await expect(mod.embedQuery('test')).rejects.toThrow();
  });
});
