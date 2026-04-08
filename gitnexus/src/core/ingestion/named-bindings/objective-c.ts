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

  return {
    type: 'objc-protocol',
    local: protocolName,
    exported: protocolName,
    protocolName,
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

/** Extract required and optional methods from a protocol body. */
function extractProtocolMethods(node: SyntaxNode): {
  requiredMethods: ObjCMethodSignature[];
  optionalMethods: ObjCMethodSignature[];
} {
  const requiredMethods: ObjCMethodSignature[] = [];
  const optionalMethods: ObjCMethodSignature[] = [];

  // Find the protocol body
  const protocolBody = node.children.find((c) => c.type === 'protocol_body');
  const searchNode = protocolBody ?? node;

  let currentSection: 'required' | 'optional' = 'required'; // Default to required

  // Walk through all children, tracking @required/@optional sections
  for (const child of searchNode.children) {
    const text = child.text.trim();

    // Check for section markers
    if (text === '@required') {
      currentSection = 'required';
      continue;
    }
    if (text === '@optional') {
      currentSection = 'optional';
      continue;
    }

    // Extract method declarations
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

/** Extract class name and category name from @interface ClassName (CategoryName). */
function extractCategoryNames(node: SyntaxNode): { className: string; categoryName: string } {
  let className = '';
  let categoryName = '';

  for (const child of node.children) {
    // First identifier is the class name
    if (child.type === 'identifier' && !className) {
      className = child.text.trim();
      continue;
    }

    // Category is in a 'category' node or parenthesized identifier
    if (child.type === 'category') {
      for (const catChild of child.children) {
        if (catChild.type === 'identifier') {
          categoryName = catChild.text.trim();
          break;
        }
      }
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

/** Extract return type from method_type node. */
function extractMethodReturnType(node: SyntaxNode): TypeInfo {
  for (const child of node.children) {
    if (child.type === 'method_type') {
      const text = child.text.trim();
      // Strip leading +/- and parentheses: "- (NSString *)" -> "NSString *"
      const stripped = text
        .replace(/^[+\-]\s*\(/, '')
        .replace(/\)$/, '')
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

/** Extract method selector and parameters from method declaration. */
function extractMethodSelectorAndParams(node: SyntaxNode): {
  selector: string;
  parameters: Array<{ name: string; type: TypeInfo }>;
} {
  const parts: string[] = [];
  const parameters: Array<{ name: string; type: TypeInfo }> = [];

  // Walk through children to build selector pattern
  for (const child of node.children) {
    // Skip method_type
    if (child.type === 'method_type') continue;

    // Identifier can be selector keyword or parameter name
    if (child.type === 'identifier') {
      // First identifier after method_type is typically the first selector keyword
      // or the full selector for unary methods like - (void)dealloc
      if (parts.length === 0) {
        parts.push(child.text.trim());
      }
      continue;
    }

    // Parameter declaration contains selector keyword and parameter info
    if (child.type === 'parameter_declaration') {
      const { keyword, paramName, paramType } = extractParameterInfo(child);
      if (keyword) {
        parts.push(keyword);
      }
      if (paramName && paramType) {
        parameters.push({ name: paramName, type: paramType });
      }
    }
  }

  // Build selector: concatenate parts with colons
  // For multi-arg: tableView:numberOfRowsInSection:
  // For unary: dealloc
  const hasParams = parameters.length > 0;
  const selector = hasParams ? parts.map((p) => p + ':').join('') : parts.join('');

  return { selector, parameters };
}

/** Extract parameter info from parameter_declaration node. */
function extractParameterInfo(node: SyntaxNode): {
  keyword: string;
  paramName: string;
  paramType: TypeInfo;
} {
  let keyword = '';
  let paramName = '';
  let paramType: TypeInfo = { name: 'id', isPointer: true };

  for (const child of node.children) {
    // Type descriptor contains the parameter type
    if (child.type === 'type_descriptor' || child.type === 'type_name') {
      const text = child.text.trim();
      paramType = parseTypeInfo(text);
      continue;
    }

    // Method type within parameter (alternative structure)
    if (child.type === 'method_type') {
      const text = child.text.trim();
      // Strip parentheses to get type
      const stripped = text.replace(/[()]/g, '').trim();
      paramType = parseTypeInfo(stripped);
      continue;
    }

    // Identifier could be keyword or param name
    if (child.type === 'identifier') {
      if (!keyword) {
        keyword = child.text.trim();
      } else {
        paramName = child.text.trim();
      }
    }
  }

  return { keyword, paramName, paramType };
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
