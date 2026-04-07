/**
 * Unit tests for CFG Builder
 */
import { describe, it, expect } from 'vitest';
import {
  buildCFGFromStatements,
  splitIntoBasicBlocks,
  parseStatements,
  type ParsedStatement,
} from '../../../src/core/ingestion/dataflow/cfg-builder';

describe('CFG Builder', () => {
  describe('buildCFG', () => {
    it('should build CFG for sequential statements', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = 1', line: 1 },
        { type: 'assignment', content: 'y = x', line: 2 },
        { type: 'return', content: 'return y', line: 3 },
      ];

      const cfg = buildCFGFromStatements('func1', statements);

      expect(cfg.functionId).toBe('func1');
      expect(cfg.nodes.size).toBe(3);
      expect(cfg.entryNodeId).toBe('func1:bb:0');
      expect(cfg.exitNodeId).toBe('func1:bb:2');
    });

    it('should handle branching statements', () => {
      const statements: ParsedStatement[] = [
        { type: 'if', content: 'if (cond)', line: 1 },
        { type: 'assignment', content: 'x = source()', line: 2 },
        { type: 'assignment', content: 'y = sanitize(x)', line: 3 },
      ];

      const cfg = buildCFGFromStatements('func2', statements);
      const branchNode = cfg.nodes.get('func2:bb:0');

      expect(branchNode?.isBranch).toBe(true);
      expect(branchNode?.successors.length).toBeGreaterThan(0);
    });

    it('should handle loop headers', () => {
      const statements: ParsedStatement[] = [
        { type: 'while', content: 'while (cond)', line: 1 },
        { type: 'assignment', content: 'x = source()', line: 2 },
      ];

      const cfg = buildCFGFromStatements('func3', statements);
      const loopNode = cfg.nodes.get('func3:bb:0');

      expect(loopNode?.isLoopHeader).toBe(true);
    });

    it('should handle empty function', () => {
      const cfg = buildCFGFromStatements('emptyFunc', []);

      expect(cfg.nodes.size).toBe(1);
      expect(cfg.entryNodeId).toBe(cfg.exitNodeId);
    });

    it('should build correct predecessors for sequential flow', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = 1', line: 1 },
        { type: 'assignment', content: 'y = 2', line: 2 },
        { type: 'return', content: 'return x + y', line: 3 },
      ];

      const cfg = buildCFGFromStatements('seq', statements);

      const firstNode = cfg.nodes.get('seq:bb:0');
      const secondNode = cfg.nodes.get('seq:bb:1');
      const thirdNode = cfg.nodes.get('seq:bb:2');

      expect(firstNode?.predecessors).toHaveLength(0);
      expect(secondNode?.predecessors).toContain('seq:bb:0');
      expect(thirdNode?.predecessors).toContain('seq:bb:1');
    });

    it('should handle return statements with no successors', () => {
      const statements: ParsedStatement[] = [
        { type: 'assignment', content: 'x = 1', line: 1 },
        { type: 'return', content: 'return x', line: 2 },
      ];

      const cfg = buildCFGFromStatements('ret', statements);
      const returnNode = cfg.nodes.get('ret:bb:1');

      expect(returnNode?.successors).toHaveLength(0);
    });
  });

  describe('splitIntoBasicBlocks', () => {
    it('should split statements into basic blocks', () => {
      const statements = ['x = 1', 'y = 2', 'return x + y'];
      const blocks = splitIntoBasicBlocks(statements);

      expect(blocks.length).toBe(3);
      expect(blocks[0].statements[0]).toBe('x = 1');
      expect(blocks[0].startLine).toBe(0);
      expect(blocks[0].endLine).toBe(0);
    });

    it('should preserve statement content', () => {
      const statements = ['x = userInput()', 'y = sanitize(x)'];
      const blocks = splitIntoBasicBlocks(statements);

      expect(blocks[0].statements[0]).toBe('x = userInput()');
      expect(blocks[1].statements[0]).toBe('y = sanitize(x)');
    });
  });

  describe('parseStatements', () => {
    it('should parse assignment statements', () => {
      const lines = ['x = 1', 'y = x'];
      const statements = parseStatements('parseTest', lines);

      expect(statements[0].type).toBe('assignment');
      expect(statements[0].content).toBe('x = 1');
    });

    it('should parse if statements', () => {
      const lines = ['if (cond) {', '  x = 1', '}'];
      const statements = parseStatements('parseTest', lines);

      expect(statements[0].type).toBe('if');
    });

    it('should parse while statements', () => {
      const lines = ['while (hasNext()) {', '  process()', '}'];
      const statements = parseStatements('parseTest', lines);

      expect(statements[0].type).toBe('while');
    });

    it('should parse return statements', () => {
      const lines = ['function test()', '{', '  return 42', '}'];
      const statements = parseStatements('parseTest', lines);

      expect(statements.some((s) => s.type === 'return')).toBe(true);
    });

    it('should skip empty lines and comments', () => {
      const lines = ['// comment', '', 'x = 1', '  ', '# python comment'];
      const statements = parseStatements('parseTest', lines);

      expect(statements.length).toBe(1);
      expect(statements[0].content).toBe('x = 1');
    });
  });
});
