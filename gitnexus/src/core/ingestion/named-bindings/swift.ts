/**
 * Swift named-binding extractor.
 *
 * Most Swift imports are wildcard module imports:
 *   import Foundation          →  all of Foundation is in scope
 *   import UIKit               →  all of UIKit is in scope
 *
 * Swift also supports "kind-qualified" imports that bring a single symbol
 * into scope from a specific module:
 *   import class Foundation.NSString       → {local:'NSString', exported:'NSString'}
 *   import func Darwin.sqrt                → {local:'sqrt', exported:'sqrt'}
 *   import var Foundation.NSURLErrorDomain → {local:'NSURLErrorDomain', ...}
 *
 * The import kinds are: class, struct, enum, protocol, typealias, func, var
 *
 * Tree-sitter-swift node structure for `import class Foundation.NSString`:
 *   (import_declaration
 *     "import"
 *     (import_kind "class")          ;; or the keyword appears as a direct child
 *     (identifier
 *       (simple_identifier "Foundation")
 *       "."
 *       (simple_identifier "NSString")))
 *
 * For plain `import Foundation`:
 *   (import_declaration
 *     "import"
 *     (identifier
 *       (simple_identifier "Foundation")))
 *
 * We only emit a NamedBinding for the kind-qualified form.  For plain module
 * imports we return undefined so the pipeline continues with wildcard semantics.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

/** Import kind keywords recognised by Swift. */
const IMPORT_KINDS = new Set(['typealias', 'struct', 'class', 'enum', 'protocol', 'var', 'func']);

/**
 * Collect all `simple_identifier` texts reachable from `node` in DFS order.
 * Works regardless of whether the identifier chain uses intermediate nodes.
 */
function collectSimpleIdentifiers(node: SyntaxNode): string[] {
  const result: string[] = [];

  const visit = (n: SyntaxNode): void => {
    if (n.type === 'simple_identifier') {
      result.push(n.text);
      return;
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) visit(child);
    }
  };

  visit(node);
  return result;
}

/**
 * Return named bindings for Swift kind-qualified imports.
 * Returns undefined for plain wildcard module imports.
 */
export function extractSwiftNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  if (importNode.type !== 'import_declaration') return undefined;

  // Scan children for an import kind keyword
  let hasImportKind = false;
  let identifierNode: SyntaxNode | null = null;

  for (let i = 0; i < importNode.childCount; i++) {
    const child = importNode.child(i);
    if (!child) continue;

    if (child.type === 'import_kind' || IMPORT_KINDS.has(child.text)) {
      hasImportKind = true;
    }

    if (child.type === 'identifier') {
      identifierNode = child;
    }
  }

  // Only handle kind-qualified (non-wildcard) imports
  if (!hasImportKind || !identifierNode) return undefined;

  // The symbol name is the last simple_identifier in the dotted path
  const parts = collectSimpleIdentifiers(identifierNode);
  if (parts.length === 0) return undefined;

  const symbolName = parts[parts.length - 1];
  return [{ local: symbolName, exported: symbolName }];
}
