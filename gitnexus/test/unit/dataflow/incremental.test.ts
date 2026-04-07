/**
 * Unit tests for Incremental Data Flow Analysis
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import {
  detectChangedFunctions,
  getTransitiveDependencies,
  filterSkippableFunctions,
  estimateAnalysisCost,
} from '../../../src/core/ingestion/dataflow/incremental';
import { createKnowledgeGraph } from '../../../src/core/graph/graph';

// Mock child_process module
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('Incremental Analysis', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;

  beforeEach(() => {
    graph = createKnowledgeGraph();
  });

  describe('getTransitiveDependencies', () => {
    it('should find direct callees', () => {
      // Create test functions
      graph.addNode({
        id: 'Function:a',
        label: 'Function',
        properties: { name: 'a', filePath: 'a.ts' },
      });
      graph.addNode({
        id: 'Function:b',
        label: 'Function',
        properties: { name: 'b', filePath: 'b.ts' },
      });
      graph.addNode({
        id: 'Function:c',
        label: 'Function',
        properties: { name: 'c', filePath: 'c.ts' },
      });

      // a calls b, b calls c
      graph.addRelationship({
        id: 'CALLS:a->b',
        sourceId: 'Function:a',
        targetId: 'Function:b',
        type: 'CALLS',
        confidence: 1.0,
        reason: 'test',
      });
      graph.addRelationship({
        id: 'CALLS:b->c',
        sourceId: 'Function:b',
        targetId: 'Function:c',
        type: 'CALLS',
        confidence: 1.0,
        reason: 'test',
      });

      const deps = getTransitiveDependencies(graph, ['Function:c']);

      expect(deps).toContain('Function:c');
      expect(deps).toContain('Function:b');
      expect(deps).toContain('Function:a');
    });

    it('should handle empty input', () => {
      const deps = getTransitiveDependencies(graph, []);
      expect(deps).toEqual([]);
    });

    it('should handle function with no dependencies', () => {
      graph.addNode({
        id: 'Function:orphan',
        label: 'Function',
        properties: { name: 'orphan', filePath: 'orphan.ts' },
      });

      const deps = getTransitiveDependencies(graph, ['Function:orphan']);
      expect(deps).toEqual(['Function:orphan']);
    });
  });

  describe('filterSkippableFunctions', () => {
    it('should filter functions not calling affected functions', () => {
      graph.addNode({
        id: 'Function:affected',
        label: 'Function',
        properties: { name: 'affected', filePath: 'a.ts' },
      });
      graph.addNode({
        id: 'Function:clean',
        label: 'Function',
        properties: { name: 'clean', filePath: 'b.ts' },
      });

      graph.addRelationship({
        id: 'CALLS:clean->affected',
        sourceId: 'Function:clean',
        targetId: 'Function:affected',
        type: 'CALLS',
        confidence: 1.0,
        reason: 'test',
      });

      const allFunctions = ['Function:affected', 'Function:clean'];
      const affectedFunctions = ['Function:affected'];

      const skippable = filterSkippableFunctions(graph, allFunctions, affectedFunctions);

      // 'clean' calls 'affected', so it should NOT be skippable
      expect(skippable).not.toContain('Function:clean');
    });

    it('should allow skippable functions that do not call affected', () => {
      graph.addNode({
        id: 'Function:unrelated',
        label: 'Function',
        properties: { name: 'unrelated', filePath: 'c.ts' },
      });

      const allFunctions = ['Function:unrelated'];
      const affectedFunctions = ['Function:different'];

      const skippable = filterSkippableFunctions(graph, allFunctions, affectedFunctions);

      expect(skippable).toContain('Function:unrelated');
    });
  });

  describe('estimateAnalysisCost', () => {
    it('should return 0 for empty graph', () => {
      const cost = estimateAnalysisCost(graph, 'Function:nonexistent');
      expect(cost).toBe(0);
    });

    it('should estimate cost based on nodes and edges', () => {
      graph.addNode({
        id: 'Function:func1',
        label: 'Function',
        properties: { name: 'func1', filePath: 'f1.ts' },
      });

      graph.addRelationship({
        id: 'CALLS:func1->func1',
        sourceId: 'Function:func1',
        targetId: 'Function:func1',
        type: 'CALLS',
        confidence: 1.0,
        reason: 'test',
      });

      const cost = estimateAnalysisCost(graph, 'Function:func1');
      // cost = nodeCount * 10 + edgeCount = 1 * 10 + 1 = 11
      expect(cost).toBe(11);
    });

    it('should return 0 for function not in graph', () => {
      const cost = estimateAnalysisCost(graph, 'Function:doesnotexist');
      expect(cost).toBe(0);
    });
  });

  describe('detectChangedFunctions (mocked git)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should throw error when git fails', async () => {
      const { execFileSync } = await import('node:child_process');
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('Not a git repo');
      });

      await expect(detectChangedFunctions('/fake/path', graph)).rejects.toThrow(
        'Git diff failed: Not a git repo at /fake/path',
      );
    });

    it('should return empty arrays when no git changes', async () => {
      const { execFileSync } = await import('node:child_process');
      // Empty git output means no changes
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await detectChangedFunctions('/fake/path', graph);

      expect(result.changedFiles).toEqual([]);
      expect(result.affectedFunctions).toEqual([]);
      expect(result.callGraphChanged).toBe(false);
    });

    it('should include renamed files (R status)', async () => {
      const { execFileSync } = await import('node:child_process');
      // git diff --name-status format: R<score>\t<old>\t<new>
      vi.mocked(execFileSync).mockReturnValue('R100\told/path.ts\tnew/path.ts\n');

      const result = await detectChangedFunctions('/fake/path', graph);

      expect(result.changedFiles).toContain('new/path.ts');
      expect(result.changedFiles).not.toContain('old/path.ts');
    });

    it('should include modified files (M status)', async () => {
      const { execFileSync } = await import('node:child_process');
      vi.mocked(execFileSync).mockReturnValue('M\tsrc/utils/auth.ts\n');

      const result = await detectChangedFunctions('/fake/path', graph);

      expect(result.changedFiles).toContain('src/utils/auth.ts');
    });

    it('should include added files (A status)', async () => {
      const { execFileSync } = await import('node:child_process');
      vi.mocked(execFileSync).mockReturnValue('A\tnew/file.ts\n');

      const result = await detectChangedFunctions('/fake/path', graph);

      expect(result.changedFiles).toContain('new/file.ts');
    });

    it('should exclude deleted files (D status)', async () => {
      const { execFileSync } = await import('node:child_process');
      vi.mocked(execFileSync).mockReturnValue('D\tdeleted/file.ts\n');

      const result = await detectChangedFunctions('/fake/path', graph);

      expect(result.changedFiles).not.toContain('deleted/file.ts');
    });
  });

  describe('path matching', () => {
    it('should NOT match auth.ts with auth-helpers.ts', async () => {
      const { execFileSync } = await import('node:child_process');
      // Simulate git diff that changes auth-helpers.ts
      vi.mocked(execFileSync).mockReturnValue('M\tsrc/utils/auth-helpers.ts\n');

      // Add a function in auth.ts
      graph.addNode({
        id: 'Function:login',
        label: 'Function',
        properties: { name: 'login', filePath: 'src/utils/auth.ts' },
      });

      const result = await detectChangedFunctions('/fake/path', graph);

      // auth.ts function should NOT be affected because we changed auth-helpers.ts
      expect(result.affectedFunctions).not.toContain('Function:login');
    });

    it('should match exact file path', async () => {
      const { execFileSync } = await import('node:child_process');
      // Simulate git diff that changes auth.ts
      vi.mocked(execFileSync).mockReturnValue('M\tsrc/utils/auth.ts\n');

      // Add a function in auth.ts
      graph.addNode({
        id: 'Function:login',
        label: 'Function',
        properties: { name: 'login', filePath: 'src/utils/auth.ts' },
      });

      const result = await detectChangedFunctions('/fake/path', graph);

      // auth.ts function SHOULD be affected
      expect(result.affectedFunctions).toContain('Function:login');
    });

    it('should match file in parent directory when sibling file changes', async () => {
      const { execFileSync } = await import('node:child_process');
      // Simulate git diff that changes auth-helpers.ts in same directory as auth.ts
      vi.mocked(execFileSync).mockReturnValue('M\tsrc/utils/auth-helpers.ts\n');

      // Add a function in auth.ts
      graph.addNode({
        id: 'Function:login',
        label: 'Function',
        properties: { name: 'login', filePath: 'src/utils/auth.ts' },
      });

      const result = await detectChangedFunctions('/fake/path', graph);

      // auth.ts should NOT be affected - only auth-helpers.ts changed
      expect(result.affectedFunctions).not.toContain('Function:login');
    });

    it('should handle paths with backslashes (Windows)', async () => {
      const { execFileSync } = await import('node:child_process');
      // Windows format: status followed by tab, then path with backslashes
      vi.mocked(execFileSync).mockReturnValue('M\tsrc\\utils\\auth.ts\n');

      graph.addNode({
        id: 'Function:login',
        label: 'Function',
        properties: { name: 'login', filePath: 'src/utils/auth.ts' },
      });

      const result = await detectChangedFunctions('/fake/path', graph);

      // Should match despite backslash differences
      expect(result.affectedFunctions).toContain('Function:login');
    });
  });
});
