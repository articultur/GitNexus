/**
 * Tests for extractObjCNamedBindings
 *
 * Requires tree-sitter-objc (via tree-sitter-c). Tests are skipped if the parser is unavailable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import {
  loadParser,
  loadLanguage,
  isLanguageAvailable,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { extractObjCNamedBindings } from '../../../src/core/ingestion/named-bindings/objective-c.js';
import type {
  ObjCCategoryBinding,
  ObjCProtocolBinding,
  ObjCMethodSignature,
} from '../../../src/core/ingestion/named-bindings/types.js';

const objcAvailable = isLanguageAvailable(SupportedLanguages.ObjectiveC);

function parseAndFindNodes(parser: Parser, code: string, nodeType: string): any[] {
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

function parseAndFindCategory(parser: Parser, code: string): any | undefined {
  // Category uses class_interface with a category child
  const categoryNodes = parseAndFindNodes(parser, code, 'class_interface');
  // Filter to find ones with category child
  for (const node of categoryNodes) {
    const hasCategory = node.children?.some((c: any) => c.type === 'category');
    if (hasCategory) return node;
  }
  return categoryNodes[0];
}

function parseAndFindProtocol(parser: Parser, code: string): any | undefined {
  const protocolNodes = parseAndFindNodes(parser, code, 'protocol_declaration');
  return protocolNodes[0];
}

describe('Objective-C named binding types', () => {
  it('should define ObjCCategoryBinding type', () => {
    const binding: ObjCCategoryBinding = {
      type: 'objc-category',
      local: 'URLExtensions',
      exported: 'URLExtensions',
      className: 'NSString',
      categoryName: 'URLExtensions',
      methods: [],
      properties: [],
    };
    expect(binding.type).toBe('objc-category');
  });

  it('should define ObjCProtocolBinding type', () => {
    const binding: ObjCProtocolBinding = {
      type: 'objc-protocol',
      local: 'UITableViewDataSource',
      exported: 'UITableViewDataSource',
      protocolName: 'UITableViewDataSource',
      requiredMethods: [],
      optionalMethods: [],
      properties: [],
    };
    expect(binding.type).toBe('objc-protocol');
  });

  it('should define ObjCMethodSignature type', () => {
    const sig: ObjCMethodSignature = {
      selector: 'tableView:numberOfRowsInSection:',
      returnType: { name: 'NSInteger' },
      parameters: [
        { name: 'tableView', type: { name: 'UITableView', isPointer: true } },
        { name: 'section', type: { name: 'NSInteger' } },
      ],
      isClassMethod: false,
    };
    expect(sig.selector).toBe('tableView:numberOfRowsInSection:');
  });
});

// ============================================================================
// Task 10: Category Binding Extraction Tests
// ============================================================================

describe.skipIf(!objcAvailable)('extractObjCNamedBindings - Category extraction', () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = await loadParser();
    await loadLanguage(SupportedLanguages.ObjectiveC);
  });

  it('extracts category with class name and category name', () => {
    const code = `
      @interface NSString (URLExtensions)
      @end
    `;
    const node = parseAndFindCategory(parser, code);
    expect(node).toBeDefined();
    if (!node) return;

    const result = extractObjCNamedBindings(node);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);

    const binding = result![0] as ObjCCategoryBinding;
    expect(binding.type).toBe('objc-category');
    expect(binding.className).toBe('NSString');
    expect(binding.categoryName).toBe('URLExtensions');
  });

  it('extracts category with instance methods', () => {
    const code = `
      @interface NSString (URLExtensions)
      - (BOOL)isValidURL;
      - (NSURL *)toURL;
      @end
    `;
    const node = parseAndFindCategory(parser, code);
    if (!node) return;

    const result = extractObjCNamedBindings(node);
    expect(result).toBeDefined();

    const binding = result![0] as ObjCCategoryBinding;
    expect(binding.methods).toHaveLength(2);

    // First method: isValidURL
    expect(binding.methods[0].selector).toBe('isValidURL');
    expect(binding.methods[0].returnType.name).toBe('BOOL');
    expect(binding.methods[0].isClassMethod).toBe(false);

    // Second method: toURL
    expect(binding.methods[1].selector).toBe('toURL');
    expect(binding.methods[1].returnType.name).toBe('NSURL');
    expect(binding.methods[1].returnType.isPointer).toBe(true);
  });

  it('extracts category with class methods', () => {
    const code = `
      @interface NSArray (Extensions)
      + (NSArray *)emptyArray;
      + (instancetype)arrayWithObject:(id)object;
      @end
    `;
    const node = parseAndFindCategory(parser, code);
    if (!node) return;

    const result = extractObjCNamedBindings(node);
    expect(result).toBeDefined();

    const binding = result![0] as ObjCCategoryBinding;
    expect(binding.methods.length).toBeGreaterThanOrEqual(1);

    // Find the class method
    const classMethods = binding.methods.filter((m) => m.isClassMethod);
    expect(classMethods.length).toBeGreaterThanOrEqual(1);
    expect(classMethods[0].selector).toBe('emptyArray');
  });

  it('extracts category with multi-argument methods', () => {
    const code = `
      @interface NSString (StringOps)
      - (NSString *)substringFrom:(NSInteger)start to:(NSInteger)end;
      @end
    `;
    const node = parseAndFindCategory(parser, code);
    if (!node) return;

    const result = extractObjCNamedBindings(node);
    expect(result).toBeDefined();

    const binding = result![0] as ObjCCategoryBinding;
    expect(binding.methods).toHaveLength(1);

    const method = binding.methods[0];
    // Multi-arg selectors have colons
    expect(method.selector).toContain(':');
    expect(method.selector).toBe('substringFrom:to:');
    expect(method.parameters).toHaveLength(2);
  });

  it('returns undefined for non-category nodes', () => {
    const fakeNode = {
      type: 'function_declaration',
      childCount: 0,
      namedChildCount: 0,
      children: [],
    } as any;
    expect(extractObjCNamedBindings(fakeNode)).toBeUndefined();
  });

  it('extracts category matching spec example', () => {
    const code = `
      @interface NSString (URLExtensions)
      - (BOOL)isValidURL;
      - (NSURL *)toURL;
      @end
    `;
    const node = parseAndFindCategory(parser, code);
    if (!node) return;

    const result = extractObjCNamedBindings(node);
    expect(result).toBeDefined();

    const binding = result![0] as ObjCCategoryBinding;
    expect(binding.type).toBe('objc-category');
    expect(binding.className).toBe('NSString');
    expect(binding.categoryName).toBe('URLExtensions');
    expect(binding.methods.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Task 11: Protocol Binding Extraction Tests
// ============================================================================

describe.skipIf(!objcAvailable)('extractObjCNamedBindings - Protocol extraction', () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = await loadParser();
    await loadLanguage(SupportedLanguages.ObjectiveC);
  });

  it('extracts protocol with name', () => {
    const code = `
      @protocol MyProtocol
      @end
    `;
    const node = parseAndFindProtocol(parser, code);
    if (!node) return;

    const result = extractObjCNamedBindings(node);
    expect(result).toBeDefined();

    const binding = result![0] as ObjCProtocolBinding;
    expect(binding.type).toBe('objc-protocol');
    expect(binding.protocolName).toBe('MyProtocol');
  });

  it('extracts protocol with required methods', () => {
    const code = `
      @protocol Speakable
      - (NSString *)speak;
      @end
    `;
    const node = parseAndFindProtocol(parser, code);
    if (!node) return;

    const result = extractObjCNamedBindings(node);
    expect(result).toBeDefined();

    const binding = result![0] as ObjCProtocolBinding;
    expect(binding.requiredMethods.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts protocol with optional methods', () => {
    const code = `
      @protocol DataSource
      @required
      - (NSInteger)numberOfItems;
      @optional
      - (void)didSelectItemAtIndex:(NSInteger)index;
      @end
    `;
    const node = parseAndFindProtocol(parser, code);
    if (!node) return;

    const result = extractObjCNamedBindings(node);
    expect(result).toBeDefined();

    const binding = result![0] as ObjCProtocolBinding;
    expect(binding.requiredMethods.length).toBeGreaterThanOrEqual(1);
    expect(binding.optionalMethods.length).toBeGreaterThanOrEqual(1);
    expect(binding.requiredMethods[0].selector).toBe('numberOfItems');
    expect(binding.optionalMethods[0].selector).toBe('didSelectItemAtIndex:');
  });
});

// ============================================================================
// Type definition tests (compile-time validation)
// ============================================================================

describe('ObjCNamedBinding type definitions', () => {
  it('ObjCCategoryBinding type is valid', () => {
    const binding: ObjCCategoryBinding = {
      type: 'objc-category',
      local: 'Validation',
      exported: 'Validation',
      className: 'NSString',
      categoryName: 'Validation',
      methods: [],
      properties: ['isValidEmail', 'isNumeric'],
    };
    expect(binding.properties).toEqual(['isValidEmail', 'isNumeric']);
  });

  it('ObjCProtocolBinding type is valid', () => {
    const binding: ObjCProtocolBinding = {
      type: 'objc-protocol',
      local: 'UITableViewDataSource',
      exported: 'UITableViewDataSource',
      protocolName: 'UITableViewDataSource',
      requiredMethods: [
        {
          selector: 'tableView:numberOfRowsInSection:',
          returnType: { name: 'NSInteger' },
          parameters: [
            { name: 'tableView', type: { name: 'UITableView', isPointer: true } },
            { name: 'section', type: { name: 'NSInteger' } },
          ],
          isClassMethod: false,
        },
      ],
      optionalMethods: [
        {
          selector: 'tableView:cellForRowAtIndexPath:',
          returnType: { name: 'UITableViewCell', isPointer: true },
          parameters: [
            { name: 'tableView', type: { name: 'UITableView', isPointer: true } },
            { name: 'indexPath', type: { name: 'NSIndexPath', isPointer: true } },
          ],
          isClassMethod: false,
        },
      ],
      properties: [],
    };
    expect(binding.protocolName).toBe('UITableViewDataSource');
    expect(binding.requiredMethods).toHaveLength(1);
    expect(binding.optionalMethods).toHaveLength(1);
  });
});
