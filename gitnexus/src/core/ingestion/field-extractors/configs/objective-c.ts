/**
 * Objective-C field extraction config.
 *
 * ObjC has two kinds of instance data:
 *   - @property declarations (synthesized accessors)
 *   - Instance variables in { } blocks (`instance_variable` containing
 *     `atomic_declaration` / C-style `field_declaration`)
 *
 * tree-sitter-objc node types:
 *   - property_declaration for @property
 *   - atomic_declaration / field_declaration for instance variables
 *   - class_interface / class_implementation for type bodies
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function extractObjCFieldName(node: SyntaxNode): string | undefined {
  if (node.type === 'property_declaration') {
    // @property (attributes) Type *name;
    // Walk children to find the identifier (property name)
    for (const child of node.children) {
      if (child.type === 'declaration') {
        const ident = child.children.find((c) => c.type === 'identifier');
        if (ident) return ident.text;
        // pointer_declarator case
        const ptr = child.children.find((c) => c.type === 'pointer_declarator');
        if (ptr) {
          const inner = ptr.children.find((c) => c.type === 'identifier');
          if (inner) return inner.text;
        }
      }
      if (child.type === 'identifier') return child.text;
    }
    return undefined;
  }

  // ivar declaration: Type name;
  const fieldIdentifier = node.children.find((c) => c.type === 'field_identifier');
  if (fieldIdentifier) return fieldIdentifier.text;

  const declarator = node.childForFieldName('declarator');
  if (declarator) {
    if (declarator.type === 'identifier') return declarator.text;
    for (const child of declarator.children) {
      if (child.type === 'identifier') return child.text;
    }
    return declarator.text;
  }
  return undefined;
}

function extractObjCFieldType(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName('type');
  if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
  const typeSpecifier = node.children.find((c) => c.type === 'type_specifier');
  if (typeSpecifier) return extractSimpleTypeName(typeSpecifier) ?? typeSpecifier.text?.trim();
  // property_declaration may have type inside declaration child
  if (node.type === 'property_declaration') {
    for (const child of node.children) {
      if (child.type === 'declaration') {
        const typeChild = child.children.find(
          (c) => c.type === 'type_identifier' || c.type === 'primitive_type',
        );
        if (typeChild) return extractSimpleTypeName(typeChild) ?? typeChild.text?.trim();
      }
    }
  }
  return undefined;
}

export const objcFieldConfig: FieldExtractionConfig = {
  language: SupportedLanguages.ObjectiveC,
  typeDeclarationNodes: ['class_interface', 'class_implementation', 'protocol_declaration'],
  fieldNodeTypes: ['property_declaration', 'atomic_declaration', 'field_declaration'],
  bodyNodeTypes: ['instance_variable', 'protocol_declaration'],
  defaultVisibility: 'protected',

  extractName: extractObjCFieldName,
  extractType: extractObjCFieldType,

  extractVisibility() {
    return 'protected';
  },

  isStatic() {
    return false;
  },

  isReadonly(node) {
    // Check for readonly attribute in property
    const text = node.text;
    return text.includes('readonly');
  },
};
