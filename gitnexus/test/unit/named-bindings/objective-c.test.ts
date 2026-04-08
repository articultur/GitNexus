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
