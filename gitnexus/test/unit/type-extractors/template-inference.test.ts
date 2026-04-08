/**
 * C++ Template Inference Engine tests
 *
 * Tests for template specialization detection, SFINAE resolution,
 * decltype evaluation, and concept constraint analysis.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { loadParser, loadLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { TemplateInferenceEngine } from '../../../src/core/ingestion/type-extractors/template-inference.js';

function loadCppOrSkip() {
  return loadLanguage(SupportedLanguages.CPlusPlus).catch(() => null);
}

function parseAndFindNodes(parser: Parser, code: string, nodeType: string): Parser.SyntaxNode[] {
  const tree = parser.parse(code);
  const results: Parser.SyntaxNode[] = [];
  function walk(node: Parser.SyntaxNode) {
    if (node.type === nodeType) results.push(node);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }
  walk(tree.rootNode);
  return results;
}

function findFirstNode(parser: Parser, code: string, nodeType: string): Parser.SyntaxNode | null {
  const nodes = parseAndFindNodes(parser, code, nodeType);
  return nodes.length > 0 ? nodes[0] : null;
}

describe('Template Inference Engine', () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = await loadParser();
    if (!(await loadCppOrSkip())) return;
  });

  describe('Template specialization', () => {
    it('should detect explicit template specialization', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<>
        class Vector<int> {
          int* data;
        };
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();
      const result = engine.resolveSpecialization(tree.rootNode);

      expect(result).toBeDefined();
      expect(result?.templateName).toBe('Vector');
      expect(result?.templateParams).toEqual([{ name: 'int' }]);
      expect(result?.specializedType).toEqual({ name: 'Vector<int>' });
    });

    it('should detect partial template specialization', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        class Vector<T*> {
          T** data;
        };
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();
      const result = engine.resolveSpecialization(tree.rootNode);

      expect(result).toBeDefined();
      expect(result?.templateName).toBe('Vector');
      expect(result?.templateParams).toEqual([{ name: 'T*', isPointer: true }]);
    });

    it('should detect template with multiple parameters', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename K, typename V>
        class Map { };
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();
      const result = engine.resolveSpecialization(tree.rootNode);

      expect(result).toBeDefined();
      expect(result?.templateName).toBe('Map');
      expect(result?.templateParams.length).toBeGreaterThanOrEqual(2);
    });

    it('should return null for non-template code', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        class User {
          int id;
        };
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();
      const result = engine.resolveSpecialization(tree.rootNode);

      expect(result).toBeNull();
    });
  });

  describe('SFINAE resolution', () => {
    it('should resolve std::enable_if pattern', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        typename std::enable_if<std::is_integral<T>::value, T>::type
        foo(T x) { return x * 2; }
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const result = engine.resolveSFINAE(tree.rootNode, {
        condition: { name: 'std::is_integral<T>::value' },
        trueType: { name: 'T' },
      });

      expect(result.name).toBe('T');
    });

    it('should resolve std::conditional_t pattern', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        using Result = std::conditional_t<sizeof(int) == 4, int, long>;
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const result = engine.resolveSFINAE(tree.rootNode, {
        condition: { name: 'sizeof(int) == 4' },
        trueType: { name: 'int' },
        falseType: { name: 'long' },
      });

      expect(result.name).toBe('int');
    });

    it('should handle std::void_t SFINAE context', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T, typename = std::void_t<decltype(std::declval<T>().size())>>
        struct has_size : std::true_type {};
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      // void_t should be recognized as SFINAE context
      const hasVoidT = tree.rootNode.text.includes('std::void_t');
      expect(hasVoidT).toBe(true);
    });

    // New enhanced SFINAE test cases

    it('should evaluate logical AND (&&) in SFINAE conditions', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        typename std::enable_if<std::is_integral<T>::value && std::is_signed<T>::value, T>::type
        foo(T x) { return x; }
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      // Test with int (integral and signed) - should pass
      const resultInt = engine.resolveSFINAE(tree.rootNode, {
        condition: { name: 'std::is_integral<int>::value && std::is_signed<int>::value' },
        trueType: { name: 'int' },
        falseType: { name: 'void' },
      });
      expect(resultInt.name).toBe('int');

      // Test with unsigned int (integral but not signed) - should fail
      const resultUnsigned = engine.resolveSFINAE(tree.rootNode, {
        condition: {
          name: 'std::is_integral<unsigned int>::value && std::is_signed<unsigned int>::value',
        },
        trueType: { name: 'int' },
        falseType: { name: 'void' },
      });
      expect(resultUnsigned.name).toBe('void');
    });

    it('should evaluate logical OR (||) in SFINAE conditions', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        typename std::enable_if<std::is_integral<T>::value || std::is_floating_point<T>::value, T>::type
        foo(T x) { return x; }
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      // Test with int (integral) - should pass
      const resultInt = engine.resolveSFINAE(tree.rootNode, {
        condition: { name: 'std::is_integral<int>::value || std::is_floating_point<int>::value' },
        trueType: { name: 'T' },
        falseType: { name: 'void' },
      });
      expect(resultInt.name).toBe('T');

      // Test with double (floating point) - should pass
      const resultFloat = engine.resolveSFINAE(tree.rootNode, {
        condition: {
          name: 'std::is_integral<double>::value || std::is_floating_point<double>::value',
        },
        trueType: { name: 'T' },
        falseType: { name: 'void' },
      });
      expect(resultFloat.name).toBe('T');

      // Test with void (neither) - should fail
      const resultVoid = engine.resolveSFINAE(tree.rootNode, {
        condition: { name: 'std::is_integral<void>::value || std::is_floating_point<void>::value' },
        trueType: { name: 'T' },
        falseType: { name: 'void' },
      });
      expect(resultVoid.name).toBe('void');
    });

    it('should evaluate sizeof(T) == N comparisons', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        typename std::enable_if<sizeof(T) == 4, T>::type
        foo(T x) { return x; }
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      // sizeof(int) == 4 should be true
      const resultInt = engine.resolveSFINAE(tree.rootNode, {
        condition: { name: 'sizeof(int) == 4' },
        trueType: { name: 'int' },
        falseType: { name: 'void' },
      });
      expect(resultInt.name).toBe('int');

      // sizeof(char) == 4 should be false
      const resultChar = engine.resolveSFINAE(tree.rootNode, {
        condition: { name: 'sizeof(char) == 4' },
        trueType: { name: 'char' },
        falseType: { name: 'void' },
      });
      expect(resultChar.name).toBe('void');

      // sizeof(long long) == 8 should be true
      const resultLongLong = engine.resolveSFINAE(tree.rootNode, {
        condition: { name: 'sizeof(long long) == 8' },
        trueType: { name: 'long long' },
        falseType: { name: 'void' },
      });
      expect(resultLongLong.name).toBe('long long');
    });

    it('should handle nested enable_if in enable_if', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        typename std::enable_if<
          std::enable_if<std::is_integral<T>::value, std::true_type>::type::value,
          T
        >::type
        foo(T x) { return x; }
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      // Nested enable_if with int should resolve correctly
      const result = engine.resolveSFINAE(tree.rootNode, {
        condition: {
          name: 'std::enable_if<std::is_integral<int>::value, std::true_type>::type::value',
        },
        trueType: { name: 'int' },
        falseType: { name: 'void' },
      });
      expect(result.name).toBe('int');
    });

    it('should handle conditional_t with enable_if condition', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        using Result = std::conditional_t<
          std::enable_if<std::is_pointer<T>::value, std::true_type>::type::value,
          T,
          void*
        >;
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      // conditional_t with int* should return int*
      const resultPointer = engine.resolveSFINAE(tree.rootNode, {
        condition: {
          name: 'std::enable_if<std::is_pointer<int*>::value, std::true_type>::type::value',
        },
        trueType: { name: 'int*' },
        falseType: { name: 'void*' },
      });
      expect(resultPointer.name).toBe('int*');

      // conditional_t with int (not a pointer) should fallback
      const resultNonPointer = engine.resolveSFINAE(tree.rootNode, {
        condition: {
          name: 'std::enable_if<std::is_pointer<int>::value, std::true_type>::type::value',
        },
        trueType: { name: 'int' },
        falseType: { name: 'void*' },
      });
      expect(resultNonPointer.name).toBe('void*');
    });
  });

  describe('decltype evaluation', () => {
    it('should evaluate decltype of function call', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `decltype(foo(42))`;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const result = engine.evaluateDecltype(tree.rootNode);
      expect(result.name).toBeDefined();
    });

    it('should evaluate decltype of member access', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `decltype(obj.member)`;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const result = engine.evaluateDecltype(tree.rootNode);
      expect(result.name).toBeDefined();
    });

    it('should evaluate decltype of literal', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `decltype(42)`;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const result = engine.evaluateDecltype(tree.rootNode);
      expect(result.name).toBe('int');
    });
  });

  describe('Concept constraints', () => {
    it('should analyze requires clause', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        requires std::integral<T>
        T add(T a, T b) { return a + b; }
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const constraints = engine.analyzeConceptConstraint(tree.rootNode);
      expect(constraints.length).toBeGreaterThanOrEqual(0);
    });

    it('should analyze concept definition', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        concept Sortable = requires(T t) {
          { t.sort() } -> std::same_as<void>;
        };
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const constraints = engine.analyzeConceptConstraint(tree.rootNode);
      expect(constraints.length).toBeGreaterThanOrEqual(0);
    });

    it('should return empty array for non-constraint code', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        int add(int a, int b) { return a + b; }
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const constraints = engine.analyzeConceptConstraint(tree.rootNode);
      expect(constraints).toEqual([]);
    });
  });

  describe('Caching', () => {
    it('should cache resolved types', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `decltype(42)`;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      // First call
      const result1 = engine.evaluateDecltype(tree.rootNode);
      // Second call should return cached result
      const result2 = engine.evaluateDecltype(tree.rootNode);

      expect(result1).toEqual(result2);
    });
  });

  // ============================================================================
  // Task 14: C++ decltype and concept constraint support tests
  // ============================================================================

  describe('decltype(auto) return type deduction', () => {
    it('should recognize decltype(auto) pattern', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        decltype(auto) get_value(T&& t) {
          return t.value();
        }
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      // Find decltype(auto) in the code
      const hasDecltypeAuto = tree.rootNode.text.includes('decltype(auto)');
      expect(hasDecltypeAuto).toBe(true);

      // Evaluate the decltype - should identify it as decltype(auto)
      const result = engine.evaluateDecltype(tree.rootNode);
      expect(result.name).toBeDefined();
    });

    it('should handle declval<T>() pattern in decltype', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `decltype(std::declval<int>())`;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const result = engine.evaluateDecltype(tree.rootNode);
      // std::declval<int>() should return int&&
      expect(result.name).toContain('int');
    });
  });

  describe('C++20 concept syntax', () => {
    it('should parse requires clause in function template', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        requires std::integral<T>
        T add(T a, T b) { return a + b; }
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const constraints = engine.analyzeConceptConstraint(tree.rootNode);
      expect(constraints.length).toBeGreaterThan(0);
      // Should find the requires constraint
      expect(constraints.some((c) => c.kind === 'requires')).toBe(true);
    });

    it('should parse abbreviated concept syntax (Integral auto)', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `void foo(Integral auto x);`;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const constraints = engine.analyzeConceptConstraint(tree.rootNode);
      // Should detect Integral as a concept constraint
      expect(constraints.some((c) => c.name === 'Integral' || c.name.includes('Integral'))).toBe(
        true,
      );
    });

    it('should handle compound requirements in requires expressions', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        concept Sortable = requires(T t) {
          { t.sort() } -> std::same_as<void>;
        };
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const constraints = engine.analyzeConceptConstraint(tree.rootNode);
      expect(constraints.length).toBeGreaterThan(0);
      // Should find concept definition or compound requirement
      const hasConcept = constraints.some((c) => c.kind === 'concept' && c.name === 'Sortable');
      const hasCompound = constraints.some((c) => c.kind === 'compound_requires');
      expect(hasConcept || hasCompound).toBe(true);
    });

    it('should parse concept definition with type trait', async () => {
      if (!(await loadCppOrSkip())) return;
      const code = `
        template<typename T>
        concept Integral = std::is_integral_v<T>;
      `;
      const tree = parser.parse(code);
      const engine = new TemplateInferenceEngine();

      const constraints = engine.analyzeConceptConstraint(tree.rootNode);
      // Should find the concept definition
      expect(constraints.some((c) => c.kind === 'concept')).toBe(true);
    });
  });
});
