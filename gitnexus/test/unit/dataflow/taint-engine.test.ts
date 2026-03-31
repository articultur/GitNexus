/**
 * Unit tests for Taint Engine
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeTaint,
  getTaintPatterns,
  isLanguageSupported,
  getSupportedLanguages,
} from '../../../src/core/ingestion/dataflow/taint-engine';
import { buildCFG } from '../../../src/core/ingestion/dataflow/cfg-builder';
import type { ParsedStatement } from '../../../src/core/ingestion/dataflow/cfg-builder';
import type { DFAContext } from '../../../src/core/ingestion/dataflow/dfa-engine';

describe('Taint Engine', () => {
  describe('analyzeTaint', () => {
    it('should detect taint source', () => {
      const statements: ParsedStatement[] = [
        { type: 'call', content: 'userInput()', line: 1 },
      ];

      const cfg = buildCFG('process', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
      };

      const result = analyzeTaint(cfg, context, 'typescript');

      expect(result.sources.length).toBeGreaterThan(0);
    });

    it('should detect sink', () => {
      const statements: ParsedStatement[] = [
        { type: 'call', content: 'executeQuery(sql)', line: 1 },
      ];

      const cfg = buildCFG('execute', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
      };

      const result = analyzeTaint(cfg, context, 'typescript');

      expect(result.sinks.length).toBeGreaterThan(0);
    });

    it('should build taint path from source to sink', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = userInput()', line: 1 },
        { type: 'assignment', content: 'y = x', line: 2 },
        { type: 'call', content: 'executeQuery(y)', line: 3 },
      ];

      const cfg = buildCFG('unsafe', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
      };

      const result = analyzeTaint(cfg, context, 'typescript');

      expect(result.paths.length).toBeGreaterThan(0);
      expect(result.paths[0].source.kind).toContain('source');
      expect(result.paths[0].sink.kind).toContain('sink');
    });

    it('should reduce confidence when sanitizer present', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = userInput()', line: 1 },
        { type: 'assignment', content: 'y = sanitize(x)', line: 2 },
        { type: 'call', content: 'executeQuery(y)', line: 3 },
      ];

      const cfg = buildCFG('safe', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
      };

      const result = analyzeTaint(cfg, context, 'typescript');

      // Path with sanitizer should have lower confidence
      expect(result.paths[0]?.confidence).toBeLessThan(1.0);
    });

    it('should handle Java taint sources', () => {
      const statements: ParsedStatement[] = [
        { type: 'call', content: 'request.getParameter("name")', line: 1 },
      ];

      const cfg = buildCFG('javaProcess', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
      };

      const result = analyzeTaint(cfg, context, 'java');

      expect(result.sources.length).toBeGreaterThan(0);
    });

    it('should handle Python taint sources', () => {
      const statements: ParsedStatement[] = [
        { type: 'call', content: 'request.args.get("name")', line: 1 },
      ];

      const cfg = buildCFG('pythonProcess', statements);

      const context: DFAContext = {
        cfg,
        symbolTable: new Map(),
        callsGraph: new Map(),
        assignments: new Map(),
      };

      const result = analyzeTaint(cfg, context, 'python');

      expect(result.sources.length).toBeGreaterThan(0);
    });
  });

  describe('getTaintPatterns', () => {
    it('should return patterns for TypeScript', () => {
      const patterns = getTaintPatterns('typescript');
      expect(patterns).toBeDefined();
      expect(patterns.sources.size).toBeGreaterThan(0);
      expect(patterns.sinks.size).toBeGreaterThan(0);
    });

    it('should return patterns for Java', () => {
      const patterns = getTaintPatterns('java');
      expect(patterns).toBeDefined();
    });

    it('should fallback to TypeScript patterns for unknown language', () => {
      const patterns = getTaintPatterns('unknown-lang');
      expect(patterns).toBeDefined();
    });
  });

  describe('isLanguageSupported', () => {
    it('should return true for TypeScript', () => {
      expect(isLanguageSupported('typescript')).toBe(true);
    });

    it('should return true for Java', () => {
      expect(isLanguageSupported('java')).toBe(true);
    });

    it('should return true for Python', () => {
      expect(isLanguageSupported('python')).toBe(true);
    });

    it('should return true for JavaScript', () => {
      expect(isLanguageSupported('javascript')).toBe(true);
    });
  });

  describe('getSupportedLanguages', () => {
    it('should return list of supported languages', () => {
      const languages = getSupportedLanguages();
      expect(languages).toContain('typescript');
      expect(languages).toContain('java');
      expect(languages).toContain('python');
    });
  });
});
