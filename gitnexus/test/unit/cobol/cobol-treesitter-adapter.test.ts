/**
/**
 * Tests for COBOL tree-sitter adapter PoC
 *
 * These tests cover the adapter's public API and safety mechanisms WITHOUT
 * requiring tree-sitter-cobol to be installed. The Worker execution is
 * mocked so tests run in any environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCobolTsMode,
  CobolTreeSitterTimeoutError,
  CobolTreeSitterAdapter,
  getCobolTreeSitterAdapter,
} from '../../../../src/core/ingestion/cobol/cobol-treesitter-adapter.js';

// ── Mock worker_threads ────────────────────────────────────────────────────
// vi.mock is hoisted to the top of the file, so any variables referenced
// inside the factory must be declared with vi.hoisted() or defined inline.

const mockState = vi.hoisted(() => ({
  workerBehaviour: 'neverRespond' as 'successOnce' | 'neverRespond' | 'errorOnce',
}));

vi.mock('worker_threads', () => {
  class MockWorkerInstance {
    private _handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

    constructor(_code: string, _opts: unknown) {
      if (mockState.workerBehaviour === 'successOnce') {
        setTimeout(() => {
          this._trigger('message', {
            ok: true,
            symbols: [{ type: 'program', name: 'MY-PROGRAM', startLine: 1 }],
            parseTimeMs: 42,
          });
        }, 5);
      } else if (mockState.workerBehaviour === 'errorOnce') {
        setTimeout(() => {
          this._trigger('message', { ok: false, error: 'Grammar error at line 5' });
        }, 5);
      }
      // 'neverRespond' → no message, timeout will fire
    }

    on(event: string, cb: (...args: unknown[]) => void) {
      (this._handlers[event] ??= []).push(cb);
      return this;
    }

    terminate() {}

    _trigger(event: string, ...args: unknown[]) {
      for (const cb of this._handlers[event] ?? []) cb(...args);
    }
  }

  return { Worker: MockWorkerInstance, isMainThread: true, parentPort: null, workerData: {} };
});

// ── Helpers ───────────────────────────────────────────────────────────────

function makeAdapter(timeoutMs = 200) {
  return new CobolTreeSitterAdapter({ timeoutMs });
}

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  delete process.env.GITNEXUS_COBOL_TREESITTER;
  mockState.workerBehaviour = 'neverRespond';
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.GITNEXUS_COBOL_TREESITTER;
});

describe('getCobolTsMode', () => {
  it('returns false when env is not set', () => {
    expect(getCobolTsMode()).toBe(false);
  });

  it('returns true when env is "1"', () => {
    process.env.GITNEXUS_COBOL_TREESITTER = '1';
    expect(getCobolTsMode()).toBe(true);
  });

  it('returns true when env is "true"', () => {
    process.env.GITNEXUS_COBOL_TREESITTER = 'true';
    expect(getCobolTsMode()).toBe(true);
  });

  it('returns "compare" when env is "compare"', () => {
    process.env.GITNEXUS_COBOL_TREESITTER = 'compare';
    expect(getCobolTsMode()).toBe('compare');
  });

  it('returns false for unknown values', () => {
    process.env.GITNEXUS_COBOL_TREESITTER = 'yes';
    expect(getCobolTsMode()).toBe(false);
  });
});

describe('getCobolTreeSitterAdapter', () => {
  it('returns null when mode is disabled', () => {
    expect(getCobolTreeSitterAdapter()).toBeNull();
  });

  it('returns an adapter instance when mode is enabled', () => {
    process.env.GITNEXUS_COBOL_TREESITTER = '1';
    const adapter = getCobolTreeSitterAdapter();
    expect(adapter).toBeInstanceOf(CobolTreeSitterAdapter);
  });
});

describe('CobolTreeSitterAdapter.extractSymbols', () => {
  it('resolves with symbols from a successful Worker message', async () => {
    mockState.workerBehaviour = 'successOnce';
    const adapter = makeAdapter(500);
    const result = await adapter.extractSymbols('IDENTIFICATION DIVISION.', 'test.cbl');
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe('MY-PROGRAM');
    expect(result.parseTimeMs).toBe(42);
  });

  it('rejects with CobolTreeSitterTimeoutError when Worker times out', async () => {
    mockState.workerBehaviour = 'neverRespond';
    const adapter = makeAdapter(50); // very short timeout
    await expect(
      adapter.extractSymbols('       IDENTIFICATION DIVISION.', 'hang.cbl'),
    ).rejects.toBeInstanceOf(CobolTreeSitterTimeoutError);
  });

  it('rejects when Worker posts ok=false', async () => {
    mockState.workerBehaviour = 'errorOnce';
    const adapter = makeAdapter(500);
    await expect(adapter.extractSymbols('bad source', 'bad.cbl')).rejects.toThrow(
      'Grammar error at line 5',
    );
  });
});

describe('CobolTreeSitterAdapter.tryExtractSymbols', () => {
  it('returns null when extractSymbols times out', async () => {
    mockState.workerBehaviour = 'neverRespond';
    const adapter = makeAdapter(50);
    const result = await adapter.tryExtractSymbols('IDENTIFICATION DIVISION.', 'hang.cbl');
    expect(result).toBeNull();
  });

  it('returns summary when extractSymbols succeeds', async () => {
    mockState.workerBehaviour = 'successOnce';
    const adapter = makeAdapter(500);
    const result = await adapter.tryExtractSymbols('IDENTIFICATION DIVISION.', 'ok.cbl');
    expect(result).not.toBeNull();
    expect(result?.symbols).toHaveLength(1);
  });
});

describe('CobolTreeSitterTimeoutError', () => {
  it('has the correct name and message', () => {
    const err = new CobolTreeSitterTimeoutError('test.cbl', 2000);
    expect(err.name).toBe('CobolTreeSitterTimeoutError');
    expect(err.message).toContain('2000ms');
    expect(err.message).toContain('test.cbl');
    expect(err).toBeInstanceOf(Error);
  });
});
