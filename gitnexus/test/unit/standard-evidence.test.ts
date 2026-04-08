/**
 * Unit tests for StandardEvidence schema and builder.
 */

import { describe, it, expect } from 'vitest';
import { createEvidenceBuilder } from '../../src/mcp/local/tools/shared.js';

describe('createEvidenceBuilder', () => {
  describe('basic building', () => {
    it('creates empty evidence with auto-generated explanation', () => {
      const builder = createEvidenceBuilder();
      const evidence = builder.build();

      expect(evidence.explanation).toBe('No direct impact paths found.');
      expect(evidence.paths).toEqual([]);
      expect(evidence.critical_edges).toEqual([]);
      expect(evidence.confidence_breakdown).toEqual({});
      expect(evidence.exclusions).toBeUndefined();
    });

    it('builds evidence with custom explanation', () => {
      const builder = createEvidenceBuilder();
      builder.addExplanation('Custom impact explanation');
      const evidence = builder.build();

      expect(evidence.explanation).toBe('Custom impact explanation');
    });

    it('appends multiple explanations', () => {
      const builder = createEvidenceBuilder();
      builder.addExplanation('First part.');
      builder.addExplanation('Second part.');
      const evidence = builder.build();

      expect(evidence.explanation).toBe('First part. Second part.');
    });
  });

  describe('paths', () => {
    it('adds paths to evidence', () => {
      const builder = createEvidenceBuilder();
      builder.addPath(
        { id: 'func:src/a.ts', name: 'funcA', filePath: 'src/a.ts' },
        { id: 'func:src/b.ts', name: 'funcB', filePath: 'src/b.ts' },
        'CALLS',
      );
      const evidence = builder.build();

      expect(evidence.paths.length).toBe(1);
      expect(evidence.paths[0].from.name).toBe('funcA');
      expect(evidence.paths[0].to.name).toBe('funcB');
      expect(evidence.paths[0].relation).toBe('CALLS');
    });

    it('deduplicates identical paths', () => {
      const builder = createEvidenceBuilder();
      builder.addPath({ id: 'func:a', name: 'fA' }, { id: 'func:b', name: 'fB' }, 'CALLS');
      builder.addPath({ id: 'func:a', name: 'fA' }, { id: 'func:b', name: 'fB' }, 'CALLS');
      const evidence = builder.build();

      expect(evidence.paths.length).toBe(1);
    });

    it('allows different paths', () => {
      const builder = createEvidenceBuilder();
      builder.addPath({ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, 'CALLS');
      builder.addPath({ id: 'a', name: 'A' }, { id: 'c', name: 'C' }, 'IMPORTS');
      const evidence = builder.build();

      expect(evidence.paths.length).toBe(2);
    });
  });

  describe('critical edges', () => {
    it('adds critical edges to evidence', () => {
      const builder = createEvidenceBuilder();
      builder.addCriticalEdge('node:a', 'node:b', 'CALLS', 0.9);
      const evidence = builder.build();

      expect(evidence.critical_edges.length).toBe(1);
      expect(evidence.critical_edges[0].source).toBe('node:a');
      expect(evidence.critical_edges[0].target).toBe('node:b');
      expect(evidence.critical_edges[0].confidence).toBe(0.9);
    });

    it('deduplicates identical edges', () => {
      const builder = createEvidenceBuilder();
      builder.addCriticalEdge('a', 'b', 'CALLS', 0.9);
      builder.addCriticalEdge('a', 'b', 'CALLS', 0.9);
      const evidence = builder.build();

      expect(evidence.critical_edges.length).toBe(1);
    });

    it('allows edges with different confidence', () => {
      const builder = createEvidenceBuilder();
      builder.addCriticalEdge('a', 'b', 'CALLS', 0.9);
      builder.addCriticalEdge('a', 'b', 'CALLS', 0.8);
      const evidence = builder.build();

      // Same source/target/type should still be deduplicated
      expect(evidence.critical_edges.length).toBe(1);
    });
  });

  describe('confidence breakdown', () => {
    it('adds confidence factors', () => {
      const builder = createEvidenceBuilder();
      builder.addConfidenceFactor('relation_quality', 0.85);
      builder.addConfidenceFactor('data_completeness', 0.9);
      const evidence = builder.build();

      expect(evidence.confidence_breakdown['relation_quality']).toBe(0.85);
      expect(evidence.confidence_breakdown['data_completeness']).toBe(0.9);
    });

    it('clamps confidence values to valid range', () => {
      const builder = createEvidenceBuilder();
      builder.addConfidenceFactor('too_high', 1.5);
      builder.addConfidenceFactor('too_low', -0.5);
      const evidence = builder.build();

      expect(evidence.confidence_breakdown['too_high']).toBe(1);
      expect(evidence.confidence_breakdown['too_low']).toBe(0);
    });

    it('overwrites existing factors', () => {
      const builder = createEvidenceBuilder();
      builder.addConfidenceFactor('factor', 0.5);
      builder.addConfidenceFactor('factor', 0.8);
      const evidence = builder.build();

      expect(evidence.confidence_breakdown['factor']).toBe(0.8);
    });
  });

  describe('exclusions', () => {
    it('adds exclusions', () => {
      const builder = createEvidenceBuilder();
      builder.addExclusion('Test files excluded');
      builder.addExclusion('Node modules excluded');
      const evidence = builder.build();

      expect(evidence.exclusions).toBeDefined();
      expect(evidence.exclusions!.length).toBe(2);
      expect(evidence.exclusions).toContain('Test files excluded');
    });

    it('deduplicates exclusions', () => {
      const builder = createEvidenceBuilder();
      builder.addExclusion('Same reason');
      builder.addExclusion('Same reason');
      const evidence = builder.build();

      expect(evidence.exclusions!.length).toBe(1);
    });

    it('omits exclusions array when empty', () => {
      const builder = createEvidenceBuilder();
      const evidence = builder.build();

      expect(evidence.exclusions).toBeUndefined();
    });
  });

  describe('auto-explanation generation', () => {
    it('generates explanation for paths only', () => {
      const builder = createEvidenceBuilder();
      builder.addPath({ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, 'CALLS');
      const evidence = builder.build();

      expect(evidence.explanation).toContain('1 impact path');
      expect(evidence.explanation).not.toContain('critical edge');
    });

    it('generates explanation for edges only', () => {
      const builder = createEvidenceBuilder();
      builder.addCriticalEdge('a', 'b', 'CALLS', 0.9);
      const evidence = builder.build();

      expect(evidence.explanation).toContain('1 critical edge');
      expect(evidence.explanation).not.toContain('impact path');
    });

    it('generates explanation for both paths and edges', () => {
      const builder = createEvidenceBuilder();
      builder.addPath({ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, 'CALLS');
      builder.addCriticalEdge('a', 'b', 'CALLS', 0.9);
      const evidence = builder.build();

      expect(evidence.explanation).toContain('1 impact path');
      expect(evidence.explanation).toContain('1 critical edge');
    });

    it('uses plural correctly', () => {
      const builder = createEvidenceBuilder();
      builder.addPath({ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, 'CALLS');
      builder.addPath({ id: 'b', name: 'B' }, { id: 'c', name: 'C' }, 'IMPORTS');
      const evidence = builder.build();

      expect(evidence.explanation).toContain('2 impact paths');
    });
  });

  describe('immutability', () => {
    it('returns copies of arrays', () => {
      const builder = createEvidenceBuilder();
      builder.addPath({ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, 'CALLS');

      const evidence1 = builder.build();
      builder.addPath({ id: 'c', name: 'C' }, { id: 'd', name: 'D' }, 'EXTENDS');
      const evidence2 = builder.build();

      expect(evidence1.paths.length).toBe(1);
      expect(evidence2.paths.length).toBe(2);
    });
  });

  describe('complex scenarios', () => {
    it('builds complete evidence for real impact scenario', () => {
      const builder = createEvidenceBuilder();

      builder.addExplanation('Impact analysis for function authenticateUser');
      builder.addPath(
        {
          id: 'Function:src/auth.ts:authenticateUser',
          name: 'authenticateUser',
          filePath: 'src/auth.ts',
        },
        { id: 'Function:src/api.ts:login', name: 'login', filePath: 'src/api.ts' },
        'CALLS',
      );
      builder.addPath(
        {
          id: 'Function:src/auth.ts:authenticateUser',
          name: 'authenticateUser',
          filePath: 'src/auth.ts',
        },
        { id: 'Function:src/api.ts:logout', name: 'logout', filePath: 'src/api.ts' },
        'CALLS',
      );
      builder.addCriticalEdge(
        'Function:src/auth.ts:authenticateUser',
        'Function:src/api.ts:login',
        'CALLS',
        0.95,
      );
      builder.addConfidenceFactor('relation_confidence', 0.92);
      builder.addConfidenceFactor('graph_completeness', 0.85);
      builder.addExclusion('Test files excluded from analysis');

      const evidence = builder.build();

      expect(evidence.explanation).toBe('Impact analysis for function authenticateUser');
      expect(evidence.paths.length).toBe(2);
      expect(evidence.critical_edges.length).toBe(1);
      expect(Object.keys(evidence.confidence_breakdown).length).toBe(2);
      expect(evidence.exclusions!.length).toBe(1);
    });
  });
});
