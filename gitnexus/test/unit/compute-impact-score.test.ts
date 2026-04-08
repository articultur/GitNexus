/**
 * Unit tests for computeImpactScore unified scoring model.
 */

import { describe, it, expect } from 'vitest';
import { computeImpactScore, type ImpactedItem } from '../../src/mcp/local/tools/shared.js';

describe('computeImpactScore', () => {
  describe('basic scoring', () => {
    it('returns LOW risk for minimal impact', () => {
      const result = computeImpactScore({
        directCount: 1,
        processCount: 0,
        moduleCount: 0,
        totalCount: 1,
      });

      expect(result.score).toBeLessThan(25);
      expect(result.risk).toBe('LOW');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('returns MEDIUM risk for moderate impact', () => {
      // Need score >= 25: directCount=10 gives direct_impact=20
      // With processCount=2 (3) + moduleCount=2 (2) + totalCount=50 (~19.7)
      // rawSum ≈ 20 + 3 + 2 + 19.7 = 44.7, score ≈ 34 (MEDIUM)
      const result = computeImpactScore({
        directCount: 10,
        processCount: 2,
        moduleCount: 2,
        totalCount: 50,
      });

      expect(result.score).toBeGreaterThanOrEqual(25);
      expect(result.risk).toBe('MEDIUM');
    });

    it('returns HIGH risk for significant impact', () => {
      // Need score >= 50: directCount=25 gives direct_impact=50 (max)
      // With processCount=5 (7.5) + moduleCount=4 (4) + totalCount=200 (~26.5)
      // rawSum ≈ 50 + 7.5 + 4 + 26.5 = 88, score ≈ 68 (HIGH)
      const result = computeImpactScore({
        directCount: 25,
        processCount: 5,
        moduleCount: 4,
        totalCount: 200,
      });

      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.risk).toBe('HIGH');
    });

    it('returns CRITICAL risk for massive impact', () => {
      // Need score >= 80: Need rawSum >= 104
      // directCount=25 gives direct_impact=50 (max)
      // processCount=15 gives process_impact=22.5 (capped at 30)
      // moduleCount=15 gives module_impact=15 (capped at 20)
      // totalCount=1000 gives total_impact=30 (max)
      // rawSum ≈ 50 + 22.5 + 15 + 30 = 117.5, score ≈ 90 (CRITICAL)
      const result = computeImpactScore({
        directCount: 25,
        processCount: 15,
        moduleCount: 15,
        totalCount: 1000,
      });

      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.risk).toBe('CRITICAL');
    });
  });

  describe('score breakdown', () => {
    it('includes all dimension contributions', () => {
      const result = computeImpactScore({
        directCount: 10,
        processCount: 3,
        moduleCount: 2,
        totalCount: 50,
      });

      expect(result.score_breakdown).toHaveProperty('direct_impact');
      expect(result.score_breakdown).toHaveProperty('process_impact');
      expect(result.score_breakdown).toHaveProperty('module_impact');
      expect(result.score_breakdown).toHaveProperty('total_impact');

      // Direct should have highest weight
      expect(result.score_breakdown.direct_impact).toBeGreaterThan(
        result.score_breakdown.total_impact,
      );
    });
  });

  describe('top contributors', () => {
    it('calculates top contributors from impacted items', () => {
      const impactedItems: ImpactedItem[] = [
        { depth: 1, relationType: 'CALLS', confidence: 0.9, name: 'funcA' },
        { depth: 1, relationType: 'IMPORTS', confidence: 0.85, name: 'funcB' },
        { depth: 2, relationType: 'CALLS', confidence: 0.8, name: 'funcC' },
        { depth: 3, relationType: 'EXTENDS', confidence: 0.7, name: 'funcD' },
        { depth: 1, relationType: 'IMPLEMENTS', confidence: 0.9, name: 'funcE' },
        { depth: 2, relationType: 'CALLS', confidence: 0.75, name: 'funcF' },
      ];

      const result = computeImpactScore({
        directCount: 3,
        processCount: 2,
        moduleCount: 1,
        totalCount: 6,
        impactedItems,
        direction: 'upstream',
      });

      expect(result.top_contributors.length).toBeLessThanOrEqual(5);
      expect(result.top_contributors[0].symbol).toBeDefined();
      expect(result.top_contributors[0].contribution).toBeGreaterThan(0);
      expect(result.top_contributors[0].reason).toContain('Direct');
    });

    it('prioritizes depth 1 items over deeper items', () => {
      const impactedItems: ImpactedItem[] = [
        { depth: 3, relationType: 'CALLS', confidence: 0.9, name: 'deepFunc' },
        { depth: 1, relationType: 'CALLS', confidence: 0.9, name: 'directFunc' },
      ];

      const result = computeImpactScore({
        directCount: 1,
        processCount: 0,
        moduleCount: 0,
        totalCount: 2,
        impactedItems,
        direction: 'upstream',
      });

      const directIdx = result.top_contributors.findIndex((c) => c.symbol === 'directFunc');
      const deepIdx = result.top_contributors.findIndex((c) => c.symbol === 'deepFunc');
      expect(directIdx).toBeLessThan(deepIdx);
    });

    it('returns empty contributors when no impacted items provided', () => {
      const result = computeImpactScore({
        directCount: 5,
        processCount: 1,
        moduleCount: 1,
        totalCount: 10,
      });

      expect(result.top_contributors).toEqual([]);
    });
  });

  describe('confidence calculation', () => {
    it('has higher confidence with impacted items data', () => {
      const withoutItems = computeImpactScore({
        directCount: 5,
        processCount: 1,
        moduleCount: 1,
        totalCount: 10,
      });

      const withItems = computeImpactScore({
        directCount: 5,
        processCount: 1,
        moduleCount: 1,
        totalCount: 10,
        impactedItems: [{ depth: 1, relationType: 'CALLS', confidence: 0.9, name: 'funcA' }],
        direction: 'upstream',
      });

      expect(withItems.confidence).toBeGreaterThan(withoutItems.confidence);
    });
  });

  describe('direction awareness', () => {
    it('generates appropriate reasons for upstream direction', () => {
      const impactedItems: ImpactedItem[] = [
        { depth: 1, relationType: 'CALLS', confidence: 0.9, name: 'caller' },
      ];

      const result = computeImpactScore({
        directCount: 1,
        processCount: 0,
        moduleCount: 0,
        totalCount: 1,
        impactedItems,
        direction: 'upstream',
      });

      expect(result.top_contributors[0].reason).toContain('caller');
    });

    it('generates appropriate reasons for downstream direction', () => {
      const impactedItems: ImpactedItem[] = [
        { depth: 1, relationType: 'CALLS', confidence: 0.9, name: 'callee' },
      ];

      const result = computeImpactScore({
        directCount: 1,
        processCount: 0,
        moduleCount: 0,
        totalCount: 1,
        impactedItems,
        direction: 'downstream',
      });

      expect(result.top_contributors[0].reason).toContain('callee');
    });
  });

  describe('edge cases', () => {
    it('handles zero counts', () => {
      const result = computeImpactScore({
        directCount: 0,
        processCount: 0,
        moduleCount: 0,
        totalCount: 0,
      });

      expect(result.score).toBe(0);
      expect(result.risk).toBe('LOW');
    });

    it('handles very large counts', () => {
      const result = computeImpactScore({
        directCount: 1000,
        processCount: 100,
        moduleCount: 50,
        totalCount: 5000,
      });

      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.risk).toBe('CRITICAL');
    });

    it('normalizes score to 0-100 range', () => {
      // Test various combinations to ensure score stays in range
      for (let i = 0; i < 10; i++) {
        const result = computeImpactScore({
          directCount: Math.floor(Math.random() * 100),
          processCount: Math.floor(Math.random() * 50),
          moduleCount: Math.floor(Math.random() * 30),
          totalCount: Math.floor(Math.random() * 500),
        });

        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      }
    });

    it('score_breakdown contains all four dimension keys', () => {
      const result = computeImpactScore({
        directCount: 5,
        processCount: 2,
        moduleCount: 1,
        totalCount: 20,
      });

      expect(result.score_breakdown).toHaveProperty('direct_impact');
      expect(result.score_breakdown).toHaveProperty('process_impact');
      expect(result.score_breakdown).toHaveProperty('module_impact');
      expect(result.score_breakdown).toHaveProperty('total_impact');
      // All breakdown values should be non-negative
      for (const val of Object.values(result.score_breakdown)) {
        expect(val).toBeGreaterThanOrEqual(0);
      }
    });

    it('confidence is capped at 1.0 even with many high-confidence direct items', () => {
      const manyDirectItems: ImpactedItem[] = Array.from({ length: 50 }, (_, i) => ({
        depth: 1,
        relationType: 'CALLS',
        confidence: 1.0,
        name: `func${i}`,
      }));

      const result = computeImpactScore({
        directCount: 50,
        processCount: 5,
        moduleCount: 3,
        totalCount: 50,
        impactedItems: manyDirectItems,
        direction: 'upstream',
      });

      expect(result.confidence).toBeLessThanOrEqual(1.0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });
  });
});
