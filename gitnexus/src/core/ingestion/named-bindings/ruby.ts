/**
 * Ruby named-binding extractor.
 *
 * Ruby uses wildcard import semantics (require/require_relative bring
 * everything into scope), so traditional named bindings like Python's
 * `from X import Y` do not exist.
 *
 * Statically determinable subset:
 *   - `require_relative 'module'` — resolves to a file path (handled by import resolver)
 *   - `require 'gem_name'` — resolves to a gem (handled by import resolver)
 *
 * Since Ruby imports are always wildcard, this extractor returns undefined
 * for all import nodes. It exists to satisfy the LanguageProvider interface
 * and document the boundary: Ruby cannot statically determine per-symbol
 * import bindings because `require` mixes the entire module into scope.
 *
 * Boundary note:
 *   - `include`/`extend`/`prepend` ModuleName → these are heritage (mixin), not imports
 *   - Module constant access (SomeModule::SomeClass) → resolved via symbol resolution, not bindings
 *   - Dynamic require (require variable) → not statically determinable
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

/**
 * Ruby named-binding extractor.
 * Returns undefined because Ruby uses wildcard import semantics.
 */
export function extractRubyNamedBindings(_importNode: SyntaxNode): NamedBinding[] | undefined {
  // Ruby's require/require_relative are wildcard imports —
  // no per-symbol binding extraction is possible.
  return undefined;
}
