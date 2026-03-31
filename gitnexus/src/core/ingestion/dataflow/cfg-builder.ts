/**
 * Control Flow Graph (CFG) Builder.
 *
 * Builds a CFG from function statements. The CFG represents all possible
 * execution paths through a function, with nodes representing basic blocks
 * and edges representing control flow.
 *
 * Each basic block contains a sequence of statements that execute together,
 * with no branches inside the block.
 */

import type { CFGNode } from './types.js';

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface BasicBlock {
  id: string;
  statements: string[];
  startLine: number;
  endLine: number;
}

export interface CFG {
  functionId: string;
  nodes: Map<string, CFGNode>;
  entryNodeId: string;
  exitNodeId: string;
}

// ── Statement Types ─────────────────────────────────────────────────────────

export type StatementType =
  | 'assignment'   // x = expr
  | 'call'        // function call (no assignment)
  | 'return'      // return statement
  | 'if'          // conditional branch
  | 'while'       // while loop
  | 'for'         // for loop
  | 'switch'      // switch statement
  | 'throw'       // throw statement
  | 'try'         // try-catch block
  | 'label'       // labeled statement
  | 'goto'        // goto statement
  | 'enter'       // function entry
  | 'exit';       // function exit

export interface ParsedStatement {
  type: StatementType;
  content: string;
  line: number;
}

// ── CFG Builder ─────────────────────────────────────────────────────────────

/**
 * Build a CFG from parsed statements.
 *
 * @param functionId - Unique identifier for this function
 * @param statements - Parsed statements from the function body
 * @returns CFG with nodes and edges
 */
export function buildCFG(
  functionId: string,
  statements: ParsedStatement[]
): CFG {
  const nodes = new Map<string, CFGNode>();

  if (statements.length === 0) {
    // Empty function - create single entry/exit node
    const entryId = `${functionId}:bb:0`;
    nodes.set(entryId, {
      id: entryId,
      functionId,
      basicBlock: [],
      predecessors: [],
      successors: [],
    });
    return {
      functionId,
      nodes,
      entryNodeId: entryId,
      exitNodeId: entryId,
    };
  }

  // First pass: identify branch points and loop headers
  const branchIndices = new Set<number>();
  const loopHeaders = new Set<number>();

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    if (stmt.type === 'if' || stmt.type === 'switch') {
      branchIndices.add(i);
    } else if (stmt.type === 'while' || stmt.type === 'for') {
      loopHeaders.add(i);
      // Also mark the next statement as a branch target
      if (i + 1 < statements.length) {
        branchIndices.add(i + 1);
      }
    }
  }

  // Second pass: build nodes with predecessors/successors
  let currentIndex = 0;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const nodeId = `${functionId}:bb:${currentIndex}`;

    // Calculate predecessors
    const predecessors: string[] = [];
    if (i === 0) {
      // Entry node has no predecessors
    } else if (statements[i - 1].type === 'if') {
      // Previous statement was a branch - this is the true branch target
      const prevNodeId = `${functionId}:bb:${currentIndex}`;
      predecessors.push(prevNodeId);
      currentIndex++;
      const newNodeId = `${functionId}:bb:${currentIndex}`;
      predecessors.length = 0;
      predecessors.push(newNodeId);
    } else if (statements[i - 1].type === 'while' || statements[i - 1].type === 'for') {
      // Previous statement was a loop - this could be reached from loop start
      const loopStartIdx = i - 1;
      // Find the basic block index of the loop start
      let loopBlockIdx = 0;
      let count = 0;
      for (let j = 0; j <= loopStartIdx; j++) {
        if (statements[j].type === 'if' || statements[j].type === 'while' || statements[j].type === 'for') {
          // These statements create their own blocks
        }
        count++;
      }
      loopBlockIdx = count - 1;
      const loopNodeId = `${functionId}:bb:${loopBlockIdx}`;
      predecessors.push(loopNodeId);
    } else {
      // Sequential fall-through from previous statement
      predecessors.push(`${functionId}:bb:${currentIndex - 1}`);
    }

    // Calculate successors
    const successors: string[] = [];

    if (stmt.type === 'if') {
      // If has two branches: true (next statement) and false (after if block)
      // For simplicity, we just mark the next statement as successor
      // In a full implementation, we'd track the false branch separately
      if (i + 1 < statements.length) {
        successors.push(`${functionId}:bb:${currentIndex + 1}`);
      }
    } else if (stmt.type === 'while' || stmt.type === 'for') {
      // Loop loops back to itself
      successors.push(`${functionId}:bb:${currentIndex}`);
      if (i + 1 < statements.length) {
        successors.push(`${functionId}:bb:${currentIndex + 1}`);
      }
    } else if (stmt.type === 'return' || stmt.type === 'throw') {
      // Terminal statements have no successors
    } else if (i + 1 < statements.length) {
      // Normal fall-through to next statement
      successors.push(`${functionId}:bb:${currentIndex + 1}`);
    }

    nodes.set(nodeId, {
      id: nodeId,
      functionId,
      basicBlock: [stmt.content],
      predecessors,
      successors,
      isLoopHeader: loopHeaders.has(i),
      isBranch: branchIndices.has(i),
    });

    currentIndex++;
  }

  const lastIndex = Math.max(0, statements.length - 1);

  return {
    functionId,
    nodes,
    entryNodeId: `${functionId}:bb:0`,
    exitNodeId: `${functionId}:bb:${lastIndex}`,
  };
}

/**
 * Split statements into basic blocks.
 *
 * A basic block is a maximal sequence of statements with:
 * - No labels (except at the entry point)
 * - No jumps (except at the exit point)
 * - No branch targets (except at the entry point)
 */
export function splitIntoBasicBlocks(statements: string[]): BasicBlock[] {
  const blocks: BasicBlock[] = [];

  for (let i = 0; i < statements.length; i++) {
    blocks.push({
      id: `bb:${i}`,
      statements: [statements[i]],
      startLine: i,
      endLine: i,
    });
  }

  return blocks;
}

/**
 * Parse raw statements into typed statements.
 *
 * This is a simplified parser that recognizes common patterns.
 * A full implementation would use the AST from tree-sitter.
 */
export function parseStatements(functionId: string, sourceLines: string[]): ParsedStatement[] {
  const statements: ParsedStatement[] = [];

  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i].trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) {
      continue; // Skip empty lines and comments
    }

    const type = inferStatementType(line);
    statements.push({
      type,
      content: line,
      line: i + 1,
    });
  }

  return statements;
}

/**
 * Infer statement type from content.
 */
function inferStatementType(line: string): StatementType {
  if (line.startsWith('if ') || line.startsWith('if(')) return 'if';
  if (line.startsWith('while ') || line.startsWith('while(')) return 'while';
  if (line.startsWith('for ') || line.startsWith('for(')) return 'for';
  if (line.startsWith('switch ') || line.startsWith('switch(')) return 'switch';
  if (line.startsWith('return ')) return 'return';
  if (line.startsWith('throw ')) return 'throw';
  if (line.startsWith('try ') || line.startsWith('try{')) return 'try';
  if (line.match(/^\w+:$/)) return 'label'; // label:
  if (line === 'enter' || line === 'function entry') return 'enter';
  if (line === 'exit' || line === 'function exit') return 'exit';
  if (line.includes('(') && !line.includes('=')) return 'call';
  if (line.includes('=')) return 'assignment';
  return 'assignment';
}

/**
 * Add edges between CFG nodes based on control flow.
 *
 * This function refines the basic CFG with proper edge connections
 * for branches and loops.
 */
export function addCFGEdges(cfg: CFG, statements: ParsedStatement[]): CFG {
  const nodes = new Map(cfg.nodes);

  for (let i = 0; i < statements.length; i++) {
    const nodeId = `${cfg.functionId}:bb:${i}`;
    const node = nodes.get(nodeId);
    if (!node) continue;

    const stmt = statements[i];

    // Update successors based on statement type
    if (stmt.type === 'if') {
      // For if statements, the first successor is the true branch,
      // second would be the false branch (if we tracked it)
      if (i + 1 < statements.length) {
        node.successors.push(`${cfg.functionId}:bb:${i + 1}`);
      }
    } else if (stmt.type === 'while' || stmt.type === 'for') {
      // Loop back to self
      node.successors = [nodeId];
      // Also fall through to next statement after loop
      if (i + 1 < statements.length) {
        node.successors.push(`${cfg.functionId}:bb:${i + 1}`);
      }
    } else if (stmt.type === 'return' || stmt.type === 'throw') {
      node.successors = [];
    }

    nodes.set(nodeId, node);
  }

  return { ...cfg, nodes };
}
