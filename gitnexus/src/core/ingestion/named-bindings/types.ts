/**
 * Named binding types — shared across all per-language binding extractors.
 *
 * Extracted from import-resolution.ts to co-locate types with their consumers.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';

/** A single named import binding: local name in the importing file and exported name from the source.
 *  When `isModuleAlias` is true, the binding represents a Python `import X as Y` module alias
 *  and is routed to moduleAliasMap instead of namedImportMap during import processing. */
export interface NamedBinding {
  local: string;
  exported: string;
  isModuleAlias?: boolean;
}

/** Per-language named binding extractor -- optional (returns undefined if language has no named imports). */
export type NamedBindingExtractorFn = (importNode: SyntaxNode) => NamedBinding[] | undefined;

// ============================================================================
// Objective-C Named Binding Types
// ============================================================================

/** Type information for Objective-C method parameters and return types. */
export interface TypeInfo {
  name: string;
  isPointer?: boolean;
  isNullable?: boolean;
  generics?: TypeInfo[];
}

/** Objective-C method signature with selector, return type, and parameters.
 *  Used for Category and Protocol method declarations. */
export interface ObjCMethodSignature {
  /** Method selector, e.g., "tableView:numberOfRowsInSection:" */
  selector: string;
  /** Return type of the method */
  returnType: TypeInfo;
  /** Method parameters with names and types */
  parameters: Array<{
    name: string;
    type: TypeInfo;
  }>;
  /** True for class methods (+), false for instance methods (-) */
  isClassMethod: boolean;
}

/** Base interface for Objective-C named bindings that extend a class or protocol.
 *  Discriminated by the `type` field. */
export interface ObjCNamedBindingBase extends NamedBinding {
  /** Methods defined in this extension/protocol */
  methods: ObjCMethodSignature[];
  /** Properties defined in this extension/protocol */
  properties: string[];
}

/** Objective-C Category binding: @interface ClassName (CategoryName)
 *  Represents a category extension that adds methods to an existing class. */
export interface ObjCCategoryBinding extends ObjCNamedBindingBase {
  type: 'objc-category';
  /** The class being extended */
  className: string;
  /** The category name (the part in parentheses) */
  categoryName: string;
}

/** Objective-C Protocol binding: @protocol ProtocolName
 *  Represents a protocol declaration with required and optional methods. */
export interface ObjCProtocolBinding extends ObjCNamedBindingBase {
  type: 'objc-protocol';
  /** The protocol name */
  protocolName: string;
  /** Methods that conforming classes must implement */
  requiredMethods: ObjCMethodSignature[];
  /** Methods that conforming classes may optionally implement */
  optionalMethods: ObjCMethodSignature[];
}

/** Union type for all Objective-C binding types */
export type ObjCNamedBinding = ObjCCategoryBinding | ObjCProtocolBinding;
