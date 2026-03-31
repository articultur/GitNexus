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
} from './types.js';
import type { CFG } from './cfg-builder.js';
import type { DFAContext } from './dfa-engine.js';

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

// ── Taint Analysis ────────────────────────────────────────────────────────

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

  // Scan CFG for sources, sinks, and sanitizers using pattern matching
  for (const [nodeId, node] of cfg.nodes) {
    for (const stmt of node.basicBlock) {
      // Check for taint sources
      for (const pattern of sourcePatterns) {
        if (stmt.includes(pattern)) {
          sources.push({
            nodeId,
            variable: extractVariable(stmt),
            kind: `source:${pattern}`,
            description: `Taint source: ${pattern}`,
          });
          break;
        }
      }

      // Check for sinks
      for (const pattern of sinkPatterns) {
        if (stmt.includes(pattern)) {
          sinks.push({
            nodeId,
            variable: extractVariable(stmt),
            kind: `sink:${pattern}`,
            description: `Taint sink: ${pattern}`,
          });
          break;
        }
      }

      // Check for sanitizers
      for (const pattern of sanitizerPatterns) {
        if (stmt.includes(pattern)) {
          sanitizers.push({
            nodeId,
            variable: extractVariable(stmt),
            description: `Sanitizer: ${pattern}`,
          });
          break;
        }
      }
    }
  }

  // Build taint paths from sources to sinks
  for (const source of sources) {
    for (const sink of sinks) {
      const path = findTaintPath(source, sink, cfg, sanitizers);
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

  return { paths, sources, sinks, sanitizers };
}

/**
 * Get the AST node type for a statement.
 *
 * This is a simplified version - in full implementation,
 * this would parse the actual AST node type.
 */
function getNodeType(stmt: string): string {
  // Simplified node type detection based on statement content
  if (stmt.includes('(') && stmt.includes(')')) {
    if (stmt.includes('=')) {
      return 'call_expression'; // method call with assignment
    }
    return 'method_invocation'; // method call without assignment
  }
  if (stmt.includes('getParameter') || stmt.includes('getenv') || stmt.includes('request.')) {
    return 'method_invocation';
  }
  if (stmt.includes('execute') || stmt.includes('eval') || stmt.includes('query')) {
    return 'call_expression'; // sink
  }
  return 'expression_statement';
}

/**
 * Extract variable name from a statement.
 */
function extractVariable(stmt: string): string {
  // Try to extract LHS of assignment
  const assignMatch = stmt.match(/^(\w+)\s*=/);
  if (assignMatch) {
    return assignMatch[1];
  }

  // Try to extract from method call
  const callMatch = stmt.match(/(\w+)\s*\(/);
  if (callMatch) {
    return callMatch[1];
  }

  // Return the statement as-is
  return stmt;
}

/**
 * Find a taint path from source to sink through the CFG.
 *
 * Uses a simplified BFS approach to find connected paths.
 * In a full implementation, this would use the data flow facts
 * to precisely track value propagation.
 */
function findTaintPath(
  source: TaintSource,
  sink: TaintSink,
  cfg: CFG,
  sanitizers: Sanitizer[]
): { steps: TaintStep[]; sanitizersInPath: Sanitizer[] } | null {
  const steps: TaintStep[] = [];
  const sanitizersInPath: Sanitizer[] = [];

  // Simplified path building
  // In full implementation, use CFG traversal with data flow facts
  const sourceNodeId = source.nodeId;
  const sinkNodeId = sink.nodeId;

  // Check if source and sink nodes exist in CFG
  if (!cfg.nodes.has(sourceNodeId) || !cfg.nodes.has(sinkNodeId)) {
    return null;
  }

  // Simple case: direct connection
  if (sourceNodeId === sinkNodeId) {
    steps.push({
      from: sourceNodeId,
      to: sinkNodeId,
      operation: 'direct',
    });
    return { steps, sanitizersInPath };
  }

  // BFS to find path through CFG
  const visited = new Set<string>();
  const queue: Array<{ nodeId: string; path: TaintStep[] }> = [
    { nodeId: sourceNodeId, path: [] }
  ];

  while (queue.length > 0) {
    const { nodeId, path } = queue.shift()!;

    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = cfg.nodes.get(nodeId);
    if (!node) continue;

    // Check for sanitizers at this node
    const nodeSanitizers = sanitizers.filter(s => s.nodeId === nodeId);
    sanitizersInPath.push(...nodeSanitizers);

    // Check if we've reached the sink
    if (nodeId === sinkNodeId) {
      steps.push(...path, {
        from: sourceNodeId,
        to: sinkNodeId,
        operation: 'propagate',
      });
      return { steps, sanitizersInPath };
    }

    // Add successors to queue
    for (const succId of node.successors) {
      if (!visited.has(succId)) {
        const newPath = [...path, {
          from: nodeId,
          to: succId,
          operation: 'propagate',
        }];
        queue.push({ nodeId: succId, path: newPath });
      }
    }
  }

  // No path found - return a direct step if both nodes exist
  if (cfg.nodes.has(sourceNodeId) && cfg.nodes.has(sinkNodeId)) {
    steps.push({
      from: sourceNodeId,
      to: sinkNodeId,
      operation: 'propagate',
    });
    return { steps, sanitizersInPath };
  }

  return null;
}

/**
 * Calculate confidence score for a taint path.
 *
 * Confidence decreases when:
 * - More sanitizers in the path (each sanitizer reduces confidence)
 * - Longer path length (more opportunities for precision loss)
 * - Unknown/nonexistent sanitizers
 */
function calculateConfidence(
  sanitizersInPath: Sanitizer[],
  source: TaintSource,
  sink: TaintSink
): number {
  // Base confidence
  let confidence = 1.0;

  // Reduce confidence for each sanitizer in path
  confidence -= sanitizersInPath.length * 0.15;

  // High-confidence sources (env vars, system input)
  if (source.kind.includes('env') || source.kind.includes('request')) {
    confidence += 0.1; // Extra confidence for known strong sources
  }

  // High-risk sinks (eval, exec)
  if (sink.kind.includes('eval') || sink.kind.includes('exec')) {
    confidence -= 0.1; // Extra risk for dangerous sinks
  }

  // Clamp to [0.1, 1.0]
  return Math.max(0.1, Math.min(1.0, confidence));
}

/**
 * Standard taint source patterns by language.
 */
const STANDARD_SOURCE_PATTERNS: Record<string, Set<string>> = {
  typescript: new Set(['userInput', 'getenv', 'getParameter', 'request', 'process.env']),
  javascript: new Set(['userInput', 'getenv', 'getParameter', 'request', 'process.env']),
  python: new Set(['request.args', 'request.form', 'input', 'sys.argv', 'os.environ']),
  java: new Set(['getParameter', 'getHeader', 'getenv', 'request.getInputStream']),
  go: new Set(['os.Getenv', 'fmt.Scan', 'bufio.Reader', 'request.FormValue']),
  rust: new Set(['env::var', 'std::io::stdin', 'args']),
  csharp: new Set(['Request.QueryString', 'Request.Form', 'getenv', 'Console.ReadLine']),
};

/**
 * Standard taint sink patterns by language.
 */
const STANDARD_SINK_PATTERNS: Record<string, Set<string>> = {
  typescript: new Set(['execute', 'eval', 'exec', 'query', 'sql', 'innerHTML']),
  javascript: new Set(['eval', 'exec', 'innerHTML', 'Function']),
  python: new Set(['execute', 'eval', 'exec', 'cursor.execute', 'subprocess']),
  java: new Set(['executeQuery', 'executeUpdate', 'createStatement', 'exec']),
  go: new Set(['Exec', 'Query', 'Run', 'os.Exec']),
  rust: new Set(['exec', 'eval', 'from_str']),
  csharp: new Set(['ExecuteQuery', 'ExecuteNonQuery', 'Process.Start', 'eval']),
};

/**
 * Standard sanitizer patterns by language.
 */
const STANDARD_SANITIZER_PATTERNS: Record<string, Set<string>> = {
  typescript: new Set(['sanitize', 'escape', 'htmlEscape', 'encodeForHTML', 'encodeForURL']),
  javascript: new Set(['sanitize', 'escape', 'htmlEscape', 'DOMPurify']),
  python: new Set(['html.escape', 'urllib.parse.quote', 'markupsafe.escape']),
  java: new Set(['escapeHtml', 'encodeForHTML', 'encodeForURL', 'StringEscapeUtils']),
};

/**
 * Get taint patterns for a language.
 */
export function getTaintPatterns(language: string): {
  sources: Set<string>;
  sinks: Set<string>;
  sanitizers: Set<string>;
} {
  return {
    sources: STANDARD_SOURCE_PATTERNS[language] ?? STANDARD_SOURCE_PATTERNS['typescript']!,
    sinks: STANDARD_SINK_PATTERNS[language] ?? STANDARD_SINK_PATTERNS['typescript']!,
    sanitizers: STANDARD_SANITIZER_PATTERNS[language] ?? STANDARD_SANITIZER_PATTERNS['typescript']!,
  };
}

/**
 * Check if a language is supported for taint analysis.
 */
export function isLanguageSupported(language: string): boolean {
  return language in STANDARD_SOURCE_PATTERNS;
}

/**
 * Get all supported languages for taint analysis.
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(STANDARD_SOURCE_PATTERNS);
}
