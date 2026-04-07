/**
 * Integration Tests: Data Flow Edge Types in Impact Analysis
 *
 * Tests that impact analysis correctly traverses DATA_FLOW, TAINTED,
 * SINK_REACHABLE and other data flow edge types when --data-flow is enabled.
 *
 * This verifies the acceptance criteria:
 * "API 扩展支持 impact --data-flow"
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// ─── Seed Data ─────────────────────────────────────────────────────────────

/**
 * Create nodes and relationships for testing data flow edge traversal.
 *
 * Graph structure:
 *   sourceFunc ->(DATA_FLOW)-> intermediateVar ->(TAINTED)-> sinkFunc
 *   sourceFunc ->(CALLS)-> caller
 */
const DATA_FLOW_SEED = [
  // Nodes
  `CREATE (source:Function {id:'fn:sourceFunc', name:'sourceFunc', filePath:'test.ts', startLine:1, endLine:10, isExported:true, content:'function sourceFunc() { return userInput(); }', description:''})`,
  `CREATE (intermediate:Function {id:'fn:intermediate', name:'intermediate', filePath:'test.ts', startLine:12, endLine:20, isExported:true, content:'function intermediate(x) { return sanitize(x); }', description:''})`,
  `CREATE (sink:Function {id:'fn:sinkFunc', name:'sinkFunc', filePath:'test.ts', startLine:22, endLine:30, isExported:true, content:'function sinkFunc(x) { return execute(x); }', description:''})`,
  `CREATE (caller:Function {id:'fn:caller', name:'caller', filePath:'test.ts', startLine:32, endLine:40, isExported:true, content:'function caller() { sinkFunc(intermediate(sourceFunc())); }', description:''})`,

  // Standard CALLS edge
  `MATCH (a:Function {id:'fn:caller'}), (b:Function {id:'fn:sinkFunc'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct call', step:0}]->(b)`,

  // DATA_FLOW edge (value propagation)
  `MATCH (a:Function {id:'fn:sourceFunc'}), (b:Function {id:'fn:intermediate'}) CREATE (a)-[:CodeRelation {type:'DATA_FLOW', confidence:0.75, reason:'value flows from source to intermediate', step:1}]->(b)`,

  // TAINTED edge (tainted value propagation)
  `MATCH (a:Function {id:'fn:intermediate'}), (b:Function {id:'fn:sinkFunc'}) CREATE (a)-[:CodeRelation {type:'TAINTED', confidence:0.7, reason:'tainted value reaches sink', step:2}]->(b)`,
];

// ─── Tests ─────────────────────────────────────────────────────────────────

withTestLbugDB(
  'dataflow-impact',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as any)._backend;
    });

    // ─── Test 1: impact without --data-flow (default relationTypes) ─────────
    describe('impact without --data-flow (default relationTypes)', () => {
      it('only traverses CALLS edges, not DATA_FLOW edges', async () => {
        const result = await backend.callTool('impact', {
          target: 'sourceFunc',
          direction: 'downstream',
          maxDepth: 3,
        });

        // Should find sinkFunc through CALLS path (caller -> sinkFunc)
        const impactedIds = Object.values(result.byDepth as Record<string, any[]>)
          .flat()
          .map((item: any) => item.id);

        // The DATA_FLOW edge from sourceFunc -> intermediate should NOT appear
        // because DATA_FLOW is not in default relationTypes
        expect(impactedIds.some((id: string) => id.includes('intermediate'))).toBe(false);
      });
    });

    // ─── Test 2: impact with DATA_FLOW in relationTypes ─────────────────────
    describe('impact with DATA_FLOW in relationTypes', () => {
      it('traverses DATA_FLOW edges when explicitly included', async () => {
        const result = await backend.callTool('impact', {
          target: 'sourceFunc',
          direction: 'downstream',
          maxDepth: 3,
          relationTypes: ['CALLS', 'DATA_FLOW'],
        });

        const impacted = Object.values(result.byDepth as Record<string, any[]>)
          .flat()
          .map((item: any) => ({ id: item.id, relationType: item.relationType }));

        // Should find intermediate through DATA_FLOW edge
        const dataFlowItems = impacted.filter((i: any) => i.relationType === 'DATA_FLOW');
        expect(dataFlowItems.length).toBeGreaterThan(0);
        expect(dataFlowItems.some((i: any) => i.id.includes('intermediate'))).toBe(true);
      });
    });

    // ─── Test 3: impact with TAINTED in relationTypes ───────────────────────
    describe('impact with TAINTED in relationTypes', () => {
      it('traverses TAINTED edges when included', async () => {
        const result = await backend.callTool('impact', {
          target: 'sourceFunc',
          direction: 'downstream',
          maxDepth: 5,
          relationTypes: ['CALLS', 'DATA_FLOW', 'TAINTED'],
        });

        const impacted = Object.values(result.byDepth as Record<string, any[]>)
          .flat()
          .map((item: any) => ({ id: item.id, relationType: item.relationType }));

        // Should find sinkFunc through TAINTED edge
        const taintedItems = impacted.filter((i: any) => i.relationType === 'TAINTED');
        expect(taintedItems.length).toBeGreaterThan(0);
        expect(taintedItems.some((i: any) => i.id.includes('sinkFunc'))).toBe(true);
      });
    });

    // ─── Test 4: impact --data-flow equivalent ──────────────────────────────
    describe('impact --data-flow equivalent (relationTypes with data flow edges)', () => {
      it('finds full taint path with DATA_FLOW, TAINTED, SINK_REACHABLE', async () => {
        const result = await backend.callTool('impact', {
          target: 'sourceFunc',
          direction: 'downstream',
          maxDepth: 5,
          relationTypes: ['CALLS', 'DATA_FLOW', 'TAINTED', 'SINK_REACHABLE'],
        });

        const impacted = Object.values(result.byDepth as Record<string, any[]>)
          .flat()
          .map((item: any) => item.id);

        // Should find intermediate and sinkFunc in the taint path (sourceFunc is the target, not included in byDepth)
        expect(impacted.some((id: string) => id.includes('intermediate'))).toBe(true);
        expect(impacted.some((id: string) => id.includes('sinkFunc'))).toBe(true);
        // Should find at least 2 impacted items (intermediate via DATA_FLOW, sinkFunc via TAINTED)
        expect(result.impactedCount).toBeGreaterThanOrEqual(2);
      });
    });
  },
  {
    seed: DATA_FLOW_SEED,
    afterSetup: async (handle) => {
      // Configure listRegisteredRepos mock with handle values so LocalBackend can find repos
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'dataflow-test-repo',
          path: '/test/dataflow-repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 1, nodes: 4, communities: 0, processes: 0 },
        },
      ]);
      // Attach backend for tests
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
