import { beforeAll, describe, expect, it } from 'vitest';
import path from 'path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const HARMONY_APP = path.resolve(__dirname, '..', 'fixtures', 'harmony-app');

describe('Harmony capability gap coverage', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(HARMONY_APP, () => {});
  }, 60000);

  it('creates HANDLES_ROUTE edges for @Entry pages', () => {
    const routes: string[] = [];
    const edges: { source: string; target: string; reason: string }[] = [];

    result.graph.forEachNode((node) => {
      if (node.label === 'Route') {
        routes.push(String(node.properties.name));
      }
    });

    for (const rel of result.graph.iterRelationships()) {
      if (rel.type !== 'HANDLES_ROUTE') continue;
      const source = result.graph.getNode(rel.sourceId);
      const target = result.graph.getNode(rel.targetId);
      if (!source || !target) continue;
      edges.push({
        source: String(source.properties.filePath || source.properties.name),
        target: String(target.properties.name),
        reason: rel.reason ?? '',
      });
    }

    expect(routes).toContain('/pages/Index');
    expect(
      edges.some(
        (edge) => edge.source.includes('pages/Index.ets') && edge.target === '/pages/Index',
      ),
    ).toBe(true);
    expect(edges.some((edge) => edge.reason === 'decorator-Entry')).toBe(true);
  });

  it('creates QUERIES edges for Harmony RDB and Preferences calls', () => {
    const queryEdges: { source: string; target: string; reason: string }[] = [];

    for (const rel of result.graph.iterRelationships()) {
      if (rel.type !== 'QUERIES') continue;
      const source = result.graph.getNode(rel.sourceId);
      const target = result.graph.getNode(rel.targetId);
      if (!source || !target) continue;
      queryEdges.push({
        source: String(source.properties.filePath || source.properties.name),
        target: String(target.properties.name),
        reason: rel.reason ?? '',
      });
    }

    const harmonyEdges = queryEdges.filter((edge) => edge.source.includes('data/UserStore.ets'));
    const targets = harmonyEdges.map((edge) => edge.target);
    const reasons = harmonyEdges.map((edge) => edge.reason);

    expect(targets).toContain('users');
    expect(targets).toContain('audit_logs');
    expect(targets).toContain('theme');
    expect(reasons.some((reason) => reason.includes('harmony-rdb-query'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('harmony-rdb-querySql'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('harmony-preferences-get'))).toBe(true);
  });
});
