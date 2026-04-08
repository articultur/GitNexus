/**
 * cfg-from-tsg.ts
 *
 * Phase 4: Integration layer bridging tree-sitter-graph DSL output to the
 * GitNexus CFGResult format consumed by the DFA engine.
 *
 * Pipeline:
 *   Source file → tree-sitter-graph CLI → TSG JSON
 *     → parseTSGOutput() → postProcessTSGGraph() → tsgToCFGResult()
 *
 * Dynamic scope (BREAK/CONTINUE/THROW/CATCH) is resolved by the
 * TypeScript post-processor, not Rust host functions.
 *
 * Requires: tree-sitter-graph CLI (`cargo install --features cli tree-sitter-graph`)
 */

import { execFileSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseTSGOutput, postProcessTSGGraph, tsgToCFGResult } from './cfg-post-processor.js';
import type { CFGResult } from './types.js';
import type { SyntaxNode } from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';

// ESM: define __dirname for compatibility with CommonJS-style path construction
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Re-export for convenience
export { parseTSGOutput, postProcessTSGGraph } from './cfg-post-processor.js';
export type { TSGNode, CFGNode, CFGEdge } from './cfg-post-processor.js';

/** Function node types across languages */
const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'class_method',
  'constructor',
  'program',
]);

/**
 * Extract function name from a function node.
 */
function extractFunctionName(node: SyntaxNode): string | null {
  const nameNode =
    node.childForFieldName('name') ??
    node.childForFieldName('identifier') ??
    node.childForFieldName('property_identifier') ??
    node.childForFieldName('simple_identifier') ??
    node.childForFieldName('field_identifier');
  if (nameNode?.text) return nameNode.text;
  return null;
}

/**
 * Extract function ID from a tree root node.
 */
function extractFunctionId(rootNode: SyntaxNode): string | null {
  for (const child of rootNode.namedChildren) {
    if (FUNCTION_NODE_TYPES.has(child.type)) {
      return extractFunctionName(child) ?? null;
    }
  }
  return null;
}

/**
 * Supported language → tree-sitter-graph DSL file mapping.
 * Each DSL file handles the AST node patterns for that language.
 */
const LANGUAGE_DSL_MAP: Record<string, string> = {
  typescript: 'typescript-static-edges.sg',
  javascript: 'javascript-static-edges.sg',
  python: 'python-static-edges.sg',
  java: 'java-static-edges.sg',
  go: 'go-static-edges.sg',
  kotlin: 'kotlin-static-edges.sg',
  csharp: 'csharp-static-edges.sg',
  rust: 'rust-static-edges.sg',
  c: 'c-static-edges.sg',
  cpp: 'cpp-static-edges.sg',
  objectivec: 'objectivec-static-edges.sg',
};

/** Directories searched for DSL files, in priority order */
const DSL_SEARCH_PATHS = [
  // Relative to compiled output — resolves correctly in both src (dev) and dist (prod)
  join(__dirname, 'dsl'),
];

/**
 * Find the tree-sitter-graph CLI executable.
 * Searches PATH and common installation locations.
 */
function findTSGCLI(): string {
  const candidates = [
    // Installed via cargo
    process.env.HOME ? join(process.env.HOME, '.cargo', 'bin', 'tree-sitter-graph') : null,
    // System PATH
    'tree-sitter-graph',
    // Common macOS Homebrew location
    '/usr/local/bin/tree-sitter-graph',
    '/opt/homebrew/bin/tree-sitter-graph',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate!)) return candidate!;
  }

  // Try PATH lookup by checking each directory
  const pathDirs = process.env.PATH?.split(':') ?? [];
  for (const dir of pathDirs) {
    const full = join(dir, 'tree-sitter-graph');
    if (existsSync(full)) return full;
  }

  throw new Error(
    'tree-sitter-graph CLI not found. Install with:\n' +
      '  cargo install --features cli tree-sitter-graph\n' +
      'See: https://github.com/tree-sitter/tree-sitter-graph',
  );
}

/**
 * Find a DSL file by language name, searching all DSL_SEARCH_PATHS.
 */
function findDSLFile(language: string): string {
  const dslName = LANGUAGE_DSL_MAP[language];
  if (!dslName) {
    throw new Error(
      `No tree-sitter-graph DSL file for language "${language}". ` +
        `Supported: ${Object.keys(LANGUAGE_DSL_MAP).join(', ')}`,
    );
  }

  for (const dir of DSL_SEARCH_PATHS) {
    const full = join(dir, dslName);
    if (existsSync(full)) return full;
  }

  throw new Error(
    `DSL file "${dslName}" not found in any search path:\n` +
      DSL_SEARCH_PATHS.map((p) => `  - ${p}`).join('\n'),
  );
}

/**
 * Build a CFG using the tree-sitter-graph DSL pipeline.
 *
 * This is the Phase 4 integration function that can replace the imperative
 * cfg-builder.ts for languages where a DSL file exists.
 *
 * @param tree      Parsed tree from tree-sitter
 * @param source    Original source text
 * @param language  Supported language (e.g. 'typescript', 'javascript')
 * @param functionId Optional function identifier
 * @returns CFGResult compatible with dfa-engine
 */
export function buildCFGFromTSG(
  tree: { rootNode: SyntaxNode },
  source: string,
  language: SupportedLanguages,
  functionId?: string,
): CFGResult {
  const fid = functionId ?? extractFunctionId(tree.rootNode) ?? 'anonymous';
  const langKey = language.toLowerCase();

  const tsgCLI = findTSGCLI();
  const dslFile = findDSLFile(langKey);

  // Write source to a temp file (tree-sitter-graph uses file extension to infer language)
  const EXT_MAP: Record<string, string> = {
    typescript: 'ts',
    javascript: 'js',
    python: 'py',
  };
  const ext = EXT_MAP[langKey] ?? 'txt';
  const tmpSource = join(
    process.env.TMPDIR ?? '/tmp',
    `gitnexus-tsg-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`,
  );
  writeFileSync(tmpSource, source);

  try {
    // Run: tree-sitter-graph <dsl> <source>
    // CLI usage: tree-sitter-graph [OPTIONS] <tsg> <source>
    // Using execFileSync with array args avoids shell injection since all paths are controlled
    const json = execFileSync(tsgCLI, ['--json', dslFile, tmpSource], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }).trim();

    // Parse TSG JSON → CFGNode[] + CFGEdge[]
    const { nodes, edges } = parseTSGOutput(json);

    // Post-process: resolve dynamic scope (BREAK/CONTINUE/THROW/CATCH) with AST parent-walking
    const { edges: processedEdges } = postProcessTSGGraph(nodes, edges, tree);

    // Adapt to CFGResult
    return tsgToCFGResult(nodes, processedEdges, fid);
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tmpSource);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Check whether tree-sitter-graph CLI and DSL files are available.
 * Useful for feature detection without throwing.
 */
export function isTSGAvailable(): { cli: boolean; dsl: Record<string, boolean> } {
  let cli = false;
  try {
    findTSGCLI();
    cli = true;
  } catch {
    /* not available */
  }

  const dsl: Record<string, boolean> = {};
  for (const lang of Object.keys(LANGUAGE_DSL_MAP)) {
    try {
      findDSLFile(lang);
      dsl[lang] = true;
    } catch {
      dsl[lang] = false;
    }
  }

  return { cli, dsl };
}
