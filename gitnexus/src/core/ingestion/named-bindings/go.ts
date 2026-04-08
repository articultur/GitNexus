/**
 * Go named-binding extractor.
 *
 * Go imports are package-level (wildcard semantics by default).  The only
 * "named" variant is the package alias:
 *
 *   import io    "io/ioutil"   // alias: io  → {local:'io', exported:'io/ioutil', isModuleAlias:true}
 *   import .     "fmt"         // dot-import: wildcard — we return undefined
 *   import _     "embed"       // blank import: side-effect only — we return undefined
 *
 * Without an explicit alias identifier the import resolves by the last path
 * segment (handled upstream by importSemantics:'wildcard'), so we only emit a
 * binding when there is an explicit, non-special alias.
 *
 * Tree-sitter-go node structure:
 *   (import_spec
 *     name: (identifier)?          ;; alias, dot, or blank
 *     path: (interpreted_string_literal))
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

export function extractGoNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  if (importNode.type !== 'import_spec') return undefined;

  const nameNode = importNode.childForFieldName?.('name');
  if (!nameNode) return undefined;

  const alias = nameNode.text;

  // Special symbols — not true aliases
  if (alias === '.' || alias === '_') return undefined;

  const pathNode = importNode.childForFieldName?.('path');
  if (!pathNode) return undefined;

  // Strip surrounding quotes from the string literal  e.g. `"io/ioutil"` → `io/ioutil`
  const importPath = pathNode.text.replace(/^["``]|["``]$/g, '');

  return [{ local: alias, exported: importPath, isModuleAlias: true }];
}
