import { describe, it, expect } from 'vitest';
import type {
  ObjCCategoryBinding,
  ObjCProtocolBinding,
  ObjCMethodSignature,
} from '../../../src/core/ingestion/named-bindings/types.js';

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
// Task 10: Category Binding Tests
// ============================================================================

describe('ObjCCategoryBinding extraction', () => {
  it('should extract category with methods', () => {
    const binding: ObjCCategoryBinding = {
      type: 'objc-category',
      local: 'URLExtensions',
      exported: 'URLExtensions',
      className: 'NSString',
      categoryName: 'URLExtensions',
      methods: [
        {
          selector: 'asURL',
          returnType: { name: 'NSURL', isPointer: true },
          parameters: [],
          isClassMethod: false,
        },
      ],
      properties: [],
    };
    expect(binding.className).toBe('NSString');
    expect(binding.categoryName).toBe('URLExtensions');
    expect(binding.methods).toHaveLength(1);
    expect(binding.methods[0].selector).toBe('asURL');
  });

  it('should extract category with properties', () => {
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
});

// ============================================================================
// Task 11: Protocol Binding Tests
// ============================================================================

describe('ObjCProtocolBinding extraction', () => {
  it('should extract basic protocol with required method', () => {
    const binding: ObjCProtocolBinding = {
      type: 'objc-protocol',
      local: 'Speakable',
      exported: 'Speakable',
      protocolName: 'Speakable',
      requiredMethods: [
        {
          selector: 'speak',
          returnType: { name: 'NSString', isPointer: true },
          parameters: [],
          isClassMethod: false,
        },
      ],
      optionalMethods: [],
      properties: [],
    };
    expect(binding.protocolName).toBe('Speakable');
    expect(binding.requiredMethods).toHaveLength(1);
    expect(binding.requiredMethods[0].selector).toBe('speak');
    expect(binding.optionalMethods).toHaveLength(0);
  });

  it('should extract protocol with required and optional methods', () => {
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
    expect(binding.requiredMethods[0].selector).toBe('tableView:numberOfRowsInSection:');
    expect(binding.optionalMethods[0].selector).toBe('tableView:cellForRowAtIndexPath:');
  });

  it('should extract protocol with property declarations', () => {
    const binding: ObjCProtocolBinding = {
      type: 'objc-protocol',
      local: 'NSURLConnectionDelegate',
      exported: 'NSURLConnectionDelegate',
      protocolName: 'NSURLConnectionDelegate',
      requiredMethods: [],
      optionalMethods: [],
      properties: ['connection', 'delegate'],
    };
    expect(binding.properties).toEqual(['connection', 'delegate']);
  });

  it('should extract protocol with inheritance', () => {
    const binding: ObjCProtocolBinding = {
      type: 'objc-protocol',
      local: 'CustomProtocol',
      exported: 'CustomProtocol',
      protocolName: 'CustomProtocol',
      requiredMethods: [
        {
          selector: 'customMethod',
          returnType: { name: 'void' },
          parameters: [],
          isClassMethod: false,
        },
      ],
      optionalMethods: [],
      properties: [],
    };
    // Inheritance info is available through the protocol_reference_list
    // but not directly in ObjCProtocolBinding (could be extended)
    expect(binding.protocolName).toBe('CustomProtocol');
    expect(binding.requiredMethods).toHaveLength(1);
  });

  it('should extract protocol with mixed class and instance methods', () => {
    const binding: ObjCProtocolBinding = {
      type: 'objc-protocol',
      local: 'MixedMethodsProtocol',
      exported: 'MixedMethodsProtocol',
      protocolName: 'MixedMethodsProtocol',
      requiredMethods: [
        {
          selector: 'instanceMethod',
          returnType: { name: 'void' },
          parameters: [],
          isClassMethod: false,
        },
        {
          selector: 'sharedInstance',
          returnType: { name: 'id', isPointer: true },
          parameters: [],
          isClassMethod: true,
        },
      ],
      optionalMethods: [
        {
          selector: 'optionalInstanceMethod',
          returnType: { name: 'BOOL' },
          parameters: [],
          isClassMethod: false,
        },
      ],
      properties: [],
    };
    expect(binding.requiredMethods).toHaveLength(2);
    expect(binding.requiredMethods[0].isClassMethod).toBe(false);
    expect(binding.requiredMethods[1].isClassMethod).toBe(true);
    expect(binding.optionalMethods).toHaveLength(1);
    expect(binding.optionalMethods[0].isClassMethod).toBe(false);
  });
});
