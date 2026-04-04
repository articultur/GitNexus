/**
 * Taint Analysis Engine.
 *
 * Implements SOURCE → PROPAGATION → SINK tracking for security analysis.
 * Works with the simplified string-based CFG representation.
 *
 * This module provides:
 * - Taint path detection from sources to sinks
 * - Confidence scoring based on sanitizers in path
 * - Pattern-based detection for common taint sources/sinks
 */

import type {
  TaintPath,
  TaintSource,
  TaintSink,
  TaintStep,
  Sanitizer,
  CFGNode,
} from './types.js';
import type { CFG } from './cfg-builder.js';
import type { DFAContext } from './dfa-engine.js';
import type { SyntaxNode } from 'tree-sitter';

// ── Result Types ───────────────────────────────────────────────────────────

export interface TaintAnalysisResult {
  /** Complete SOURCE → SINK paths found */
  paths: TaintPath[];
  /** All detected taint sources */
  sources: TaintSource[];
  /** All detected taint sinks */
  sinks: TaintSink[];
  /** All detected sanitizers */
  sanitizers: Sanitizer[];
}

// ── Taint Analysis ───────────────────────────────────────────────────────

/**
 * Perform taint analysis on a CFG.
 *
 * @param cfg - Control flow graph
 * @param context - DFA context with symbol table and call graph
 * @param language - Language identifier (used for context)
 * @returns Taint analysis result with paths, sources, sinks, sanitizers
 */
export function analyzeTaint(
  cfg: CFG,
  context: DFAContext,
  _language: string
): TaintAnalysisResult {
  const sources: TaintSource[] = [];
  const sinks: TaintSink[] = [];
  const sanitizers: Sanitizer[] = [];
  const paths: TaintPath[] = [];

  // Standard taint patterns (language-agnostic)
  const sourcePatterns = context.taintSources ?? new Set([
    'userInput', 'getenv', 'getParameter', 'request',
    'ARGV', 'ENV', 'stdin', 'input', 'readline'
  ]);

  const sanitizerPatterns = context.sanitizers ?? new Set([
    'sanitize', 'escape', 'htmlEscape', 'encodeForHTML',
    'encodeForURL', 'trim', 'strip', 'replace'
  ]);

  const sinkPatterns = context.sinks ?? new Set([
    'execute', 'eval', 'exec', 'execSync', 'query', 'sql',
    'system', 'popen', 'spawn'
  ]);

  // Scan CFG for sources, sinks, and sanitizers using improved pattern matching
  // Uses function call patterns for better precision (reduces false positives from variable names)
  for (const [nodeId, cfgNode] of cfg.nodes) {
    const astNode = getAstNode(cfgNode);
    for (const stmt of cfgNode.basicBlock) {
      // Skip comments to reduce false positives
      const trimmed = stmt.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) {
        continue;
      }

      // Check for taint sources - match function calls like: userInput(), getenv("VAR")
      for (const pattern of sourcePatterns) {
        if (hasFunctionCall(stmt, pattern)) {
          sources.push({
            nodeId,
            variable: extractVariable(stmt, astNode),
            kind: 'source:' + pattern,
            description: 'Taint source: ' + pattern + '()',
          });
          break;
        }
      }

      // Check for sinks - match function calls like: execute(sql), eval(code)
      for (const pattern of sinkPatterns) {
        if (hasFunctionCall(stmt, pattern)) {
          sinks.push({
            nodeId,
            variable: extractVariable(stmt, astNode),
            kind: 'sink:' + pattern,
            description: 'Taint sink: ' + pattern + '()',
          });
          break;
        }
      }

      // Check for sanitizers - match function calls like: sanitize(x), escape(str)
      for (const pattern of sanitizerPatterns) {
        if (hasFunctionCall(stmt, pattern)) {
          sanitizers.push({
            nodeId,
            variable: extractVariable(stmt, astNode),
            description: 'Sanitizer: ' + pattern + '()',
          });
          break;
        }
      }
    }
  }

  // Build taint paths from sources to sinks using variable-aware propagation.
  for (const source of sources) {
    for (const sink of sinks) {
      const path = findVariableAwareTaintPath(
        source,
        sink,
        cfg,
        sanitizers,
        sourcePatterns,
        sanitizerPatterns,
        sinkPatterns,
      );
      if (path) {
        paths.push({
          source,
          sink,
          path: path.steps,
          sanitizers: path.sanitizersInPath,
          confidence: calculateConfidence(path.sanitizersInPath, source, sink),
        });
      }
    }
  }

  // Deduplicate paths with same source-sink pair
  const uniquePaths = deduplicatePaths(paths);

  return {
    paths: uniquePaths,
    sources: deduplicateById(sources),
    sinks: deduplicateById(sinks),
    sanitizers: deduplicateById(sanitizers),
  };
}

// ── Path Finding ─────────────────────────────────────────────────────────

/**
 * Find a taint path from source to sink through the CFG.
 */
function findTaintPath(
  source: TaintSource,
  sink: TaintSink,
  cfg: CFG,
  sanitizers: Sanitizer[]
): { steps: TaintStep[]; sanitizersInPath: Sanitizer[] } | undefined {
  return findVariableAwareTaintPath(
    source,
    sink,
    cfg,
    sanitizers,
    new Set<string>(),
    new Set<string>(),
    new Set<string>(),
  );
}

function findVariableAwareTaintPath(
  source: TaintSource,
  sink: TaintSink,
  cfg: CFG,
  sanitizers: Sanitizer[],
  sourcePatterns: Set<string>,
  sanitizerPatterns: Set<string>,
  sinkPatterns: Set<string>,
): { steps: TaintStep[]; sanitizersInPath: Sanitizer[] } | undefined {
  type State = {
    nodeId: string;
    tainted: Set<string>;
    path: TaintStep[];
    sanitizersInPath: Sanitizer[];
  };

  const initialTaint = new Set<string>([source.variable]);
  const queue: State[] = [
    { nodeId: source.nodeId, tainted: initialTaint, path: [], sanitizersInPath: [] },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const stateKey = `${current.nodeId}|${[...current.tainted].sort().join(',')}`;
    if (visited.has(stateKey)) continue;
    visited.add(stateKey);

    const node = cfg.nodes.get(current.nodeId);
    if (!node) continue;

    const stmt = node.basicBlock.join(' ');
    const astNode = getAstNode(node);
    const updatedTaint = transferTaintWithContext(
      stmt,
      astNode,
      current.tainted,
      sourcePatterns,
      sanitizerPatterns,
      cfg,
    );

    const nodeSanitizers = sanitizers.filter((s) => s.nodeId === current.nodeId);
    const updatedSanitizers = [...current.sanitizersInPath, ...nodeSanitizers];

    if (current.nodeId === sink.nodeId && sinkUsesTaintedInput(stmt, sinkPatterns, updatedTaint)) {
      return { steps: current.path, sanitizersInPath: updatedSanitizers };
    }

    for (const succ of node.successors) {
      const step: TaintStep = {
        from: current.nodeId,
        to: succ,
        operation: 'propagate',
      };
      queue.push({
        nodeId: succ,
        tainted: updatedTaint,
        path: [...current.path, step],
        sanitizersInPath: updatedSanitizers,
      });
    }
  }

  if (source.nodeId === sink.nodeId) {
    return { steps: [], sanitizersInPath: [] };
  }

  return undefined;
}

/**
 * Transfer taint with inter-procedural context.
 * When a function call is encountered and the callee is in the CFG,
 * inline the callee's effect on taint.
 */
function transferTaintWithContext(
  stmt: string,
  astNode: SyntaxNode | undefined,
  tainted: Set<string>,
  sourcePatterns: Set<string>,
  sanitizerPatterns: Set<string>,
  cfg: CFG,
): Set<string> {
  const next = new Set<string>(tainted);
  const lhs = extractAssignedVariable(stmt);

  // Source assignment: x = userInput()
  if (lhs && hasAnyFunctionCall(stmt, sourcePatterns)) {
    next.add(lhs);
    return next;
  }

  // Sanitizer assignment: y = sanitize(x)
  if (lhs && hasAnyFunctionCall(stmt, sanitizerPatterns)) {
    if (usesAnyVariable(stmt, tainted, lhs)) {
      next.add(lhs);
    } else {
      next.delete(lhs);
    }
    return next;
  }

  // Check for function call and inline callee effect if in CFG (inter-procedural tracking)
  if (lhs && hasFunctionCall(stmt, '')) {
    // Extract callee name from AST if available
    const calleeName = astNode ? extractCalleeFromAst(astNode) : extractCalleeFromText(stmt);
    if (calleeName && cfg.nodes.has(calleeName)) {
      // Callee is in CFG - inline its taint effect
      const calleeNode = cfg.nodes.get(calleeName);
      if (calleeNode) {
        const calleeTaint = inlineCalleeTaint(calleeNode, tainted);
        for (const t of calleeTaint) {
          next.add(t);
        }
      }
    }
    // Also propagate through parameters: if y = foo(x) and x is tainted, y is tainted
    if (usesAnyVariable(stmt, tainted)) {
      next.add(lhs);
    }
    return next;
  }

  // Assignment propagation: y = x / y = foo(x)
  if (lhs) {
    if (usesAnyVariable(stmt, tainted, lhs)) {
      next.add(lhs);
    } else {
      // Overwritten by a value we don't consider tainted in this state.
      next.delete(lhs);
    }
    return next;
  }

  // Non-assignment calls can represent parameter passing but do not create locals.
  return next;
}

/**
 * Inline the callee's effect on taint - if callee returns a tainted value,
 * propagate that taint through the call.
 */
function inlineCalleeTaint(calleeNode: CFGNode, tainted: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const stmt of calleeNode.basicBlock) {
    const lhs = extractAssignedVariable(stmt);
    if (lhs && hasAnyFunctionCall(stmt, new Set(['userInput', 'getenv', 'getParameter', 'request']))) {
      result.add(lhs);
    }
    // Propagate through assignments
    if (lhs && usesAnyVariable(stmt, tainted)) {
      result.add(lhs);
    }
  }
  return result;
}

/**
 * Extract callee name from AST node (AST-aware).
 */
function extractCalleeFromAst(node: SyntaxNode): string | null {
  const callee = childByType(node, 'function', 'callee', 'method');
  return extractCalleeName(callee);
}

/**
 * Extract callee name from statement text (fallback).
 */
function extractCalleeFromText(stmt: string): string | null {
  // Match "obj.method()" or "func()"
  const match = stmt.match(/([\w$]+(?:\.[\w$]+)*)\s*\(/);
  return match?.[1] ?? null;
}

function sinkUsesTaintedInput(stmt: string, sinkPatterns: Set<string>, tainted: Set<string>): boolean {
  if (!hasAnyFunctionCall(stmt, sinkPatterns)) return false;
  return usesAnyVariable(stmt, tainted);
}

function extractAssignedVariable(stmt: string): string | undefined {
  const assignMatch = stmt.match(/^\s*(?:let|const|var)?\s*([A-Za-z_][\w$]*)\s*=/);
  return assignMatch?.[1];
}

function usesAnyVariable(stmt: string, vars: Set<string>, exclude?: string): boolean {
  for (const variable of vars) {
    if (!variable || variable === exclude) continue;
    const regex = new RegExp(`\\b${escapeRegex(variable)}\\b`);
    if (regex.test(stmt)) {
      return true;
    }
  }
  return false;
}

function hasAnyFunctionCall(stmt: string, patterns: Set<string>): boolean {
  for (const pattern of patterns) {
    if (hasFunctionCall(stmt, pattern)) {
      return true;
    }
  }
  return false;
}

function hasFunctionCall(stmt: string, pattern: string): boolean {
  // Match word boundary before pattern, followed by any chars (except paren) and opening paren.
  // This allows "execute" to match "executeQuery(" and "request.args.get" to match "request.args.get(".
  const regex = new RegExp('\\b' + escapeRegex(pattern) + '[^)]*\\(', 'g');
  return regex.test(stmt);
}

function escapeRegex(str: string): string {
  return str.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

/**
 * Calculate confidence score based on sanitizers and path characteristics.
 */
function calculateConfidence(
  sanitizersInPath: Sanitizer[],
  source: TaintSource,
  sink: TaintSink
): number {
  // Base confidence
  let confidence = 0.9;

  // Increase confidence if we have clear source-sink pattern
  if (source.kind.includes('userInput') || source.kind.includes('request')) {
    confidence = 1.0;
  }

  // High risk sinks get high confidence (but only if no sanitizers in path)
  if (sink.kind.includes('execute') || sink.kind.includes('eval')) {
    if (sanitizersInPath.length === 0) {
      confidence = 1.0;
    }
  }

  // Reduce confidence based on sanitizers in path
  if (sanitizersInPath.length > 0) {
    confidence = Math.max(0.3, confidence - 0.4 * sanitizersInPath.length);
  }

  return confidence;
}

/**
 * Extract variable name from a statement using AST.
 * Falls back to regex if AST node is not available.
 *
 * For "x = userInput()", returns "x".
 * For "userInput()", returns "userInput".
 * For "obj.method()", returns "obj.method" (captures full member expression).
 */
function extractVariable(stmt: string, astNode?: unknown): string {
  // AST-based extraction: traverse children by type
  if (astNode && typeof astNode === 'object' && astNode !== null) {
    const node = astNode as SyntaxNode;
    // For assignment expressions: left side is the variable
    // Common assignment node types across languages
    const lhs = childByType(node, 'left', 'left_expression', 'identifier', 'member_expression', 'variable_name');
    if (lhs) {
      return extractIdentifierText(lhs) || extractIdentifierText(childByType(node, 'right')) || stmt;
    }
    // For call expressions: the function being called
    const callee = childByType(node, 'function', 'callee', 'method');
    if (callee) {
      return extractIdentifierText(callee) || stmt;
    }
  }

  // Fallback to regex-based extraction
  // Handle assignment patterns: "x = func()" or "let x = func()"
  const assignMatch = stmt.match(/^\s*(?:let|const|var)?\s*([\w$]+(?:\.[\w$]+)*)\s*=/);
  if (assignMatch) {
    return assignMatch[1];
  }

  // Handle direct function call: "func()" or "obj.method()" or "obj.sub.method()"
  const callMatch = stmt.match(/^\s*([\w$]+(?:\.[\w$]+)*)\s*\(/);
  if (callMatch) {
    return callMatch[1];
  }

  return stmt.trim().split(' ')[0] || stmt;
}

/**
 * Get the first child node matching one of the given type names (by type or field name).
 * Mirrors the objective-c.ts pattern: traverse children checking type.
 */
function childByType(node: SyntaxNode, ...types: string[]): SyntaxNode | null {
  for (const child of node.children) {
    if (types.includes(child.type)) {
      return child;
    }
  }
  // Also check field names
  for (const type of types) {
    const fieldChild = node.childForFieldName(type);
    if (fieldChild) return fieldChild;
  }
  return null;
}

/**
 * Extract text from an identifier node, handling member expressions recursively.
 * For "obj.method", returns "obj.method".
 */
function extractIdentifierText(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === 'identifier' || node.type === 'property_identifier' ||
      node.type === 'simple_identifier' || node.type === 'field_identifier') {
    return node.text;
  }
  if (node.type === 'member_expression') {
    const obj = childByType(node, 'object', 'expression');
    const prop = childByType(node, 'property', 'field');
    const objText = extractIdentifierText(obj);
    const propText = extractIdentifierText(prop);
    if (objText && propText) return `${objText}.${propText}`;
  }
  return node.text || null;
}

/**
 * Extract function name from a call expression AST node.
 */
function extractCalleeName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'member_expression') {
    return extractIdentifierText(node);
  }
  return null;
}

/**
 * Get the AST node for a CFG node, if available.
 */
function getAstNode(node: CFGNode): SyntaxNode | undefined {
  return node.astNode as SyntaxNode | undefined;
}

/**
 * Deduplicate paths by source-sink pair.
 */
function deduplicatePaths(paths: TaintPath[]): TaintPath[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const key = p.source.nodeId + '->' + p.sink.nodeId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Deduplicate by node ID.
 */
function deduplicateById<T extends { nodeId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.nodeId)) return false;
    seen.add(item.nodeId);
    return true;
  });
}

// ── Pattern Accessors ───────────────────────────────────────────────────

/**
 * Get taint patterns for a specific language.
 * Returns source, sink, and sanitizer patterns for that language.
 */
export function getTaintPatterns(language: string): {
  sources: Set<string>;
  sinks: Set<string>;
  sanitizers: Set<string>;
} {
  // Default patterns
  const defaults = {
    sources: new Set(['userInput', 'getenv', 'getParameter', 'request', 'ARGV', 'ENV', 'stdin', 'input', 'readline']),
    sinks: new Set(['execute', 'eval', 'exec', 'execSync', 'query', 'sql', 'system', 'popen', 'spawn']),
    sanitizers: new Set(['sanitize', 'escape', 'htmlEscape', 'encodeForHTML', 'encodeForURL', 'trim', 'strip', 'replace']),
  };

  // Language-specific overrides
  const overrides: Record<string, Partial<typeof defaults>> = {
    typescript: {
      sources: new Set(['process.argv', 'process.env', 'req.body', 'req.query', 'request.body']),
      sinks: new Set(['execute', 'eval', 'exec', 'execSync', 'query', 'sql', 'child_process']),
    },
    python: {
      // Use specific method patterns for method chains like request.args.get("x")
      sources: new Set(['sys.argv', 'os.environ', 'request.args.get', 'request.form.get', 'request.json.get', 'input', 'raw_input']),
      sinks: new Set(['execute', 'eval', 'exec', 'cursor.execute', 'os.system', 'subprocess']),
    },
    java: {
      sources: new Set(['request.getParameter', 'request.getHeader', 'System.getenv']),
      sinks: new Set(['execute', 'executeQuery', 'exec', 'eval', 'Class.forName']),
    },
  };

  const override = overrides[language] || {};
  return {
    sources: override.sources || defaults.sources,
    sinks: override.sinks || defaults.sinks,
    sanitizers: override.sanitizers || defaults.sanitizers,
  };
}

/**
 * Check if a language is supported for taint analysis.
 */
export function isLanguageSupported(language: string): boolean {
  const supportedLanguages = ['typescript', 'javascript', 'python', 'java', 'kotlin', 'go', 'rust', 'csharp', 'c', 'cpp', 'php', 'ruby', 'swift', 'dart'];
  return supportedLanguages.includes(language.toLowerCase());
}

/**
 * Get list of supported languages.
 */
export function getSupportedLanguages(): string[] {
  return ['typescript', 'javascript', 'python', 'java', 'kotlin', 'go', 'rust', 'csharp', 'c', 'cpp', 'php', 'ruby', 'swift', 'dart'];
}
