/**
 * COBOL tree-sitter Adapter — Experimental PoC
 *
 * ─────────────────────── Evaluation Summary ──────────────────────────────
 *
 * Package evaluated: `tree-sitter-cobol@0.0.1` (latest as of 2026-04-09)
 *
 * Findings:
 *   1. Still at 0.0.1 — no new release since initial publication; no community
 *      maintenance activity visible.
 *   2. The known critical issue (external scanner hangs indefinitely on ~5% of
 *      production COBOL files, including those with Italian comments, vendor
 *      patch markers, or dialect extensions) is NOT fixed.
 *   3. No other viable tree-sitter-based COBOL grammar exists on npm.
 *   4. ANTLR4 options (proleap-cobol-parser) remain Java-only; generating a
 *      JavaScript ANTLR4 target from the .g4 grammar is a 1–2 week project.
 *
 * Conclusion (2026-04-09):
 *   The regex processor (`cobol-preprocessor.ts`) REMAINS the recommended
 *   production implementation. It is faster, dialect-tolerant, and tested.
 *
 *   tree-sitter-cobol becomes viable only if:
 *     (a) the external scanner hang is resolved upstream, AND
 *     (b) dialect coverage is extended.
 *
 *   This module provides a timeout-guarded proof-of-concept that makes
 *   tree-sitter-cobol safe to use experimentally. It is enabled via the
 *   `GITNEXUS_COBOL_TREESITTER` environment variable and NEVER affects the
 *   default production path.
 *
 * ─────────────────────── PoC Design ─────────────────────────────────────
 *
 * The core safety problem — the external scanner hang — is solved by spawning
 * the tree-sitter parse inside a Worker thread and killing it after a
 * configurable timeout (default 2 s per file). This makes tree-sitter-cobol
 * safe to evaluate against real production files without risk of blocking the
 * main ingestion pipeline.
 *
 * Usage (experimental, opt-in only):
 *
 *   GITNEXUS_COBOL_TREESITTER=1 gitnexus analyze
 *
 * Output comparison mode (logs regex vs tree-sitter symbol counts to stderr):
 *
 *   GITNEXUS_COBOL_TREESITTER=compare gitnexus analyze
 *
 * Architecture:
 *
 *   CobolTreeSitterAdapter.extractSymbols(content, filePath)
 *     → spawn Worker(cobol-treesitter-worker.js, {content})
 *       → Worker imports tree-sitter + tree-sitter-cobol
 *       → Worker traverses AST, emits CobolTsSummary
 *       → Main thread receives result or kills Worker after timeout
 *     → on timeout/error: throw CobolTreeSitterTimeoutError
 *
 * The adapter is deliberately kept thin so it can be swapped for a future
 * tree-sitter-cobol version without touching `cobol-preprocessor.ts`.
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

// ─── Public types ─────────────────────────────────────────────────────────

export interface CobolTsSymbol {
  type: 'program' | 'paragraph' | 'section' | 'data-item' | 'call';
  name: string;
  startLine: number;
}

export interface CobolTsSummary {
  symbols: CobolTsSymbol[];
  parseTimeMs: number;
}

export class CobolTreeSitterTimeoutError extends Error {
  constructor(filePath: string, timeoutMs: number) {
    super(
      `tree-sitter-cobol parse timed out after ${timeoutMs}ms for "${filePath}". ` +
        `This is a known issue with tree-sitter-cobol@0.0.1's external scanner. ` +
        `Falling back to regex processor.`,
    );
    this.name = 'CobolTreeSitterTimeoutError';
  }
}

// ─── Feature flags ────────────────────────────────────────────────────────

/**
 * Whether the tree-sitter experimental path is active.
 *   - `false`     → disabled (default production behaviour)
 *   - `true`      → tree-sitter replaces regex
 *   - `'compare'` → both run; symbol counts logged to stderr for evaluation
 */
export type CobolTsMode = false | true | 'compare';

export function getCobolTsMode(): CobolTsMode {
  const env = process.env.GITNEXUS_COBOL_TREESITTER;
  if (!env) return false;
  if (env === 'compare') return 'compare';
  if (env === '1' || env === 'true') return true;
  return false;
}

// ─── Worker inline code ───────────────────────────────────────────────────

/**
 * Inline worker source — avoids a separate file.
 *
 * The worker attempts to:
 *   1. Import tree-sitter and tree-sitter-cobol (both optional dependencies)
 *   2. Parse the COBOL source
 *   3. Walk the syntax tree and extract symbols via node type inspection
 *   4. Post the result back to the parent thread
 *
 * Node types targeted (tree-sitter-cobol@0.0.1 grammar):
 *   - `program_id_paragraph`  → program name
 *   - `paragraph`             → paragraph name
 *   - `section`               → section name
 *   - `data_description_entry` → data item (level 01/77/88)
 *   - `call_statement`        → CALL target
 */
const WORKER_CODE = /* js */ `
import { parentPort, workerData } from 'worker_threads';

async function run() {
  const startTime = performance.now();
  try {
    // Dynamic import — tree-sitter-cobol is an optional dependency
    const Parser = (await import('tree-sitter')).default;
    const CobolLanguage = (await import('tree-sitter-cobol')).default;

    const parser = new Parser();
    parser.setLanguage(CobolLanguage);

    const tree = parser.parse(workerData.content);
    const symbols = [];

    function walk(node) {
      switch (node.type) {
        case 'program_id_paragraph':
          symbols.push({ type: 'program', name: node.firstNamedChild?.text ?? '', startLine: node.startPosition.row + 1 });
          break;
        case 'paragraph_name_definition':
          symbols.push({ type: 'paragraph', name: node.text ?? '', startLine: node.startPosition.row + 1 });
          break;
        case 'section_name_definition':
          symbols.push({ type: 'section', name: node.text ?? '', startLine: node.startPosition.row + 1 });
          break;
        case 'data_description_entry': {
          const nameNode = node.childForFieldName?.('name') ?? node.firstNamedChild;
          if (nameNode) symbols.push({ type: 'data-item', name: nameNode.text ?? '', startLine: node.startPosition.row + 1 });
          break;
        }
        case 'call_statement': {
          const target = node.childForFieldName?.('target') ?? node.firstNamedChild;
          if (target) symbols.push({ type: 'call', name: target.text?.replace(/['"]/g, '') ?? '', startLine: node.startPosition.row + 1 });
          break;
        }
      }
      for (const child of node.children) walk(child);
    }

    walk(tree.rootNode);
    parentPort.postMessage({ ok: true, symbols, parseTimeMs: performance.now() - startTime });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
}

run();
`;

// ─── Main adapter ─────────────────────────────────────────────────────────

/**
 * Options for CobolTreeSitterAdapter.
 */
export interface CobolTreeSitterAdapterOptions {
  /** Timeout per file in milliseconds. Default: 2000. */
  timeoutMs?: number;
}

/**
 * Experimental adapter that wraps tree-sitter-cobol in a Worker thread with
 * a configurable timeout. Safe to use against arbitrary production COBOL files
 * because hangs are bounded by the timeout.
 *
 * This class is only instantiated when `GITNEXUS_COBOL_TREESITTER` is set and
 * tree-sitter + tree-sitter-cobol are installed.
 */
export class CobolTreeSitterAdapter {
  private readonly timeoutMs: number;

  constructor(options: CobolTreeSitterAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 2000;
  }

  /**
   * Extract symbols from COBOL source content using tree-sitter-cobol.
   *
   * @throws CobolTreeSitterTimeoutError if the Worker exceeds the timeout.
   * @throws Error if tree-sitter or tree-sitter-cobol are not installed.
   */
  async extractSymbols(content: string, filePath: string): Promise<CobolTsSummary> {
    return new Promise<CobolTsSummary>((resolve, reject) => {
      const worker = new Worker(WORKER_CODE, {
        eval: true,
        workerData: { content },
      });

      const timer = setTimeout(() => {
        worker.terminate();
        reject(new CobolTreeSitterTimeoutError(filePath, this.timeoutMs));
      }, this.timeoutMs);

      worker.on(
        'message',
        (msg: { ok: boolean; symbols?: CobolTsSymbol[]; parseTimeMs?: number; error?: string }) => {
          clearTimeout(timer);
          worker.terminate();
          if (msg.ok) {
            resolve({ symbols: msg.symbols ?? [], parseTimeMs: msg.parseTimeMs ?? 0 });
          } else {
            reject(new Error(`tree-sitter-cobol worker error: ${msg.error}`));
          }
        },
      );

      worker.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Convenience helper that returns `null` instead of throwing on timeout.
   * Useful in 'compare' mode where the regex result is always the authoritative one.
   */
  async tryExtractSymbols(content: string, filePath: string): Promise<CobolTsSummary | null> {
    try {
      return await this.extractSymbols(content, filePath);
    } catch {
      return null;
    }
  }
}

// ─── Singleton factory ────────────────────────────────────────────────────

let _adapterInstance: CobolTreeSitterAdapter | null = null;

/**
 * Get or create the singleton adapter instance.
 * Returns `null` if the experimental mode is disabled.
 */
export function getCobolTreeSitterAdapter(): CobolTreeSitterAdapter | null {
  if (!getCobolTsMode()) return null;
  if (!_adapterInstance) {
    _adapterInstance = new CobolTreeSitterAdapter();
  }
  return _adapterInstance;
}
