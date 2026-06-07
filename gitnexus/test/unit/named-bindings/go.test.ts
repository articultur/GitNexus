/**
 * Tests for extractGoNamedBindings
 *
 * Requires tree-sitter-go.  Tests are skipped if the parser is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { extractGoNamedBindings } from '../../../src/core/ingestion/named-bindings/go.js';

let Parser: typeof import('tree-sitter').default;
let Go: any;
let goAvailable = false;

try {
  const tsModule = await import('tree-sitter');
  Parser = tsModule.default;
  const goModule = await import('tree-sitter-go');
  Go = goModule.default ?? goModule;
  goAvailable = true;
} catch {
  goAvailable = false;
}

function findAll(node: any, type: string): any[] {
  const results: any[] = [];
  if (node.type === type) results.push(node);
  for (let i = 0; i < node.childCount; i++) {
    results.push(...findAll(node.child(i), type));
  }
  return results;
}

function parseAndFindImportSpec(code: string): any[] {
  const parser = new Parser();
  parser.setLanguage(Go);
  const tree = parser.parse(code);
  return findAll(tree.rootNode, 'import_spec');
}

describe('extractGoNamedBindings', () => {
  it.skipIf(!goAvailable)('returns undefined for plain import (no alias)', () => {
    const specs = parseAndFindImportSpec('import "fmt"');
    expect(specs.length).toBeGreaterThan(0);
    const result = extractGoNamedBindings(specs[0]);
    expect(result).toBeUndefined();
  });

  it.skipIf(!goAvailable)('returns module alias binding for renamed import', () => {
    const specs = parseAndFindImportSpec('import io "io/ioutil"');
    expect(specs.length).toBeGreaterThan(0);
    const result = extractGoNamedBindings(specs[0]);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      local: 'io',
      exported: 'io/ioutil',
      isModuleAlias: true,
    });
  });

  it.skipIf(!goAvailable)('returns undefined for dot import (.)', () => {
    const specs = parseAndFindImportSpec('import . "fmt"');
    expect(specs.length).toBeGreaterThan(0);
    const result = extractGoNamedBindings(specs[0]);
    expect(result).toBeUndefined();
  });

  it.skipIf(!goAvailable)('returns undefined for blank import (_)', () => {
    const specs = parseAndFindImportSpec('import _ "embed"');
    expect(specs.length).toBeGreaterThan(0);
    const result = extractGoNamedBindings(specs[0]);
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-import_spec nodes', () => {
    const fakeNode = { type: 'function_declaration', childCount: 0, namedChildCount: 0 } as any;
    expect(extractGoNamedBindings(fakeNode)).toBeUndefined();
  });
});
