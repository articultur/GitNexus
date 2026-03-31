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

  /**
   * Escape regex special characters in a string.
   */
  function escapeRegex(str: string): string {
    return str.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  }

  /**
   * Check if a statement contains a function call pattern (more precise than simple includes).
   */
  function hasFunctionCall(stmt: string, pattern: string): boolean {
    // Match word boundary before pattern, followed by any chars (except paren) and opening paren.
    // This allows "execute" to match "executeQuery(" and "request.args.get" to match "request.args.get("
    const regex = new RegExp('\\b' + escapeRegex(pattern) + '[^)]*\\(', 'g');
    return regex.test(stmt);
  }

  // Scan CFG for sources, sinks, and sanitizers using improved pattern matching
  // Uses function call patterns for better precision (reduces false positives from variable names)
  for (const [nodeId, node] of cfg.nodes) {
    for (const stmt of node.basicBlock) {
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
            variable: extractVariable(stmt),
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
            variable: extractVariable(stmt),
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
            variable: extractVariable(stmt),
            description: 'Sanitizer: ' + pattern + '()',
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
  // BFS to find path from source node to sink node
  const queue: Array<{ nodeId: string; path: TaintStep[]; sanitizersInPath: Sanitizer[] }> = [
    { nodeId: source.nodeId, path: [], sanitizersInPath: [] }
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { nodeId, path, sanitizersInPath } = queue.shift()!;

    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = cfg.nodes.get(nodeId);
    if (!node) continue;

    // Check if this node has a sanitizer
    const nodeSanitizers = sanitizers.filter(s => s.nodeId === nodeId);
    const updatedSanitizers = [...sanitizersInPath, ...nodeSanitizers];

    // Check if this is the sink
    if (nodeId === sink.nodeId && path.length > 0) {
      return { steps: path, sanitizersInPath: updatedSanitizers };
    }

    // Continue BFS along successors
    for (const succ of node.successors) {
      const step: TaintStep = {
        from: nodeId,
        to: succ,
        operation: 'propagate',
      };
      queue.push({ nodeId: succ, path: [...path, step], sanitizersInPath: updatedSanitizers });
    }
  }

  // If we found sink but path was empty, return direct connection
  if (source.nodeId === sink.nodeId) {
    return { steps: [], sanitizersInPath: [] };
  }

  return undefined;
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
 * Extract variable name from a statement.
 * For "x = userInput()", returns "x".
 * For "userInput()", returns "userInput".
 */
function extractVariable(stmt: string): string {
  // Handle assignment patterns: "x = func()" or "let x = func()"
  const assignMatch = stmt.match(/^\s*(?:let|const|var)?\s*(\w+)\s*=/);
  if (assignMatch) {
    return assignMatch[1];
  }

  // Handle direct function call: "func()"
  const callMatch = stmt.match(/^\s*(\w+)\s*\(/);
  if (callMatch) {
    return callMatch[1];
  }

  return stmt.trim().split(' ')[0] || stmt;
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
