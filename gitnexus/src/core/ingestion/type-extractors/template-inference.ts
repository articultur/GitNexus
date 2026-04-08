/**
 * C++ Template Inference Engine
 *
 * Handles:
 * - Template specialization detection
 * - SFINAE type deduction
 * - decltype expression evaluation
 * - Concept constraint analysis
 */
import type { SyntaxNode } from '../utils/ast-helpers.js';

/** Type information extracted from template/specialization analysis. */
export interface TypeInfo {
  name: string;
  isPointer?: boolean;
  isTemplate?: boolean;
  templateArgs?: TypeInfo[];
  isSpecial?: boolean;
}

/** Result of template specialization analysis. */
export interface TemplateSpecialization {
  templateName: string;
  templateParams: TypeInfo[];
  specializedType: TypeInfo;
  sourceLocation?: { line: number; column: number };
}

/** Context for SFINAE type resolution. */
export interface SFINAEContext {
  condition: TypeInfo;
  trueType: TypeInfo;
  falseType?: TypeInfo;
}

/** Type constraint extracted from concept/requires clauses. */
export interface TypeConstraint {
  kind: 'concept' | 'requires' | 'where';
  name: string;
  typeParams: string[];
}

/**
 * C++ Template Inference Engine
 *
 * Provides type inference for C++ template constructs:
 * - Detects explicit and partial template specializations
 * - Resolves SFINAE patterns (enable_if, conditional_t, void_t)
 * - Evaluates decltype expressions
 * - Analyzes concept constraints
 */
export class TemplateInferenceEngine {
  private cache: Map<string, TypeInfo> = new Map();
  private maxRecursionDepth: number = 10;

  /**
   * Resolve template specialization from AST node.
   * Detects both explicit (template<>) and partial (template<typename T> class Foo<T*>)
   * specializations.
   */
  resolveSpecialization(node: SyntaxNode): TemplateSpecialization | null {
    // Find template declaration
    const templateDecl = this.findTemplateDeclaration(node);
    if (!templateDecl) return null;

    // Check if this is a template specialization (has template<> or partial specialization pattern)
    if (!this.isTemplateSpecialization(templateDecl)) return null;

    // Extract template name
    const templateName = this.extractTemplateName(templateDecl);
    if (!templateName) return null;

    // Extract template parameters
    const templateParams = this.extractTemplateParams(templateDecl);

    // Build specialized type
    const specializedType: TypeInfo = {
      name: `${templateName}<${templateParams.map((p) => p.name).join(', ')}>`,
      isTemplate: true,
      templateArgs: templateParams,
    };

    // Extract source location
    const sourceLocation = {
      line: templateDecl.startPosition.row + 1,
      column: templateDecl.startPosition.column,
    };

    return {
      templateName,
      templateParams,
      specializedType,
      sourceLocation,
    };
  }

  /**
   * Resolve SFINAE type from enable_if/conditional_t patterns.
   */
  resolveSFINAE(node: SyntaxNode, context: SFINAEContext): TypeInfo {
    const cacheKey = `sfinae:${node.text}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Check for std::enable_if pattern
    if (this.isEnableIfPattern(node)) {
      const result = this.resolveEnableIf(node, context);
      this.cache.set(cacheKey, result);
      return result;
    }

    // Check for std::conditional_t pattern
    if (this.isConditionalTPattern(node)) {
      const result = this.resolveConditionalT(node, context);
      this.cache.set(cacheKey, result);
      return result;
    }

    // Default: return the true type
    return context.trueType;
  }

  /**
   * Evaluate decltype expression.
   */
  evaluateDecltype(node: SyntaxNode): TypeInfo {
    const cacheKey = `decltype:${node.text}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Find the expression inside decltype
    const exprNode = this.findDecltypeExpression(node);
    if (!exprNode) {
      return { name: 'auto' };
    }

    const result = this.inferExpressionTypeRecursive(exprNode, 0);
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Analyze concept constraints.
   */
  analyzeConceptConstraint(node: SyntaxNode): TypeConstraint[] {
    const constraints: TypeConstraint[] = [];

    // Find requires clause
    const requiresClause = this.findRequiresClause(node);
    if (requiresClause) {
      constraints.push(...this.extractRequiresConstraints(requiresClause));
    }

    // Find concept definitions
    const conceptDef = this.findConceptDefinition(node);
    if (conceptDef) {
      constraints.push(...this.extractConceptConstraints(conceptDef));
    }

    return constraints;
  }

  // Private helper methods

  private findTemplateDeclaration(node: SyntaxNode): SyntaxNode | null {
    if (
      node.type === 'template_declaration' ||
      node.type === 'template_specialization' ||
      node.type === 'class_specifier'
    ) {
      return node;
    }

    for (const child of node.children ?? []) {
      const found = this.findTemplateDeclaration(child);
      if (found) return found;
    }

    return null;
  }

  private isTemplateSpecialization(node: SyntaxNode): boolean {
    const text = node.text;

    // Explicit specialization: template<>
    if (text.includes('template<>')) return true;

    // Partial specialization: check for template<typename T> class Foo<T*>
    // Pattern: template declaration with a class/struct that has template arguments
    if (node.type === 'template_declaration') {
      const hasTemplateParams = node.children?.some(
        (c) => c.type === 'template_parameter_list' && c.text !== '<>',
      );
      const hasClassSpec = node.children?.some((c) => c.type === 'class_specifier');
      if (hasTemplateParams && hasClassSpec) {
        // Check if class_specifier has a template type (e.g., Vector<T*>)
        const classSpec = node.children?.find((c) => c.type === 'class_specifier');
        if (classSpec) {
          const nameNode = classSpec.childForFieldName?.('name');
          if (nameNode && nameNode.type === 'type_identifier' && nameNode.text.includes('<')) {
            return true;
          }
          // Also check for template_type child
          const hasTemplateType = classSpec.children?.some(
            (c) => c.type === 'type_identifier' && c.text.includes('<'),
          );
          if (hasTemplateType) return true;
        }
      }
    }

    return false;
  }

  private extractTemplateName(node: SyntaxNode): string | null {
    // Look for the class/struct name in the template declaration
    const findName = (n: SyntaxNode): string | null => {
      // Check for name field
      const nameField = n.childForFieldName?.('name');
      if (nameField) {
        const text = nameField.text;
        // Extract base name from Vector<int> → Vector
        const match = text.match(/^(\w+)</);
        return match ? match[1] : text;
      }

      // Check for type_identifier child
      for (const child of n.children ?? []) {
        if (child.type === 'type_identifier') {
          const text = child.text;
          const match = text.match(/^(\w+)</);
          return match ? match[1] : text;
        }
        if (child.type === 'class_specifier' || child.type === 'struct_specifier') {
          const name = findName(child);
          if (name) return name;
        }
      }

      return null;
    };

    return findName(node);
  }

  private extractTemplateParams(node: SyntaxNode): TypeInfo[] {
    const params: TypeInfo[] = [];

    // Find template_argument_list or template_parameter_list
    const paramList =
      node.childForFieldName?.('parameters') ??
      node.children?.find(
        (c) => c.type === 'template_argument_list' || c.type === 'template_parameter_list',
      );

    if (!paramList) return params;

    for (const child of paramList.children ?? []) {
      if (child.type === 'type_descriptor' || child.type === 'type_identifier') {
        const text = child.text.trim();
        params.push({
          name: text,
          isPointer: text.includes('*'),
        });
      } else if (child.type === 'type_parameter') {
        // Template parameter like typename T
        const nameNode = child.childForFieldName?.('name');
        if (nameNode) {
          params.push({ name: nameNode.text });
        }
      }
    }

    // If no params found via AST, try text extraction
    if (params.length === 0) {
      const text = node.text;

      // Extract from template<...> pattern
      const templateMatch = text.match(/template\s*<([^>]+)>/);
      if (templateMatch) {
        const args = templateMatch[1].split(',').map((s) => s.trim());
        for (const arg of args) {
          if (arg && !arg.startsWith('typename') && !arg.startsWith('class')) {
            params.push({
              name: arg,
              isPointer: arg.includes('*'),
            });
          }
        }
      }

      // Extract from class Vector<int> pattern
      const classMatch = text.match(/(?:class|struct)\s+(\w+)<([^>]+)>/);
      if (classMatch) {
        const args = classMatch[2].split(',').map((s) => s.trim());
        for (const arg of args) {
          if (arg) {
            params.push({
              name: arg,
              isPointer: arg.includes('*'),
            });
          }
        }
      }
    }

    return params;
  }

  private isEnableIfPattern(node: SyntaxNode): boolean {
    const text = node.text;
    return text.includes('std::enable_if') || text.includes('enable_if');
  }

  private isConditionalTPattern(node: SyntaxNode): boolean {
    const text = node.text;
    return text.includes('std::conditional_t') || text.includes('conditional_t');
  }

  private resolveEnableIf(_node: SyntaxNode, context: SFINAEContext): TypeInfo {
    // Simplified: return true type if condition is met
    // Full implementation would evaluate the condition
    return context.trueType;
  }

  private resolveConditionalT(_node: SyntaxNode, context: SFINAEContext): TypeInfo {
    // Simplified: return true type
    // Full implementation would parse the ternary
    return context.trueType;
  }

  private findDecltypeExpression(node: SyntaxNode): SyntaxNode | null {
    if (node.type === 'decltype_expression' || node.type === 'decltype') {
      // Return the expression inside decltype
      for (const child of node.children ?? []) {
        if (child.type !== 'decltype') {
          return child;
        }
      }
      return null;
    }

    for (const child of node.children ?? []) {
      const found = this.findDecltypeExpression(child);
      if (found) return found;
    }

    return null;
  }

  private inferExpressionTypeRecursive(node: SyntaxNode, depth: number): TypeInfo {
    if (depth > this.maxRecursionDepth) {
      return { name: 'auto' };
    }

    // Call expression: foo(args)
    if (node.type === 'call_expression') {
      return this.inferCallReturnType(node, depth);
    }

    // Member access: obj.member
    if (node.type === 'field_expression') {
      return this.inferMemberType(node, depth);
    }

    // Simple type inference
    return this.inferExpressionType(node);
  }

  private inferCallReturnType(node: SyntaxNode, _depth: number): TypeInfo {
    const funcNode = node.childForFieldName?.('function');
    if (!funcNode) return { name: 'auto' };

    // If function is a type identifier, it's a constructor call
    if (funcNode.type === 'type_identifier') {
      return { name: funcNode.text };
    }

    // For other calls, we'd need function signature lookup
    return { name: 'auto' };
  }

  private inferMemberType(node: SyntaxNode, _depth: number): TypeInfo {
    // Simplified: return unknown type for member access
    const memberNode = node.lastNamedChild ?? node.children?.[node.children.length - 1];
    if (memberNode) {
      return { name: `auto /* ${memberNode.text} */` };
    }
    return { name: 'auto' };
  }

  private inferExpressionType(node: SyntaxNode): TypeInfo {
    const text = node.text;

    // String literals
    if (text.includes('"')) return { name: 'const char*' };
    if (text.includes("'") && !text.includes('"')) return { name: 'char' };

    // Number literals
    if (/^\d+$/.test(text)) return { name: 'int' };
    if (/^\d+\.\d+$/.test(text) || /^\d+[eE][+-]?\d+$/.test(text)) return { name: 'double' };
    if (/^\d+[fF]$/.test(text)) return { name: 'float' };
    if (/^-?\d+$/.test(text)) return { name: 'int' };

    // Boolean literals
    if (text === 'true' || text === 'false') return { name: 'bool' };

    // Nullptr
    if (text === 'nullptr') return { name: 'nullptr_t' };

    return { name: 'auto' };
  }

  private findRequiresClause(node: SyntaxNode): SyntaxNode | null {
    if (node.type === 'requires_clause') return node;

    for (const child of node.children ?? []) {
      if (child.type === 'requires_clause' || child.text.startsWith('requires')) {
        return child;
      }
      const found = this.findRequiresClause(child);
      if (found) return found;
    }

    return null;
  }

  private extractRequiresConstraints(node: SyntaxNode): TypeConstraint[] {
    const constraints: TypeConstraint[] = [];
    const text = node.text;

    // Extract concept name from requires clause
    const match = text.match(/requires\s+(\w+(?:::\w+)*)/);
    if (match) {
      constraints.push({
        kind: 'requires',
        name: match[1],
        typeParams: [],
      });
    }

    return constraints;
  }

  private findConceptDefinition(node: SyntaxNode): SyntaxNode | null {
    if (node.type === 'concept_definition') return node;

    for (const child of node.children ?? []) {
      const found = this.findConceptDefinition(child);
      if (found) return found;
    }

    return null;
  }

  private extractConceptConstraints(node: SyntaxNode): TypeConstraint[] {
    const constraints: TypeConstraint[] = [];

    // Extract concept name
    const nameNode = node.childForFieldName?.('name');
    if (nameNode) {
      constraints.push({
        kind: 'concept',
        name: nameNode.text,
        typeParams: [],
      });
    }

    return constraints;
  }
}
