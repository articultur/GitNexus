/**
 * Control Flow Graph (CFG) Builder using tree-sitter AST.
 *
 * Extracts statement-level nodes from a tree-sitter Tree and builds a CFG
 * with edges for all control-flow constructs.
 *
 * Edge types: NEXT | TRUE_BRANCH | FALSE_BRANCH | LOOP_HEADER | BREAK |
 *             CONTINUE | SWITCH_CASE | SWITCH_DEFAULT | TRY_BODY | CATCH |
 *             THROW | RETURN
 */

import type { Tree, SyntaxNode } from 'tree-sitter';
import type { CFGNode, CFGResult, CFGEdgeType, CFG, ParsedStatement } from './types.js';
export type { CFG };
import { SupportedLanguages } from 'gitnexus-shared';

// ── Statement kinds carried through the walk ─────────────────────────────────

interface StmtNode {
  id: string;
  node: SyntaxNode;
  basicBlock: string[];
  blockNumber: number;
}

/** Per-function walk state accumulated as we recurse. */
interface WalkState {
  nodes: StmtNode[];
  edges: Array<{ from: string; to: string; type: CFGEdgeType }>;
  nextBlockNumber: number;
  /** Stack of active loop header ids — used to resolve BREAK / CONTINUE. */
  loopStack: string[];
  /** Stack of active try-block entry ids — used to resolve THROW routing. */
  tryStack: string[];
  /** id of the node added for the last sequential statement (fall-through target). */
  lastSeqId: string | null;
}

// ── Language-agnostic statement-type node type sets ───────────────────────────

const CONTROL_STMT_TYPES = new Set([
  'if_statement',
  'while_statement',
  'for_statement',
  'for_in_statement',          // Python / JS: for x in y
  'for_of_statement',          // JS: for x of y
  'switch_statement',
  'try_statement',
  'do_statement',              // do-while
  'catch_clause',
  'finally_clause',
]);

const BRANCH_TYPES = new Set([
  'if_statement',
  'switch_statement',
  'conditional_expression',     // ternary: a ? b : c
]);

const LOOP_TYPES = new Set([
  'while_statement',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'do_statement',
]);

const TERMINAL_STMT_TYPES = new Set([
  'return_statement',
  'throw_statement',
  'break_statement',
  'continue_statement',
]);

// Statements that are "simple" (single expression) — one block per occurrence.
const SIMPLE_STMT_TYPES = new Set([
  'expression_statement',
  'local_variable_statement',   // Go / C# local vars
  'variable_declaration',       // C/C++/Java/TS
  'let_statement',              // JS let
  'const_statement',           // JS const
  'assignment_expression',     // bare `a = b` (not inside expression_statement)
  'call_expression',           // function call as statement
  'yield_expression',
  'await_expression',
  'identifier',
]);

/** Node types that are purely structural / should NOT become CFG nodes themselves. */
const SKIP_TYPES = new Set([
  'program',
  'block',
  'statement_block',
  'switch_body',
  'try_body',               // not a tree-sitter type per se but guard below
  'catch_clause',
  'finally_clause',
  'else_clause',
  'alternative',            // Python else / elif
  'consequence',            // Python if consequence
  'condition',              // Python while/for header condition
  'comparison',
  'binary_expression',
  'unary_expression',
  'member_expression',
  'call_expression',
  'assignment_expression',
  'identifier',
  'literal',
  'comment',
  'ERROR',
  // Language-specific wrappers that should be skipped
  'declaration',            // Go var/const declarations
  'variable_list',           // Go multiple var()
  'parenthesized_expression',
  'sequence_expression',
  'argument_list',
  'formal_parameters',
  'parameter_list',
  'type',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

let _nodeCounter = 0;
const freshId = () => `cfg-n${_nodeCounter++}`;

const isNamed = (n: SyntaxNode) => n.isNamed;

const isComment = (n: SyntaxNode) =>
  n.type === 'comment' || (!n.isNamed && /^\s*\/\//.test(n.text));

/** True when the node should be entered recursively (structural / block container). */
function isContainer(n: SyntaxNode): boolean {
  const t = n.type;
  if (SKIP_TYPES.has(t)) return true;
  if (t === 'block' || t === 'statement_block') return true;
  if (t === 'class_body' || t === 'struct_body') return true;
  if (t === 'interface_body' || t === 'enum_body') return true;
  // C++/Java: for (init; cond; update) — three separate fields, not children
  if (t === 'for_statement') return true;
  if (t === 'while_statement') return true;
  if (t === 'do_statement') return true;
  if (t === 'if_statement') return true;
  if (t === 'switch_statement') return true;
  if (t === 'try_statement') return true;
  if (t === 'catch_clause') return true;
  if (t === 'finally_clause') return true;
  if (t === 'else_clause') return true;
  // Python
  if (t === 'if_statement' || t === 'elif_clause' || t === 'else_clause') return true;
  if (t === 'while_statement' || t === 'for_statement') return true;
  if (t === 'try_statement' || t === 'except_clause' || t === 'finally_clause') return true;
  if (t === 'with_statement') return true;  // Python with
  // Ruby
  if (t === 'rescue_clause' || t === 'ensure_clause') return true;
  return false;
}

/** True when the node itself is a statement-level construct that becomes a CFG node. */
function isStatementNode(n: SyntaxNode): boolean {
  const t = n.type;
  return (
    CONTROL_STMT_TYPES.has(t) ||
    TERMINAL_STMT_TYPES.has(t) ||
    SIMPLE_STMT_TYPES.has(t)
  );
}

/** Does this node's source text end with an explicit terminator (semicolon / newline)? */
function isImplicitSequencePoint(n: SyntaxNode): boolean {
  return n.type === 'expression_statement' || n.type === 'local_variable_statement';
}

// ── Core recursive walk ───────────────────────────────────────────────────────

/**
 * Walk the AST rooted at `node`, creating CFG blocks and edges.
 * Returns a new WalkState (pure — does not mutate `state`).
 */
function walkNode(node: SyntaxNode, state: WalkState): WalkState {
  const t = node.type;

  // Skip non-code artifacts
  if (isComment(node)) return state;

  // ── Terminal statements ──────────────────────────────────────────────────────
  if (t === 'return_statement') {
    const id = freshId();
    state.nodes.push({ id, node, basicBlock: [node.text.trim()], blockNumber: state.nextBlockNumber++ });
    // Emit fall-through edge from previous sequential statement
    if (state.lastSeqId !== null) {
      state.edges.push({ from: state.lastSeqId, to: id, type: 'NEXT' });
    }
    // No successors — return exits the function
    state.lastSeqId = null;
    return state;
  }

  if (t === 'throw_statement') {
    const id = freshId();
    state.nodes.push({ id, node, basicBlock: [node.text.trim()], blockNumber: state.nextBlockNumber++ });
    if (state.lastSeqId !== null) {
      state.edges.push({ from: state.lastSeqId, to: id, type: 'NEXT' });
    }
    // Route to nearest catch or unwind
    if (state.tryStack.length > 0) {
      // Edge to the catch block entry
      state.edges.push({ from: id, to: state.tryStack[state.tryStack.length - 1], type: 'THROW' });
    }
    state.lastSeqId = null;
    return state;
  }

  if (t === 'break_statement') {
    const id = freshId();
    state.nodes.push({ id, node, basicBlock: [node.text.trim()], blockNumber: state.nextBlockNumber++ });
    if (state.lastSeqId !== null) {
      state.edges.push({ from: state.lastSeqId, to: id, type: 'NEXT' });
    }
    // Break jumps to the loop exit (top of loopStack = innermost loop header)
    if (state.loopStack.length > 0) {
      state.edges.push({ from: id, to: state.loopStack[state.loopStack.length - 1], type: 'BREAK' });
    }
    state.lastSeqId = null;
    return state;
  }

  if (t === 'continue_statement') {
    const id = freshId();
    state.nodes.push({ id, node, basicBlock: [node.text.trim()], blockNumber: state.nextBlockNumber++ });
    if (state.lastSeqId !== null) {
      state.edges.push({ from: state.lastSeqId, to: id, type: 'NEXT' });
    }
    // Continue jumps back to loop header
    if (state.loopStack.length > 0) {
      state.edges.push({ from: id, to: state.loopStack[state.loopStack.length - 1], type: 'CONTINUE' });
    }
    state.lastSeqId = null;
    return state;
  }

  // ── If / conditional ────────────────────────────────────────────────────────
  if (t === 'if_statement' || t === 'conditional_expression') {
    const id = freshId();
    const label = t === 'conditional_expression'
      ? `[ternary] ${node.text.trim()}`
      : node.text.trim().split('\n')[0];
    state.nodes.push({ id, node, basicBlock: [label], blockNumber: state.nextBlockNumber++ });

    if (state.lastSeqId !== null) {
      state.edges.push({ from: state.lastSeqId, to: id, type: 'NEXT' });
    }
    state.lastSeqId = id;

    // Collect branches
    const branches = collectIfBranches(node);
    if (branches.length > 0) {
      // First branch: TRUE edge
      state.edges.push({ from: id, to: branches[0], type: 'TRUE_BRANCH' });
      state.lastSeqId = branches[branches.length - 1];
    }
    if (branches.length > 1) {
      // Second branch: FALSE edge (fall-through or explicit else)
      state.edges.push({ from: id, to: branches[1], type: 'FALSE_BRANCH' });
    }
    return state;
  }

  // ── While loop ─────────────────────────────────────────────────────────────
  if (t === 'while_statement' || t === 'do_statement') {
    const headerId = freshId();
    const headerLabel = node.text.trim().split('\n')[0];
    state.nodes.push({ id: headerId, node, basicBlock: [headerLabel], blockNumber: state.nextBlockNumber++ });

    if (state.lastSeqId !== null) {
      state.edges.push({ from: state.lastSeqId, to: headerId, type: 'NEXT' });
    }
    state.lastSeqId = headerId;

    // Push loop header onto stack before recursing into body
    state.loopStack.push(headerId);
    state.edges.push({ from: headerId, to: headerId, type: 'LOOP_HEADER' });

    // Body
    const bodyNode = findChild(node, 'block', 'consequence', 'body', 'statement_block') ?? node;
    const afterState = walkChildren(bodyNode, state);

    // After body, loop back to header
    if (afterState.lastSeqId !== null) {
      afterState.edges.push({ from: afterState.lastSeqId, to: headerId, type: 'NEXT' });
      afterState.lastSeqId = headerId;
    }
    afterState.loopStack.pop();
    return afterState;
  }

  // ── For loop ───────────────────────────────────────────────────────────────
  if (t === 'for_statement' || t === 'for_in_statement' || t === 'for_of_statement') {
    const headerId = freshId();
    const headerLabel = node.text.trim().split('\n')[0];
    state.nodes.push({ id: headerId, node, basicBlock: [headerLabel], blockNumber: state.nextBlockNumber++ });

    if (state.lastSeqId !== null) {
      state.edges.push({ from: state.lastSeqId, to: headerId, type: 'NEXT' });
    }
    state.lastSeqId = headerId;

    state.loopStack.push(headerId);
    state.edges.push({ from: headerId, to: headerId, type: 'LOOP_HEADER' });

    // Recurse into body
    const bodyNode = findChild(node, 'block', 'body', 'consequence', 'statement_block') ?? node;
    const afterState = walkChildren(bodyNode, state);

    if (afterState.lastSeqId !== null) {
      afterState.edges.push({ from: afterState.lastSeqId, to: headerId, type: 'NEXT' });
      afterState.lastSeqId = headerId;
    }
    afterState.loopStack.pop();
    return afterState;
  }

  // ── Switch ─────────────────────────────────────────────────────────────────
  if (t === 'switch_statement') {
    const headerId = freshId();
    const headerLabel = `switch ${node.text.trim().split('\n')[0]}`;
    state.nodes.push({ id: headerId, node, basicBlock: [headerLabel], blockNumber: state.nextBlockNumber++ });

    if (state.lastSeqId !== null) {
      state.edges.push({ from: state.lastSeqId, to: headerId, type: 'NEXT' });
    }
    state.lastSeqId = headerId;

    // Collect all switch cases
    const caseIds = collectSwitchCases(node, state);

    // Each case is reached via SWITCH_CASE from the header
    for (const caseId of caseIds) {
      state.edges.push({ from: headerId, to: caseId, type: 'SWITCH_CASE' });
    }

    // After switch, lastSeqId is the last case block
    if (caseIds.length > 0) {
      state.lastSeqId = caseIds[caseIds.length - 1];
    }
    return state;
  }

  // ── Try / catch ────────────────────────────────────────────────────────────
  if (t === 'try_statement') {
    const tryId = freshId();
    state.nodes.push({ id: tryId, node, basicBlock: ['try'], blockNumber: state.nextBlockNumber++ });

    if (state.lastSeqId !== null) {
      state.edges.push({ from: state.lastSeqId, to: tryId, type: 'NEXT' });
    }
    state.edges.push({ from: tryId, to: tryId, type: 'TRY_BODY' });
    state.lastSeqId = tryId;

    // Walk try body
    const tryBodyNode = findChild(node, 'block', 'body', 'consequence', 'statement_block') ?? node;
    let s = walkChildren(tryBodyNode, state);

    // Catch clause(s)
    const catchNodes = getNamedChildren(node, 'catch_clause', 'except_clause');
    for (const catchNode of catchNodes) {
      const catchId = freshId();
      s.nodes.push({ id: catchId, node: catchNode, basicBlock: [catchNode.text.trim().split('\n')[0]], blockNumber: s.nextBlockNumber++ });
      s.edges.push({ from: tryId, to: catchId, type: 'CATCH' });
      // THROW edges from throw statements in try body to this catch
      for (const n of s.nodes) {
        if (n.node.type === 'throw_statement') {
          s.edges.push({ from: n.id, to: catchId, type: 'THROW' });
        }
      }
      s.edges.push({ from: tryId, to: catchId, type: 'CATCH' });
      s.lastSeqId = catchId;

      const catchBodyNode = findChild(catchNode, 'block', 'body', 'consequence', 'statement_block') ?? catchNode;
      s = walkChildren(catchBodyNode, s);
    }

    // Finally clause
    const finallyNode = getNamedChild(node, 'finally_clause');
    if (finallyNode) {
      const finId = freshId();
      s.nodes.push({ id: finId, node: finallyNode, basicBlock: ['finally'], blockNumber: s.nextBlockNumber++ });
      s.edges.push({ from: tryId, to: finId, type: 'NEXT' });
      s.lastSeqId = finId;
      const finBodyNode = findChild(finallyNode, 'block', 'body', 'consequence', 'statement_block') ?? finallyNode;
      s = walkChildren(finBodyNode, s);
    }

    return s;
  }

  // ── Simple statement ────────────────────────────────────────────────────────
  if (isStatementNode(node)) {
    // Skip nodes that are purely structural (already handled above)
    if (isContainer(node) && !isStatementNode(node)) return walkChildren(node, state);

    const id = freshId();
    state.nodes.push({ id, node, basicBlock: [node.text.trim()], blockNumber: state.nextBlockNumber++ });

    if (state.lastSeqId !== null) {
      state.edges.push({ from: state.lastSeqId, to: id, type: 'NEXT' });
    }
    state.lastSeqId = id;
    return state;
  }

  // ── Default: recurse into children ──────────────────────────────────────────
  return walkChildren(node, state);
}

function walkChildren(node: SyntaxNode, state: WalkState): WalkState {
  let s = state;
  for (let i = 0; i < node.childCount; i++) {
    s = walkNode(node.child(i)!, s);
  }
  return s;
}

/** Find the first named child with one of the given type strings. */
function findChild(node: SyntaxNode, ...types: string[]): SyntaxNode | null {
  for (const t of types) {
    const found = getNamedChild(node, t);
    if (found) return found;
  }
  return null;
}

function getNamedChild(node: SyntaxNode, ...types: string[]): SyntaxNode | null {
  for (const t of types) {
    for (const child of node.namedChildren) {
      if (child.type === t) return child;
    }
  }
  return null;
}

function getNamedChildren(node: SyntaxNode, ...types: string[]): SyntaxNode[] {
  return node.namedChildren.filter((c) => types.includes(c.type));
}

// ── If / switch branch helpers ────────────────────────────────────────────────

/**
 * Collect the entry-block ids for each branch of an if_statement.
 * The caller is responsible for emitting TRUE_BRANCH / FALSE_BRANCH edges.
 *
 * For `if (c) { a } else if (d) { b } else { c }` (modelled as nested if_statement):
 * returns [a, b, c] — the entry ids of each consequence block.
 */
function collectIfBranches(ifNode: SyntaxNode): string[] {
  const ids: string[] = [];

  const walk = (node: SyntaxNode): void => {
    const cons = getNamedChild(node, 'consequence', 'block', 'statement_block');
    if (cons) {
      const state: WalkState = {
        nodes: [], edges: [], nextBlockNumber: 0,
        loopStack: [], tryStack: [], lastSeqId: null,
      };
      const s = walkChildren(cons, state);
      if (s.nodes.length > 0) ids.push(s.nodes[0].id);
    }

    // Python: consequence can be a single statement
    if (!cons) {
      const alt = getNamedChild(node, 'body');
      if (alt) {
        const state: WalkState = {
          nodes: [], edges: [], nextBlockNumber: 0,
          loopStack: [], tryStack: [], lastSeqId: null,
        };
        const s = walkChildren(alt, state);
        if (s.nodes.length > 0) ids.push(s.nodes[0].id);
      }
    }

    // Recurse into else / elif
    const elseNode = getNamedChild(node, 'alternative', 'else_clause');
    if (elseNode) {
      // If the else is itself an if_statement (else if), recurse
      if (elseNode.type === 'if_statement' || elseNode.type === 'elif_clause') {
        walk(elseNode);
      } else {
        // Plain else block
        const state: WalkState = {
          nodes: [], edges: [], nextBlockNumber: 0,
          loopStack: [], tryStack: [], lastSeqId: null,
        };
        const s = walkChildren(elseNode, state);
        if (s.nodes.length > 0) ids.push(s.nodes[0].id);
      }
    }
  };

  walk(ifNode);
  return ids;
}

/**
 * Collect all case blocks (and default block) inside a switch_statement.
 * Returns the entry block id for each case.
 */
function collectSwitchCases(switchNode: SyntaxNode, state: WalkState): string[] {
  const ids: string[] = [];
  const body = getNamedChild(switchNode, 'body', 'switch_body') ?? switchNode;

  for (const child of body.namedChildren) {
    if (child.type === 'switch_case') {
      const blockId = freshId();
      state.nodes.push({ id: blockId, node: child, basicBlock: [child.text.trim().split('\n')[0]], blockNumber: state.nextBlockNumber++ });
      ids.push(blockId);
    } else if (child.type === 'default_case') {
      const blockId = freshId();
      state.nodes.push({ id: blockId, node: child, basicBlock: ['default:'], blockNumber: state.nextBlockNumber++ });
      state.edges.push({ from: state.nodes[state.nodes.length - 2]?.id ?? blockId, to: blockId, type: 'SWITCH_DEFAULT' });
      ids.push(blockId);
    } else if (child.type === 'statement') {
      // Skip — handled inside case/default blocks
    }
  }

  return ids;
}

// ── Backwards-compatible overload (text-based) ────────────────────────────────

/**
 * Build a CFG from pre-parsed statements (text-based, deprecated).
 * @deprecated Use buildCFG(tree, source, language, functionId?) instead.
 */
export function buildCFGFromStatements(
  functionId: string,
  statements: ParsedStatement[],
): CFG {
  const nodes = new Map<string, CFGNode>();

  if (statements.length === 0) {
    const entryId = `${functionId}:bb:0`;
    nodes.set(entryId, {
      id: entryId,
      functionId,
      basicBlock: [],
      predecessors: [],
      successors: [],
    });
    return { functionId, nodes, entryNodeId: entryId, exitNodeId: entryId };
  }

  // Identify branch points and loop headers
  const branchIndices = new Set<number>();
  const loopHeaders = new Set<number>();

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    if (stmt.type === 'if' || stmt.type === 'switch') {
      branchIndices.add(i);
    } else if (stmt.type === 'while' || stmt.type === 'for') {
      loopHeaders.add(i);
      if (i + 1 < statements.length) branchIndices.add(i + 1);
    }
  }

  // Build nodes
  let currentIndex = 0;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const nodeId = `${functionId}:bb:${currentIndex}`;
    const predecessors: string[] = [];

    if (i === 0) {
      // Entry node has no predecessors
    } else if (statements[i - 1].type === 'if') {
      const prevNodeId = `${functionId}:bb:${currentIndex}`;
      predecessors.push(prevNodeId);
      currentIndex++;
      const newNodeId = `${functionId}:bb:${currentIndex}`;
      predecessors.length = 0;
      predecessors.push(newNodeId);
    } else if (statements[i - 1].type === 'while' || statements[i - 1].type === 'for') {
      const loopStartIdx = i - 1;
      let count = 0;
      for (let j = 0; j <= loopStartIdx; j++) {
        if (statements[j].type === 'if' || statements[j].type === 'while' || statements[j].type === 'for') {}
        count++;
      }
      const loopNodeId = `${functionId}:bb:${count - 1}`;
      predecessors.push(loopNodeId);
    } else {
      predecessors.push(`${functionId}:bb:${currentIndex - 1}`);
    }

    const successors: string[] = [];

    if (stmt.type === 'if') {
      if (i + 1 < statements.length) successors.push(`${functionId}:bb:${currentIndex + 1}`);
    } else if (stmt.type === 'while' || stmt.type === 'for') {
      successors.push(`${functionId}:bb:${currentIndex}`);
      if (i + 1 < statements.length) successors.push(`${functionId}:bb:${currentIndex + 1}`);
    } else if (stmt.type === 'return' || stmt.type === 'throw') {
      // No successors
    } else if (i + 1 < statements.length) {
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a CFG from a tree-sitter Tree.
 *
 * @param tree     Parsed tree from tree-sitter
 * @param source   Original source text (used for node labels)
 * @param language Supported language (used to route language-specific AST patterns)
 * @param functionId Optional function identifier (extracted from AST if not provided)
 */
export function buildCFG(
  tree: Tree,
  source: string,
  language: SupportedLanguages,
  functionId?: string,
): CFGResult {
  _nodeCounter = 0;

  // Resolve functionId from the tree root if not provided.
  const fid = functionId ?? extractFunctionId(tree.rootNode, language) ?? 'anonymous';

  const state: WalkState = {
    nodes: [],
    edges: [],
    nextBlockNumber: 0,
    loopStack: [],
    tryStack: [],
    lastSeqId: null,
  };

  const s = walkNode(tree.rootNode, state);

  // ── Convert StmtNode[] → CFGNode[] ─────────────────────────────────────────
  const cfgNodes: CFGNode[] = s.nodes.map((n): CFGNode => {
    const preds = s.edges
      .filter((e) => e.to === n.id)
      .map((e) => e.from);
    const succs = s.edges
      .filter((e) => e.from === n.id)
      .map((e) => e.to);

    // Determine statement type
    let statementType: string | undefined;
    if (isLoopType(n.node)) statementType = 'loop';
    else if (isBranchType(n.node)) statementType = 'branch';
    else if (isTerminalType(n.node)) statementType = 'terminal';

    return {
      id: n.id,
      functionId: fid,
      basicBlock: n.basicBlock,
      predecessors: [...new Set(preds)],
      successors: [...new Set(succs)],
      blockNumber: n.blockNumber,
      statementType,
      astNode: n.node,
    };
  });

  // ── Convert edge records → CFGEdge[] ───────────────────────────────────────
  // Deduplicate edges (multiple identical edges can arise from shared fall-throughs)
  const seenEdges = new Set<string>();
  const cfgEdges = s.edges
    .filter((e) => {
      const key = `${e.from}|${e.to}|${e.type}`;
      if (seenEdges.has(key)) return false;
      seenEdges.add(key);
      return true;
    })
    .map((e) => ({ sourceId: e.from, targetId: e.to, edgeType: e.type }));

  return { nodes: cfgNodes, edges: cfgEdges, functionId: fid };
}

// ── Helpers for CFGNode.statementType ─────────────────────────────────────────

function isLoopType(n: SyntaxNode): boolean {
  return LOOP_TYPES.has(n.type);
}

function isBranchType(n: SyntaxNode): boolean {
  return BRANCH_TYPES.has(n.type);
}

function isTerminalType(n: SyntaxNode): boolean {
  return TERMINAL_STMT_TYPES.has(n.type);
}

// ── Function id extraction ────────────────────────────────────────────────────

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'method_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'async_function_declaration',
  'generator_function_declaration',
  'function_item',            // Rust
  'function_signature',       // Dart
  'method',                  // Ruby def
  'singleton_method',        // Ruby def self.foo
  'init_declaration',       // Swift
  'constructor_declaration',
  'local_function_statement', // C#
  'compilation_unit',        // fallback
]);

function extractFunctionId(rootNode: SyntaxNode, language: SupportedLanguages): string | null {
  for (const child of rootNode.namedChildren) {
    if (FUNCTION_NODE_TYPES.has(child.type)) {
      return extractNameFromFunctionNode(child) ?? null;
    }
    // Java / Kotlin: class → method
    if (child.type === 'class_declaration' || child.type === 'class_body') {
      const method = getNamedChild(child, 'method_declaration', 'method_definition', 'constructor_declaration');
      if (method) return extractNameFromFunctionNode(method) ?? null;
    }
  }
  return null;
}

function extractNameFromFunctionNode(node: SyntaxNode): string | null {
  const nameNode =
    node.childForFieldName('name') ??
    getNamedChild(node, 'identifier', 'property_identifier', 'simple_identifier', 'field_identifier');
  if (nameNode?.text) return nameNode.text;

  // C/C++ qualified name: function_declarator → qualified_identifier → identifier
  const declarator = node.childForFieldName('declarator');
  if (declarator) {
    const qid = getNamedChild(declarator, 'qualified_identifier', 'identifier');
    if (qid) return qid.text;
  }
  return null;
}

// ── Re-export old text-based API for backwards compatibility ──────────────────
export { splitIntoBasicBlocks, parseStatements, addCFGEdges } from './types.js';
export type { BasicBlock, ParsedStatement, StatementType } from './types.js';

/**
 * Convert the legacy Map-based CFG to the array-based CFGResult.
 * Used to feed legacy CFG results into writeCFGEdges().
 */
export function cfgToResult(cfg: import('./types.js').CFG): CFGResult {
  return {
    functionId: cfg.functionId,
    nodes: Array.from(cfg.nodes.values()),
    edges: [],
  };
}

