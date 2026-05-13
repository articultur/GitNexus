import { describe, it, expect } from 'vitest';
import {
  getCommunityColor,
  COMMUNITY_COLORS,
  processCommunities,
} from '../../src/core/ingestion/community-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { GraphNode, GraphRelationship } from '../../src/core/graph/types.js';

/** Create a GraphNode with commonly-needed properties */
function makeNode(
  id: string,
  name: string,
  label: GraphNode['label'],
  filePath: string,
): GraphNode {
  return {
    id,
    label,
    properties: { name, filePath, startLine: 1, endLine: 10, isExported: false },
  };
}

/** Create a CALLS relationship between two nodes */
function makeRel(id: string, sourceId: string, targetId: string): GraphRelationship {
  return { id, sourceId, targetId, type: 'CALLS', confidence: 1.0, reason: '' };
}

/** Add a fully-connected clique of Function nodes to the graph */
function addClique(
  graph: ReturnType<typeof createKnowledgeGraph>,
  prefix: string,
  folder: string,
  size: number,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < size; i++) {
    const id = `fn:${prefix}${i}`;
    ids.push(id);
    graph.addNode(makeNode(id, `${prefix}Fn${i}`, 'Function', `/src/${folder}/f${i}.ts`));
  }
  // Fully connect all pairs
  let relIdx = 0;
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      graph.addRelationship(makeRel(`rel:${prefix}_${relIdx++}`, ids[i], ids[j]));
    }
  }
  return ids;
}

describe('community-processor', () => {
  describe('COMMUNITY_COLORS', () => {
    it('has 12 colors', () => {
      expect(COMMUNITY_COLORS).toHaveLength(12);
    });

    it('contains valid hex color strings', () => {
      for (const color of COMMUNITY_COLORS) {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it('has no duplicate colors', () => {
      const unique = new Set(COMMUNITY_COLORS);
      expect(unique.size).toBe(COMMUNITY_COLORS.length);
    });
  });

  describe('getCommunityColor', () => {
    it('returns first color for index 0', () => {
      expect(getCommunityColor(0)).toBe(COMMUNITY_COLORS[0]);
    });

    it('wraps around when index exceeds color count', () => {
      expect(getCommunityColor(12)).toBe(COMMUNITY_COLORS[0]);
      expect(getCommunityColor(13)).toBe(COMMUNITY_COLORS[1]);
    });

    it('returns different colors for different indices', () => {
      const c0 = getCommunityColor(0);
      const c1 = getCommunityColor(1);
      expect(c0).not.toBe(c1);
    });
  });

  describe('singleton community filtering', () => {
    it('should not produce memberships for singleton communities', async () => {
      // Build a graph with a clique (valid community) plus a node that becomes
      // a singleton in the graphology graph. This happens when a Function node
      // has a CALLS relationship to a target that is not a symbol-type node
      // (e.g. a non-existent node) — the source enters the graph but has no
      // edges, so Leiden assigns it to its own singleton community.
      const graph = createKnowledgeGraph();

      // Clique of 4 — will form a real community
      addClique(graph, 'c', 'cluster', 4);

      // Function node with a CALLS edge to a non-existent target.
      // buildGraphologyGraph adds fn:iso to the graph (it's a Function with
      // a CALLS edge) but the edge won't be added (target missing from graph).
      // Result: fn:iso is an isolated vertex in the graphology graph, so
      // Leiden assigns it to a singleton community.
      graph.addNode(makeNode('fn:iso0', 'isoFn0', 'Function', '/src/isolated/iso0.ts'));
      graph.addRelationship(makeRel('rel:iso_ghost', 'fn:iso0', 'fn:ghost_target'));

      const result = await processCommunities(graph);
      const validCommunityIds = new Set(result.communities.map((c) => c.id));

      for (const membership of result.memberships) {
        expect(validCommunityIds.has(membership.communityId)).toBe(true);
      }
    });
  });

  describe('heuristicLabel uniqueness', () => {
    it('should produce unique heuristicLabels across communities', async () => {
      // Build a graph where two separate cliques share the same folder name,
      // which causes generateHeuristicLabel to return the same label for both.
      const graph = createKnowledgeGraph();

      // Clique 1: 4 nodes in folder "components"
      addClique(graph, 'a', 'components', 4);
      // Clique 2: 3 nodes in the same folder "components"
      addClique(graph, 'b', 'components', 3);

      const result = await processCommunities(graph);
      const labels = result.communities.map((c) => c.heuristicLabel);
      const uniqueLabels = new Set(labels);
      expect(labels.length).toBe(uniqueLabels.size);
    });
  });
});
