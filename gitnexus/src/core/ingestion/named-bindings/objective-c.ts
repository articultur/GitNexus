/**
 * Objective-C named-binding extractor.
 *
 * Handles extraction of:
 * - @protocol declarations with required/optional method sections
 * - @interface Category extensions (Task 10)
 *
 * Tree-sitter-objc AST structures:
 *
 * Protocol:
 *   (protocol_declaration
 *     (identifier)                        ;; protocol name
 *     (protocol_reference_list            ;; optional inheritance
 *       (identifier) ...)
 *     (protocol_body
 *       ...method_declarations...))
 *
 * Category:
 *   (class_interface
 *     (identifier)                        ;; class name
 *     (category)                          ;; category name in parens
 *       (identifier))
 *     ...method_declarations...)
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  NamedBinding,
  ObjCCategoryBinding,
  ObjCProtocolBinding,
  ObjCMethodSignature,
  TypeInfo,
} from './types.js';

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Extract ObjC named bindings from a protocol or category declaration node.
 * Returns undefined for other node types.
 */
export function extractObjCNamedBindings(node: SyntaxNode): NamedBinding[] | undefined {
  if (node.type === 'protocol_declaration') {
    const binding = extractProtocolBinding(node);
    return binding ? [binding] : undefined;
  }

  if (node.type === 'class_interface') {
    const binding = extractCategoryBinding(node);
    return binding ? [binding] : undefined;
  }

  return undefined;
}

// ============================================================================
// Protocol Extraction (Task 11)
// ============================================================================

/**
 * Extract protocol binding from a @protocol declaration.
 *
 * Example:
 *   @protocol UITableViewDataSource <NSObject>
 *   @required
 *   - (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section;
 *   @optional
 *   - (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath;
 *   @end
 */
function extractProtocolBinding(node: SyntaxNode): ObjCProtocolBinding | undefined {
  const protocolName = extractProtocolName(node);
  if (!protocolName) return undefined;

  const { requiredMethods, optionalMethods } = extractProtocolMethods(node);
  const properties = extractProtocolProperties(node);
  const inherits = extractProtocolInheritance(node);

  return {
    type: 'objc-protocol',
    local: protocolName,
    exported: protocolName,
    protocolName,
    inherits: inherits.length > 0 ? inherits : undefined,
    requiredMethods,
    optionalMethods,
    properties,
    methods: [...requiredMethods, ...optionalMethods],
  };
}

/** Extract protocol name from @protocol declaration. */
function extractProtocolName(node: SyntaxNode): string | undefined {
  // Protocol name is the first identifier child
  for (const child of node.children) {
    if (child.type === 'identifier') {
      return child.text.trim();
    }
  }
  return undefined;
}

/** Extract inherited protocols from protocol_reference_list. */
function extractProtocolInheritance(node: SyntaxNode): string[] {
  const inherited: string[] = [];

  for (const child of node.children) {
    if (child.type === 'protocol_reference_list') {
      for (const refChild of child.children) {
        if (refChild.type === 'identifier') {
          inherited.push(refChild.text.trim());
        }
      }
    }
  }

  return inherited;
}

/** Extract required and optional methods from a protocol body.
 *
 * Tree-sitter-objc (via tree-sitter-c) structure:
 *   [ '@protocol', identifier, qualified_protocol_interface_declaration*, '@end' ]
 *
 * Where qualified_protocol_interface_declaration contains:
 *   '@required\n  - (void)method;' or '@optional\n  - (void)method;'
 */
function extractProtocolMethods(node: SyntaxNode): {
  requiredMethods: ObjCMethodSignature[];
  optionalMethods: ObjCMethodSignature[];
} {
  const requiredMethods: ObjCMethodSignature[] = [];
  const optionalMethods: ObjCMethodSignature[] = [];

  // Find the protocol body (some tree-sitter versions)
  const protocolBody = node.children.find((c) => c.type === 'protocol_body');

  // Protocol body with @required/@optional markers (some versions)
  if (protocolBody) {
    let currentSection: 'required' | 'optional' = 'required'; // Default to required

    for (const child of protocolBody.children) {
      const text = child.text.trim();

      if (text === '@required') {
        currentSection = 'required';
        continue;
      }
      if (text === '@optional') {
        currentSection = 'optional';
        continue;
      }

      if (child.type === 'method_declaration') {
        const method = extractMethodSignature(child);
        if (method) {
          if (currentSection === 'required') {
            requiredMethods.push(method);
          } else {
            optionalMethods.push(method);
          }
        }
      }
    }
    return { requiredMethods, optionalMethods };
  }

  // tree-sitter-c style: qualified_protocol_interface_declaration nodes
  // Each contains @required or @optional followed by methods
  for (const child of node.children) {
    if (child.type === 'qualified_protocol_interface_declaration') {
      const text = child.text.trim();
      const isOptional = text.startsWith('@optional');
      const isRequired = text.startsWith('@required');

      // Find method declarations within this section
      for (const innerChild of child.children) {
        if (innerChild.type === 'method_declaration') {
          const method = extractMethodSignature(innerChild);
          if (method) {
            if (isOptional) {
              optionalMethods.push(method);
            } else {
              // Default to required for @required or unknown
              requiredMethods.push(method);
            }
          }
        }
      }
    }

    // Also handle direct method_declaration children (protocol without @required/@optional)
    if (child.type === 'method_declaration') {
      const method = extractMethodSignature(child);
      if (method) {
        requiredMethods.push(method); // Default to required
      }
    }
  }

  return { requiredMethods, optionalMethods };
}

/** Extract property names from a protocol. */
function extractProtocolProperties(node: SyntaxNode): string[] {
  const properties: string[] = [];

  const protocolBody = node.children.find((c) => c.type === 'protocol_body');
  const searchNode = protocolBody ?? node;

  for (const child of searchNode.children) {
    if (child.type === 'property_declaration') {
      const name = extractPropertyName(child);
      if (name) properties.push(name);
    }
  }

  return properties;
}

// ============================================================================
// Category Extraction (Task 10)
// ============================================================================

/**
 * Extract category binding from @interface ClassName (CategoryName).
 *
 * Example:
 *   @interface NSString (URLExtensions)
 *   - (NSURL *)asURL;
 *   @property (readonly) BOOL isHTTPS;
 *   @end
 */
function extractCategoryBinding(node: SyntaxNode): ObjCCategoryBinding | undefined {
  const { className, categoryName } = extractCategoryNames(node);
  if (!className || !categoryName) return undefined;

  const methods = extractCategoryMethods(node);
  const properties = extractCategoryProperties(node);

  return {
    type: 'objc-category',
    local: categoryName,
    exported: categoryName,
    className,
    categoryName,
    methods,
    properties,
  };
}

/** Extract class name and category name from @interface ClassName (CategoryName).
 *
 * Tree-sitter-objc can represent categories in two ways:
 * 1. With a 'category' child node (some versions)
 * 2. As a parenthesized pattern: @interface ClassName ( CategoryName )
 *    where the category name is a second identifier after '('
 */
function extractCategoryNames(node: SyntaxNode): { className: string; categoryName: string } {
  let className = '';
  let categoryName = '';
  let seenOpenParen = false;

  for (const child of node.children) {
    // First identifier is the class name
    if (child.type === 'identifier' && !className) {
      className = child.text.trim();
      continue;
    }

    // Category is in a 'category' child node (some tree-sitter-objc versions)
    if (child.type === 'category') {
      for (const catChild of child.children) {
        if (catChild.type === 'identifier') {
          categoryName = catChild.text.trim();
          break;
        }
      }
      continue;
    }

    // Handle parenthesized pattern: "(" followed by identifier followed by ")"
    // This is the pattern used by tree-sitter-c when parsing ObjC
    if (child.text === '(') {
      seenOpenParen = true;
      continue;
    }

    if (child.text === ')') {
      seenOpenParen = false;
      continue;
    }

    // If we're inside parentheses and see an identifier, it's the category name
    if (seenOpenParen && child.type === 'identifier' && !categoryName) {
      categoryName = child.text.trim();
    }
  }

  return { className, categoryName };
}

/** Extract methods from a category interface. */
function extractCategoryMethods(node: SyntaxNode): ObjCMethodSignature[] {
  const methods: ObjCMethodSignature[] = [];

  for (const child of node.children) {
    if (child.type === 'method_declaration') {
      const method = extractMethodSignature(child);
      if (method) methods.push(method);
    }
  }

  return methods;
}

/** Extract properties from a category interface. */
function extractCategoryProperties(node: SyntaxNode): string[] {
  const properties: string[] = [];

  for (const child of node.children) {
    if (child.type === 'property_declaration') {
      const name = extractPropertyName(child);
      if (name) properties.push(name);
    }
  }

  return properties;
}

// ============================================================================
// Method Signature Extraction
// ============================================================================

/**
 * Extract a complete method signature from a method_declaration node.
 *
 * Tree-sitter-objc structure:
 *   (method_declaration
 *     (method_type)                 ;; return type in parens
 *     (identifier)                  ;; first selector part OR full selector for unary
 *     (parameter_declaration) ...)  ;; parameters for multi-arg methods
 */
function extractMethodSignature(node: SyntaxNode): ObjCMethodSignature | undefined {
  // Determine if class method (+) or instance method (-)
  const isClassMethod = detectClassMethod(node);

  // Extract return type
  const returnType = extractMethodReturnType(node);

  // Extract selector and parameters
  const { selector, parameters } = extractMethodSelectorAndParams(node);

  if (!selector) return undefined;

  return {
    selector,
    returnType,
    parameters,
    isClassMethod,
  };
}

/** Detect if method is a class method (+) or instance method (-). */
function detectClassMethod(node: SyntaxNode): boolean {
  // Check the method_type or first child for '+' prefix
  for (const child of node.children) {
    if (child.type === 'method_type') {
      return child.text.trim().startsWith('+');
    }
    // Also check text for leading +/-
    const text = child.text.trim();
    if (text === '+' || text.startsWith('+(')) return true;
    if (text === '-' || text.startsWith('-(')) return false;
  }
  return false; // Default to instance method
}

/** Extract return type from method_type node.
 *  The method_type can be:
 *  - `(BOOL)` - just the type in parentheses (tree-sitter-c style)
 *  - `- (BOOL)` - with leading minus/plus (some tree-sitter-objc versions)
 */
function extractMethodReturnType(node: SyntaxNode): TypeInfo {
  for (const child of node.children) {
    if (child.type === 'method_type') {
      const text = child.text.trim();
      // Strip leading +/- and parentheses: "- (NSString *)" -> "NSString *"
      // Also handle just "(BOOL)" without leading +/-
      const stripped = text
        .replace(/^[+\-]\s*/, '') // Strip leading +/- and whitespace
        .replace(/^\(/, '') // Strip leading (
        .replace(/\)$/, '') // Strip trailing )
        .trim();
      return parseTypeInfo(stripped);
    }
  }
  return { name: 'id', isPointer: true }; // Default to id
}

/** Parse a type string into TypeInfo. */
function parseTypeInfo(typeText: string): TypeInfo {
  const isPointer = typeText.includes('*');
  const isNullable = typeText.includes('nullable') || typeText.includes('_Nullable');
  const name = typeText
    .replace(/\*/g, '')
    .replace(/nullable/g, '')
    .replace(/_Nullable/g, '')
    .trim();
  return { name: name || 'id', isPointer, isNullable };
}

/** Extract method selector and parameters from method declaration.
 *
 * Tree-sitter-objc (via tree-sitter-c) structure for multi-arg methods:
 *   [ '-', method_type, identifier, method_parameter, identifier, method_parameter, ';' ]
 *
 * Where method_parameter looks like ':(NSInteger)start' containing the colon and param info.
 */
function extractMethodSelectorAndParams(node: SyntaxNode): {
  selector: string;
  parameters: Array<{ name: string; type: TypeInfo }>;
} {
  const parts: string[] = [];
  const parameters: Array<{ name: string; type: TypeInfo }> = [];
  let hasParamAfter = false;

  // Walk through children to build selector pattern
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];

    // Skip method_type and literal tokens
    if (
      child.type === 'method_type' ||
      child.text === '-' ||
      child.text === '+' ||
      child.text === ';'
    ) {
      continue;
    }

    // Identifier can be selector keyword
    if (child.type === 'identifier') {
      const text = child.text.trim();
      // Check if there's a method_parameter following this identifier
      const nextChild = node.children[i + 1];
      if (nextChild?.type === 'method_parameter' || nextChild?.type === 'parameter_declaration') {
        parts.push(text + ':');
        hasParamAfter = true;
      } else {
        parts.push(text);
      }
      continue;
    }

    // method_parameter contains the colon and parameter info
    if (child.type === 'method_parameter' || child.type === 'parameter_declaration') {
      const paramInfo = extractMethodParameterInfo(child);
      if (paramInfo.paramName && paramInfo.paramType) {
        parameters.push({ name: paramInfo.paramName, type: paramInfo.paramType });
      }
      continue;
    }
  }

  // Build selector: concatenate parts
  const selector = parts.join('');

  return { selector, parameters };
}

/** Extract parameter info from method_parameter or parameter_declaration node. */
function extractMethodParameterInfo(node: SyntaxNode): {
  paramName: string;
  paramType: TypeInfo;
} {
  let paramName = '';
  let paramType: TypeInfo = { name: 'id', isPointer: true };

  const text = node.text.trim();
  // method_parameter looks like ':(NSInteger)start' or ':(NSString *)name'
  // Strip leading colon
  const content = text.replace(/^:/, '').trim();

  // Try to parse type and name from content
  // Pattern: (Type)name or (Type *)name
  const match = content.match(/^\(([^)]+)\)\s*(\w+)$/);
  if (match) {
    const typeText = match[1].trim();
    paramName = match[2];
    paramType = parseTypeInfo(typeText);
  } else {
    // Fallback: look for identifier children
    for (const child of node.children) {
      if (child.type === 'type_descriptor' || child.type === 'type_name') {
        paramType = parseTypeInfo(child.text.trim());
      }
      if (child.type === 'identifier') {
        if (!paramName) {
          paramName = child.text.trim();
        }
      }
    }
  }

  return { paramName, paramType };
}

// ============================================================================
// Property Extraction
// ============================================================================

/** Extract property name from a property_declaration node. */
function extractPropertyName(node: SyntaxNode): string | undefined {
  // Walk through children to find the identifier
  for (const child of node.children) {
    // Property may be in a struct_declaration wrapper
    if (child.type === 'struct_declaration') {
      for (const inner of child.children) {
        if (inner.type === 'struct_declarator') {
          for (const decl of inner.children) {
            // Pointer declarator: NSString *name
            if (decl.type === 'pointer_declarator') {
              const identifier = decl.children.find((c) => c.type === 'identifier');
              if (identifier) return identifier.text.trim();
            }
            // Direct identifier: BOOL flag
            if (decl.type === 'identifier') {
              return decl.text.trim();
            }
          }
        }
      }
    }

    // Direct identifier (alternative structure)
    if (child.type === 'identifier') {
      return child.text.trim();
    }
  }

  return undefined;
}

// ============================================================================
// Re-exports
// ============================================================================

export type { ObjCCategoryBinding, ObjCProtocolBinding, ObjCMethodSignature, TypeInfo };
