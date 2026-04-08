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
  /** Whether this represents a boolean value (for type traits) */
  isBool?: boolean;
  /** The boolean value for type trait evaluation */
  boolValue?: boolean;
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
  kind: 'concept' | 'requires' | 'where' | 'compound_requires';
  name: string;
  typeParams: string[];
  /** For compound requirements: the expression being tested */
  expression?: string;
  /** For compound requirements: the expected concept type (e.g., 'std::same_as<void>') */
  expectedType?: string;
}

/** Result of decltype(auto) analysis */
export interface DecltypeAutoResult {
  isAuto: boolean;
  deducedType: TypeInfo;
  /** When true, the type is deduced from a return statement */
  deducedFromReturn?: boolean;
}

/** Known C++ standard concepts */
const KNOWN_CONCEPTS = new Set([
  'std::integral',
  'std::floating_point',
  'std::same_as',
  'std::convertible_to',
  'std::derived_from',
  'std::common_with',
  'std::common_reference_with',
  'std::assignable_from',
  'std::swappable',
  'std::swappable_with',
  'std::destructible',
  'std::constructible_from',
  'std::default_constructible',
  'std::move_constructible',
  'std::copy_constructible',
  'std::movable',
  'std::copyable',
  'std::semiregular',
  'std::regular',
  'std::equality_comparable',
  'std::totally_ordered',
  'std::regular_invocable',
  'std::predicate',
  'std::relation',
  'std::strict_weak_order',
  'std::numeric',
  'integral',
  'floating_point',
  'same_as',
  'convertible_to',
  'derived_from',
]);

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
   * Resolve SFINAE type from enable_if/conditional_t/void_t patterns.
   */
  resolveSFINAE(node: SyntaxNode, context: SFINAEContext): TypeInfo {
    const cacheKey = `sfinae:${node.text}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Check for std::void_t pattern
    if (this.isVoidTPattern(node)) {
      const result = this.resolveVoidT(node);
      this.cache.set(cacheKey, result);
      return result;
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
   * Handles:
   * - decltype(auto) return type deduction
   * - decltype(expr) with function calls
   * - decltype(std::declval<T>()) pattern
   */
  evaluateDecltype(node: SyntaxNode): TypeInfo {
    const cacheKey = `decltype:${node.text}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Check for decltype(auto) pattern
    if (this.isDecltypeAuto(node)) {
      const result = this.evaluateDecltypeAuto(node);
      this.cache.set(cacheKey, result.deducedType);
      return result.deducedType;
    }

    // Find the expression inside decltype
    const exprNode = this.findDecltypeExpression(node);
    if (!exprNode) {
      return { name: 'auto' };
    }

    // Check for std::declval<T>() pattern
    if (this.isDeclvalPattern(exprNode)) {
      const result = this.resolveDeclvalType(exprNode);
      this.cache.set(cacheKey, result);
      return result;
    }

    const result = this.inferExpressionTypeRecursive(exprNode, 0);
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Analyze decltype(auto) for return type deduction.
   * Returns information about whether this is decltype(auto) and the deduced type.
   */
  evaluateDecltypeAutoFull(node: SyntaxNode): DecltypeAutoResult {
    if (!this.isDecltypeAuto(node)) {
      return { isAuto: false, deducedType: { name: 'auto' } };
    }

    // decltype(auto) deduces the type as if by decltype(return-expression)
    // This typically requires context to determine the return type
    return {
      isAuto: true,
      deducedType: { name: 'auto', isSpecial: true },
      deducedFromReturn: true,
    };
  }

  /**
   * Check if node represents decltype(auto) pattern.
   */
  private isDecltypeAuto(node: SyntaxNode): boolean {
    const text = node.text;
    return /\bdecltype\s*\(\s*auto\s*\)/.test(text) || text === 'decltype(auto)';
  }

  /**
   * Evaluate decltype(auto) context.
   */
  private evaluateDecltypeAuto(node: SyntaxNode): DecltypeAutoResult {
    return this.evaluateDecltypeAutoFull(node);
  }

  /**
   * Check if node represents std::declval<T>() pattern.
   */
  private isDeclvalPattern(node: SyntaxNode): boolean {
    const text = node.text;
    return text.includes('std::declval') || text.includes('declval<');
  }

  /**
   * Resolve type from std::declval<T>() pattern.
   * std::declval<T>() returns T&& (rvalue reference to T).
   */
  private resolveDeclvalType(node: SyntaxNode): TypeInfo {
    const text = node.text;

    // Extract template argument from declval<T>()
    const match = text.match(/declval\s*<\s*([^>]+)\s*>/);
    if (match) {
      const innerType = match[1].trim();
      // declval<T>() returns T&&, declval<T&>() returns T&
      if (innerType.endsWith('&')) {
        return { name: innerType, isPointer: false };
      }
      return { name: `${innerType}&&`, isPointer: false };
    }

    // Fallback: could be declval<T> without parens
    const matchNoParens = text.match(/declval\s*<\s*([^>]+)\s*>/);
    if (matchNoParens) {
      const innerType = matchNoParens[1].trim();
      if (innerType.endsWith('&')) {
        return { name: innerType, isPointer: false };
      }
      return { name: `${innerType}&&`, isPointer: false };
    }

    return { name: 'auto' };
  }

  /**
   * Analyze concept constraints.
   * Handles:
   * - requires clauses in function templates
   * - concept definitions
   * - compound requirements: requires { { expr } -> Concept; }
   * - C++20 abbreviated function syntax: void foo(Integral auto x)
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

    // Find compound requirements in requires expressions
    const compoundReqs = this.findCompoundRequirements(node);
    for (const req of compoundReqs) {
      constraints.push(...this.extractCompoundRequirements(req));
    }

    // Find C++20 abbreviated syntax: void foo(Integral auto x)
    const abbreviatedSyn = this.findAbbreviatedConceptSyntax(node);
    constraints.push(...abbreviatedSyn);

    return constraints;
  }

  /**
   * Find compound requirements within requires expressions.
   * Pattern: requires { { expr } -> Concept; }
   */
  private findCompoundRequirements(node: SyntaxNode): SyntaxNode[] {
    const results: SyntaxNode[] = [];

    const walk = (n: SyntaxNode) => {
      // Check for requires_expression (contains compound requirements)
      if (n.type === 'requires_expression' || n.type === 'requirement_sequence') {
        results.push(n);
      }
      for (const child of n.children ?? []) {
        walk(child);
      }
    };

    walk(node);
    return results;
  }

  /**
   * Extract compound requirements from a requires expression.
   * Handles patterns like:
   * - { expr } -> Concept<T>;
   * - { expr } noexcept;
   * - requires requires { expr };
   */
  private extractCompoundRequirements(node: SyntaxNode): TypeConstraint[] {
    const constraints: TypeConstraint[] = [];
    const text = node.text;

    // Pattern: { expr } -> Concept<T>;
    const arrowPattern = /\{\s*([^}]+)\s*\}\s*->\s*(\w+(?:::\w+)*(?:<[^>]+>)?)/g;
    let match;
    while ((match = arrowPattern.exec(text)) !== null) {
      constraints.push({
        kind: 'compound_requires',
        name: this.normalizeConceptName(match[2]),
        typeParams: [],
        expression: match[1].trim(),
        expectedType: match[2].trim(),
      });
    }

    // Pattern: requires(T t) { t.sort(); } - nested requires
    const nestedRequires = /\brequires\s*\([^)]*\)\s*\{([^}]+)\}/;
    const nestedMatch = nestedRequires.exec(text);
    if (nestedMatch) {
      constraints.push({
        kind: 'compound_requires',
        name: 'requires_expression',
        typeParams: [],
        expression: nestedMatch[1].trim(),
      });
    }

    return constraints;
  }

  /**
   * Find C++20 abbreviated concept syntax.
   * Pattern: void foo(Integral auto x) - where Integral is a concept
   */
  private findAbbreviatedConceptSyntax(node: SyntaxNode): TypeConstraint[] {
    const constraints: TypeConstraint[] = [];
    const text = node.text;

    // Pattern: Concept auto or Concept auto& or Concept auto&&
    // Matches: Integral auto, Sortable auto&, etc.
    const abbrevPattern = /(\w+(?:::\w+)*)\s+auto\s*(&{0,2})?/g;
    let match;
    while ((match = abbrevPattern.exec(text)) !== null) {
      const conceptName = match[1];
      // Only add if it's a known concept or follows naming conventions
      if (KNOWN_CONCEPTS.has(conceptName) || /^[A-Z]/.test(conceptName)) {
        constraints.push({
          kind: 'concept',
          name: this.normalizeConceptName(conceptName),
          typeParams: [],
        });
      }
    }

    // Pattern: std::ranges::range auto - with namespace
    const nsPattern = /(std::\w+(?:::\w+)*)\s+auto/g;
    while ((match = nsPattern.exec(text)) !== null) {
      constraints.push({
        kind: 'concept',
        name: match[1],
        typeParams: [],
      });
    }

    return constraints;
  }

  /**
   * Normalize concept name by removing std:: prefix if present.
   */
  private normalizeConceptName(name: string): string {
    // Keep std:: prefix for standard concepts
    if (name.startsWith('std::')) {
      return name;
    }
    return name;
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

  /**
   * Resolve std::conditional_t<Condition, TrueType, FalseType> pattern.
   * Properly evaluates the condition and returns the appropriate type.
   *
   * Supports:
   * - Boolean conditions
   * - Type traits as conditions
   * - sizeof comparisons
   * - Logical operators (&&, ||, !)
   * - Nested enable_if as condition
   */
  private resolveConditionalT(_node: SyntaxNode, context: SFINAEContext): TypeInfo {
    const cacheKey = `conditional_t:${JSON.stringify(context)}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Evaluate the condition with full SFINAE support
    const conditionMet = this.evaluateCondition(context.condition, 0);

    if (conditionMet === true) {
      this.cache.set(cacheKey, context.trueType);
      return context.trueType;
    }

    if (conditionMet === false) {
      const result = context.falseType ?? { name: 'void' };
      this.cache.set(cacheKey, result);
      return result;
    }

    // Cannot determine statically - default to trueType optimistically
    this.cache.set(cacheKey, context.trueType);
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

  // ============================================================================
  // std::void_t<Ts...> pattern support
  // ============================================================================

  /**
   * Check if node represents std::void_t<Ts...> pattern.
   * std::void_t maps any sequence of type arguments to void.
   */
  isVoidTPattern(node: SyntaxNode): boolean {
    const text = node.text;
    return text.includes('std::void_t') || text.includes('void_t') || /\bvoid_t\s*</.test(text);
  }

  /**
   * Resolve std::void_t<Ts...> to void type.
   * void_t always resolves to void if all template arguments are valid types.
   * In SFINAE contexts, if any argument is ill-formed, the entire expression fails.
   */
  resolveVoidT(node: SyntaxNode): TypeInfo {
    const cacheKey = `void_t:${node.text}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // void_t always maps to void when valid
    // The SFINAE failure happens at a higher level when arguments are ill-formed
    const result: TypeInfo = { name: 'void' };
    this.cache.set(cacheKey, result);
    return result;
  }

  // ============================================================================
  // std::is_*<T>::value type trait support
  // ============================================================================

  /** Known C++ type traits with their evaluation logic hints */
  private static readonly TYPE_TRAITS: Set<string> = new Set([
    'is_integral',
    'is_floating_point',
    'is_arithmetic',
    'is_pointer',
    'is_reference',
    'is_lvalue_reference',
    'is_rvalue_reference',
    'is_array',
    'is_class',
    'is_struct',
    'is_enum',
    'is_union',
    'is_void',
    'is_null_pointer',
    'is_same',
    'is_convertible',
    'is_assignable',
    'is_constructible',
    'is_trivially_constructible',
    'is_trivially_assignable',
    'is_copy_constructible',
    'is_move_constructible',
    'is_copy_assignable',
    'is_move_assignable',
    'is_destructible',
    'is_trivially_destructible',
    'is_const',
    'is_volatile',
    'is_signed',
    'is_unsigned',
    'is_fundamental',
    'is_compound',
    'is_scalar',
    'is_object',
    'is_function',
    'is_member_pointer',
    'is_member_function_pointer',
    'is_member_object_pointer',
    'is_abstract',
    'is_polymorphic',
    'is_final',
    'is_empty',
    'has_virtual_destructor',
    'is_default_constructible',
    'is_nothrow_constructible',
    'is_nothrow_assignable',
    'is_nothrow_destructible',
    'is_trivial',
    'is_trivially_copyable',
    'is_standard_layout',
    'is_pod',
    'is_literal_type',
  ]);

  /**
   * Check if node represents std::is_*<T>::value pattern.
   * Examples: std::is_integral<int>::value, std::is_pointer<T*>::value
   */
  isTypeTraitPattern(node: SyntaxNode): boolean {
    const text = node.text;

    // Check for common patterns:
    // 1. std::is_integral<T>::value
    // 2. is_integral<T>::value
    // 3. std::is_same<T, U>::value
    const traitMatch = text.match(/(?:std::)?is_(\w+)\s*</);
    if (traitMatch && TemplateInferenceEngine.TYPE_TRAITS.has(`is_${traitMatch[1]}`)) {
      return true;
    }

    // Check for has_* traits
    const hasMatch = text.match(/(?:std::)?has_(\w+)\s*</);
    if (hasMatch) {
      return true;
    }

    // Check for ::value suffix indicating type trait evaluation
    if (text.includes('::value')) {
      // Could be a custom type trait
      return true;
    }

    return false;
  }

  /**
   * Resolve type trait to a boolean TypeInfo.
   * Returns { name: 'bool', isBool: true, boolValue: true/false }
   */
  resolveTypeTrait(node: SyntaxNode): TypeInfo {
    const cacheKey = `trait:${node.text}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const text = node.text;

    // Extract trait name and arguments
    const traitMatch = text.match(/(?:std::)?(is_\w+|has_\w+)\s*<([^>]+)>/);
    if (!traitMatch) {
      // Not a recognizable trait pattern
      const result: TypeInfo = { name: 'bool', isBool: true };
      this.cache.set(cacheKey, result);
      return result;
    }

    const traitName = traitMatch[1];
    const args = traitMatch[2].split(',').map((s) => s.trim());

    // Evaluate the trait based on the argument types
    const boolValue = this.evaluateTypeTrait(traitName, args);

    const result: TypeInfo = {
      name: 'bool',
      isBool: true,
      boolValue,
    };
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Evaluate a type trait given its name and arguments.
   * Returns a boolean indicating if the trait holds true.
   * Uses static analysis heuristics for common cases.
   */
  private evaluateTypeTrait(traitName: string, args: string[]): boolean {
    if (args.length === 0) return false;

    const arg = args[0];

    switch (traitName) {
      case 'is_integral':
        return this.isIntegralType(arg);

      case 'is_floating_point':
        return this.isFloatingPointType(arg);

      case 'is_arithmetic':
        return this.isIntegralType(arg) || this.isFloatingPointType(arg);

      case 'is_pointer':
        return arg.includes('*') || arg.includes('^'); // C++ pointer or C++/CLI handle

      case 'is_reference':
        return arg.includes('&') || arg.includes('&&');

      case 'is_lvalue_reference':
        return arg.includes('&') && !arg.includes('&&');

      case 'is_rvalue_reference':
        return arg.includes('&&');

      case 'is_array':
        return /\[\d*\]/.test(arg) || /std::array/.test(arg);

      case 'is_void':
        return arg === 'void';

      case 'is_const':
        return arg.startsWith('const ') || /\bconst\b/.test(arg);

      case 'is_volatile':
        return /\bvolatile\b/.test(arg);

      case 'is_signed':
        return this.isSignedType(arg);

      case 'is_unsigned':
        return this.isUnsignedType(arg);

      case 'is_same':
        // is_same<T, U> - check if both args are equal
        return args.length >= 2 && args[0] === args[1];

      case 'is_convertible':
        // Heuristic: assume convertible if not obviously incompatible
        return args.length >= 2 && this.mayBeConvertible(args[0], args[1]);

      case 'is_class':
      case 'is_struct':
        // Heuristic: assume user-defined types starting with uppercase or common patterns are classes
        return /^[A-Z]/.test(arg) && !this.isBuiltinType(arg);

      case 'is_enum':
        return /enum\s+/.test(arg);

      case 'is_null_pointer':
        return arg === 'nullptr_t' || arg === 'decltype(nullptr)';

      case 'is_function':
        // Function type would have parentheses in type
        return /\(\)/.test(arg) || /\(\*\)/.test(arg);

      case 'is_scalar':
        return (
          this.isBuiltinType(arg) || arg.includes('*') || arg === 'nullptr_t' || /enum\s+/.test(arg)
        );

      case 'is_fundamental':
        return this.isBuiltinType(arg);

      default:
        // For unknown traits, return undefined boolean value
        // This allows callers to handle unknown traits explicitly
        return false;
    }
  }

  /** Check if type is a known integral type */
  private isIntegralType(type: string): boolean {
    const integralTypes = new Set([
      'int',
      'short',
      'long',
      'long long',
      'char',
      'signed char',
      'unsigned char',
      'unsigned int',
      'unsigned short',
      'unsigned long',
      'unsigned long long',
      'wchar_t',
      'char8_t',
      'char16_t',
      'char32_t',
      'int8_t',
      'int16_t',
      'int32_t',
      'int64_t',
      'uint8_t',
      'uint16_t',
      'uint32_t',
      'uint64_t',
      'size_t',
      'ptrdiff_t',
      'intptr_t',
      'uintptr_t',
    ]);
    return integralTypes.has(type.replace(/const\s*/g, '').trim());
  }

  /** Check if type is a known floating-point type */
  private isFloatingPointType(type: string): boolean {
    const floatTypes = new Set(['float', 'double', 'long double']);
    return floatTypes.has(type.replace(/const\s*/g, '').trim());
  }

  /** Check if type is a signed integral type */
  private isSignedType(type: string): boolean {
    const signedTypes = new Set([
      'int',
      'short',
      'long',
      'long long',
      'signed char',
      'char8_t',
      'char16_t',
      'char32_t',
      'wchar_t',
      'int8_t',
      'int16_t',
      'int32_t',
      'int64_t',
      'ptrdiff_t',
      'intptr_t',
    ]);
    const cleanType = type.replace(/const\s*/g, '').trim();
    return (
      signedTypes.has(cleanType) ||
      (cleanType.startsWith('signed ') && !cleanType.includes('unsigned'))
    );
  }

  /** Check if type is an unsigned integral type */
  private isUnsignedType(type: string): boolean {
    const cleanType = type.replace(/const\s*/g, '').trim();
    return (
      cleanType.startsWith('unsigned ') ||
      cleanType === 'size_t' ||
      cleanType === 'uintptr_t' ||
      cleanType === 'uint8_t' ||
      cleanType === 'uint16_t' ||
      cleanType === 'uint32_t' ||
      cleanType === 'uint64_t'
    );
  }

  /** Check if type is a builtin/primitive type */
  private isBuiltinType(type: string): boolean {
    const cleanType = type
      .replace(/const\s*/g, '')
      .replace(/volatile\s*/g, '')
      .trim();
    const builtins = new Set([
      'void',
      'bool',
      'char',
      'short',
      'int',
      'long',
      'float',
      'double',
      'wchar_t',
      'char8_t',
      'char16_t',
      'char32_t',
    ]);
    return (
      builtins.has(cleanType) ||
      this.isIntegralType(cleanType) ||
      this.isFloatingPointType(cleanType)
    );
  }

  /** Heuristic for type convertibility */
  private mayBeConvertible(from: string, to: string): boolean {
    // Same type is always convertible
    if (from === to) return true;

    // void is not convertible to anything
    if (from === 'void' || to === 'void') return false;

    // Pointer conversions
    if (from.includes('*') && to.includes('*')) {
      // T* to void* or T* to const T* etc.
      return true;
    }

    // Numeric conversions are generally allowed
    if (this.isIntegralType(from) && this.isIntegralType(to)) return true;
    if (this.isFloatingPointType(from) && this.isFloatingPointType(to)) return true;
    if (
      (this.isIntegralType(from) || this.isFloatingPointType(from)) &&
      (this.isIntegralType(to) || this.isFloatingPointType(to))
    )
      return true;

    return true; // Default to true for heuristics
  }

  // ============================================================================
  // Updated enable_if resolution with type trait evaluation
  // ============================================================================

  /**
   * Resolve std::enable_if<Condition, T>::type pattern.
   * Properly evaluates type trait conditions and handles nested SFINAE.
   *
   * Supports:
   * - Simple conditions: std::is_integral<T>::value
   * - Compound conditions: std::is_integral<T>::value && std::is_signed<T>::value
   * - Nested enable_if: std::enable_if<std::enable_if<C1, T>::type::value, U>
   * - falseType branch when condition is false
   */
  private resolveEnableIf(node: SyntaxNode, context: SFINAEContext): TypeInfo {
    const cacheKey = `enable_if:${node.text}:${JSON.stringify(context)}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Check for nested enable_if pattern in the condition
    if (this.isNestedEnableIf(context.condition)) {
      const result = this.resolveNestedEnableIf(context, 0);
      this.cache.set(cacheKey, result);
      return result;
    }

    // Evaluate the condition with full SFINAE support
    const conditionMet = this.evaluateCondition(context.condition, 0);

    // When condition is explicitly false, return falseType or undefined marker
    if (conditionMet === false) {
      // Return falseType if available, otherwise return a SFINAE-failure marker
      const result = context.falseType ?? { name: '__sfinae_failure__', isSpecial: true };
      this.cache.set(cacheKey, result);
      return result;
    }

    // When condition is explicitly true, return trueType
    if (conditionMet === true) {
      this.cache.set(cacheKey, context.trueType);
      return context.trueType;
    }

    // Cannot determine statically - return trueType optimistically
    // This is the safe default for SFINAE: assume the condition holds
    this.cache.set(cacheKey, context.trueType);
    return context.trueType;
  }

  /**
   * Check if condition contains nested enable_if pattern.
   */
  private isNestedEnableIf(condition: TypeInfo): boolean {
    const name = condition.name;
    // Check for nested enable_if: enable_if<enable_if<...>>
    const nestedMatch = name.match(/enable_if\s*<\s*.*enable_if\s*</);
    // Check for conditional_t with enable_if condition
    const conditionalMatch = name.match(/conditional_t\s*<\s*.*enable_if/);
    return !!(nestedMatch || conditionalMatch);
  }

  /**
   * Resolve nested enable_if pattern.
   * Handles: std::enable_if<std::enable_if<C1, T>::type::value, U>
   * And: std::conditional_t<std::enable_if<C, T>::value, A, B>
   */
  private resolveNestedEnableIf(context: SFINAEContext, depth: number): TypeInfo {
    if (depth > this.maxRecursionDepth) {
      return context.trueType;
    }

    const name = context.condition.name;

    // Handle conditional_t with enable_if condition
    const conditionalMatch = name.match(/conditional_t\s*<\s*(.+?)\s*,\s*(\w+)\s*,\s*(\w+)\s*>/);
    if (conditionalMatch) {
      const innerCondition = conditionalMatch[1];
      const trueBranch = conditionalMatch[2];
      const falseBranch = conditionalMatch[3];

      // Check if inner condition has enable_if
      if (innerCondition.includes('enable_if')) {
        // Recursively resolve the enable_if
        const innerResult = this.evaluateCondition({ name: innerCondition }, depth + 1);
        if (innerResult === true) {
          return { name: trueBranch };
        } else if (innerResult === false) {
          return { name: falseBranch };
        }
      }
    }

    // Handle nested enable_if: enable_if<enable_if<C, T>::type::value, U>
    const nestedMatch = name.match(/enable_if\s*<\s*(.+?)\s*,\s*(\w+)\s*>/);
    if (nestedMatch) {
      const innerCondition = nestedMatch[1];
      const outerType = nestedMatch[2];

      // Check if inner condition is another enable_if
      if (innerCondition.includes('enable_if')) {
        // Parse inner enable_if
        const innerMatch = innerCondition.match(/enable_if\s*<\s*(.+?)\s*,\s*(\w+)\s*>::value/);
        if (innerMatch) {
          const actualCondition = innerMatch[1];
          const truthyValue = innerMatch[2];

          // If truthyValue is std::true_type, the outer enable_if depends on actualCondition
          if (truthyValue === 'std::true_type' || truthyValue === 'true_type') {
            const innerResult = this.evaluateCondition({ name: actualCondition }, depth + 1);
            if (innerResult === true) {
              // Inner enable_if succeeds, now check outer
              return { name: outerType };
            } else if (innerResult === false) {
              // Inner enable_if fails, SFINAE failure
              return context.falseType ?? { name: '__sfinae_failure__', isSpecial: true };
            }
          }
        }
      }
    }

    // Default: evaluate the outer condition normally
    const result = this.evaluateCondition(context.condition, depth + 1);
    return result === false
      ? (context.falseType ?? { name: '__sfinae_failure__', isSpecial: true })
      : context.trueType;
  }

  /**
   * Evaluate a condition (type trait or expression) to a boolean.
   * Returns null if the condition cannot be statically determined.
   *
   * Supports:
   * - Simple boolean values (true, false, true_type, false_type)
   * - Type traits (std::is_integral<T>::value, etc.)
   * - sizeof comparisons (sizeof(T) == N, sizeof(T) > N, etc.)
   * - Logical operators (&& and ||)
   * - Negation (!)
   * - Parenthesized expressions
   * - Nested conditions
   */
  private evaluateCondition(condition: TypeInfo, depth: number = 0): boolean | null {
    // Prevent infinite recursion
    if (depth > this.maxRecursionDepth) {
      return null;
    }

    // If the TypeInfo already has a boolean value, use it
    if (condition.isBool && condition.boolValue !== undefined) {
      return condition.boolValue;
    }

    const name = condition.name;

    // Check for known true/false patterns
    if (name === 'true' || name === 'std::true_type' || name === 'true_type') {
      return true;
    }
    if (name === 'false' || name === 'std::false_type' || name === 'false_type') {
      return false;
    }

    // Handle logical AND (&&) - split on && and evaluate all parts
    if (this.containsLogicalAnd(name)) {
      return this.evaluateLogicalAnd(name, depth);
    }

    // Handle logical OR (||) - split on || and evaluate all parts
    if (this.containsLogicalOr(name)) {
      return this.evaluateLogicalOr(name, depth);
    }

    // Handle negation (!)
    if (name.startsWith('!')) {
      return this.evaluateLogicalNot(name, depth);
    }

    // Check for type trait patterns in the name
    if (/\b(is_\w+|has_\w+)\s*</.test(name)) {
      // This looks like a type trait, try to parse and evaluate
      const match = name.match(/(?:std::)?(is_\w+|has_\w+)\s*<([^>]+)>/);
      if (match) {
        const traitName = match[1];
        const args = match[2].split(',').map((s) => s.trim());
        return this.evaluateTypeTrait(traitName, args);
      }
    }

    // Check for comparison expressions (sizeof, etc.)
    const sizeofMatch = name.match(/sizeof\s*\(\s*(\w+)\s*\)\s*(==|!=|>=|<=|>|<)\s*(\d+)/);
    if (sizeofMatch) {
      const sizeExpr = this.evaluateSizeof(sizeofMatch[1]);
      const op = sizeofMatch[2];
      const value = parseInt(sizeofMatch[3], 10);
      return this.compareValues(sizeExpr, op, value);
    }

    // Handle more complex sizeof expressions like sizeof(T) == sizeof(U)
    const sizeofCompareMatch = name.match(
      /sizeof\s*\(\s*(\w+)\s*\)\s*(==|!=|>=|<=|>|<)\s*sizeof\s*\(\s*(\w+)\s*\)/,
    );
    if (sizeofCompareMatch) {
      const size1 = this.evaluateSizeof(sizeofCompareMatch[1]);
      const op = sizeofCompareMatch[2];
      const size2 = this.evaluateSizeof(sizeofCompareMatch[3]);
      return this.compareValues(size1, op, size2);
    }

    // Handle parentheses - extract inner expression
    const parenMatch = name.match(/\(([^()]+)\)/);
    if (parenMatch && parenMatch[1] !== name) {
      return this.evaluateCondition({ name: parenMatch[1].trim() }, depth + 1);
    }

    // Cannot determine statically
    return null;
  }

  /**
   * Check if expression contains logical AND operator (not nested).
   */
  private containsLogicalAnd(expr: string): boolean {
    // Simple check - splitLogicalExpression handles nesting properly
    return expr.includes('&&');
  }

  /**
   * Check if expression contains logical OR operator (not nested).
   */
  private containsLogicalOr(expr: string): boolean {
    // Simple check - splitLogicalExpression handles nesting properly
    return expr.includes('||');
  }

  /**
   * Evaluate logical AND expression (condition1 && condition2 && ...)
   * Returns true only if ALL conditions are true.
   * Returns false if ANY condition is false.
   * Returns null if any condition cannot be determined.
   */
  private evaluateLogicalAnd(expr: string, depth: number): boolean | null {
    // Split on && while respecting nesting (parentheses, angle brackets)
    const parts = this.splitLogicalExpression(expr, '&&');

    let hasNull = false;
    for (const part of parts) {
      const result = this.evaluateCondition({ name: part.trim() }, depth + 1);
      if (result === false) {
        // Short-circuit: any false makes the whole AND false
        return false;
      }
      if (result === null) {
        hasNull = true;
      }
    }

    // If all parts are true, return true
    // If any part is null (undetermined), return null
    return hasNull ? null : true;
  }

  /**
   * Evaluate logical OR expression (condition1 || condition2 || ...)
   * Returns true if ANY condition is true.
   * Returns false only if ALL conditions are false.
   * Returns null if no condition is true and some cannot be determined.
   */
  private evaluateLogicalOr(expr: string, depth: number): boolean | null {
    // Split on || while respecting nesting
    const parts = this.splitLogicalExpression(expr, '||');

    let hasNull = false;
    for (const part of parts) {
      const result = this.evaluateCondition({ name: part.trim() }, depth + 1);
      if (result === true) {
        // Short-circuit: any true makes the whole OR true
        return true;
      }
      if (result === null) {
        hasNull = true;
      }
    }

    // If all parts are false, return false
    // If no part is true and some are null, return null
    return hasNull ? null : false;
  }

  /**
   * Evaluate logical NOT expression (!condition)
   */
  private evaluateLogicalNot(expr: string, depth: number): boolean | null {
    // Remove the ! prefix
    const inner = expr.substring(1).trim();

    // Handle !! (double negation)
    if (inner.startsWith('!')) {
      // Double negation: !!x is equivalent to x
      return this.evaluateCondition({ name: inner.substring(1).trim() }, depth + 1);
    }

    const result = this.evaluateCondition({ name: inner }, depth + 1);
    if (result === null) return null;
    return !result;
  }

  /**
   * Split a logical expression while respecting nesting (parentheses, angle brackets).
   * Handles cases like: (a && b) || c, std::is_same<T, U>::value && sizeof(T) > 4
   */
  private splitLogicalExpression(expr: string, operator: '&&' | '||'): string[] {
    const parts: string[] = [];
    let current = '';
    let parenDepth = 0;
    let angleDepth = 0;
    let i = 0;

    while (i < expr.length) {
      const char = expr[i];
      const twoChars = expr.substring(i, i + 2);

      // Track nesting
      if (char === '(') parenDepth++;
      if (char === ')') parenDepth--;
      if (char === '<') angleDepth++;
      if (char === '>') angleDepth--;

      // Only split when not nested
      if (parenDepth === 0 && angleDepth === 0 && twoChars === operator) {
        parts.push(current.trim());
        current = '';
        i += 2; // Skip the operator
        continue;
      }

      current += char;
      i++;
    }

    // Add the last part
    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts;
  }

  /**
   * Evaluate sizeof expression heuristically.
   * Returns a size hint based on common type sizes.
   */
  private evaluateSizeof(type: string): number {
    const sizeHints: Record<string, number> = {
      char: 1,
      'signed char': 1,
      'unsigned char': 1,
      char8_t: 1,
      short: 2,
      'unsigned short': 2,
      int: 4,
      'unsigned int': 4,
      float: 4,
      long: 8, // On 64-bit systems
      'unsigned long': 8,
      'long long': 8,
      'unsigned long long': 8,
      double: 8,
      'long double': 16,
      pointer: 8, // 64-bit systems
    };

    // Check for pointer types
    if (type.includes('*') || type.includes('^')) {
      return 8; // Assume 64-bit pointers
    }

    return sizeHints[type] ?? 0; // Unknown size
  }

  /**
   * Compare values with a relational operator.
   */
  private compareValues(left: number, op: string, right: number): boolean {
    switch (op) {
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      case '>=':
        return left >= right;
      case '<=':
        return left <= right;
      case '>':
        return left > right;
      case '<':
        return left < right;
      default:
        return false;
    }
  }
}
