/**
 * Objective-C method extraction config.
 *
 * ObjC method declarations use a unique syntax:
 *   - (ReturnType)methodName:(Type1)param1 key2:(Type2)param2;  (instance)
 *   + (ReturnType)classNameMethod;                               (class)
 *
 * tree-sitter-objc node types:
 *   - method_declaration for method definitions/declarations
 *   - class_interface / class_implementation for type bodies
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { MethodExtractionConfig, ParameterInfo } from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function extractObjCMethodName(node: SyntaxNode): string | undefined {
  // Build the full selector from selector parts
  const parts: string[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!child) continue;
    if (child.type === 'method_type') continue;
    if (child.text === '-' || child.text === '+' || child.text === ';') continue;
    if (child.type === 'identifier') {
      const next = node.children[i + 1];
      if (next?.type === 'method_parameter' || next?.type === 'parameter_declaration') {
        parts.push(child.text + ':');
      } else {
        parts.push(child.text);
      }
      continue;
    }
  }
  const selector = parts.join('');
  return selector || undefined;
}

function extractObjCMethodReturnType(node: SyntaxNode): string | undefined {
  for (const child of node.children) {
    if (child.type === 'method_type') {
      const text = child.text
        .replace(/^[+\-]\s*/, '')
        .replace(/^\(/, '')
        .replace(/\)$/, '')
        .trim();
      return text || undefined;
    }
  }
  return undefined;
}

function extractObjCMethodParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child?.type === 'method_parameter' || child?.type === 'parameter_declaration') {
      const text = child.text.replace(/^:/, '').trim();
      const match = text.match(/^\(([^)]+)\)\s*(\w+)$/);
      if (match) {
        params.push({
          name: match[2],
          type: match[1].replace(/\*/g, '').trim(),
          rawType: match[1],
          isOptional: false,
          isVariadic: false,
        });
      } else {
        const ident = child.children.find((c) => c.type === 'identifier');
        if (ident) {
          params.push({
            name: ident.text,
            type: null,
            rawType: null,
            isOptional: false,
            isVariadic: false,
          });
        }
      }
    }
  }
  return params;
}

function isObjCClassMethod(node: SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === 'method_type') {
      return child.text.trim().startsWith('+');
    }
    const text = child.text.trim();
    if (text === '+' || text.startsWith('+(')) return true;
    if (text === '-' || text.startsWith('-(')) return false;
  }
  return false;
}

export const objcMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.ObjectiveC,
  typeDeclarationNodes: ['class_interface', 'class_implementation', 'protocol_declaration'],
  methodNodeTypes: ['method_declaration'],
  bodyNodeTypes: ['protocol_body'],

  extractName: extractObjCMethodName,
  extractReturnType: extractObjCMethodReturnType,
  extractParameters: extractObjCMethodParameters,

  extractVisibility() {
    return 'public';
  },

  isStatic: isObjCClassMethod,

  isAbstract(node) {
    // Protocol methods are abstract (no body)
    return !node.children.some((c) => c.type === 'compound_statement' || c.type === 'block');
  },

  isFinal() {
    return false;
  },
};
