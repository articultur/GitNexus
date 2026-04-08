/**
 * Bug Detection — Rule Engine
 *
 * Core registry and evaluator for detection rules.
 * Given a knowledge graph, walks nodes and evaluates registered rules
 * to produce DetectionResults (findings).
 */

import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import type {
  Rule,
  RuleContext,
  RuleDefinition,
  LanguageScope,
  DetectionResult,
} from './types.js';

// ── Language detection from file path ───────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  java: 'java',
  kt: 'kotlin',
  go: 'go',
  rs: 'rust',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  m: 'objc',
  mm: 'objc',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  dart: 'dart',
};

function languageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? 'typescript';
}

// ── Rule Engine ─────────────────────────────────────────────────────────────

export class RuleEngine {
  private rules = new Map<string, Rule>();

  /** Register a rule. Throws if a rule with the same id already exists. */
  register(rule: Rule): void {
    if (this.rules.has(rule.definition.id)) {
      throw new Error(`Rule already registered: ${rule.definition.id}`);
    }
    this.rules.set(rule.definition.id, rule);
  }

  /** Remove a rule by id. */
  unregister(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  /** Get all registered rule definitions. */
  getRules(): RuleDefinition[] {
    return [...this.rules.values()].map((r) => r.definition);
  }

  /** Get a rule by id. */
  getRule(ruleId: string): Rule | undefined {
    return this.rules.get(ruleId);
  }

  /** Number of registered rules. */
  get ruleCount(): number {
    return this.rules.size;
  }

  /**
   * Evaluate all rules against a single node context.
   * Returns findings for all rules that triggered.
   */
  evaluateNode(ctx: RuleContext): DetectionResult[] {
    const results: DetectionResult[] = [];
    const lang = ctx.language;

    for (const rule of this.rules.values()) {
      // Language filter
      if (
        rule.definition.languages.length > 0 &&
        !rule.definition.languages.includes('*') &&
        !rule.definition.languages.includes(lang as LanguageScope)
      ) {
        continue;
      }

      try {
        const result = rule.evaluate(ctx);
        if (result) {
          results.push(result);
        }
      } catch {
        // Rule evaluation errors are non-fatal — skip this rule for this node
      }
    }

    return results;
  }

  /**
   * Evaluate all rules across an entire knowledge graph.
   * Builds RuleContext per node and collects all findings.
   */
  evaluateGraph(
    nodes: Iterable<GraphNode>,
    getRelationships: (nodeId: string) => {
      outgoing: GraphRelationship[];
      incoming: GraphRelationship[];
    },
    getNode: (id: string) => GraphNode | undefined,
  ): DetectionResult[] {
    const allResults: DetectionResult[] = [];

    for (const node of nodes) {
      const { outgoing, incoming } = getRelationships(node.id);
      const outgoingTargets = new Map<string, GraphNode>();
      for (const rel of outgoing) {
        const target = getNode(rel.targetId);
        if (target) outgoingTargets.set(rel.id, target);
      }

      const ctx: RuleContext = {
        node,
        outgoingRelationships: outgoing,
        incomingRelationships: incoming,
        outgoingTargets,
        language: languageFromPath((node.properties as any).filePath ?? ''),
      };

      const results = this.evaluateNode(ctx);
      allResults.push(...results);
    }

    return allResults;
  }
}

// ── Helper: Build relationship index ────────────────────────────────────────

export interface RelationshipIndex {
  outgoing: Map<string, GraphRelationship[]>;
  incoming: Map<string, GraphRelationship[]>;
}

/** Build an index of relationships by source/target node id. */
export function buildRelationshipIndex(
  relationships: Iterable<GraphRelationship>,
): RelationshipIndex {
  const outgoing = new Map<string, GraphRelationship[]>();
  const incoming = new Map<string, GraphRelationship[]>();

  for (const rel of relationships) {
    let outList = outgoing.get(rel.sourceId);
    if (!outList) {
      outList = [];
      outgoing.set(rel.sourceId, outList);
    }
    outList.push(rel);

    let inList = incoming.get(rel.targetId);
    if (!inList) {
      inList = [];
      incoming.set(rel.targetId, inList);
    }
    inList.push(rel);
  }

  return { outgoing, incoming };
}

// ── Helper: Create engine from rules ────────────────────────────────────────

/** Create a RuleEngine pre-loaded with the given rules. */
export function createEngine(rules: Rule[]): RuleEngine {
  const engine = new RuleEngine();
  for (const rule of rules) {
    engine.register(rule);
  }
  return engine;
}
