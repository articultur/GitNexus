/**
 * ArkTS method extraction config.
 *
 * ArkTS uses the TypeScript tree-sitter parser; AST nodes are the same as TS.
 * Reuses TypeScript method extraction patterns.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { MethodExtractionConfig } from '../../method-types.js';
import type { ParameterInfo, MethodVisibility } from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { findVisibility, hasKeyword } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';

const TS_VIS = new Set<MethodVisibility>(['public', 'private', 'protected']);

function extractTsMethodName(node: SyntaxNode): string | undefined {
  const name = node.childForFieldName('name');
  return name?.text ?? undefined;
}

function extractTsReturnType(node: SyntaxNode): string | undefined {
  const retType = node.childForFieldName('return_type');
  if (retType) {
    const inner = retType.firstNamedChild;
    return inner ? (extractSimpleTypeName(inner) ?? inner.text?.trim()) : retType.text?.trim();
  }
  return undefined;
}

function extractTsParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return params;
  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param || (param.type !== 'required_parameter' && param.type !== 'optional_parameter'))
      continue;
    const nameNode = param.childForFieldName('pattern') ?? param.firstNamedChild;
    const typeNode = param.childForFieldName('type');
    params.push({
      name: nameNode?.text ?? '?',
      type: typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null) : null,
      rawType: typeNode?.text?.trim() ?? null,
      isOptional: param.type === 'optional_parameter',
      isVariadic: false,
    });
  }
  return params;
}

export const arktsMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.ArkTS,
  typeDeclarationNodes: ['class_declaration', 'interface_declaration', 'enum_declaration'],
  methodNodeTypes: [
    'method_definition',
    'function_declaration',
    'arrow_function',
    'generator_function_declaration',
  ],
  bodyNodeTypes: ['class_body', 'declaration_list', 'object'],

  extractName: extractTsMethodName,
  extractReturnType: extractTsReturnType,
  extractParameters: extractTsParameters,

  extractVisibility(node) {
    return findVisibility(node, TS_VIS, 'public', 'accessibility_modifier');
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isAbstract(node) {
    return hasKeyword(node, 'abstract');
  },

  isFinal() {
    return false;
  },
};
