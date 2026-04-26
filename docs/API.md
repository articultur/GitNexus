# GitNexus API Reference

## MCP Tools

GitNexus MCP tools provide code intelligence capabilities including context lookup, impact analysis, search, and graph operations.

### contextTool

360-degree symbol view with categorized refs.

```typescript
async contextTool(
  repo: RepoHandle,
  params: {
    name?: string;           // Symbol name (supports "Class.method" syntax)
    uid?: string;            // Direct UID lookup
    file_path?: string;      // Filter by file path
    include_content?: boolean; // Include source content (default: true)
    include_evidence?: boolean; // Include evidence block (default: true)
  },
  ensureInitialized: (id: string) => Promise<void>
): Promise<ContextResult>
```

**Returns:** Symbol details with callers, callees, and references.

---

### queryTool

Process-grouped search (BM25 + semantic hybrid).

```typescript
async queryTool(
  repo: RepoHandle,
  params: {
    query: string;                    // Search query (required)
    task_context?: string;            // Task context for relevance
    goal?: string;                    // Search goal
    limit?: number;                  // Max processes (default: 5)
    max_symbols?: number;             // Max symbols per process (default: 10)
    include_content?: boolean;        // Include source content
    method?: 'hybrid' | 'bm25' | 'fulltext' | 'vector' | 'semantic';
    relevance_threshold?: number;     // Relevance threshold (default: 0)
  },
  ensureInitialized: (id: string) => Promise<void>
): Promise<QueryResult>
```

---

### impactTool

Blast radius analysis before editing.

```typescript
async impactTool(
  repo: RepoHandle,
  params: {
    target: string;           // Symbol name to analyze
    direction: 'upstream' | 'downstream' | 'both';
    depth?: number;          // Analysis depth (default: 3)
  },
  ensureInitialized: (id: string) => Promise<void>
): Promise<ImpactResult>
```

**Returns:** Direct callers, indirect dependencies, and risk assessment.

---

### renameTool

Safe multi-file rename with call graph awareness.

```typescript
async renameTool(
  repo: RepoHandle,
  params: {
    symbol_name: string;      // Current symbol name
    new_name: string;         // New symbol name
    dry_run?: boolean;        // Preview without changes (default: true)
  },
  ensureInitialized: (id: string) => Promise<void>
): Promise<RenameResult>
```

---

### detectTool

Detect code patterns and changes.

```typescript
async detectTool(
  repo: RepoHandle,
  params: {
    scope?: 'staged' | 'all' | 'compare';
    base_ref?: string;       // Base branch/commit for comparison
  },
  ensureInitialized: (id: string) => Promise<void>
): Promise<DetectResult>
```

---

### routeTools

Route extraction and analysis for web frameworks.

```typescript
async routeTools(
  repo: RepoHandle,
  params: {
    action: 'list' | 'map';
    framework?: string;      // 'echo' | 'fiber' | 'gin' | 'laravel' | etc.
  },
  ensureInitialized: (id: string) => Promise<void>
): Promise<RouteResult>
```

---

### graphTools

Graph query and manipulation.

```typescript
async graphTools(
  repo: RepoHandle,
  params: {
    action: 'query' | 'nodes' | 'edges' | 'stats';
    query?: string;          // Cypher query (for 'query' action)
    labels?: string[];       // Node labels to filter
    types?: string[];         // Relationship types to filter
  },
  ensureInitialized: (id: string) => Promise<void>
): Promise<GraphResult>
```

---

### resourcesTool

Repository resource listing.

```typescript
async resourcesTool(
  repo: RepoHandle,
  params: {
    pattern?: string;        // Glob pattern
    type?: 'file' | 'directory' | 'all';
  },
  ensureInitialized: (id: string) => Promise<void>
): Promise<ResourcesResult>
```

---

### dataflowTool

Data flow analysis (taint tracking).

```typescript
async dataflowTool(
  repo: RepoHandle,
  params: {
    source: string;           // Taint source symbol
    target?: string;          // Taint sink symbol
    path_type?: 'all' | 'shortest' | 'all_paths';
  },
  ensureInitialized: (id: string) => Promise<void>
): Promise<DataflowResult>
```

---

### overviewTool

Repository overview and statistics.

```typescript
async overviewTool(
  repo: RepoHandle,
  params: {
    include?: ('languages' | 'frameworks' | 'structure')[];
  },
  ensureInitialized: (id: string) => Promise<void>
): Promise<OverviewResult>
```

---

## CLI Commands

### npx gitnexus analyze

Analyze a repository.

```bash
npx gitnexus analyze [options]

Options:
  --repo <path>           Repository path (default: current directory)
  --embeddings           Preserve existing embeddings
  --force                Force re-analysis
  --verbose              Verbose output
```

### npx gitnexus query

Query the knowledge graph.

```bash
npx gitnexus query <query> [options]

Options:
  --repo <path>           Repository path
  --method <method>      Search method: hybrid, bm25, vector, semantic
  --limit <n>            Max results (default: 5)
```

### npx gitnexus context

Get symbol context.

```bash
npx gitnexus context <symbol-name> [options]

Options:
  --repo <path>           Repository path
  --uid <uid>            Lookup by UID
  --file <path>          Filter by file path
```

---

## Type Definitions

### RepoHandle

```typescript
interface RepoHandle {
  id: string;              // Repository unique identifier
  path: string;           // Repository file path
  name: string;           // Repository name
}
```

### ImpactResult

```typescript
interface ImpactResult {
  symbol: string;
  direction: 'upstream' | 'downstream';
  depth: number;
  direct_callers?: SymbolRef[];
  indirect_dependencies?: SymbolRef[];
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  affected_processes?: string[];
}
```

### QueryResult

```typescript
interface QueryResult {
  processes: ProcessGroup[];
  total_results: number;
  method_used: string;
  fts_used: boolean;
}
```

---

## Error Handling

All tools return error objects on failure:

```typescript
{ error: string; details?: any }
```

Common errors:
- `"Repository not initialized"` - Call `ensureInitialized` first
- `"Symbol not found"` - Symbol doesn't exist in the index
- `"Invalid query parameters"` - Missing or invalid parameters
