// gitnexus/src/core/ingestion/method-extractors/configs/objc.ts
// Verified against tree-sitter-objc (tree-sitter-objective-c)

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// ObjC container types that own methods
// ---------------------------------------------------------------------------

const OBJC_CLASS_CONTAINER_TYPES = new Set([
  'class_interface',
  'class_implementation',
  'category_interface',
  'category_implementation',
  'protocol_declaration',
]);

// ---------------------------------------------------------------------------
// ObjC helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first selector keyword from an ObjC method declaration/definition.
 *
 * Tree-sitter-objc structure:
 *   (method_declaration
 *     (method_type)           ;; '-' or '+'
 *     (identifier "viewDidLoad")   ;; first selector piece
 *     ...)
 *
 * The `identifier` immediately after `method_type` is the first selector keyword,
 * which serves as the primary method name for graph indexing purposes.
 *
 * For multi-keyword selectors like `- (id)initWithName:(NSString*)n value:(int)v`,
 * we concatenate all keyword pieces separated by ':' to get `initWithName:value:`.
 */
function extractObjCMethodName(node: SyntaxNode): string | undefined {
  // Find method_type first, then collect identifiers that are selector keywords.
  let seenMethodType = false;
  const selectorParts: string[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (child.type === 'method_type') {
      seenMethodType = true;
      continue;
    }

    if (!seenMethodType) continue;

    // 'identifier' after method_type is a selector keyword
    if (child.type === 'identifier') {
      selectorParts.push(child.text);
    }

    // 'keyword_argument' or 'keyword_declarator' holds 'keyword:' pieces in multi-arg selectors
    if (child.type === 'keyword_argument' || child.type === 'keyword_declarator') {
      // The keyword identifier is usually a child named 'name' or the first identifier
      const kw = child.childForFieldName('name') ?? child.firstNamedChild;
      if (kw?.type === 'identifier') selectorParts.push(kw.text + ':');
    }
  }

  if (selectorParts.length === 0) {
    // Fallback: return text of first identifier child after method_type
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier') return child.text;
    }
    return undefined;
  }

  return selectorParts.join('');
}

/**
 * Climb the parent chain to find the enclosing ObjC class/protocol container
 * and return its name.
 *
 * ObjC method declarations/definitions are direct children of class_interface /
 * class_implementation / protocol_declaration etc. — there is no intermediate
 * body container node.
 */
function extractObjCOwnerName(node: SyntaxNode): string | undefined {
  let current: SyntaxNode | null = node.parent ?? null;
  while (current) {
    if (OBJC_CLASS_CONTAINER_TYPES.has(current.type)) {
      // The class name is the first identifier child
      for (let i = 0; i < current.namedChildCount; i++) {
        const child = current.namedChild(i);
        if (child?.type === 'identifier') return child.text;
      }
    }
    current = current.parent ?? null;
  }
  return undefined;
}

/**
 * Extract return type from an ObjC method node.
 *
 * The return type sits inside a `type_name` or `type_descriptor` child after the
 * `method_type` child ('-' / '+').  It is wrapped in parentheses in source but
 * tree-sitter strips those.
 */
function extractObjCReturnType(node: SyntaxNode): string | undefined {
  // Walk named children for 'type_name', then extract its text
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (
      child.type === 'type_name' ||
      child.type === 'type_descriptor' ||
      child.type === 'return_type'
    ) {
      return child.text?.replace(/[()]/g, '').trim();
    }
  }
  return undefined;
}

/**
 * Extract parameters from an ObjC method.
 * ObjC keyword parameters: `- (void)setName:(NSString*)name value:(int)val`
 * Each `keyword_declarator` / `keyword_argument` holds one parameter.
 */
function extractObjCParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (child.type === 'keyword_argument' || child.type === 'keyword_declarator') {
      // Name is the last identifier, type is in a type_name child
      let paramName: string | null = null;
      let paramType: string | null = null;

      for (let j = 0; j < child.namedChildCount; j++) {
        const kChild = child.namedChild(j);
        if (!kChild) continue;
        if (kChild.type === 'type_name' || kChild.type === 'type_descriptor') {
          paramType = kChild.text?.replace(/[()]/g, '').trim() ?? null;
        }
        if (kChild.type === 'identifier' || kChild.type === 'simple_identifier') {
          paramName = kChild.text;
        }
      }

      if (paramName) {
        params.push({
          name: paramName,
          type: paramType,
          isOptional: false,
          isVariadic: false,
        });
      }
    }
  }

  return params;
}

/**
 * Check whether the method is a class method ('+' prefix) or instance method ('-').
 */
function isObjCClassMethod(node: SyntaxNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'method_type') {
      return child.text.includes('+');
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Exported config
// ---------------------------------------------------------------------------

export const objcMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.ObjectiveC,

  // Each method_declaration / method_definition is its own "container"
  // (same pattern as Go where methods stand alone, not nested in a body).
  typeDeclarationNodes: ['method_declaration', 'method_definition'],
  methodNodeTypes: ['method_declaration', 'method_definition'],
  bodyNodeTypes: [],

  extractName: extractObjCMethodName,
  extractReturnType: extractObjCReturnType,
  extractParameters: extractObjCParameters,
  extractOwnerName: extractObjCOwnerName,

  extractVisibility(): MethodVisibility {
    // ObjC has no method-level visibility — all methods are effectively public
    return 'public';
  },

  isStatic: isObjCClassMethod,

  isAbstract(node, _ownerNode) {
    // Protocol method declarations without a body are abstract
    return node.type === 'method_declaration';
  },

  isFinal() {
    return false; // ObjC has no final methods
  },
};
