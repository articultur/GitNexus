/**
 * Dart named-binding extractor.
 *
 * Dart supports `show` / `hide` combinators on import statements:
 *   import 'package:flutter/material.dart' show Widget, StatelessWidget;
 *   import 'dart:math' show sqrt, pow hide Random;
 *
 * Without a `show` combinator the import is a wildcard — all public
 * symbols from the package are in scope.  With `show`, only the listed
 * identifiers are imported.
 *
 * Tree-sitter-dart node structure for:
 *   import 'dart:core' show int, String;
 *
 *   (import_or_export
 *     (library_import
 *       (import_specification
 *         (configurable_uri) ;; ← import source
 *         (combinator         ;; ← show ... or hide ...
 *           "show"
 *           (identifier) "int"
 *           (identifier) "String"))))
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

export function extractDartNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // Accepts import_or_export or library_import
  if (
    importNode.type !== 'import_or_export' &&
    importNode.type !== 'library_import' &&
    importNode.type !== 'import_specification'
  ) {
    return undefined;
  }

  const bindings: NamedBinding[] = [];
  collectShowBindings(importNode, bindings);
  return bindings.length > 0 ? bindings : undefined;
}

/**
 * Walk the subtree looking for `combinator` nodes that use `show`.
 * Each identifier inside those nodes is a named binding.
 */
function collectShowBindings(node: SyntaxNode, bindings: NamedBinding[]): void {
  if (node.type === 'combinator') {
    // Detect show vs hide by inspecting the keyword child
    let isShow = false;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.text === 'show') {
        isShow = true;
        break;
      }
    }

    // `hide` combinators restrict a wildcard import — the default set of
    // imports is still wildcard, so we do not produce named bindings for hide.
    if (!isShow) return;

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier' && child.text) {
        bindings.push({ local: child.text, exported: child.text });
      }
    }
    return;
  }

  // Recurse into children
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) collectShowBindings(child, bindings);
  }
}
