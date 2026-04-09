/**
 * Local Backend (Multi-Repo)
 *
 * Provides tool implementations using local .gitnexus/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * LadybugDB connections are opened lazily per repo on first query.
 */

import fs from 'fs/promises';
import path from 'path';
import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../core/graph/types.js';
import { initLbug, closeLbug, isLbugReady, isWriteQuery } from '../../core/lbug/pool-adapter.js';
export { isWriteQuery };
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at MCP server startup — crashes on unsupported Node ABI versions (#89)
// git utilities available if needed
// import { isGitRepo, getCurrentCommit, getGitRoot } from '../../storage/git.js';
import { listRegisteredRepos, cleanupOldKuzuFiles } from '../../storage/repo-manager.js';
import { GroupService, type GroupToolPort } from '../../core/group/service.js';

// AI context generation is CLI-only (gitnexus analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';

// ─── Tool module imports ─────────────────────────────────────────────────────
import { contextTool } from './tools/context.js';
import { overviewTool, formatCypherAsMarkdown, queryRepoOverviewTool } from './tools/overview.js';
import { queryTool } from './tools/query.js';
import { detectChangesTool } from './tools/detect.js';
import { renameTool } from './tools/rename.js';
import { impactTool, impactByUidTool } from './tools/impact.js';
import { testImpactTool } from './tools/test-impact.js';
import { routeMapTool, shapeCheckTool, toolMapTool } from './tools/route-tools.js';
import { shortestPathTool, getCodeTool, apiImpactTool, cypherTool } from './tools/graph-tools.js';
import { explainDataflowTool } from './tools/dataflow.js';
import {
  queryClustersTool,
  queryProcessesTool,
  queryClusterDetailTool,
  queryProcessDetailTool,
} from './tools/resources.js';
import {
  isTestFilePath,
  VALID_NODE_LABELS,
  VALID_RELATION_TYPES,
  IMPACT_RELATION_CONFIDENCE,
  type RepoHandle,
  type CodebaseContext,
  type RepoOverview,
} from './tools/shared.js';

// Re-export for backward compatibility
export { isTestFilePath, VALID_NODE_LABELS, VALID_RELATION_TYPES, IMPACT_RELATION_CONFIDENCE };
// Re-export interfaces moved to shared.ts
export type { CodebaseContext, RepoOverview } from './tools/shared.js';

/**
 * 文件路径到符号的索引，加速符号查询
 *
 * 用于降级模式下快速查找文件内的所有符号，
 * 避免遍历整个知识图谱。
 */
export class FilePathIndex {
  private index: Map<string, GraphNode[]> = new Map();
  private built = false;

  /**
   * 从知识图谱构建索引
   */
  build(graph: KnowledgeGraph): void {
    if (this.built) return;

    for (const node of graph.iterNodes()) {
      const filePath = node.properties.filePath;
      if (!filePath) continue;

      if (!this.index.has(filePath)) {
        this.index.set(filePath, []);
      }
      this.index.get(filePath)!.push(node);
    }

    // 按行号排序
    for (const [, symbols] of this.index) {
      symbols.sort((a, b) => (a.properties.startLine || 0) - (b.properties.startLine || 0));
    }

    this.built = true;
  }

  /**
   * 查找文件内的所有符号
   * O(1) 查找，不再需要遍历全图
   */
  findSymbolsInFile(filePath: string): GraphNode[] {
    return this.index.get(filePath) || [];
  }

  /**
   * 获取索引统计信息
   */
  getStats(): { files: number; symbols: number } {
    let symbols = 0;
    for (const syms of this.index.values()) {
      symbols += syms.length;
    }
    return { files: this.index.size, symbols };
  }

  /**
   * 清除索引
   */
  clear(): void {
    this.index.clear();
    this.built = false;
  }
}

export class LocalBackend {
  private repos: Map<string, RepoHandle> = new Map();
  private contextCache: Map<string, CodebaseContext> = new Map();
  private initializedRepos: Set<string> = new Set();
  private reinitPromises: Map<string, Promise<void>> = new Map();
  private lastStalenessCheck: Map<string, number> = new Map();
  private groupToolSvc: GroupService | null = null;

  /** 文件路径索引，用于降级模式快速符号查询 */
  private filePathIndex: FilePathIndex | null = null;

  /**
   * 获取文件路径索引（延迟构建）
   *
   * 注意：此方法返回一个空的索引实例，需要调用者手动调用 build() 并传入 KnowledgeGraph。
   * LocalBackend 使用 LadybugDB 而非内存中的 KnowledgeGraph，因此无法自动构建索引。
   */
  getFilePathIndex(): FilePathIndex {
    if (!this.filePathIndex) {
      this.filePathIndex = new FilePathIndex();
    }
    return this.filePathIndex;
  }

  /**
   * Cross-repo group tools (CLI). Shares logic with MCP `group_*` handlers.
   */
  getGroupService(): GroupService {
    if (!this.groupToolSvc) {
      const port: GroupToolPort = {
        resolveRepo: (p) => this.resolveRepo(p),
        impact: (r, p) => impactTool(r as RepoHandle, p, this.ensureInitialized.bind(this)),
        query: (r, p) => queryTool(r as RepoHandle, p, this.ensureInitialized.bind(this)),
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

    // 重置文件路径索引
    if (this.filePathIndex) {
      this.filePathIndex.clear();
    }

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
    const context = this.getContext(repo.id) || this.getContext() || null;
    return queryRepoOverviewTool(repo, context, this.ensureInitialized.bind(this));
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
      const svc = this.getGroupService();
      switch (method) {
        case 'group_list':
          return svc.groupList(params || {});
        case 'group_sync':
          return svc.groupSync(params || {});
        case 'group_contracts':
          return svc.groupContracts(params || {});
        case 'group_query':
          await this.refreshRepos();
          return svc.groupQuery(params || {});
        case 'group_status':
          await this.refreshRepos();
          return svc.groupStatus(params || {});
        default:
          throw new Error(`Unknown group tool: ${method}`);
      }
    }

    // Resolve repo from optional param (re-reads registry on miss)
    const repo = await this.resolveRepo(params?.repo);
    const init = this.ensureInitialized.bind(this);

    switch (method) {
      case 'query':
      case 'search': // Legacy alias
        return queryTool(repo, params, init);
      case 'cypher': {
        const raw = await cypherTool(repo, params, init);
        return formatCypherAsMarkdown(raw);
      }
      case 'context':
      case 'explore': // Legacy alias — routes to context
        return contextTool(
          repo,
          method === 'explore' ? { name: params?.name, ...params } : params,
          init,
        );
      case 'impact':
        return impactTool(repo, params, init);
      case 'detect_changes':
        return detectChangesTool(repo, params, init);
      case 'rename':
        return renameTool(repo, params, init);
      case 'overview':
        return overviewTool(repo, params, init);
      case 'route_map':
        return routeMapTool(repo, params, init);
      case 'shape_check':
        return shapeCheckTool(repo, params, init);
      case 'tool_map':
        return toolMapTool(repo, params, init);
      case 'api_impact':
        return apiImpactTool(repo, params, init);
      case 'shortest_path':
        return shortestPathTool(repo, params, init);
      case 'get_code':
        return getCodeTool(repo, params, init);
      case 'test_impact':
        return testImpactTool(repo, params, init);
      case 'explain_dataflow':
        return explainDataflowTool(repo, params);
      default:
        throw new Error(`Unknown tool: ${method}`);
    }
  }

  // ─── Tool Implementations ────────────────────────────────────────

  // query() → delegated to queryTool (tools/query.ts)

  async executeCypher(repoName: string, query: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    return cypherTool(repo, { query }, this.ensureInitialized.bind(this));
  }

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

  // ─── Direct Graph Queries (for resources.ts) ────────────────────

  async queryClusters(repoName?: string, limit = 100): Promise<{ clusters: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);
    return queryClustersTool(repo.id, limit);
  }

  async queryProcesses(repoName?: string, limit = 50): Promise<{ processes: any[] }> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);
    return queryProcessesTool(repo.id, limit);
  }

  async queryClusterDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);
    return queryClusterDetailTool(repo.id, name);
  }

  async queryProcessDetail(name: string, repoName?: string): Promise<any> {
    const repo = await this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);
    return queryProcessDetailTool(repo.id, name);
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
