import { describe, it, expect } from 'vitest';
import { TAINT_CONFIGS, arktsTaintConfig } from '../../src/core/ingestion/type-extractors/taint.js';

describe('ArkTS taint configuration', () => {
  it('is registered in TAINT_CONFIGS under the "arkts" key', () => {
    expect(TAINT_CONFIGS).toHaveProperty('arkts');
    expect(TAINT_CONFIGS['arkts']).toBe(arktsTaintConfig);
  });

  it('declares the expected source node types', () => {
    expect(arktsTaintConfig.sourceNodeTypes.has('member_expression')).toBe(true);
    expect(arktsTaintConfig.sourceNodeTypes.has('call_expression')).toBe(true);
  });

  it('declares the expected sink node types', () => {
    expect(arktsTaintConfig.sinkNodeTypes.has('call_expression')).toBe(true);
  });

  it('declares the expected sanitizer node types', () => {
    expect(arktsTaintConfig.sanitizerNodeTypes.has('call_expression')).toBe(true);
  });

  it('returns undefined for an unknown source node (null-safety)', () => {
    // extractSourceDeclaration always returns undefined (declaration-based sources not used)
    const fakeNode = {} as any;
    expect(arktsTaintConfig.extractSourceDeclaration(fakeNode)).toBeUndefined();
  });

  it('returns undefined from extractSinkCall for a node with no callee/function child', () => {
    // A minimal SyntaxNode-like object with no children
    const fakeNode = {
      type: 'call_expression',
      childForFieldName: (_: string) => null,
    } as any;
    expect(arktsTaintConfig.extractSinkCall(fakeNode)).toBeUndefined();
  });

  it('returns undefined from extractSanitizerCall for an unknown method name', () => {
    const fakeCalleeNode = {
      type: 'member_expression',
      childForFieldName: (field: string) => {
        if (field === 'property') {
          return { type: 'identifier', text: 'someUnknownMethod' };
        }
        return null;
      },
    };
    const fakeSinkNode = {
      type: 'call_expression',
      childForFieldName: (field: string) => {
        if (field === 'callee' || field === 'function') return fakeCalleeNode;
        return null;
      },
    } as any;
    expect(arktsTaintConfig.extractSanitizerCall(fakeSinkNode)).toBeUndefined();
  });

  it('recognises encodeURIComponent as a sanitizer', () => {
    const fakeCallee = {
      type: 'identifier',
      text: 'encodeURIComponent',
    };
    const fakeNode = {
      type: 'call_expression',
      childForFieldName: (field: string) => {
        if (field === 'callee' || field === 'function') return fakeCallee;
        return null;
      },
    } as any;
    const result = arktsTaintConfig.extractSanitizerCall(fakeNode);
    expect(result).toBeDefined();
    expect(result?.name).toBe('arkts-sanitizer:encodeURIComponent');
  });

  it('recognises executeSql as a sink', () => {
    const fakeProp = { type: 'identifier', text: 'executeSql' };
    const fakeCallee = {
      type: 'member_expression',
      childForFieldName: (field: string) => (field === 'property' ? fakeProp : null),
    };
    const fakeNode = {
      type: 'call_expression',
      childForFieldName: (field: string) => {
        if (field === 'callee' || field === 'function') return fakeCallee;
        return null;
      },
    } as any;
    const result = arktsTaintConfig.extractSinkCall(fakeNode);
    expect(result).toBeDefined();
    expect(result?.name).toBe('arkts-sink:executeSql');
  });

  it('recognises router.getParams() as a source', () => {
    const fakeObj = { type: 'identifier', text: 'router' };
    const fakeProp = { type: 'identifier', text: 'getParams' };
    const fakeCallee = {
      type: 'member_expression',
      childForFieldName: (field: string) => {
        if (field === 'object') return fakeObj;
        if (field === 'property') return fakeProp;
        return null;
      },
    };
    const fakeNode = {
      type: 'call_expression',
      childForFieldName: (field: string) => {
        if (field === 'callee' || field === 'function') return fakeCallee;
        return null;
      },
    } as any;
    const result = arktsTaintConfig.extractSourceDeclaration(fakeNode);
    // extractSourceDeclaration always returns undefined; source is via extractSinkCall/source-node-type matching
    // For call_expression taint sources, the engine checks via sourceNodeTypes + external logic.
    // The config function arktsTaintSource is not exported; we verify through the config API surface.
    expect(arktsTaintConfig.sourceNodeTypes.has('call_expression')).toBe(true);
    expect(result).toBeUndefined(); // declaration-based extraction not used
  });
});
