import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import {
  loadParser,
  loadLanguage,
  isLanguageAvailable,
} from '../../../src/core/tree-sitter/parser-loader.js';
import {
  extractObjCMethodReturnType,
  synthesizePropertyAccessors,
  type ObjCMethodContext,
} from '../../../src/core/ingestion/type-extractors/objective-c.js';

const objcAvailable = isLanguageAvailable(SupportedLanguages.ObjectiveC);

function parseAndFindNodes(parser: Parser, code: string, nodeType: string) {
  const tree = parser.parse(code);
  if (!tree) return [];
  const results: any[] = [];
  function walk(node: any) {
    if (node.type === nodeType) results.push(node);
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
  }
  walk(tree.rootNode);
  return results;
}

/**
 * Find the enclosing class name from a method node by walking up to the
 * class_interface or class_implementation container.
 */
function findEnclosingClassName(node: any): string | undefined {
  let current: any = node.parent;
  while (current) {
    if (
      current.type === 'class_interface' ||
      current.type === 'class_implementation' ||
      current.type === 'category_interface' ||
      current.type === 'category_implementation' ||
      current.type === 'protocol_declaration'
    ) {
      // The class name is the first identifier child
      for (let i = 0; i < current.namedChildCount; i++) {
        const child = current.namedChild(i);
        if (child?.type === 'identifier') return child.text;
      }
    }
    current = current.parent;
  }
  return undefined;
}

describe.skipIf(!objcAvailable)('Objective-C type extractor', () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = await loadParser();
    // loadLanguage returns void, but sets language on the global parser
    await loadLanguage(SupportedLanguages.ObjectiveC);
  });

  describe('instancetype inference', () => {
    it('should infer instancetype as the current class for instance methods', async () => {
      const code = `
        @interface User
        - (instancetype)initWithName:(NSString *)name;
        @end
      `;
      const nodes = parseAndFindNodes(parser, code, 'method_declaration');
      expect(nodes.length).toBeGreaterThan(0);

      const methodNode = nodes[0];
      const enclosingClass = findEnclosingClassName(methodNode);
      expect(enclosingClass).toBe('User');

      const context: ObjCMethodContext = { enclosingClass };
      const result = extractObjCMethodReturnType(methodNode, context);
      expect(result).toEqual({ name: 'User', isPointer: true });
    });

    it('should infer instancetype as the current class for class methods', async () => {
      const code = `
        @interface User
        + (instancetype)userWithName:(NSString *)name;
        @end
      `;
      const nodes = parseAndFindNodes(parser, code, 'method_declaration');
      expect(nodes.length).toBeGreaterThan(0);

      const methodNode = nodes[0];
      const enclosingClass = findEnclosingClassName(methodNode);
      expect(enclosingClass).toBe('User');

      const context: ObjCMethodContext = { enclosingClass };
      const result = extractObjCMethodReturnType(methodNode, context);
      expect(result).toEqual({ name: 'User', isPointer: true });
    });

    it('should return instancetype literal when no enclosing class context', async () => {
      // Note: ObjC requires methods to be inside a class/interface
      // For this test, we use a minimal class wrapper but don't pass enclosingClass
      const code = `
        @interface Dummy
        - (instancetype)foo;
        @end
      `;
      const nodes = parseAndFindNodes(parser, code, 'method_declaration');
      expect(nodes.length).toBeGreaterThan(0);

      const methodNode = nodes[0];
      const context: ObjCMethodContext = {}; // No enclosing class
      const result = extractObjCMethodReturnType(methodNode, context);
      expect(result).toEqual({ name: 'instancetype', isSpecial: true });
    });

    it('should handle explicit return types (not instancetype)', async () => {
      const code = `
        @interface Service
        - (NSString *)getName;
        - (void)doSomething;
        @end
      `;
      const nodes = parseAndFindNodes(parser, code, 'method_declaration');
      expect(nodes.length).toBeGreaterThanOrEqual(2);

      const context: ObjCMethodContext = { enclosingClass: 'Service' };

      // NSString * return type
      const nsstringResult = extractObjCMethodReturnType(nodes[0], context);
      expect(nsstringResult?.name).toBe('NSString');
      expect(nsstringResult?.isPointer).toBe(true);

      // void return type
      const voidResult = extractObjCMethodReturnType(nodes[1], context);
      expect(voidResult?.name).toBe('void');
    });
  });

  describe('property synthesis', () => {
    // Helper to parse property and return the translation_unit root
    function parsePropertyCode(code: string) {
      const tree = parser.parse(code);
      return tree?.rootNode ?? null;
    }

    it('should synthesize getter and setter for readwrite property', async () => {
      const code = `@property (nonatomic, strong) NSString *name;`;
      const rootNode = parsePropertyCode(code);
      expect(rootNode).not.toBeNull();
      const result = synthesizePropertyAccessors(rootNode!);
      expect(result).toEqual({
        getter: { selector: 'name', returnType: { name: 'NSString', isPointer: true } },
        setter: {
          selector: 'setName:',
          returnType: { name: 'void' },
          paramType: { name: 'NSString', isPointer: true },
        },
      });
    });

    it('should synthesize only getter for readonly property', async () => {
      const code = `@property (nonatomic, readonly) NSInteger age;`;
      const rootNode = parsePropertyCode(code);
      expect(rootNode).not.toBeNull();
      const result = synthesizePropertyAccessors(rootNode!);
      expect(result).toEqual({
        getter: { selector: 'age', returnType: { name: 'NSInteger', isPointer: false } },
        setter: null,
      });
    });

    it('should handle custom getter attribute', async () => {
      const code = `@property (nonatomic, getter=isHidden) BOOL hidden;`;
      const rootNode = parsePropertyCode(code);
      expect(rootNode).not.toBeNull();
      const result = synthesizePropertyAccessors(rootNode!);
      expect(result.getter.selector).toBe('isHidden');
    });

    it('should handle custom setter attribute', async () => {
      const code = `@property (nonatomic, setter=setHiddenFlag:) BOOL hidden;`;
      const rootNode = parsePropertyCode(code);
      expect(rootNode).not.toBeNull();
      const result = synthesizePropertyAccessors(rootNode!);
      expect(result.setter?.selector).toBe('setHiddenFlag:');
    });

    it('should handle property without attributes', async () => {
      const code = `@property NSString *title;`;
      const rootNode = parsePropertyCode(code);
      expect(rootNode).not.toBeNull();
      const result = synthesizePropertyAccessors(rootNode!);
      expect(result.getter.selector).toBe('title');
      expect(result.setter?.selector).toBe('setTitle:');
    });

    it('should handle primitive type property', async () => {
      const code = `@property (assign) NSInteger count;`;
      const rootNode = parsePropertyCode(code);
      expect(rootNode).not.toBeNull();
      const result = synthesizePropertyAccessors(rootNode!);
      expect(result.getter.returnType.name).toBe('NSInteger');
      expect(result.getter.returnType.isPointer).toBe(false);
    });

    it('should handle id type property', async () => {
      const code = `@property (nonatomic) id delegate;`;
      const rootNode = parsePropertyCode(code);
      expect(rootNode).not.toBeNull();
      const result = synthesizePropertyAccessors(rootNode!);
      expect(result.getter.returnType.name).toBe('id');
    });
  });
});
