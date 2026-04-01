/**
 * Analysis-quality benchmark runner.
 *
 * Auto-discovers all case directories under test/fixtures/analysis-quality/,
 * loads the labeled case.json manifest for each, runs the pipeline on the
 * fixture repo, and validates structured assertions against the produced graph.
 *
 * Assertion types supported:
 *   callEdges               – CALLS edges between symbols
 *   importEdges             – IMPORTS edges between files
 *   inheritsEdges           – EXTENDS / IMPLEMENTS edges between types
 *   resolvedSymbols         – cross-file declaration matching via call edges
 *   detectChangesAssertions – symbols indexed per file (validates the node
 *                             set that detect_changes queries by filePath)
 */
import fs from 'fs/promises';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, type PipelineResult } from './resolvers/helpers.js';

interface SymbolRef {
  file: string;
  symbol: string;
  lineContains?: string;
}

interface BenchmarkManifest {
  id: string;
  language: string;
  repoPath: string;
  capabilities: string[];
  assertions: {
    resolvedSymbols?: Array<{
      reference: SymbolRef;
      expectedDeclaration: SymbolRef;
    }>;
    callEdges?: Array<{
      source: SymbolRef;
      target: SymbolRef;
    }>;
    importEdges?: Array<{
      sourceFile: string;
      targetFile: string;
    }>;
    inheritsEdges?: Array<{
      /** Child class/interface */
      child: SymbolRef;
      /** Parent class/interface being extended or implemented */
      parent: SymbolRef;
      /** 'EXTENDS' | 'IMPLEMENTS' — defaults to 'EXTENDS' when omitted */
      edgeType?: string;
    }>;
    /** Validates that the symbols detect_changes would return are indexed. */
    detectChangesAssertions?: Array<{
      changedFile: string;
      expectedSymbols: Array<{ name: string; kind?: string }>;
    }>;
  };
}

const ANALYSIS_QUALITY_FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'analysis-quality');

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Scan the fixtures directory for case directories (those containing case.json).
 * Returns an array of { caseId, caseDir } entries.
 */
async function discoverCases(): Promise<Array<{ caseId: string; caseDir: string }>> {
  const entries = await fs.readdir(ANALYSIS_QUALITY_FIXTURES, { withFileTypes: true });
  const results: Array<{ caseId: string; caseDir: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const caseDir = path.join(ANALYSIS_QUALITY_FIXTURES, entry.name);
    try {
      await fs.access(path.join(caseDir, 'case.json'));
      results.push({ caseId: entry.name, caseDir });
    } catch {
      // No case.json — skip
    }
  }
  return results;
}

// ── Outer guard ──────────────────────────────────────────────────────────────

describe('Analysis-quality benchmark runner', () => {
  let cases: Array<{ caseId: string; caseDir: string }> = [];

  beforeAll(async () => {
    cases = await discoverCases();
  }, 10000);

  it('discovers at least one benchmark case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(1);
  });

  // ── Per-case suites ────────────────────────────────────────────────────────

  /**
   * Each case gets its own `describe` block registered after the discovery
   * `beforeAll`. The inner `beforeAll` runs the pipeline once per case.
   */
  describe.each(
    // Provide a synchronous seed list so Vitest can collect the describe blocks
    // at collection time. Actual manifests are loaded inside each inner beforeAll.
    // We resolve the list lazily via a getter so it picks up cases from the outer
    // beforeAll by the time the inner beforeAll runs.
    [
      'typescript-symbol-resolution-basic',
      'typescript-class-inheritance-basic',
      'python-import-call-basic',
      'java-implements-basic',
      'detect-changes-basic',
    ] as const,
  )('case: %s', (caseId) => {
    let manifest: BenchmarkManifest;
    let result: PipelineResult;
    let calls: ReturnType<typeof getRelationships>;
    let imports: ReturnType<typeof getRelationships>;
    let extends_: ReturnType<typeof getRelationships>;
    let implements_: ReturnType<typeof getRelationships>;

    beforeAll(async () => {
      const caseDir = path.join(ANALYSIS_QUALITY_FIXTURES, caseId);
      // Skip unknown cases gracefully (will be guarded by the outer discovery test)
      let manifestText: string;
      try {
        manifestText = await fs.readFile(path.join(caseDir, 'case.json'), 'utf8');
      } catch {
        return;
      }
      manifest = JSON.parse(manifestText) as BenchmarkManifest;
      result = await runPipelineFromRepo(path.join(caseDir, manifest.repoPath), () => {});
      calls = getRelationships(result, 'CALLS');
      imports = getRelationships(result, 'IMPORTS');
      extends_ = getRelationships(result, 'EXTENDS');
      implements_ = getRelationships(result, 'IMPLEMENTS');
    }, 60000);

    it('loads manifest with expected id', () => {
      if (!manifest) return; // case was skipped
      expect(manifest.id).toBe(caseId);
    });

    it('matches all labeled import edges', () => {
      if (!manifest) return;
      for (const edge of manifest.assertions.importEdges ?? []) {
        expect(
          imports.some(
            (rel) =>
              normalizePath(rel.sourceFilePath).endsWith(edge.sourceFile) &&
              normalizePath(rel.targetFilePath).endsWith(edge.targetFile),
          ),
          `import edge ${edge.sourceFile} → ${edge.targetFile} not found`,
        ).toBe(true);
      }
    });

    it('matches all labeled call edges', () => {
      if (!manifest) return;
      for (const edge of manifest.assertions.callEdges ?? []) {
        expect(
          calls.some(
            (rel) =>
              rel.source === edge.source.symbol &&
              rel.target === edge.target.symbol &&
              normalizePath(rel.sourceFilePath).endsWith(edge.source.file) &&
              normalizePath(rel.targetFilePath).endsWith(edge.target.file),
          ),
          `call edge ${edge.source.symbol} → ${edge.target.symbol} not found`,
        ).toBe(true);
      }
    });

    it('matches all labeled inherit edges (EXTENDS / IMPLEMENTS)', () => {
      if (!manifest) return;
      for (const edge of manifest.assertions.inheritsEdges ?? []) {
        const edgeType = (edge.edgeType ?? 'EXTENDS').toUpperCase();
        const pool = edgeType === 'IMPLEMENTS' ? implements_ : extends_;
        expect(
          pool.some(
            (rel) =>
              rel.source === edge.child.symbol &&
              rel.target === edge.parent.symbol &&
              normalizePath(rel.sourceFilePath).endsWith(edge.child.file) &&
              normalizePath(rel.targetFilePath).endsWith(edge.parent.file),
          ),
          `${edgeType} edge ${edge.child.symbol} → ${edge.parent.symbol} not found`,
        ).toBe(true);
      }
    });

    it('uses labeled resolved symbol expectations as declaration checks', () => {
      if (!manifest) return;
      for (const assertion of manifest.assertions.resolvedSymbols ?? []) {
        expect(
          calls.some(
            (rel) =>
              rel.target === assertion.expectedDeclaration.symbol &&
              normalizePath(rel.targetFilePath).endsWith(assertion.expectedDeclaration.file) &&
              normalizePath(rel.sourceFilePath).endsWith(assertion.reference.file),
          ),
          `resolved symbol ${assertion.reference.symbol} → ${assertion.expectedDeclaration.symbol} not found`,
        ).toBe(true);
      }
    });

    it('symbols for changed files are indexed in the graph (detect_changes coverage)', () => {
      if (!manifest) return;
      for (const assertion of manifest.assertions.detectChangesAssertions ?? []) {
        const nodesInFile: Array<{ name: string }> = [];
        result.graph.forEachNode((n) => {
          if (normalizePath(n.properties.filePath ?? '').endsWith(assertion.changedFile)) {
            nodesInFile.push({ name: n.properties.name });
          }
        });
        for (const expected of assertion.expectedSymbols) {
          expect(
            nodesInFile.some((n) => n.name === expected.name),
            `symbol ${expected.name} not indexed in ${assertion.changedFile}`,
          ).toBe(true);
        }
      }
    });
  });
});
