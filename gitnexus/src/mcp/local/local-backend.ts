/**
 * Local Backend (Multi-Repo)
 *
 * Provides tool implementations using local .gitnexus/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * LadybugDB connections are opened lazily per repo on first query.
 */

import fs from 'fs/promises';
import path from 'path';
import {
  initLbug,
  executeQuery,
  executeParameterized,
  closeLbug,
  isLbugReady,
  isWriteQuery,
} from '../../core/lbug/pool-adapter.js';
export { isWriteQuery };
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at MCP server startup — crashes on unsupported Node ABI versions (#89)
// git utilities available if needed
// import { isGitRepo, getCurrentCommit, getGitRoot } from '../../storage/git.js';
import {
  listRegisteredRepos,
  cleanupOldKuzuFiles,
  type RegistryEntry,
} from '../../storage/repo-manager.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { isLanguageAvailable } from '../../core/tree-sitter/parser-loader.js';
import { GroupService, type GroupToolPort } from '../../core/group/service.js';
import { resolveLLMConfig, callLLM } from '../../core/wiki/llm-client.js';
// AI context generation is CLI-only (gitnexus analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';

// ─── Tool module imports ─────────────────────────────────────────────────────
import { contextTool, exploreTool } from './tools/context.js';
import { overviewTool, aggregateClusters, formatCypherAsMarkdown } from './tools/overview.js';
import { detectChangesTool } from './tools/detect.js';
import { renameTool } from './tools/rename.js';
import { impactTool, impactByUidTool } from './tools/impact.js';
import { testImpactTool } from './tools/test-impact.js';

/**
 * Quick test-file detection for filtering impact results.
 * Matches common test file patterns across all supported languages.
 */
export function isTestFilePath(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.includes('__tests__/') ||
    p.includes('__mocks__/') ||
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/testing/') ||
    p.includes('/fixtures/') ||
    p.endsWith('_test.go') ||
    p.endsWith('_test.py') ||
    p.endsWith('_spec.rb') ||
    p.endsWith('_test.rb') ||
    p.includes('/spec/') ||
    p.includes('/test_') ||
    p.includes('/conftest.')
  );
}

/** Valid LadybugDB node labels for safe Cypher query construction */
export const VALID_NODE_LABELS = new Set([
  'File',
  'Folder',
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Community',
  'Process',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
  'Route',
  'Tool',
]);

/** Valid relation types for impact analysis filtering */
export const VALID_RELATION_TYPES = new Set([
  'CALLS',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'METHOD_OVERRIDES',
  'OVERRIDES', // Legacy alias — dual-read for pre-rename indexes
  'METHOD_IMPLEMENTS',
  'ACCESSES',
  'HANDLES_ROUTE',
  'FETCHES',
  'HANDLES_TOOL',
  'ENTRY_POINT_OF',
  'WRAPS',
  'DATA_FLOW',
  'TAINTED',
  'SINK_REACHABLE',
  'PROPAGATES',
  'RETURNS',
  'SANITIZES',
  'ALIASES',
]);

/**
 * Per-relation-type confidence floor for impact analysis.
 *
 * When the graph stores a relation with a confidence value, that stored
 * value is used as-is (it reflects resolution-tier accuracy from analysis
 * time).  This map provides the floor for each edge type when no stored
 * confidence is available, and is also used for display / tooltip hints.
 *
 * Rationale:
 *   CALLS / IMPORTS  – direct, strongly-typed references → 0.9
 *   EXTENDS          – class hierarchy, statically verifiable → 0.85
 *   IMPLEMENTS       – interface contract, statically verifiable → 0.85
 *   METHOD_OVERRIDES  – method override, statically verifiable → 0.85
 *   METHOD_IMPLEMENTS – interface method implementation, statically verifiable → 0.85
 *   HAS_METHOD       – structural containment → 0.95
 *   HAS_PROPERTY     – structural containment → 0.95
 *   ACCESSES         – field read/write, may be indirect → 0.8
 *   CONTAINS         – folder/file containment → 0.95
 *   (unknown type)   – conservative fallback → 0.5
 */
export const IMPACT_RELATION_CONFIDENCE: Readonly<Record<string, number>> = {
  CALLS: 0.9,
  IMPORTS: 0.9,
  EXTENDS: 0.85,
  IMPLEMENTS: 0.85,
  METHOD_OVERRIDES: 0.85,
  METHOD_IMPLEMENTS: 0.85,
  HAS_METHOD: 0.95,
  HAS_PROPERTY: 0.95,
  ACCESSES: 0.8,
  CONTAINS: 0.95,
  DATA_FLOW: 0.75,
  TAINTED: 0.7,
  SINK_REACHABLE: 0.7,
  PROPAGATES: 0.75,
  RETURNS: 0.85,
  SANITIZES: 0.7,
  ALIASES: 0.8,
};

/**
 * Return the confidence floor for a given relation type.
 * Falls back to 0.5 for unknown types so they are not silently elevated.
 */
const confidenceForRelType = (relType: string | undefined): number =>
  IMPACT_RELATION_CONFIDENCE[relType ?? ''] ?? 0.5;

/** Filter and normalize relation types for impact analysis. Returns defaults if none survive. */
const filterRelationTypes = (raw?: string[]): string[] => {
  const filtered = raw && raw.length > 0 ? raw.filter((t) => VALID_RELATION_TYPES.has(t)) : [];
  return filtered.length > 0 ? filtered : ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
};

/** Structured error logging for query failures — replaces empty catch blocks */
function logQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`GitNexus [${context}]: ${msg}`);
}

/** Shared params for impact analysis methods */
interface ImpactParams {
  target: string;
  direction: 'upstream' | 'downstream';
  maxDepth?: number;
  relationTypes?: string[];
  includeTests?: boolean;
  minConfidence?: number;
  /** When false, omit the `evidence` block from the response. Default: true */
  include_evidence?: boolean;
  /** When true, include source code content for each impacted symbol. */
  include_content?: boolean;
  /** File path to filter impact results to a specific file. */
  file_path?: string;
}

export interface CodebaseContext {
  projectName: string;
  stats: {
    fileCount: number;
    functionCount: number;
    communityCount: number;
    processCount: number;
  };
}

export interface RepoOverview {
  context: CodebaseContext;
  maintainability: {
    fileImportCycles: number;
    oversizedSymbols: number;
    crossModuleEdges: number;
    hotspots: {
      incoming: Array<{ name: string; filePath: string; count: number }>;
      outgoing: Array<{ name: string; filePath: string; count: number }>;
    };
  };
  coverage: {
    parserCoverage: {
      available: number;
      total: number;
    };
    languages: Array<{
      language: string;
      parserMode: 'tree-sitter' | 'standalone';
      parserAvailable: boolean;
      status: 'available' | 'unavailable' | 'standalone';
      note?: string;
    }>;
    blindSpots: string[];
    analysisConfidence: 'high' | 'medium' | 'low';
  };
}

interface RepoHandle {
  id: string; // unique key = repo name (basename)
  name: string;
  repoPath: string;
  storagePath: string;
  lbugPath: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RegistryEntry['stats'];
}

export class LocalBackend {
  private repos: Map<string, RepoHandle> = new Map();
  private contextCache: Map<string, CodebaseContext> = new Map();
  private initializedRepos: Set<string> = new Set();
  private reinitPromises: Map<string, Promise<void>> = new Map();
  private lastStalenessCheck: Map<string, number> = new Map();
  private groupToolSvc: GroupService | null = null;

  /**
   * Cross-repo group tools (CLI). Shares logic with MCP `group_*` handlers.
   */
  getGroupService(): GroupService {
    if (!this.groupToolSvc) {
      const port: GroupToolPort = {
        resolveRepo: (p) => this.resolveRepo(p),
        impact: (r, p) => this.impact(r as RepoHandle, p),
        query: (r, p) => this.query(r as RepoHandle, p),
        impactByUid: (id, uid, d, o) => this.impactByUid(id, uid, d, o),
      };
      this.groupToolSvc = new GroupService(port);
    }
    return this.groupToolSvc;
  }

  /** Close all pooled LadybugDB connections (CLI one-shot; optional for long-lived MCP). */
  async dispose(): Promise<void> {
    await closeLbug();
  }

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize from the global registry.
   * Returns true if at least one repo is available.
   */
  async init(): Promise<boolean> {
    await this.refreshRepos();
    return this.repos.size > 0;
  }

  /**
   * Re-read the global registry and update the in-memory repo map.
   * New repos are added, existing repos are updated, removed repos are pruned.
   * LadybugDB connections for removed repos are NOT closed (they idle-timeout naturally).
   */
  private async refreshRepos(): Promise<void> {
    const entries = await listRegisteredRepos({ validate: true });
    const freshIds = new Set<string>();

    for (const entry of entries) {
      const id = this.repoId(entry.name, entry.path);
      freshIds.add(id);

      const storagePath = entry.storagePath;
      const lbugPath = path.join(storagePath, 'lbug');

      // Clean up any leftover KuzuDB files from before the LadybugDB migration.
      // If kuzu exists but lbug doesn't, warn so the user knows to re-analyze.
      const kuzu = await cleanupOldKuzuFiles(storagePath);
      if (kuzu.found && kuzu.needsReindex) {
        console.error(
          `GitNexus: "${entry.name}" has a stale KuzuDB index. Run: gitnexus analyze ${entry.path}`,
        );
      }

      const handle: RepoHandle = {
        id,
        name: entry.name,
        repoPath: entry.path,
        storagePath,
        lbugPath,
        indexedAt: entry.indexedAt,
        lastCommit: entry.lastCommit,
        stats: entry.stats,
      };

      this.repos.set(id, handle);

      // Build lightweight context (no LadybugDB needed)
      const s = entry.stats || {};
      this.contextCache.set(id, {
        projectName: entry.name,
        stats: {
          fileCount: s.files || 0,
          functionCount: s.nodes || 0,
          communityCount: s.communities || 0,
          processCount: s.processes || 0,
        },
      });
    }

    // Prune repos that no longer exist in the registry
    for (const id of this.repos.keys()) {
      if (!freshIds.has(id)) {
        this.repos.delete(id);
        this.contextCache.delete(id);
        this.initializedRepos.delete(id);
      }
    }
  }

  /**
   * Generate a stable repo ID from name + path.
   * If names collide, append a hash of the path.
   */
  private repoId(name: string, repoPath: string): string {
    const base = name.toLowerCase();
    // Check for name collision with a different path
    for (const [id, handle] of this.repos) {
      if (id === base && handle.repoPath !== path.resolve(repoPath)) {
        // Collision — use path hash
        const hash = Buffer.from(repoPath).toString('base64url').slice(0, 6);
        return `${base}-${hash}`;
      }
    }
    return base;
  }

  // ─── Repo Resolution ─────────────────────────────────────────────

  /**
   * Resolve which repo to use.
   * - If repoParam is given, match by name or path
   * - If only 1 repo, use it
   * - If 0 or multiple without param, throw with helpful message
   *
   * On a miss, re-reads the registry once in case a new repo was indexed
   * while the MCP server was running.
   */
  async resolveRepo(repoParam?: string): Promise<RepoHandle> {
    const result = this.resolveRepoFromCache(repoParam);
    if (result) return result;

    // Miss — refresh registry and try once more
    await this.refreshRepos();
    const retried = this.resolveRepoFromCache(repoParam);
    if (retried) return retried;

    // Still no match — throw with helpful message
    if (this.repos.size === 0) {
      throw new Error('No indexed repositories. Run: gitnexus analyze');
    }
    if (repoParam) {
      const names = [...this.repos.values()].map((h) => h.name);
      throw new Error(`Repository "${repoParam}" not found. Available: ${names.join(', ')}`);
    }
    const names = [...this.repos.values()].map((h) => h.name);
    throw new Error(
      `Multiple repositories indexed. Specify which one with the "repo" parameter. Available: ${names.join(', ')}`,
    );
  }

  /**
   * Try to resolve a repo from the in-memory cache. Returns null on miss.
   */
  private resolveRepoFromCache(repoParam?: string): RepoHandle | null {
    if (this.repos.size === 0) return null;

    if (repoParam) {
      const paramLower = repoParam.toLowerCase();
      // Match by id
      if (this.repos.has(paramLower)) return this.repos.get(paramLower)!;
      // Match by name (case-insensitive)
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase() === paramLower) return handle;
      }
      // Match by path (substring)
      const resolved = path.resolve(repoParam);
      for (const handle of this.repos.values()) {
        if (handle.repoPath === resolved) return handle;
      }
      // Match by partial name
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase().includes(paramLower)) return handle;
      }
      return null;
    }

    if (this.repos.size === 1) {
      return this.repos.values().next().value!;
    }

    return null; // Multiple repos, no param — ambiguous
  }

  // ─── Lazy LadybugDB Init ────────────────────────────────────────────

  private async ensureInitialized(repoId: string): Promise<void> {
    // If a reinit is already in progress for this repo, wait for it
    const pending = this.reinitPromises.get(repoId);
    if (pending) return pending;

    const handle = this.repos.get(repoId);
    if (!handle) throw new Error(`Unknown repo: ${repoId}`);

    // Check if the index was rebuilt since we opened the connection (#297).
    // Throttle staleness checks to at most once per 5 seconds per repo to
    // avoid an fs.readFile round-trip on every tool invocation.
    if (this.initializedRepos.has(repoId) && isLbugReady(repoId)) {
      const now = Date.now();
      const lastCheck = this.lastStalenessCheck.get(repoId) ?? 0;
      if (now - lastCheck < 5000) return; // Checked recently — skip

      this.lastStalenessCheck.set(repoId, now);
      try {
        const metaPath = path.join(handle.storagePath, 'meta.json');
        const metaRaw = await fs.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(metaRaw);
        if (meta.indexedAt && meta.indexedAt !== handle.indexedAt) {
          // Index was rebuilt — close stale connection and re-init.
          // Wrap in reinitPromises to prevent TOCTOU race where concurrent
          // callers both detect staleness and double-close the pool.
          const reinit = (async () => {
            try {
              await closeLbug(repoId);
              this.initializedRepos.delete(repoId);
              handle.indexedAt = meta.indexedAt;
              await initLbug(repoId, handle.lbugPath);
              this.initializedRepos.add(repoId);
            } finally {
              this.reinitPromises.delete(repoId);
            }
          })();
          this.reinitPromises.set(repoId, reinit);
          return reinit;
        } else {
          return; // Pool is current
        }
      } catch {
        return; // Can't read meta — assume pool is fine
      }
    }

    try {
      await initLbug(repoId, handle.lbugPath);
      this.initializedRepos.add(repoId);
    } catch (err: any) {
      // If lock error, mark as not initialized so next call retries
      this.initializedRepos.delete(repoId);
      throw err;
    }
  }

  // ─── Public Getters ──────────────────────────────────────────────

  /**
   * Get context for a specific repo (or the single repo if only one).
   */
  getContext(repoId?: string): CodebaseContext | null {
    if (repoId && this.contextCache.has(repoId)) {
      return this.contextCache.get(repoId)!;
    }
    if (this.repos.size === 1) {
      return this.contextCache.values().next().value ?? null;
    }
    return null;
  }

  async queryRepoOverview(repoName?: string): Promise<RepoOverview> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const context = this.getContext(repo.id) ||
      this.getContext() || {
        projectName: repo.name,
        stats: {
          fileCount: repo.stats?.files || 0,
          functionCount: repo.stats?.nodes || 0,
          communityCount: repo.stats?.communities || 0,
          processCount: repo.stats?.processes || 0,
        },
      };

    const [fileImportCycles, oversizedSymbols, crossModuleEdges, topIncoming, topOutgoing] =
      await Promise.all([
        executeQuery(
          repo.id,
          `
          MATCH (a:File)-[:CodeRelation {type: 'IMPORTS'}]->(b:File)
          MATCH (b)-[:CodeRelation {type: 'IMPORTS'}]->(a)
          WHERE a.id < b.id
          RETURN COUNT(*) AS count
        `,
        ).catch(() => []),
        executeQuery(
          repo.id,
          `
          MATCH (n)
          WHERE labels(n)[0] IN ['Function', 'Method', 'Class']
            AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL
            AND (
              (labels(n)[0] IN ['Function', 'Method'] AND (n.endLine - n.startLine + 1) >= 80)
              OR (labels(n)[0] = 'Class' AND (n.endLine - n.startLine + 1) >= 200)
            )
          RETURN COUNT(*) AS count
        `,
        ).catch(() => []),
        executeQuery(
          repo.id,
          `
          MATCH (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(c1:Community)
          MATCH (a)-[r:CodeRelation]->(b)
          MATCH (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(c2:Community)
          WHERE r.type IN ['CALLS', 'IMPORTS'] AND c1.id <> c2.id
          RETURN COUNT(DISTINCT r) AS count
        `,
        ).catch(() => []),
        executeQuery(
          repo.id,
          `
          MATCH (src)-[r:CodeRelation]->(n)
          WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
          RETURN n.name AS name, n.filePath AS filePath, COUNT(*) AS count
          ORDER BY count DESC
          LIMIT 5
        `,
        ).catch(() => []),
        executeQuery(
          repo.id,
          `
          MATCH (n)-[r:CodeRelation]->(dst)
          WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
          RETURN n.name AS name, n.filePath AS filePath, COUNT(*) AS count
          ORDER BY count DESC
          LIMIT 5
        `,
        ).catch(() => []),
      ]);

    const optionalParsers = new Set<string>([
      SupportedLanguages.Kotlin,
      SupportedLanguages.Swift,
      SupportedLanguages.Dart,
      SupportedLanguages.ObjectiveC,
    ]);

    const languages: RepoOverview['coverage']['languages'] = Object.values(SupportedLanguages).map(
      (language) => {
        const parserMode: 'tree-sitter' | 'standalone' =
          language === SupportedLanguages.Cobol ? 'standalone' : 'tree-sitter';
        const parserAvailable =
          parserMode === 'standalone' ? true : isLanguageAvailable(language as SupportedLanguages);
        let note: string | undefined;
        if (language === SupportedLanguages.Cobol) {
          note = 'Regex-based standalone processor';
        } else if (!parserAvailable && optionalParsers.has(language)) {
          note = 'Optional native parser not installed';
        }
        return {
          language,
          parserMode,
          parserAvailable,
          status: (parserMode === 'standalone'
            ? 'standalone'
            : parserAvailable
              ? 'available'
              : 'unavailable') as 'available' | 'unavailable' | 'standalone',
          ...(note ? { note } : {}),
        };
      },
    );

    const availableParserCount = languages.filter(
      (lang) => lang.status === 'available' || lang.status === 'standalone',
    ).length;
    const parserCoverageRatio = availableParserCount / Math.max(languages.length, 1);

    return {
      context,
      maintainability: {
        fileImportCycles: fileImportCycles[0]?.count ?? fileImportCycles[0]?.[0] ?? 0,
        oversizedSymbols: oversizedSymbols[0]?.count ?? oversizedSymbols[0]?.[0] ?? 0,
        crossModuleEdges: crossModuleEdges[0]?.count ?? crossModuleEdges[0]?.[0] ?? 0,
        hotspots: {
          incoming: topIncoming.map((row: any) => ({
            name: row.name ?? row[0] ?? 'unknown',
            filePath: row.filePath ?? row[1] ?? '',
            count: row.count ?? row[2] ?? 0,
          })),
          outgoing: topOutgoing.map((row: any) => ({
            name: row.name ?? row[0] ?? 'unknown',
            filePath: row.filePath ?? row[1] ?? '',
            count: row.count ?? row[2] ?? 0,
          })),
        },
      },
      coverage: {
        parserCoverage: {
          available: availableParserCount,
          total: languages.length,
        },
        languages,
        blindSpots: [
          'Variable-level data flow is not yet modeled end-to-end.',
          'Path-sensitive control-flow reasoning is partial.',
          'Security rule execution and taint propagation are not productized in MCP outputs.',
          'Parser availability can reduce language coverage on optional native grammars.',
        ],
        analysisConfidence:
          parserCoverageRatio >= 0.85 ? 'high' : parserCoverageRatio >= 0.65 ? 'medium' : 'low',
      },
    };
  }

  /**
   * List all registered repos with their metadata.
   * Re-reads the global registry so newly indexed repos are discovered
   * without restarting the MCP server.
   */
  async listRepos(): Promise<
    Array<{ name: string; path: string; indexedAt: string; lastCommit: string; stats?: any }>
  > {
    await this.refreshRepos();
    return [...this.repos.values()].map((h) => ({
      name: h.name,
      path: h.repoPath,
      indexedAt: h.indexedAt,
      lastCommit: h.lastCommit,
      stats: h.stats,
    }));
  }

  // ─── Tool Dispatch ───────────────────────────────────────────────

  async callTool(method: string, params: any): Promise<any> {
    if (method === 'list_repos') {
      return this.listRepos();
    }

    if (method.startsWith('group_')) {
      return this.handleGroupTool(method, params || {});
    }

    // Resolve repo from optional param (re-reads registry on miss)
    const repo = await this.resolveRepo(params?.repo);

    switch (method) {
      case 'query':
        return this.query(repo, params);
      case 'cypher': {
        const raw = await this.cypher(repo, params);
        return formatCypherAsMarkdown(raw);
      }
      case 'context':
        return this.context(repo, params);
      case 'impact':
        return this.impact(repo, params);
      case 'detect_changes':
        return this.detectChanges(repo, params);
      case 'rename':
        return this.rename(repo, params);
      // Legacy aliases for backwards compatibility
      case 'search':
        return this.query(repo, params);
      case 'explore':
        return this.context(repo, { name: params?.name, ...params });
      case 'overview':
        return this.overview(repo, params);
      case 'route_map':
        return this.routeMap(repo, params);
      case 'shape_check':
        return this.shapeCheck(repo, params);
      case 'tool_map':
        return this.toolMap(repo, params);
      case 'api_impact':
        return this.apiImpact(repo, params);
      case 'shortest_path':
        return this.shortestPath(repo, params);
      case 'get_code':
        return this.getCode(repo, params);
      case 'test_impact':
        return this.testImpact(repo, params);
      default:
        throw new Error(`Unknown tool: ${method}`);
    }
  }

  // ─── Tool Implementations ────────────────────────────────────────

  /**
   * Query tool — process-grouped search.
   *
   * 1. Hybrid search (BM25 + semantic) to find matching symbols
   * 2. Trace each match to its process(es) via STEP_IN_PROCESS
   * 3. Group by process, rank by aggregate relevance + internal cluster cohesion
   * 4. Return: { processes, process_symbols, definitions }
   */
  private async query(
    repo: RepoHandle,
    params: {
      query: string;
      task_context?: string;
      goal?: string;
      limit?: number;
      max_symbols?: number;
      include_content?: boolean;
      method?: string;
    },
  ): Promise<any> {
    if (!params.query?.trim()) {
      return { error: 'query parameter is required and cannot be empty.' };
    }

    await this.ensureInitialized(repo.id);

    const processLimit = params.limit || 5;
    const maxSymbolsPerProcess = params.max_symbols || 10;
    const includeContent = params.include_content ?? false;
    const searchQuery = params.query.trim();
    const method = params.method ?? 'hybrid';

    // Step 1: Run search based on method
    const searchLimit = processLimit * maxSymbolsPerProcess; // fetch enough raw results
    let bm25Results: any[] = [];
    let semanticResults: any[] = [];
    let ftsUsed = false;

    if (method === 'fulltext' || method === 'bm25') {
      const bm25SearchResult = await this.bm25Search(repo, searchQuery, searchLimit);
      bm25Results = bm25SearchResult.results;
      ftsUsed = bm25SearchResult.ftsUsed;
    } else if (method === 'vector' || method === 'semantic') {
      semanticResults = await this.semanticSearch(repo, searchQuery, searchLimit);
    } else {
      // hybrid (default)
      const [bm25SearchResult, semResults] = await Promise.all([
        this.bm25Search(repo, searchQuery, searchLimit),
        this.semanticSearch(repo, searchQuery, searchLimit),
      ]);
      bm25Results = bm25SearchResult.results;
      ftsUsed = bm25SearchResult.ftsUsed;
      semanticResults = semResults;
    }

    // Merge via reciprocal rank fusion
    const scoreMap = new Map<string, { score: number; data: any }>();

    for (let i = 0; i < bm25Results.length; i++) {
      const result = bm25Results[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (20 + i);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }

    for (let i = 0; i < semanticResults.length; i++) {
      const result = semanticResults[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (20 + i);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }

    const merged = Array.from(scoreMap.entries())
      .sort((a, b) => {
        // Primary: higher RRF score first
        const scoreDiff = b[1].score - a[1].score;
        if (scoreDiff !== 0) return scoreDiff;
        // Tiebreaker: non-test files rank above test files
        const aIsTest = isTestFilePath(a[1].data.filePath || '');
        const bIsTest = isTestFilePath(b[1].data.filePath || '');
        return aIsTest === bIsTest ? 0 : aIsTest ? 1 : -1;
      })
      .slice(0, searchLimit);

    // Step 2: For each match with a nodeId, trace to process(es)
    const processMap = new Map<
      string,
      {
        id: string;
        label: string;
        heuristicLabel: string;
        processType: string;
        stepCount: number;
        totalScore: number;
        cohesionBoost: number;
        symbols: any[];
      }
    >();
    const definitions: any[] = []; // standalone symbols not in any process

    for (const [_, item] of merged) {
      const sym = item.data;
      if (!sym.nodeId) {
        // File-level results go to definitions
        definitions.push({
          name: sym.name,
          type: sym.type || 'File',
          filePath: sym.filePath,
        });
        continue;
      }

      // Find processes this symbol participates in
      let processRows: any[] = [];
      try {
        processRows = await executeParameterized(
          repo.id,
          `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `,
          { nodeId: sym.nodeId },
        );
      } catch (e) {
        logQueryError('query:process-lookup', e);
      }

      // Get cluster membership + cohesion (cohesion used as internal ranking signal)
      let cohesion = 0;
      let module: string | undefined;
      try {
        const cohesionRows = await executeParameterized(
          repo.id,
          `
          MATCH (n {id: $nodeId})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.cohesion AS cohesion, c.heuristicLabel AS module
          LIMIT 1
        `,
          { nodeId: sym.nodeId },
        );
        if (cohesionRows.length > 0) {
          cohesion = (cohesionRows[0].cohesion ?? cohesionRows[0][0]) || 0;
          module = cohesionRows[0].module ?? cohesionRows[0][1];
        }
      } catch (e) {
        logQueryError('query:cluster-info', e);
      }

      // Optionally fetch content
      let content: string | undefined;
      if (includeContent) {
        try {
          const contentRows = await executeParameterized(
            repo.id,
            `
            MATCH (n {id: $nodeId})
            RETURN n.content AS content
          `,
            { nodeId: sym.nodeId },
          );
          if (contentRows.length > 0) {
            content = contentRows[0].content ?? contentRows[0][0];
          }
        } catch (e) {
          logQueryError('query:content-fetch', e);
        }
      }

      const symbolEntry = {
        id: sym.nodeId,
        name: sym.name,
        type: sym.type,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine,
        ...(module ? { module } : {}),
        ...(includeContent && content ? { content } : {}),
      };

      if (processRows.length === 0) {
        // Symbol not in any process — goes to definitions
        definitions.push(symbolEntry);
      } else {
        // Add to each process it belongs to
        for (const row of processRows) {
          const pid = row.pid ?? row[0];
          const label = row.label ?? row[1];
          const hLabel = row.heuristicLabel ?? row[2];
          const pType = row.processType ?? row[3];
          const stepCount = row.stepCount ?? row[4];
          const step = row.step ?? row[5];

          if (!processMap.has(pid)) {
            processMap.set(pid, {
              id: pid,
              label,
              heuristicLabel: hLabel,
              processType: pType,
              stepCount,
              totalScore: 0,
              cohesionBoost: 0,
              symbols: [],
            });
          }

          const proc = processMap.get(pid)!;
          proc.totalScore += item.score;
          proc.cohesionBoost = Math.max(proc.cohesionBoost, cohesion);
          proc.symbols.push({
            ...symbolEntry,
            process_id: pid,
            step_index: step,
          });
        }
      }
    }

    // Step 3: Rank processes by aggregate score + internal cohesion boost
    const rankedProcesses = Array.from(processMap.values())
      .map((p) => ({
        ...p,
        priority: p.totalScore + p.cohesionBoost * 0.1, // cohesion as subtle ranking signal
      }))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, processLimit);

    // Step 4: Build response
    const processes = rankedProcesses.map((p) => ({
      id: p.id,
      summary: p.heuristicLabel || p.label,
      priority: Math.round(p.priority * 1000) / 1000,
      symbol_count: p.symbols.length,
      process_type: p.processType,
      step_count: p.stepCount,
    }));

    const processSymbols = rankedProcesses.flatMap((p) =>
      p.symbols.slice(0, maxSymbolsPerProcess).map((s) => ({
        ...s,
        // remove internal fields
      })),
    );

    // Deduplicate process_symbols by id
    const seen = new Set<string>();
    const dedupedSymbols = processSymbols.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });

    return {
      processes,
      process_symbols: dedupedSymbols,
      definitions: definitions.slice(0, 20), // cap standalone definitions
      ...(!ftsUsed && {
        warning:
          'FTS extension unavailable - keyword search degraded. Run: gitnexus analyze --force to rebuild indexes.',
      }),
    };
  }

  /**
   * BM25 keyword search helper - uses LadybugDB FTS for always-fresh results
   */
  private async bm25Search(
    repo: RepoHandle,
    query: string,
    limit: number,
  ): Promise<{ results: any[]; ftsUsed: boolean }> {
    const { searchFTSFromLbug } = await import('../../core/search/bm25-index.js');
    let bm25Results;
    try {
      bm25Results = await searchFTSFromLbug(query, limit, repo.id);
    } catch (err: any) {
      console.error('GitNexus: BM25/FTS search failed (FTS indexes may not exist) -', err.message);
      return { results: [], ftsUsed: false };
    }

    const ftsUsed = bm25Results.length === 0 || bm25Results[0]?.ftsUsed !== false;

    const results: any[] = [];

    for (const bm25Result of bm25Results) {
      const fullPath = bm25Result.filePath;
      try {
        const symbols = await executeParameterized(
          repo.id,
          `
          MATCH (n)
          WHERE n.filePath = $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
          LIMIT 3
        `,
          { filePath: fullPath },
        );

        if (symbols.length > 0) {
          for (const sym of symbols) {
            results.push({
              nodeId: sym.id || sym[0],
              name: sym.name || sym[1],
              type: sym.type || sym[2],
              filePath: sym.filePath || sym[3],
              startLine: sym.startLine || sym[4],
              endLine: sym.endLine || sym[5],
              bm25Score: bm25Result.score,
            });
          }
        } else {
          const fileName = fullPath.split('/').pop() || fullPath;
          results.push({
            name: fileName,
            type: 'File',
            filePath: bm25Result.filePath,
            bm25Score: bm25Result.score,
          });
        }
      } catch (e) {
        logQueryError('bm25Search:symbol-lookup', e);
        const fileName = fullPath.split('/').pop() || fullPath;
        results.push({
          name: fileName,
          type: 'File',
          filePath: bm25Result.filePath,
          bm25Score: bm25Result.score,
        });
      }
    }

    return { results, ftsUsed };
  }

  /**
   * Semantic vector search helper
   */
  private async semanticSearch(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    try {
      // Check if embedding table exists before loading the model (avoids heavy model init when embeddings are off)
      const tableCheck = await executeQuery(
        repo.id,
        `MATCH (e:CodeEmbedding) RETURN COUNT(*) AS cnt LIMIT 1`,
      );
      if (!tableCheck.length || (tableCheck[0].cnt ?? tableCheck[0][0]) === 0) return [];

      const { embedQuery, getEmbeddingDims } = await import('../core/embedder.js');
      const queryVec = await embedQuery(query);
      const dims = getEmbeddingDims();
      const queryVecStr = `[${queryVec.join(',')}]`;

      const vectorQuery = `
        CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 
          CAST(${queryVecStr} AS FLOAT[${dims}]), ${limit})
        YIELD node AS emb, distance
        WITH emb, distance
        WHERE distance < 0.25
        RETURN emb.nodeId AS nodeId, distance
        ORDER BY distance
      `;

      const embResults = await executeQuery(repo.id, vectorQuery);

      if (embResults.length === 0) return [];

      const results: any[] = [];

      for (const embRow of embResults) {
        const nodeId = embRow.nodeId ?? embRow[0];
        const distance = embRow.distance ?? embRow[1];

        const labelEndIdx = nodeId.indexOf(':');
        const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';

        // Validate label against known node types to prevent Cypher injection
        if (!VALID_NODE_LABELS.has(label)) continue;

        try {
          const nodeQuery =
            label === 'File'
              ? `MATCH (n:File {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`
              : `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;

          const nodeRows = await executeParameterized(repo.id, nodeQuery, { nodeId });
          if (nodeRows.length > 0) {
            const nodeRow = nodeRows[0];
            results.push({
              nodeId,
              name: nodeRow.name ?? nodeRow[0] ?? '',
              type: label,
              filePath: nodeRow.filePath ?? nodeRow[1] ?? '',
              distance,
              startLine: label !== 'File' ? (nodeRow.startLine ?? nodeRow[2]) : undefined,
              endLine: label !== 'File' ? (nodeRow.endLine ?? nodeRow[3]) : undefined,
            });
          }
        } catch (e) {
          logQueryError('semanticSearch:node-lookup', e);
        }
      }

      return results;
    } catch {
      // Expected when embeddings are disabled — silently fall back to BM25-only
      return [];
    }
  }

  async executeCypher(repoName: string, query: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    return this.cypher(repo, { query });
  }

  private async cypher(repo: RepoHandle, params: { query: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!isLbugReady(repo.id)) {
      return { error: 'LadybugDB not ready. Index may be corrupted.' };
    }

    // Block write operations (defense-in-depth — DB is already read-only)
    if (isWriteQuery(params.query)) {
      return {
        error:
          'Write operations (CREATE, DELETE, SET, MERGE, REMOVE, DROP, ALTER, COPY, DETACH) are not allowed. The knowledge graph is read-only.',
      };
    }

    try {
      const result = await executeQuery(repo.id, params.query);
      return result;
    } catch (err: any) {
      return { error: err.message || 'Query failed' };
    }
  }

  /**
   * Format raw Cypher result rows as a markdown table for LLM readability.
   * Falls back to raw result if rows aren't tabular objects.
   */
  private formatCypherAsMarkdown(result: any): any {
    if (!Array.isArray(result) || result.length === 0) return result;

    const firstRow = result[0];
    if (typeof firstRow !== 'object' || firstRow === null) return result;

    const keys = Object.keys(firstRow);
    if (keys.length === 0) return result;

    const header = '| ' + keys.join(' | ') + ' |';
    const separator = '| ' + keys.map(() => '---').join(' | ') + ' |';
    const dataRows = result.map(
      (row: any) =>
        '| ' +
        keys
          .map((k) => {
            const v = row[k];
            if (v === null || v === undefined) return '';
            if (typeof v === 'object') return JSON.stringify(v);
            return String(v);
          })
          .join(' | ') +
        ' |',
    );

    return {
      markdown: [header, separator, ...dataRows].join('\n'),
      row_count: result.length,
    };
  }

  /**
   * Aggregate same-named clusters: group by heuristicLabel, sum symbols,
   * weighted-average cohesion, filter out tiny clusters (<5 symbols).
   * Raw communities stay intact in LadybugDB for Cypher queries.
   */
  private aggregateClusters(clusters: any[]): any[] {
    const groups = new Map<
      string,
      { ids: string[]; totalSymbols: number; weightedCohesion: number; largest: any }
    >();

    for (const c of clusters) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      const symbols = c.symbolCount || 0;
      const cohesion = c.cohesion || 0;
      const existing = groups.get(label);

      if (!existing) {
        groups.set(label, {
          ids: [c.id],
          totalSymbols: symbols,
          weightedCohesion: cohesion * symbols,
          largest: c,
        });
      } else {
        existing.ids.push(c.id);
        existing.totalSymbols += symbols;
        existing.weightedCohesion += cohesion * symbols;
        if (symbols > (existing.largest.symbolCount || 0)) {
          existing.largest = c;
        }
      }
    }

    return Array.from(groups.entries())
      .map(([label, g]) => ({
        id: g.largest.id,
        label,
        heuristicLabel: label,
        symbolCount: g.totalSymbols,
        cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
        subCommunities: g.ids.length,
      }))
      .filter((c) => c.symbolCount >= 5)
      .sort((a, b) => b.symbolCount - a.symbolCount);
  }

  private async overview(
    repo: RepoHandle,
    params: { showClusters?: boolean; showProcesses?: boolean; limit?: number },
  ): Promise<any> {
    return overviewTool(repo, params, this.ensureInitialized.bind(this));
  }

  /**
   * Context tool — 360-degree symbol view with categorized refs.
   * Disambiguation when multiple symbols share a name.
   * UID-based direct lookup. No cluster in output.
   */
  private async context(
    repo: RepoHandle,
    params: {
      name?: string;
      uid?: string;
      file_path?: string;
      include_content?: boolean;
      /** When false, omit the `evidence` block from the response. Default: true */
      include_evidence?: boolean;
    },
  ): Promise<any> {
    return contextTool(repo, params, this.ensureInitialized.bind(this));
  }

  /**
   * Legacy explore — kept for backwards compatibility with resources.ts.
   * Routes cluster/process types to direct graph queries.
   */
  private async explore(
    repo: RepoHandle,
    params: { name: string; type: 'symbol' | 'cluster' | 'process' },
  ): Promise<any> {
    return exploreTool(repo, params, this.ensureInitialized.bind(this));
  }

  /**
   * Detect changes — git-diff based impact analysis.
   * Maps changed lines to indexed symbols, then finds affected processes.
   */
  private async detectChanges(
    repo: RepoHandle,
    params: {
      scope?: string;
      base_ref?: string;
      /** When false, omit the `evidence` block from the response. Default: true */
      include_evidence?: boolean;
      /** When true, run bug detection rules on changed symbols. Default: false */
      enable_detection?: boolean;
    },
  ): Promise<any> {
    return detectChangesTool(repo, params, this.ensureInitialized.bind(this));
  }

  /**
   * Rename tool — multi-file coordinated rename using graph + text search.
   * Graph refs are tagged "graph" (high confidence).
   * Additional refs found via text search are tagged "text_search" (lower confidence).
   */
  private async rename(
    repo: RepoHandle,
    params: {
      symbol_name?: string;
      symbol_uid?: string;
      new_name: string;
      file_path?: string;
      dry_run?: boolean;
    },
  ): Promise<any> {
    return renameTool(repo, params, this.ensureInitialized.bind(this));
  }

  private async impact(repo: RepoHandle, params: ImpactParams): Promise<any> {
    return impactTool(repo, params, this.ensureInitialized.bind(this));
  }

  /**
   * Shared BFS traversal for impact analysis (name-resolved or UID-resolved symbol).
   */

  /**
   * UID-based impact for cross-repo fan-out. Same result shape as `impact`.
   * Returns null if the repo is unknown, the UID is missing, or analysis fails.
   */
  async impactByUid(
    repoId: string,
    uid: string,
    direction: string,
    opts: {
      maxDepth: number;
      relationTypes: string[];
      minConfidence: number;
      includeTests: boolean;
      include_evidence?: boolean;
      include_content?: boolean;
    },
  ): Promise<any | null> {
    return impactByUidTool(
      repoId,
      uid,
      direction as 'upstream' | 'downstream',
      opts as any,
      this.ensureInitialized.bind(this),
      (id) => this.repos.get(id),
      this.refreshRepos.bind(this),
    );
  }

  /**
   * test_impact tool — find test files that cover a changed symbol.
   *
   * Traverses the call/import graph upstream (BFS) from the seed symbols and
   * collects any encountered node whose file path matches isTestFilePath().
   * Returns results sorted by proximity (min BFS depth) then hit count.
   */
  private async testImpact(
    repo: RepoHandle,
    params: {
      target?: string;
      changes?: string[];
      scope?: string;
      base_ref?: string;
      maxDepth?: number;
      minConfidence?: number;
    },
  ): Promise<any> {
    return testImpactTool(repo, params, this.ensureInitialized.bind(this));
  }

  private handleGroupTool(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'group_list':
        return this.groupList(params);
      case 'group_sync':
        return this.groupSync(params);
      case 'group_contracts':
        return this.groupContracts(params);
      case 'group_query':
        return this.groupQuery(params);
      case 'group_status':
        return this.groupStatus(params);
      default:
        throw new Error(`Unknown group tool: ${method}`);
    }
  }

  private async groupList(params: Record<string, unknown>): Promise<unknown> {
    return this.getGroupService().groupList(params);
  }

  private async groupSync(params: Record<string, unknown>): Promise<unknown> {
    return this.getGroupService().groupSync(params);
  }

  private async groupContracts(params: Record<string, unknown>): Promise<unknown> {
    return this.getGroupService().groupContracts(params);
  }

  private async groupQuery(params: Record<string, unknown>): Promise<unknown> {
    await this.refreshRepos();
    return this.getGroupService().groupQuery(params);
  }

  private async groupStatus(params: Record<string, unknown>): Promise<unknown> {
    await this.refreshRepos();
    return this.getGroupService().groupStatus(params);
  }

  /**
   * Fetch Route nodes with their consumers in a single query.
   * Shared by routeMap and shapeCheck to avoid N+1 query patterns.
   */
  private async fetchRoutesWithConsumers(
    repoId: string,
    routeFilter: string,
    params: Record<string, string>,
  ): Promise<
    Array<{
      id: string;
      name: string;
      filePath: string;
      responseKeys: string[] | null;
      errorKeys: string[] | null;
      middleware: string[] | null;
      consumers: Array<{
        name: string;
        filePath: string;
        accessedKeys?: string[];
        fetchCount?: number;
      }>;
    }>
  > {
    const rows = await executeParameterized(
      repoId,
      `
      MATCH (n:Route)
      WHERE n.id STARTS WITH 'Route:' ${routeFilter}
      OPTIONAL MATCH (consumer)-[r:CodeRelation]->(n)
      WHERE r.type = 'FETCHES'
      RETURN n.id AS routeId, n.name AS routeName, n.filePath AS handlerFile,
             n.responseKeys AS responseKeys, n.errorKeys AS errorKeys, n.middleware AS middleware,
             consumer.name AS consumerName, consumer.filePath AS consumerFile,
             r.reason AS fetchReason
    `,
      params,
    );

    // Strip wrapping quotes from DB array elements — CSV COPY stores ['key'] which
    // LadybugDB may return as "'key'" rather than "key"
    const stripQuotes = (keys: string[] | null): string[] | null =>
      keys ? keys.map((k) => k.replace(/^['"]|['"]$/g, '')) : null;

    const routeMap = new Map<
      string,
      {
        id: string;
        name: string;
        filePath: string;
        responseKeys: string[] | null;
        errorKeys: string[] | null;
        middleware: string[] | null;
        consumers: Array<{
          name: string;
          filePath: string;
          accessedKeys?: string[];
          fetchCount?: number;
        }>;
      }
    >();
    for (const row of rows) {
      const id = row.routeId ?? row[0];
      const name = row.routeName ?? row[1];
      const filePath = row.handlerFile ?? row[2];
      const responseKeys = stripQuotes(row.responseKeys ?? row[3] ?? null);
      const errorKeys = stripQuotes(row.errorKeys ?? row[4] ?? null);
      const middleware = stripQuotes(row.middleware ?? row[5] ?? null);
      const consumerName = row.consumerName ?? row[6];
      const consumerFile = row.consumerFile ?? row[7];
      const fetchReason: string | null = row.fetchReason ?? row[8] ?? null;

      if (!routeMap.has(id)) {
        routeMap.set(id, {
          id,
          name,
          filePath,
          responseKeys,
          errorKeys,
          middleware,
          consumers: [],
        });
      }
      if (consumerName && consumerFile) {
        // Parse accessed keys from reason field: "fetch-url-match|keys:data,pagination|fetches:3"
        let accessedKeys: string[] | undefined;
        let fetchCount: number | undefined;
        if (fetchReason) {
          const keysMatch = fetchReason.match(/\|keys:([^|]+)/);
          if (keysMatch) {
            accessedKeys = keysMatch[1].split(',').filter((k) => k.length > 0);
          }
          const fetchesMatch = fetchReason.match(/\|fetches:(\d+)/);
          if (fetchesMatch) {
            fetchCount = parseInt(fetchesMatch[1], 10);
          }
        }
        routeMap.get(id)!.consumers.push({
          name: consumerName,
          filePath: consumerFile,
          ...(accessedKeys ? { accessedKeys } : {}),
          ...(fetchCount && fetchCount > 1 ? { fetchCount } : {}),
        });
      }
    }

    return [...routeMap.values()];
  }

  /**
   * Batch-fetch execution flows linked to a set of Route or Tool nodes.
   * Single query instead of N+1.
   */
  private async fetchLinkedFlowsBatch(
    repoId: string,
    nodeIds: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (nodeIds.length === 0) return result;
    try {
      // Use list_contains to filter at DB level instead of fetching all and filtering in memory
      const rows = await executeParameterized(
        repoId,
        `
        MATCH (source)-[r:CodeRelation]->(proc:Process)
        WHERE r.type = 'ENTRY_POINT_OF'
          AND list_contains($nodeIds, source.id)
        RETURN source.id AS sourceId, proc.label AS name
      `,
        { nodeIds },
      );
      for (const row of rows) {
        const sourceId = row.sourceId ?? row[0];
        const name = row.name ?? row[1];
        if (!name) continue;
        let list = result.get(sourceId);
        if (!list) {
          list = [];
          result.set(sourceId, list);
        }
        list.push(name);
      }
    } catch (e) {
      logQueryError('fetchLinkedFlowsBatch', e);
    }
    return result;
  }

  private async routeMap(repo: RepoHandle, params: { route?: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const routeFilter = params.route ? `AND n.name CONTAINS $route` : '';
    const queryParams = params.route ? { route: params.route } : {};
    const routes = await this.fetchRoutesWithConsumers(repo.id, routeFilter, queryParams);

    if (routes.length === 0) {
      return {
        routes: [],
        total: 0,
        message: params.route
          ? `No routes matching "${params.route}"`
          : 'No routes found in this project.',
      };
    }

    const flowMap = await this.fetchLinkedFlowsBatch(
      repo.id,
      routes.map((r) => r.id),
    );

    return {
      routes: routes.map((r) => ({
        route: r.name,
        handler: r.filePath,
        middleware: r.middleware || [],
        consumers: r.consumers,
        flows: flowMap.get(r.id) || [],
      })),
      total: routes.length,
    };
  }

  private async shapeCheck(repo: RepoHandle, params: { route?: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const routeFilter = params.route ? `AND n.name CONTAINS $route` : '';
    const queryParams = params.route ? { route: params.route } : {};
    const allRoutes = await this.fetchRoutesWithConsumers(repo.id, routeFilter, queryParams);

    const results = allRoutes
      .filter(
        (r) =>
          ((r.responseKeys && r.responseKeys.length > 0) ||
            (r.errorKeys && r.errorKeys.length > 0)) &&
          r.consumers.length > 0,
      )
      .map((r) => {
        // Keys already normalized by fetchRoutesWithConsumers (quotes stripped)
        const responseKeys = r.responseKeys ?? [];
        const errorKeys = r.errorKeys ?? [];
        // Combined set: consumer accessing either success or error keys is valid
        const allKnownKeys = new Set([...responseKeys, ...errorKeys]);

        // Check each consumer's accessed keys against the route's response shape
        const responseKeySet = new Set(responseKeys);
        const consumers = r.consumers.map((c) => {
          if (!c.accessedKeys || c.accessedKeys.length === 0) {
            return { name: c.name, filePath: c.filePath };
          }
          const mismatched = c.accessedKeys.filter((k) => !allKnownKeys.has(k));
          // Keys in allKnownKeys but not in responseKeys — error-path access (e.g., .error from errorKeys)
          const errorPathKeys = c.accessedKeys.filter(
            (k) => allKnownKeys.has(k) && !responseKeySet.has(k),
          );
          const isMultiFetch = (c.fetchCount ?? 1) > 1;
          return {
            name: c.name,
            filePath: c.filePath,
            accessedKeys: c.accessedKeys,
            ...(mismatched.length > 0
              ? {
                  mismatched,
                  mismatchConfidence: isMultiFetch ? ('low' as const) : ('high' as const),
                }
              : {}),
            ...(errorPathKeys.length > 0 ? { errorPathKeys } : {}),
            ...(isMultiFetch
              ? {
                  attributionNote: `This file fetches ${c.fetchCount} routes — accessed keys may belong to a different route.`,
                }
              : {}),
          };
        });

        const hasMismatches = consumers.some(
          (c) => 'mismatched' in c && (c as any).mismatched.length > 0,
        );

        return {
          route: r.name,
          handler: r.filePath,
          ...(responseKeys.length > 0 ? { responseKeys } : {}),
          ...(errorKeys.length > 0 ? { errorKeys } : {}),
          consumers,
          ...(hasMismatches ? { status: 'MISMATCH' as const } : {}),
        };
      });

    const mismatchCount = results.filter((r) => r.status === 'MISMATCH').length;

    return {
      routes: results,
      total: results.length,
      routesWithShapes: results.length,
      ...(mismatchCount > 0 ? { mismatches: mismatchCount } : {}),
      message:
        results.length === 0
          ? 'No routes with both response shapes and consumers found.'
          : mismatchCount > 0
            ? `Found ${results.length} route(s) with response shape data. ${mismatchCount} route(s) have consumer/shape mismatches.`
            : `Found ${results.length} route(s) with response shape data and consumers.`,
    };
  }

  private async toolMap(repo: RepoHandle, params: { tool?: string }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const toolFilter = params.tool ? `AND n.name CONTAINS $tool` : '';
    const queryParams = params.tool ? { tool: params.tool } : {};

    const rows = await executeParameterized(
      repo.id,
      `
      MATCH (n:Tool)
      WHERE n.id STARTS WITH 'Tool:' ${toolFilter}
      RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.description AS description
    `,
      queryParams,
    );

    if (rows.length === 0) {
      return {
        tools: [],
        total: 0,
        message: params.tool ? `No tools matching "${params.tool}"` : 'No tool definitions found.',
      };
    }

    const toolIds = rows.map((r: any) => r.id ?? r[0]);
    const flowMap = await this.fetchLinkedFlowsBatch(repo.id, toolIds);

    return {
      tools: rows.map((r: any) => {
        const id = r.id ?? r[0];
        return {
          name: r.name ?? r[1],
          filePath: r.filePath ?? r[2],
          description: (r.description ?? r[3] ?? '').slice(0, 200),
          flows: flowMap.get(id) || [],
        };
      }),
      total: rows.length,
    };
  }

  /**
   * Shortest path between two nodes via BFS on CodeRelation edges.
   */
  private async shortestPath(
    repo: RepoHandle,
    params: {
      source_id: string;
      target_id: string;
      max_hops?: number;
      relation_types?: string[];
    },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    const { source_id, target_id, max_hops = 5, relation_types } = params;

    if (!source_id || !target_id) {
      return { error: 'source_id and target_id are required.' };
    }

    const relTypes =
      relation_types && relation_types.length > 0
        ? relation_types
        : [
            'CALLS',
            'IMPORTS',
            'EXTENDS',
            'IMPLEMENTS',
            'HAS_METHOD',
            'HAS_PROPERTY',
            'OVERRIDES',
            'ACCESSES',
            'DATA_FLOW',
          ];

    type BFSEntry = {
      nodeId: string;
      path: string[];
      edges: { sourceId: string; targetId: string; type: string; confidence: number | null }[];
    };
    const visited = new Set<string>();
    const queue: BFSEntry[] = [];

    queue.push({ nodeId: source_id, path: [source_id], edges: [] });
    visited.add(source_id);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.path.length > max_hops) continue;

      if (current.nodeId === target_id) {
        const nodeDetails = await this.resolvePathNodes(repo.id, current.path);
        return {
          nodes: nodeDetails,
          edges: current.edges,
          hop_count: current.path.length - 1,
        };
      }

      const expandQuery = `
        MATCH (n {id: $nodeId})-[r:CodeRelation]->(target)
        WHERE r.type IN $relTypes AND NOT target.id IN $visited
        RETURN target.id AS targetId, r.type AS relType, r.confidence AS confidence
      `;

      try {
        const rows = await executeParameterized(repo.id, expandQuery, {
          nodeId: current.nodeId,
          relTypes,
          visited: Array.from(visited),
        });

        for (const row of rows) {
          const nextId: string = row.targetId ?? row[0];
          if (visited.has(nextId)) continue;
          visited.add(nextId);

          queue.push({
            nodeId: nextId,
            path: [...current.path, nextId],
            edges: [
              ...current.edges,
              {
                sourceId: current.nodeId,
                targetId: nextId,
                type: row.relType ?? row[1],
                confidence: row.confidence ?? row[2] ?? null,
              },
            ],
          });
        }
      } catch (e) {
        logQueryError('shortestPath:expand', e);
      }
    }

    return {
      nodes: [],
      edges: [],
      hop_count: -1,
      message: `No path found between ${source_id} and ${target_id} within ${max_hops} hops.`,
    };
  }

  private async resolvePathNodes(repoId: string, nodeIds: string[]): Promise<any[]> {
    const results: any[] = [];
    for (const nodeId of nodeIds) {
      const label = nodeId.includes(':') ? nodeId.split(':')[0] : 'Unknown';
      if (!VALID_NODE_LABELS.has(label)) continue;
      try {
        const rows = await executeParameterized(
          repoId,
          `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine LIMIT 1`,
          { nodeId },
        );
        if (rows.length > 0) {
          const r = rows[0];
          results.push({
            uid: r.id ?? r[0],
            name: r.name ?? r[1],
            kind: label,
            filePath: r.filePath ?? r[2],
            startLine: r.startLine ?? r[3] ?? null,
            endLine: r.endLine ?? r[4] ?? null,
          });
        }
      } catch (e) {
        logQueryError('resolvePathNodes', e);
      }
    }
    return results;
  }

  /**
   * Standalone get_code tool — retrieve source code from a node's file span.
   */
  private async getCode(
    repo: RepoHandle,
    params: {
      uid?: string;
      name?: string;
      file_path?: string;
    },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    const { uid, name, file_path } = params;

    if (!uid && !name) {
      return { error: 'uid or name parameter is required.' };
    }

    if (uid) {
      const label = uid.includes(':') ? uid.split(':')[0] : 'Unknown';
      if (!VALID_NODE_LABELS.has(label)) {
        return { error: `Invalid UID format: unknown label "${label}"` };
      }
      try {
        const rows = await executeParameterized(
          repo.id,
          `MATCH (n:\`${label}\` {id: $uid}) RETURN n.id AS id, n.name AS name, labels(n)[0] AS kind, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content LIMIT 1`,
          { uid },
        );
        if (rows.length === 0) {
          return { error: `Node ${uid} not found` };
        }
        const r = rows[0];
        return {
          uid: r.id ?? r[0],
          name: r.name ?? r[1],
          kind: r.kind ?? label,
          filePath: r.filePath ?? r[3],
          startLine: r.startLine ?? r[4],
          endLine: r.endLine ?? r[5],
          content: r.content ?? r[6] ?? null,
        };
      } catch (e) {
        logQueryError('getCode:uid-lookup', e);
        return { error: `Failed to fetch node: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    let whereClause = 'WHERE n.name = $symName';
    const queryParams: Record<string, string> = { symName: name };

    if (file_path) {
      whereClause += ' AND n.filePath CONTAINS $filePath';
      queryParams.filePath = file_path;
    }

    try {
      const rows = await executeParameterized(
        repo.id,
        `MATCH (n) ${whereClause} RETURN n.id AS id, n.name AS name, labels(n)[0] AS kind, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content LIMIT 1`,
        queryParams,
      );
      if (rows.length === 0) {
        return {
          error: `No symbol found matching "${name}"${file_path ? ` in ${file_path}` : ''}`,
        };
      }
      const r = rows[0];
      return {
        uid: r.id ?? r[0],
        name: r.name ?? r[1],
        kind: r.kind ?? r[2],
        filePath: r.filePath ?? r[3],
        startLine: r.startLine ?? r[4],
        endLine: r.endLine ?? r[5],
        content: r.content ?? r[6] ?? null,
      };
    } catch (e) {
      logQueryError('getCode:name-lookup', e);
      return { error: `Failed to fetch symbol: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async apiImpact(
    repo: RepoHandle,
    params: { route?: string; file?: string },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    if (!params.route && !params.file) {
      return { error: 'Either "route" or "file" parameter is required.' };
    }

    // If file is provided but route is not, look up the route by file path
    let routeFilter = '';
    const queryParams: Record<string, string> = {};

    if (params.route) {
      routeFilter = `AND n.name CONTAINS $route`;
      queryParams.route = params.route;
    } else if (params.file) {
      routeFilter = `AND n.filePath CONTAINS $file`;
      queryParams.file = params.file;
    }

    const routes = await this.fetchRoutesWithConsumers(repo.id, routeFilter, queryParams);

    if (routes.length === 0) {
      const target = params.route || params.file;
      return { error: `No routes found matching "${target}".` };
    }

    const flowMap = await this.fetchLinkedFlowsBatch(
      repo.id,
      routes.map((r) => r.id),
    );

    // Count how many routes share the same handler file (for middleware partial detection)
    const routeCountByHandler = new Map<string, number>();
    for (const r of routes) {
      if (r.filePath) {
        routeCountByHandler.set(r.filePath, (routeCountByHandler.get(r.filePath) ?? 0) + 1);
      }
    }

    const results = routes.map((r) => {
      // Keys already normalized by fetchRoutesWithConsumers (quotes stripped)
      const responseKeys = r.responseKeys ?? [];
      const errorKeys = r.errorKeys ?? [];
      const allKnownKeys = new Set([...responseKeys, ...errorKeys]);

      // Build consumer list with mismatch detection
      const consumers = r.consumers.map((c) => ({
        name: c.name,
        file: c.filePath,
        accesses: c.accessedKeys ?? [],
        ...(c.fetchCount && c.fetchCount > 1
          ? {
              attributionNote: `This file fetches ${c.fetchCount} routes — accessed keys may belong to a different route.`,
            }
          : {}),
      }));

      // Detect mismatches: consumer accesses keys not in response shape
      const mismatches: Array<{
        consumer: string;
        field: string;
        reason: string;
        confidence: 'high' | 'low';
      }> = [];
      if (allKnownKeys.size > 0) {
        for (const c of r.consumers) {
          if (!c.accessedKeys) continue;
          const isMultiFetch = (c.fetchCount ?? 1) > 1;
          for (const key of c.accessedKeys) {
            if (!allKnownKeys.has(key)) {
              mismatches.push({
                consumer: c.filePath,
                field: key,
                reason: 'accessed but not in response shape',
                confidence: isMultiFetch ? 'low' : 'high',
              });
            }
          }
        }
      }

      const flows = flowMap.get(r.id) || [];
      const consumerCount = r.consumers.length;

      // Risk level heuristic
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
      if (consumerCount >= 10) {
        riskLevel = 'HIGH';
      } else if (consumerCount >= 4) {
        riskLevel = 'MEDIUM';
      } else {
        riskLevel = 'LOW';
      }
      // Bump up one level if mismatches exist
      if (mismatches.length > 0) {
        if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
        else if (riskLevel === 'MEDIUM') riskLevel = 'HIGH';
      }

      const warning =
        consumerCount > 0
          ? `Changing response shape will affect ${consumerCount} component${consumerCount === 1 ? '' : 's'}`
          : undefined;

      // Flag when middleware was detected but handler exports multiple HTTP methods
      // (middleware chain may only reflect one export)
      const middlewareArr = r.middleware || [];
      const handlerRouteCount = r.filePath ? (routeCountByHandler.get(r.filePath) ?? 1) : 1;
      const middlewarePartial = middlewareArr.length > 0 && handlerRouteCount > 1;

      return {
        route: r.name,
        handler: r.filePath,
        responseShape: {
          success: responseKeys,
          error: errorKeys,
        },
        middleware: middlewareArr,
        ...(middlewarePartial
          ? {
              middlewareDetection: 'partial' as const,
              middlewareNote:
                'Middleware captured from first HTTP method export only — other methods in this handler may use different middleware chains.',
            }
          : {}),
        consumers,
        ...(mismatches.length > 0 ? { mismatches } : {}),
        executionFlows: flows,
        impactSummary: {
          directConsumers: consumerCount,
          affectedFlows: flows.length,
          riskLevel,
          ...(warning ? { warning } : {}),
        },
      };
    });

    // If a single route was targeted, return it directly (not wrapped in array)
    if (results.length === 1) {
      return results[0];
    }

    return { routes: results, total: results.length };
  }

  // ─── Direct Graph Queries (for resources.ts) ────────────────────

  /**
   * Query clusters (communities) directly from graph.
   * Used by getClustersResource — avoids legacy overview() dispatch.
   */
  async queryClusters(repoName?: string, limit = 100): Promise<{ clusters: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    try {
      const rawLimit = Math.max(limit * 5, 200);
      const clusters = await executeQuery(
        repo.id,
        `
        MATCH (c:Community)
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
        ORDER BY c.symbolCount DESC
        LIMIT ${rawLimit}
      `,
      );
      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0],
        label: c.label || c[1],
        heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3],
        symbolCount: c.symbolCount || c[4],
      }));
      return { clusters: aggregateClusters(rawClusters).slice(0, limit) };
    } catch {
      return { clusters: [] };
    }
  }

  /**
   * Query processes directly from graph.
   * Used by getProcessesResource — avoids legacy overview() dispatch.
   */
  async queryProcesses(repoName?: string, limit = 50): Promise<{ processes: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    try {
      const processes = await executeQuery(
        repo.id,
        `
        MATCH (p:Process)
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        ORDER BY p.stepCount DESC
        LIMIT ${limit}
      `,
      );
      return {
        processes: processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        })),
      };
    } catch {
      return { processes: [] };
    }
  }

  /**
   * Query cluster detail (members) directly from graph.
   * Used by getClusterDetailResource.
   */
  async queryClusterDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const clusters = await executeParameterized(
      repo.id,
      `
      MATCH (c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
    `,
      { clusterName: name },
    );
    if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

    const rawClusters = clusters.map((c: any) => ({
      id: c.id || c[0],
      label: c.label || c[1],
      heuristicLabel: c.heuristicLabel || c[2],
      cohesion: c.cohesion || c[3],
      symbolCount: c.symbolCount || c[4],
    }));

    let totalSymbols = 0,
      weightedCohesion = 0;
    for (const c of rawClusters) {
      const s = c.symbolCount || 0;
      totalSymbols += s;
      weightedCohesion += (c.cohesion || 0) * s;
    }

    const members = await executeParameterized(
      repo.id,
      `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
      LIMIT 30
    `,
      { clusterName: name },
    );

    return {
      cluster: {
        id: rawClusters[0].id,
        label: rawClusters[0].heuristicLabel || rawClusters[0].label,
        heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
        cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
        symbolCount: totalSymbols,
        subCommunities: rawClusters.length,
      },
      members: members.map((m: any) => ({
        name: m.name || m[0],
        type: m.type || m[1],
        filePath: m.filePath || m[2],
      })),
    };
  }

  /**
   * Query process detail (steps) directly from graph.
   * Used by getProcessDetailResource.
   */
  async queryProcessDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const processes = await executeParameterized(
      repo.id,
      `
      MATCH (p:Process)
      WHERE p.label = $processName OR p.heuristicLabel = $processName
      RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
      LIMIT 1
    `,
      { processName: name },
    );
    if (processes.length === 0) return { error: `Process '${name}' not found` };

    const proc = processes[0];
    const procId = proc.id || proc[0];
    const steps = await executeParameterized(
      repo.id,
      `
      MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
      RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
      ORDER BY r.step
    `,
      { procId },
    );

    return {
      process: {
        id: procId,
        label: proc.label || proc[1],
        heuristicLabel: proc.heuristicLabel || proc[2],
        processType: proc.processType || proc[3],
        stepCount: proc.stepCount || proc[4],
      },
      steps: steps.map((s: any) => ({
        step: s.step || s[3],
        name: s.name || s[0],
        type: s.type || s[1],
        filePath: s.filePath || s[2],
      })),
    };
  }

  /**
   * explain_dataflow tool — LLM-powered explanation of a TaintPath.
   * Accepts a JSON-string taint_path and returns a plain English vulnerability explanation.
   */
  private async explainDataflow(
    _repo: RepoHandle,
    params: { taint_path: string },
  ): Promise<{ explanation: string; raw?: string }> {
    let taintPath: any;
    try {
      taintPath = JSON.parse(params.taint_path);
    } catch {
      return {
        explanation:
          'Invalid taint_path JSON. Expected: { source, sink, path, sanitizers, confidence }',
      };
    }

    const { source, sink, path = [], sanitizers = [], confidence = 0 } = taintPath;

    const pathSteps = path
      .map((s: any) => `  - ${s.from} --[${s.operation}]--> ${s.to}`)
      .join('\n');

    const sanitizerList = sanitizers.length
      ? sanitizers.map((s: any) => `  - ${s.variable} at ${s.nodeId}: ${s.description}`).join('\n')
      : '  (none)';

    const prompt = `You are a security expert explaining a data flow vulnerability.

## Source (untrusted input)
- Node: ${source?.nodeId ?? '?'}
- Variable: ${source?.variable ?? '?'}
- Kind: ${source?.kind ?? '?'}
- Description: ${source?.description ?? '?'}

## Sink (harmful destination)
- Node: ${sink?.nodeId ?? '?'}
- Variable: ${sink?.variable ?? '?'}
- Kind: ${sink?.kind ?? '?'}
- Description: ${sink?.description ?? '?'}

## Propagation path
${pathSteps || '  (path unavailable)'}

## Sanitizers on path
${sanitizerList}

## Confidence
${confidence}

Please explain in plain English:
1. What the vulnerability is and how it works
2. What an attacker could do (attack scenario)
3. How to fix or mitigate it

Be concise — 3-5 sentences maximum.`;

    try {
      const config = await resolveLLMConfig({ maxTokens: 500 });
      const result = await callLLM(prompt, config);
      return { explanation: result.content };
    } catch (err) {
      return {
        explanation:
          'LLM explanation unavailable. Check that an API key is configured (GITNEXUS_API_KEY or OPENAI_API_KEY).',
        raw: String(err),
      };
    }
  }
  async disconnect(): Promise<void> {
    await closeLbug(); // close all connections
    // Note: we intentionally do NOT call disposeEmbedder() here.
    // ONNX Runtime's native cleanup segfaults on macOS and some Linux configs,
    // and importing the embedder module on Node v24+ crashes if onnxruntime
    // was never loaded during the session. Since process.exit(0) follows
    // immediately after disconnect(), the OS reclaims everything. See #38, #89.
    this.repos.clear();
    this.contextCache.clear();
    this.initializedRepos.clear();
  }
}
