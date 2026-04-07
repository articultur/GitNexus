/**
 * Unit tests for Path-Sensitive Analysis
 */
import { describe, it, expect } from 'vitest';
import { analyzePathSensitive, satisfiesConstraints, mergePathFacts } from '../../../src/core/ingestion/dataflow/path-sensitive';
import { buildCFGFromStatements } from '../../../src/core/ingestion/dataflow/cfg-builder';
import type { ParsedStatement } from '../../../src/core/ingestion/dataflow/cfg-builder';

describe('Path-Sensitive Analysis', () => {
  describe('analyzePathSensitive', () => {
    it('should analyze simple sequential flow', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = 1', line: 1 },
        { type: 'assignment', content: 'y = x + 1', line: 2 },
        { type: 'return', content: 'return y', line: 3 },
      ];

      const cfg = buildCFGFromStatements('simple', statements);
      const result = analyzePathSensitive(cfg, 10, 100);

      expect(result.pathCount).toBeGreaterThan(0);
      expect(result.paths.size).toBeGreaterThan(0);
    });

    it('should handle branch with if statement', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = input()', line: 1 },
        { type: 'if', content: 'if (x > 0)', line: 2 },
        { type: 'assignment', content: 'y = x', line: 3 },
        { type: 'assignment', content: 'z = x', line: 4 },
      ];

      const cfg = buildCFGFromStatements('branched', statements);
      const result = analyzePathSensitive(cfg, 10, 100);

      // Should have explored multiple paths
      expect(result.pathCount).toBeGreaterThan(0);
    });

    it('should respect maxDepth limit', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = 1', line: 1 },
        { type: 'assignment', content: 'y = x', line: 2 },
        { type: 'assignment', content: 'z = y', line: 3 },
        { type: 'assignment', content: 'w = z', line: 4 },
      ];

      const cfg = buildCFGFromStatements('deep', statements);
      const result = analyzePathSensitive(cfg, 2, 100); // maxDepth = 2

      expect(result.pathCount).toBeLessThan(10);
    });

    it('should respect maxPaths limit', () => {
      // Create many branches
      const statements: ParsedStatement[] = [
        { type: 'if', content: 'if (a)', line: 1 },
        { type: 'if', content: 'if (b)', line: 2 },
        { type: 'if', content: 'if (c)', line: 3 },
        { type: 'if', content: 'if (d)', line: 4 },
      ];

      const cfg = buildCFGFromStatements('manyBranches', statements);
      const result = analyzePathSensitive(cfg, 10, 5); // maxPaths = 5

      expect(result.pathCount).toBeLessThanOrEqual(5);
    });

    it('should handle empty CFG', () => {
      const cfg = buildCFGFromStatements('empty', []);
      const result = analyzePathSensitive(cfg, 10, 100);

      expect(result.pathCount).toBe(1); // Just the root path
      expect(result.paths.size).toBe(1);
    });
  });

  describe('satisfiesConstraints', () => {
    it('should return false for UNINIT values', () => {
      const result = satisfiesConstraints('UNINIT', []);
      expect(result).toBe(false);
    });

    it('should return true for CONSTANT values with no constraints', () => {
      const result = satisfiesConstraints('CONSTANT', []);
      expect(result).toBe(true);
    });

    it('should return true for SANITIZED values with no constraints', () => {
      const result = satisfiesConstraints('SANITIZED', []);
      expect(result).toBe(true);
    });

    it('should return true for CONSTANT values with constraints', () => {
      const result = satisfiesConstraints('CONSTANT', [
        { condition: 'x > 0', variable: 'x', value: '0' },
      ]);
      expect(result).toBe(true);
    });
  });

  describe('mergePathFacts', () => {
    it('should merge facts from multiple paths', () => {
      const path1 = new Map<string, string>();
      path1.set('x', 'TAINTED');
      path1.set('y', 'CONSTANT');

      const path2 = new Map<string, string>();
      path2.set('x', 'CONSTANT');
      path2.set('y', 'CONSTANT');

      const pathFacts = [path1, path2];

      // Simple join function: CONSTANT + anything = that thing, else NAC
      const join = (a: string, b: string): string => {
        if (a === 'CONSTANT') return b;
        if (b === 'CONSTANT') return a;
        if (a === b) return a;
        return 'NAC';
      };

      const result = mergePathFacts(pathFacts, join);

      expect(result.has('x')).toBe(true);
      expect(result.has('y')).toBe(true);
    });

    it('should return empty map for empty input', () => {
      const result = mergePathFacts([], (a, b) => a);
      expect(result.size).toBe(0);
    });

    it('should handle single path', () => {
      const path1 = new Map<string, string>();
      path1.set('x', 'TAINTED');

      const result = mergePathFacts([path1], (a, b) => a);

      expect(result.get('x')).toBe('TAINTED');
    });
  });
});
