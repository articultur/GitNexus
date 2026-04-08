/**
 * Tests for extractDartNamedBindings
 *
 * Requires tree-sitter-dart.  Tests are skipped if the parser is unavailable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractDartNamedBindings } from '../../../src/core/ingestion/named-bindings/dart.js';

let Parser: typeof import('tree-sitter').default;
let Dart: any;
let dartAvailable = false;

// tree-sitter-dart is an optional dependency — skip tests if absent
beforeAll(async () => {
  try {
    const tsModule = await import('tree-sitter');
    Parser = tsModule.default;
    const dartModule = await import('tree-sitter-dart');
    Dart = dartModule.default ?? dartModule;
    dartAvailable = true;
  } catch {
    dartAvailable = false;
  }
});

/** Walk a tree depth-first, collect all nodes of a given type. */
function findAll(node: any, type: string): any[] {
  const results: any[] = [];
  if (node.type === type) results.push(node);
  for (let i = 0; i < node.childCount; i++) {
    results.push(...findAll(node.child(i), type));
  }
  return results;
}

function parseAndFindImport(code: string): any | undefined {
  const parser = new Parser();
  parser.setLanguage(Dart);
  const tree = parser.parse(code);
  // Dart grammar: import_or_export wraps library_import
  const importNodes = findAll(tree.rootNode, 'import_or_export');
  return importNodes[0];
}

describe('extractDartNamedBindings', () => {
  it.skipIf(!dartAvailable)('returns undefined for plain import (no combinator)', () => {
    const importNode = parseAndFindImport("import 'dart:core';");
    if (!importNode) return;
    const result = extractDartNamedBindings(importNode);
    expect(result).toBeUndefined();
  });

  it.skipIf(!dartAvailable)('extracts show combinator bindings', () => {
    const importNode = parseAndFindImport(
      "import 'package:flutter/material.dart' show Widget, StatelessWidget;",
    );
    if (!importNode) return;
    const result = extractDartNamedBindings(importNode);
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({ local: 'Widget', exported: 'Widget' });
    expect(result![1]).toEqual({ local: 'StatelessWidget', exported: 'StatelessWidget' });
  });

  it.skipIf(!dartAvailable)(
    'returns undefined for hide combinator (wildcard still applies)',
    () => {
      const importNode = parseAndFindImport("import 'dart:math' hide Random;");
      if (!importNode) return;
      const result = extractDartNamedBindings(importNode);
      // hide restricts but does not produce named bindings — wildcard synthesis handles it
      expect(result).toBeUndefined();
    },
  );

  it.skipIf(!dartAvailable)('handles single-symbol show', () => {
    const importNode = parseAndFindImport("import 'dart:async' show Future;");
    if (!importNode) return;
    const result = extractDartNamedBindings(importNode);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({ local: 'Future', exported: 'Future' });
  });

  it('returns undefined for non-import nodes', () => {
    // extractDartNamedBindings must not throw for wrong node types
    const fakeNode = { type: 'function_declaration', childCount: 0, namedChildCount: 0 } as any;
    expect(extractDartNamedBindings(fakeNode)).toBeUndefined();
  });
});
