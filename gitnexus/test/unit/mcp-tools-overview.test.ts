/**
 * Unit Tests: mcp/local/tools/overview — pure utility functions
 *
 * Covers aggregateClusters and formatCypherAsMarkdown which are pure
 * transformation functions with no I/O dependencies.
 */
import { describe, it, expect } from 'vitest';
import { aggregateClusters, formatCypherAsMarkdown } from '../../src/mcp/local/tools/overview.js';

// ─── aggregateClusters ────────────────────────────────────────────────────

describe('aggregateClusters', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateClusters([])).toEqual([]);
  });

  it('filters out clusters with fewer than 5 symbols', () => {
    const clusters = [
      { id: 'c1', heuristicLabel: 'Small', symbolCount: 2, cohesion: 0.5 },
      { id: 'c2', heuristicLabel: 'AlsoSmall', symbolCount: 4, cohesion: 0.6 },
    ];
    expect(aggregateClusters(clusters)).toEqual([]);
  });

  it('keeps clusters with exactly 5 symbols', () => {
    const clusters = [{ id: 'c1', heuristicLabel: 'Boundary', symbolCount: 5, cohesion: 0.5 }];
    const result = aggregateClusters(clusters);
    expect(result).toHaveLength(1);
    expect(result[0].symbolCount).toBe(5);
  });

  it('merges clusters sharing the same heuristicLabel', () => {
    const clusters = [
      { id: 'c1', heuristicLabel: 'Auth', symbolCount: 10, cohesion: 0.8 },
      { id: 'c2', heuristicLabel: 'Auth', symbolCount: 15, cohesion: 0.6 },
    ];
    const result = aggregateClusters(clusters);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Auth');
    expect(result[0].symbolCount).toBe(25);
    expect(result[0].subCommunities).toBe(2);
  });

  it('computes weighted-average cohesion when merging', () => {
    // (0.8 * 10 + 0.6 * 15) / 25 = (8 + 9) / 25 = 17/25 = 0.68
    const clusters = [
      { id: 'c1', heuristicLabel: 'Auth', symbolCount: 10, cohesion: 0.8 },
      { id: 'c2', heuristicLabel: 'Auth', symbolCount: 15, cohesion: 0.6 },
    ];
    const result = aggregateClusters(clusters);
    expect(result[0].cohesion).toBeCloseTo(0.68, 5);
  });

  it('sorts results by symbolCount descending', () => {
    const clusters = [
      { id: 'c1', heuristicLabel: 'Small', symbolCount: 6, cohesion: 0.5 },
      { id: 'c2', heuristicLabel: 'Large', symbolCount: 50, cohesion: 0.7 },
      { id: 'c3', heuristicLabel: 'Medium', symbolCount: 20, cohesion: 0.6 },
    ];
    const result = aggregateClusters(clusters);
    expect(result.map((c) => c.label)).toEqual(['Large', 'Medium', 'Small']);
  });

  it('sets id to the largest community in a merged group', () => {
    const clusters = [
      { id: 'smaller', heuristicLabel: 'Group', symbolCount: 5, cohesion: 0.5 },
      { id: 'bigger', heuristicLabel: 'Group', symbolCount: 30, cohesion: 0.7 },
    ];
    const result = aggregateClusters(clusters);
    expect(result[0].id).toBe('bigger');
  });

  it('uses label fallback when heuristicLabel is absent', () => {
    const clusters = [{ id: 'c1', label: 'FallbackLabel', symbolCount: 10, cohesion: 0.5 }];
    const result = aggregateClusters(clusters);
    expect(result[0].label).toBe('FallbackLabel');
  });

  it('uses "Unknown" when neither label nor heuristicLabel exists', () => {
    const clusters = [{ id: 'c1', symbolCount: 10, cohesion: 0.5 }];
    const result = aggregateClusters(clusters);
    expect(result[0].label).toBe('Unknown');
  });

  it('treats each unique label as its own group', () => {
    const clusters = [
      { id: 'c1', heuristicLabel: 'A', symbolCount: 10, cohesion: 0.5 },
      { id: 'c2', heuristicLabel: 'B', symbolCount: 10, cohesion: 0.5 },
      { id: 'c3', heuristicLabel: 'C', symbolCount: 10, cohesion: 0.5 },
    ];
    expect(aggregateClusters(clusters)).toHaveLength(3);
  });
});

// ─── formatCypherAsMarkdown ───────────────────────────────────────────────

describe('formatCypherAsMarkdown', () => {
  it('returns empty array unchanged', () => {
    expect(formatCypherAsMarkdown([])).toEqual([]);
  });

  it('returns non-array input unchanged', () => {
    expect(formatCypherAsMarkdown(null)).toBeNull();
    expect(formatCypherAsMarkdown('hello')).toBe('hello');
    expect(formatCypherAsMarkdown(42)).toBe(42);
  });

  it('returns array of primitives unchanged', () => {
    expect(formatCypherAsMarkdown([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('returns null-element array unchanged', () => {
    expect(formatCypherAsMarkdown([null])).toEqual([null]);
  });

  it('formats a single-row table with correct header and separator', () => {
    const input = [{ name: 'foo', count: 5 }];
    const result = formatCypherAsMarkdown(input) as { markdown: string; row_count: number };
    expect(result.row_count).toBe(1);
    const lines = result.markdown.split('\n');
    expect(lines[0]).toBe('| name | count |');
    expect(lines[1]).toBe('| --- | --- |');
    expect(lines[2]).toBe('| foo | 5 |');
  });

  it('formats multiple rows correctly', () => {
    const input = [
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ];
    const result = formatCypherAsMarkdown(input) as { markdown: string; row_count: number };
    expect(result.row_count).toBe(2);
    const lines = result.markdown.split('\n');
    expect(lines).toHaveLength(4); // header + sep + 2 data rows
  });

  it('handles null/undefined cell values as empty string', () => {
    const input = [{ name: null, count: undefined }];
    const result = formatCypherAsMarkdown(input) as { markdown: string; row_count: number };
    expect(result.markdown).toContain('|  |  |');
  });

  it('serialises object cell values as JSON', () => {
    const input = [{ meta: { x: 1 } }];
    const result = formatCypherAsMarkdown(input) as { markdown: string; row_count: number };
    expect(result.markdown).toContain('{"x":1}');
  });

  it('returns object with markdown and row_count keys', () => {
    const input = [{ id: 'abc' }];
    const result = formatCypherAsMarkdown(input) as any;
    expect(result).toHaveProperty('markdown');
    expect(result).toHaveProperty('row_count', 1);
  });
});
