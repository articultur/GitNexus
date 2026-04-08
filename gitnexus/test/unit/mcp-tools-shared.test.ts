/**
 * Unit Tests: mcp/local/tools/shared — pure utility functions
 *
 * Covers filterRelationTypes, confidenceForRelType, and logQueryError
 * which live in shared.ts and lack direct test coverage elsewhere.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  filterRelationTypes,
  confidenceForRelType,
  logQueryError,
  VALID_RELATION_TYPES,
} from '../../src/mcp/local/tools/shared.js';

// ─── filterRelationTypes ──────────────────────────────────────────────────

describe('filterRelationTypes', () => {
  const defaults = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];

  it('returns defaults when called with no argument', () => {
    expect(filterRelationTypes()).toEqual(defaults);
  });

  it('returns defaults for an empty array', () => {
    expect(filterRelationTypes([])).toEqual(defaults);
  });

  it('returns defaults when all supplied types are invalid', () => {
    expect(filterRelationTypes(['FAKE', 'BOGUS', 'NONEXISTENT'])).toEqual(defaults);
  });

  it('passes through a single known valid type', () => {
    expect(filterRelationTypes(['CALLS'])).toEqual(['CALLS']);
  });

  it('passes through multiple valid types unchanged', () => {
    const input = ['CALLS', 'EXTENDS', 'IMPLEMENTS'];
    expect(filterRelationTypes(input)).toEqual(input);
  });

  it('strips invalid types while keeping valid ones', () => {
    const input = ['CALLS', 'FAKE_TYPE', 'IMPORTS'];
    expect(filterRelationTypes(input)).toEqual(['CALLS', 'IMPORTS']);
  });

  it('accepts all relation types in VALID_RELATION_TYPES', () => {
    const all = Array.from(VALID_RELATION_TYPES);
    expect(filterRelationTypes(all)).toEqual(all);
  });

  it('is case-sensitive — lowercase variants are rejected', () => {
    // Relation types are uppercase in the allowlist
    expect(filterRelationTypes(['calls', 'imports'])).toEqual(defaults);
  });

  it('preserves input ordering', () => {
    const input = ['IMPLEMENTS', 'CALLS', 'EXTENDS'];
    expect(filterRelationTypes(input)).toEqual(['IMPLEMENTS', 'CALLS', 'EXTENDS']);
  });
});

// ─── confidenceForRelType ─────────────────────────────────────────────────

describe('confidenceForRelType (direct import from shared.ts)', () => {
  it('returns the correct floor for CALLS', () => {
    expect(confidenceForRelType('CALLS')).toBe(0.9);
  });

  it('returns 0.5 for unknown relation types', () => {
    expect(confidenceForRelType('UNKNOWN')).toBe(0.5);
  });

  it('returns 0.5 for undefined', () => {
    expect(confidenceForRelType(undefined)).toBe(0.5);
  });

  it('returns 0.5 for empty string', () => {
    expect(confidenceForRelType('')).toBe(0.5);
  });
});

// ─── logQueryError ────────────────────────────────────────────────────────

describe('logQueryError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs Error.message for Error instances', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logQueryError('test-context', new Error('something went wrong'));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('test-context');
    expect(spy.mock.calls[0][0]).toContain('something went wrong');
  });

  it('logs string representation for non-Error values', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logQueryError('query-ctx', 'raw string error');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('query-ctx');
    expect(spy.mock.calls[0][0]).toContain('raw string error');
  });

  it('handles null without throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logQueryError('ctx', null)).not.toThrow();
    spy.mockRestore();
  });
});
