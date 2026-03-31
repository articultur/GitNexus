/**
 * Unit tests for DFA Engine
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeForward,
  extractTaintSources,
  extractTaintSinks,
  createDefaultContext,
  type DFAContext,
} from '../../../src/core/ingestion/dataflow/dfa-engine';
import { buildCFG } from '../../../src/core/ingestion/dataflow/cfg-builder';
import type { ParsedStatement } from '../../../src/core/ingestion/dataflow/cfg-builder';

describe('DFA Engine', () => {
  describe('analyzeForward', () => {
    it('should propagate taint through assignments', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = userInput()', line: 1 },
        { type: 'assignment', content: 'y = x', line: 2 },
        { type: 'assignment', content: 'z = y', line: 3 },
      ];

      const cfg = buildCFG('processInput', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map([
          ['y', 'x'],
          ['z', 'y'],
        ]),
        taintSources: new Set(['userInput']),
        sanitizers: new Set(),
        sinks: new Set(),
      };

      const result = analyzeForward(context);

      // x should be TAINTED (from userInput())
      const xFacts = result.facts.get('processInput:bb:0');
      expect(xFacts?.get('x')).toBe('TAINTED');

      // y should propagate from x
      const yFacts = result.facts.get('processInput:bb:1');
      expect(yFacts?.get('y')).toBe('TAINTED');

      // z should propagate from y
      const zFacts = result.facts.get('processInput:bb:2');
      expect(zFacts?.get('z')).toBe('TAINTED');
    });

    it('should handle sanitize', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = userInput()', line: 1 },
        { type: 'assignment', content: 'y = sanitize(x)', line: 2 },
      ];

      const cfg = buildCFG('safeInput', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
        taintSources: new Set(['userInput']),
        sanitizers: new Set(['sanitize']),
        sinks: new Set(),
      };

      const result = analyzeForward(context);

      // x should be TAINTED
      const xFacts = result.facts.get('safeInput:bb:0');
      expect(xFacts?.get('x')).toBe('TAINTED');

      // y should be SANITIZED
      const yFacts = result.facts.get('safeInput:bb:1');
      expect(yFacts?.get('y')).toBe('SANITIZED');
    });

    it('should handle constant propagation', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = 42', line: 1 },
        { type: 'assignment', content: 'y = x', line: 2 },
      ];

      const cfg = buildCFG('constProp', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
      };

      const result = analyzeForward(context);

      // x should be CONSTANT
      const xFacts = result.facts.get('constProp:bb:0');
      expect(xFacts?.get('x')).toBe('CONSTANT');
    });

    it('should track multiple variables independently', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = userInput()', line: 1 },
        { type: 'assignment', content: 'y = 42', line: 2 },
        { type: 'assignment', content: 'z = y', line: 3 },
      ];

      const cfg = buildCFG('multiVar', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
        taintSources: new Set(['userInput']),
        sanitizers: new Set(),
        sinks: new Set(),
      };

      const result = analyzeForward(context);

      // x should be TAINTED, y should be CONSTANT, z should be CONSTANT
      const lastFacts = result.facts.get('multiVar:bb:2');
      expect(lastFacts?.get('x')).toBe('TAINTED');
      expect(lastFacts?.get('y')).toBe('CONSTANT');
      expect(lastFacts?.get('z')).toBe('CONSTANT');
    });

    it('should handle empty CFG', () => {
      const cfg = buildCFG('empty', []);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
      };

      const result = analyzeForward(context);

      expect(result.facts.size).toBeGreaterThan(0);
    });
  });

  describe('extractTaintSources', () => {
    it('should extract taint sources from analysis result', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = userInput()', line: 1 },
      ];

      const cfg = buildCFG('sourceTest', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
        taintSources: new Set(['userInput']),
      };

      const result = analyzeForward(context);
      const sources = extractTaintSources(result);

      expect(sources.some(s => s.includes('x'))).toBe(true);
    });
  });

  describe('createDefaultContext', () => {
    it('should create context with default taint sources and sanitizers', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = userInput()', line: 1 },
        { type: 'assignment', content: 'y = sanitize(x)', line: 2 },
      ];

      const cfg = buildCFG('defaultCtx', statements);
      const context = createDefaultContext(cfg);

      expect(context.taintSources).toBeDefined();
      expect(context.taintSources!.has('userInput')).toBe(true);
      expect(context.sanitizers).toBeDefined();
      expect(context.sanitizers!.has('sanitize')).toBe(true);
    });
  });
});
