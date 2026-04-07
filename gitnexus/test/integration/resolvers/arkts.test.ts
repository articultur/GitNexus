/**
 * ArkTS (.ets): cross-file function calls, imports, and struct-as-class
 * preprocessing.
 *
 * Verifies that:
 * - Functions are extracted from .ets files
 * - IMPORTS edges are emitted between files
 * - CALLS edges cross file boundaries correctly
 * - @Entry/@Component structs are captured as Class nodes after preprocessing
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

describe('ArkTS cross-file calls and imports', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'arkts-calls'), () => {});
  }, 60000);

  it('extracts top-level functions from all .ets files', () => {
    const functions = getNodesByLabel(result, 'Function');
    // utils.ets
    expect(functions).toContain('formatName');
    expect(functions).toContain('greet');
    // service.ets
    expect(functions).toContain('createGreeting');
    expect(functions).toContain('normalizeAndGreet');
    // main.ets
    expect(functions).toContain('runApp');
  });

  it('captures the @Entry struct as a Class node', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('MainPage');
  });

  it('emits IMPORTS edges from service.ets to utils.ets', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const serviceToUtils = imports.find(
      (e) => e.sourceFilePath.includes('service.ets') && e.targetFilePath.includes('utils.ets'),
    );
    expect(serviceToUtils).toBeDefined();
  });

  it('emits IMPORTS edges from main.ets to service.ets', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const mainToService = imports.find(
      (e) => e.sourceFilePath.includes('main.ets') && e.targetFilePath.includes('service.ets'),
    );
    expect(mainToService).toBeDefined();
  });

  it('resolves cross-file CALLS: createGreeting → greet', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'createGreeting' &&
        c.target === 'greet' &&
        c.sourceFilePath.includes('service.ets') &&
        c.targetFilePath.includes('utils.ets'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves cross-file CALLS: normalizeAndGreet → formatName', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'normalizeAndGreet' &&
        c.target === 'formatName' &&
        c.sourceFilePath.includes('service.ets') &&
        c.targetFilePath.includes('utils.ets'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves cross-file CALLS: runApp → createGreeting', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'runApp' &&
        c.target === 'createGreeting' &&
        c.sourceFilePath.includes('main.ets') &&
        c.targetFilePath.includes('service.ets'),
    );
    expect(edge).toBeDefined();
  });

  it('intra-file call: greet → formatName (utils.ets)', () => {
    const calls = getRelationships(result, 'CALLS');
    const edge = calls.find(
      (c) =>
        c.source === 'greet' && c.target === 'formatName' && c.sourceFilePath.includes('utils.ets'),
    );
    expect(edge).toBeDefined();
  });
});
