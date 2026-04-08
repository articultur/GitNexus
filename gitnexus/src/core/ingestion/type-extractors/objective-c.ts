import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { LanguageTypeConfig } from './types.js';
import { typeConfig as cCppTypeConfig } from './c-cpp.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

/**
 * Objective-C type extractor config.
 * Reuses C/C++ declaration and pending-assignment extraction.
 */
export const typeConfig: LanguageTypeConfig = {
  ...cCppTypeConfig,
};

// ============================================================================
// Task 1: instancetype inference
// ============================================================================

/** Context for Objective-C method return type extraction. */
export interface ObjCMethodContext {
  /** The enclosing class name (e.g., 'User' for @interface User). */
  enclosingClass?: string;
}

/** Type information extracted from a node. */
export interface TypeInfo {
  name: string;
  isPointer?: boolean;
  isSpecial?: boolean;
}

/**
 * Extract the return type from an Objective-C method declaration.
 * Handles instancetype inference based on enclosing class context.
 */
export function extractObjCMethodReturnType(
  node: SyntaxNode,
  context: ObjCMethodContext,
): TypeInfo | undefined {
  // Method declaration: - (returnType)methodName...
  // The return type is in the 'return_type' field or child
  const returnTypeNode = node.childForFieldName('return_type') ?? node.childForFieldName('type');

  if (!returnTypeNode) {
    return undefined;
  }

  const returnText = returnTypeNode.text.trim();

  // Handle instancetype - infer as the enclosing class
  if (returnText === 'instancetype') {
    if (context.enclosingClass) {
      return { name: context.enclosingClass, isPointer: true };
    }
    return { name: 'instancetype', isSpecial: true };
  }

  // Handle pointer types (NSString *, User *, etc.)
  const isPointer = returnText.includes('*');
  const typeName = extractSimpleTypeName(returnTypeNode);

  return { name: typeName ?? returnText, isPointer };
}

// ============================================================================
// Task 2: block type extraction
// ============================================================================

/** Information about a block parameter. */
export interface BlockParameterInfo {
  name: string;
  type: TypeInfo;
}

/** Complete block type information. */
export interface BlockTypeInfo {
  returnType: TypeInfo;
  parameters: BlockParameterInfo[];
}

/**
 * Extract block type information from block pointer declarator or block literal.
 * Block syntax: returnType (^blockName)(paramTypes)
 *
 * Supports:
 * - Block pointer declarations: void (^completion)(NSData *data, NSError *error)
 * - Block literals: ^(NSString *s){ return s.length; }
 * - Block typedefs: typedef void (^Handler)(NSURL *url)
 */
export function extractBlockType(node: SyntaxNode): BlockTypeInfo {
  // Handle block_pointer_declarator: void (^completion)(NSData *data, NSError *error)
  if (node.type === 'block_pointer_declarator') {
    return extractBlockPointerType(node);
  }

  // Handle block_literal: ^{ ... } or ^(params){ ... }
  if (node.type === 'block_literal' || node.type === 'block') {
    return extractBlockLiteralType(node);
  }

  // Handle block_declaration (alternative node type in some grammars)
  if (node.type === 'block_declaration') {
    return extractBlockDeclarationType(node);
  }

  // Handle type_definition for typedef blocks
  if (node.type === 'type_definition') {
    return extractTypedefBlockType(node);
  }

  // Default fallback
  return { returnType: { name: 'void' }, parameters: [] };
}

/** Extract type from block pointer declarator. */
function extractBlockPointerType(node: SyntaxNode): BlockTypeInfo {
  // Block pointer declarator structure:
  // returnType (^name)(params)
  // In tree-sitter-objc, this is typically:
  // - A parent declaration node has the return type
  // - The parameter list is a child

  let returnType: TypeInfo = { name: 'void' };

  // Find return type from parent or previous sibling
  const parent = node.parent;
  if (parent?.type === 'declaration' || parent?.type === 'type_definition') {
    const typeNode = parent.childForFieldName('type');
    if (typeNode) {
      const typeText = typeNode.text.trim();
      returnType = {
        name: extractSimpleTypeName(typeNode) ?? typeText,
        isPointer: typeText.includes('*'),
      };
    }
  }

  // Look for return type as a preceding sibling
  if (returnType.name === 'void' && parent) {
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (child === node) break;
      if (child?.type === 'type_identifier' || child?.type === 'primitive_type') {
        const typeText = child.text.trim();
        returnType = {
          name: typeText,
          isPointer: typeText.includes('*'),
        };
      }
    }
  }

  // Find parameter list
  const paramListNode = findParameterList(node);
  const parameters = paramListNode ? extractBlockParameters(paramListNode) : [];

  return { returnType, parameters };
}

/** Extract type from block literal. */
function extractBlockLiteralType(node: SyntaxNode): BlockTypeInfo {
  // Block literals may have explicit return type or inferred
  // ^returnType(params){ body }

  let returnType: TypeInfo = { name: 'id' }; // Default to id for blocks without explicit return type

  // Check for explicit return type
  for (const child of node.children) {
    // Return type might be before the parameter list
    if (child.type === 'type_identifier' || child.type === 'primitive_type') {
      const typeText = child.text.trim();
      returnType = {
        name: typeText,
        isPointer: typeText.includes('*'),
      };
      break;
    }
  }

  // Find parameter list
  const paramListNode = findParameterList(node);
  const parameters = paramListNode ? extractBlockParameters(paramListNode) : [];

  return { returnType, parameters };
}

/** Extract type from block declaration node. */
function extractBlockDeclarationType(node: SyntaxNode): BlockTypeInfo {
  // Block declaration might wrap the block pointer declarator
  const blockPointer = node.children.find(
    (c) => c.type === 'block_pointer_declarator' || c.type === 'block_declarator',
  );

  if (blockPointer) {
    return extractBlockPointerType(blockPointer);
  }

  // Try to extract directly
  let returnType: TypeInfo = { name: 'void' };
  const typeNode = node.childForFieldName('type');
  if (typeNode) {
    returnType = {
      name: extractSimpleTypeName(typeNode) ?? typeNode.text.trim(),
      isPointer: typeNode.text.includes('*'),
    };
  }

  const paramListNode = findParameterList(node);
  const parameters = paramListNode ? extractBlockParameters(paramListNode) : [];

  return { returnType, parameters };
}

/** Extract type from typedef block. */
function extractTypedefBlockType(node: SyntaxNode): BlockTypeInfo {
  // Find block declarator within typedef
  const blockDeclarator = node.children.find(
    (c) =>
      c.type === 'block_pointer_declarator' ||
      c.type === 'block_declaration' ||
      c.type === 'block_declarator',
  );

  if (blockDeclarator) {
    return extractBlockPointerType(blockDeclarator);
  }

  // Try to find type and parameters
  let returnType: TypeInfo = { name: 'void' };
  const typeNode = node.childForFieldName('type');
  if (typeNode) {
    returnType = {
      name: extractSimpleTypeName(typeNode) ?? typeNode.text.trim(),
      isPointer: typeNode.text.includes('*'),
    };
  }

  const paramListNode = findParameterList(node);
  const parameters = paramListNode ? extractBlockParameters(paramListNode) : [];

  return { returnType, parameters };
}

/** Find parameter list node within a block-related node. */
function findParameterList(node: SyntaxNode): SyntaxNode | undefined {
  // Direct parameter_list child
  const directParams = node.children.find((c) => c.type === 'parameter_list');
  if (directParams) return directParams;

  // Parameter list might be within a parameter_declaration
  for (const child of node.children) {
    if (child.type === 'parameter_declaration') {
      const innerParams = child.children.find((c) => c.type === 'parameter_list');
      if (innerParams) return innerParams;
    }
  }

  return undefined;
}

/** Extract parameters from a parameter list node. */
function extractBlockParameters(paramList: SyntaxNode): BlockParameterInfo[] {
  const params: BlockParameterInfo[] = [];

  for (const child of paramList.children) {
    if (child.type === 'parameter_declaration') {
      const param = extractParameterInfo(child);
      if (param) params.push(param);
    }
  }

  return params;
}

/** Extract parameter info from a parameter declaration node. */
function extractParameterInfo(node: SyntaxNode): BlockParameterInfo | undefined {
  const typeNode = node.childForFieldName('type');
  const declarator = node.childForFieldName('declarator');

  if (!typeNode) return undefined;

  // Get type name
  const typeText = typeNode.text.trim();
  const typeName = extractSimpleTypeName(typeNode) ?? typeText.replace(/\*/g, '').trim();
  const isPointer = typeText.includes('*');

  // Get parameter name
  let paramName: string;

  if (declarator) {
    // Handle pointer declarator wrapping
    if (declarator.type === 'pointer_declarator') {
      const inner = declarator.firstNamedChild;
      paramName = inner ? extractVarName(inner) : declarator.text.trim();
    } else {
      paramName = extractVarName(declarator);
    }
  } else {
    // Try to get name from 'name' field
    const nameNode = node.childForFieldName('name');
    paramName = nameNode ? extractVarName(nameNode) : '';
  }

  if (!paramName || typeName === 'void') {
    return undefined;
  }

  return {
    name: paramName,
    type: { name: typeName, isPointer },
  };
}

// ============================================================================
// Task 3: property synthesis
// ============================================================================

/** Information about synthesized accessor methods. */
export interface PropertyInfo {
  getter: {
    selector: string;
    returnType: TypeInfo;
  };
  setter: {
    selector: string;
    returnType: TypeInfo;
    paramType: TypeInfo;
  } | null;
}

/**
 * Synthesize getter and setter method signatures from a property declaration.
 * Handles:
 * - readwrite/readonly attributes
 * - custom getter= and setter= attributes
 * - Objective-C property type conventions
 */
export function synthesizePropertyAccessors(node: SyntaxNode): PropertyInfo {
  // Find the property name
  const nameNode = node.childForFieldName('name') ?? node.lastNamedChild;
  const propertyName = nameNode ? extractVarName(nameNode) : '';

  // Extract type
  let typeName = 'id';
  let isPointer = false;

  const typeNode = node.childForFieldName('type');
  if (typeNode) {
    const typeText = typeNode.text.trim();
    typeName = extractSimpleTypeName(typeNode) ?? typeText.replace(/\*/g, '').trim();
    isPointer = typeText.includes('*');
  }

  // Parse property attributes
  const attributes = parsePropertyAttributes(node);
  const isReadonly = attributes.has('readonly');

  // Determine getter selector (default or custom)
  const customGetter = attributes.get('getter');
  const getterSelector = customGetter ?? propertyName;

  // Determine setter selector (default or custom)
  let setterSelector: string | null = null;
  if (!isReadonly) {
    const customSetter = attributes.get('setter');
    if (customSetter) {
      setterSelector = customSetter;
    } else {
      // Default: propertyName -> setPropertyName:
      setterSelector = 'set' + propertyName.charAt(0).toUpperCase() + propertyName.slice(1) + ':';
    }
  }

  return {
    getter: {
      selector: getterSelector,
      returnType: { name: typeName, isPointer },
    },
    setter: setterSelector
      ? {
          selector: setterSelector,
          returnType: { name: 'void' },
          paramType: { name: typeName, isPointer },
        }
      : null,
  };
}

/** Parse property attributes into a map. */
function parsePropertyAttributes(node: SyntaxNode): Map<string, string> {
  const attributes = new Map<string, string>();

  // Find attribute list
  const attrList = node.children.find(
    (c) => c.type === 'attribute_specifier' || c.type === 'property_attribute_list',
  );

  if (!attrList) return attributes;

  // Parse each attribute
  for (const child of attrList.children) {
    if (child.type === 'property_attribute' || child.type === 'identifier') {
      const text = child.text.trim();
      // Handle getter=... or setter=...
      const getterMatch = text.match(/getter\s*=\s*(\w+)/);
      if (getterMatch) {
        attributes.set('getter', getterMatch[1]);
        continue;
      }
      const setterMatch = text.match(/setter\s*=\s*(\w+:)/);
      if (setterMatch) {
        attributes.set('setter', setterMatch[1]);
        continue;
      }
      // Handle simple attributes like readonly, nonatomic, etc.
      if (text === 'readonly' || text === 'readwrite') {
        attributes.set(text, 'true');
      }
    }
  }

  return attributes;
}
