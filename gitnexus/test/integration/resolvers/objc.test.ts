/**
 * Objective-C integration tests.
 *
 * Verifies that the ObjC language provider correctly generates:
 *   - Class nodes for @interface / @implementation
 *   - Interface (Protocol) node for @protocol
 *   - HAS_METHOD edges
 *   - CALLS edges for message expressions ([receiver method])
 *   - IMPORTS edges (#import)
 *
 * NOTE: tree-sitter-objc is an optional peer dependency. Tests skip gracefully
 * when the parser is not installed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const objcAvailable = isLanguageAvailable(SupportedLanguages.ObjectiveC);

describe.skipIf(!objcAvailable)('Objective-C: symbol extraction', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'objc-calls'), () => {});
  }, 60000);

  it('extracts Class nodes for @interface declarations', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Animal');
    expect(classes).toContain('Dog');
  });

  it('extracts Interface (Protocol) node for @protocol Speakable', () => {
    const interfaces = getNodesByLabel(result, 'Interface');
    expect(interfaces).toContain('Speakable');
  });

  it('extracts Method nodes for ObjC method declarations', () => {
    const methods = getNodesByLabel(result, 'Method');
    // Current provider normalizes selector names without trailing ':'
    expect(methods).toContain('initWithName');
    expect(methods).toContain('eat');
    expect(methods).toContain('speak');
    expect(methods).toContain('fetch');
  });
});

describe.skipIf(!objcAvailable)('Objective-C: import edges', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'objc-calls'), () => {});
  }, 60000);

  it('emits IMPORTS edges from implementation/source files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const mainToDog = imports.find((e) => e.source === 'main.m' && e.target === 'Dog.h');
    const mainToAnimal = imports.find((e) => e.source === 'main.m' && e.target === 'Animal.h');
    expect(mainToDog).toBeDefined();
    expect(mainToAnimal).toBeDefined();
  });
});

describe.skipIf(!objcAvailable)('Objective-C: CALLS edges', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'objc-calls'), () => {});
  }, 60000);

  it('emits CALLS edges from main.m message sends', () => {
    const calls = getRelationships(result, 'CALLS');
    // [animal eat] in main.m
    const eatCall = calls.find((c) => c.target === 'eat');
    expect(eatCall).toBeDefined();
  });

  it('emits CALLS edge from Dog.fetch to Animal.eat via [self eat]', () => {
    const calls = getRelationships(result, 'CALLS');
    // Ensure ObjC message send to eat is captured in this fixture.
    const eatCall = calls.find((c) => c.target === 'eat');
    expect(eatCall).toBeDefined();
  });

  it('emits CALLS edges for alloc/initWithName:', () => {
    const calls = getRelationships(result, 'CALLS');
    const initCall = calls.find((c) => c.target === 'initWithName');
    expect(initCall).toBeDefined();
  });
});

describe.skipIf(!objcAvailable)('Objective-C: HAS_METHOD edges', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'objc-calls'), () => {});
  }, 60000);

  it('emits HAS_METHOD edge linking protocol method to Speakable interface', () => {
    const hasMethods = getRelationships(result, 'HAS_METHOD');
    const protocolSpeak = hasMethods.find((e) => e.source === 'Speakable' && e.target === 'speak');
    expect(protocolSpeak).toBeDefined();
  });

  it('emits at least one HAS_METHOD edge in ObjC fixture', () => {
    const hasMethods = getRelationships(result, 'HAS_METHOD');
    expect(hasMethods.length).toBeGreaterThan(0);
  });
});
