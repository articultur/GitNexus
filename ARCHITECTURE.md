# Architecture — GitNexus

This repository is a **monorepo** with two main products: the **CLI / MCP package** (`gitnexus/`) and the **browser UI** (`gitnexus-web/`). Supporting folders ship editor integrations and plugins without changing the core graph engine.

## Repository layout

| Path | Role |
|------|------|
| `gitnexus/` | Published npm package `gitnexus`: CLI, MCP server (stdio), local HTTP API for bridge mode, ingestion pipeline, LadybugDB graph, embeddings (optional). |
| `gitnexus-web/` | Vite + React UI: in-browser indexing (WASM), graph visualization, optional connection to `gitnexus serve`. |
| `.claude/`, `gitnexus-claude-plugin/`, `gitnexus-cursor-integration/` | Packaged **skills** and plugin metadata so agents discover the same workflows as documented in `AGENTS.md`. |
| `eval/` | Evaluation harnesses and docs for benchmarking tool usage. |
| `.github/` | CI workflows (quality, unit, integration, E2E) and composite actions. |

## End-to-end flow: index → graph → tools

1. **Ingestion** (`gitnexus analyze`)  
   - Entry: `gitnexus/src/cli/analyze.ts` → `runPipelineFromRepo` in `gitnexus/src/core/ingestion/pipeline.ts`.  
   - Walks the git working tree, parses supported languages via **Tree-sitter**, resolves imports/calls/inheritance, detects **communities** and **processes** (execution flows), and builds an in-memory **knowledge graph** (`gitnexus/src/core/graph/`).  
   - Output is loaded into **LadybugDB** under **`.gitnexus/`** at the repo root (`lbug/`, `meta.json`, etc.). Optional **FTS** indexes and **embeddings** attach to the same store.  
   - The repo is registered in **`~/.gitnexus/registry.json`** so MCP can find it from any working directory.

2. **Persistence & metadata**  
   - `gitnexus/src/storage/repo-manager.ts` — paths, registry, cleanup of legacy Kuzu artifacts.  
   - `gitnexus/src/core/lbug/lbug-adapter.ts` — graph load, queries, embedding restore batches.

3. **Query & agents**  
   - **MCP (stdio):** `gitnexus/src/cli/mcp.ts` → `startMCPServer` → `LocalBackend` (`gitnexus/src/mcp/local/local-backend.ts`) opens registered repos and serves **tools** from `gitnexus/src/mcp/tools.ts` and **resources** from `gitnexus/src/mcp/resources.ts`.  
   - **Bridge HTTP:** `gitnexus/src/cli/serve.ts` → Express app in `gitnexus/src/server/api.ts` (CORS-limited) exposes REST + MCP-over-HTTP for the web UI.  
   - **CLI tools (no MCP):** `gitnexus query`, `context`, `impact`, `cypher` in `gitnexus/src/cli/tool.ts` call the same backend for scripts and CI.

4. **Staleness**  
   - `gitnexus/src/mcp/staleness.ts` compares indexed `lastCommit` to `HEAD` and surfaces hints when the graph is behind git.

## MCP tools (summary)

| Tool | Purpose |
|------|---------|
| `list_repos` | Discover indexed repositories when more than one is registered. |
| `query` | Natural-language / keyword search over the graph (hybrid BM25 + optional vectors). |
| `cypher` | Ad hoc **Cypher** against the schema (see resource `gitnexus://repo/{name}/schema`). |
| `context` | Callers, callees, processes for one symbol (with disambiguation). |
| `impact` | Blast radius (upstream/downstream) with depth and risk summary. |
| `detect_changes` | Map git diffs to affected symbols and processes. |
| `rename` | Graph-assisted rename with `dry_run` preview (`graph` vs `text_search` confidence). |
| `route_map` | Show API route mappings: handlers, middleware chains, consumers. |
| `shape_check` | Check API response shapes vs consumer property accesses for drift. |
| `api_impact` | Pre-change impact report for an API route handler (consumers, middleware, flows). |
| `tool_map` | Show MCP/RPC tool definitions, handler files, descriptions. |
| `group_list` | List all configured repository groups. |
| `group_sync` | Rebuild Contract Registry (contracts.json) for a group. |
| `group_contracts` | Inspect contracts and cross-links from group's contracts.json. |
| `group_query` | Run query across all repos in a group with merged results. |
| `group_status` | Report index staleness for each repo in a group. |

## Language Provider Architecture

GitNexus uses a **Strategy pattern** for multi-language support. Each language has a `LanguageProvider` that defines language-specific behavior for parsing, type extraction, import resolution, and more.

### Supported Languages (18 providers)

| Language | Extensions | Key Traits |
|----------|------------|------------|
| TypeScript | `.ts`, `.tsx` | Tree-sitter queries, interface/type nodes, JSX support |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | Tree-sitter queries, ES modules |
| Python | `.py` | Namespace imports, C3 MRO, named bindings (`from X import Y`) |
| Java | `.java` | Fully qualified names, package resolution |
| Kotlin | `.kt`, `.kts` | Kotlin-specific syntax, extension functions |
| Go | `.go` | Import paths, struct tags |
| Rust | `.rs` | Crate modules, lifetime annotations |
| C# | `.cs` | Namespaces, LINQ queries |
| C | `.c`, `.h` | Header guards, preprocessor directives |
| C++ | `.cpp`, `.hpp`, `.cc`, `.hh` | Templates, name mangling awareness |
| PHP | `.php` | `$` variables, `::` static access |
| Ruby | `.rb` | Method calls without parens, blocks |
| Swift | `.swift` | Optional chaining, implicit imports |
| Dart | `.dart` | Import prefixes, `show`/`hide` clauses |
| ArkTS | `.ts` (ArkTS mode) | Preprocessed TypeScript for ArkUI |
| Vue | `.vue` | SFC support: `<script>`, `<template>`, `<style>` blocks |
| COBOL | `.cbl`, `.cob` | Fixed-format source, paragraph sections |
| Objective-C | `.m`, `.mm` | Message send syntax `[obj msg:]` |

### LanguageProvider Interface

Each provider exports a `LanguageProvider` object with:

```typescript
interface LanguageProvider {
  id: SupportedLanguages;           // Enum value
  extensions: string[];             // File extensions to recognize
  treeSitterQueries?: QuerySet;     // Custom tree-sitter queries
  typeConfig: TypeConfig;           // Type extraction rules
  exportChecker: ExportChecker;     // Detects exported symbols
  importResolver: ImportResolver;   // Resolves import paths
  namedBindingExtractor?: BindingExtractor;  // Named import extraction
  implicitImportWirer?: ImplicitWirer;      // Auto-wire implicit imports (Swift)
  fieldExtractor?: FieldExtractor;  // Property access tracking
  methodExtractor?: MethodExtractor;// Method call tracking
  builtIns?: ReadonlySet<string>;   // Language built-ins to skip
  importSemantics?: 'wildcard' | 'namespace' | 'default';
  mroStrategy?: 'c3' | 'dfs';       // Method resolution order
}
```

### Provider Registry (`languages/index.ts`)

The registry provides:
- **`providers`**: Compile-time exhaustive table mapping `SupportedLanguages` enum → provider
- **`getProvider(lang)`**: Look up provider by language enum
- **`getProviderForFile(path)`**: Look up provider by file extension
- **`providersWithImplicitWiring`**: Pre-computed list for languages with auto-import behavior

### Processing Pipeline

Each language follows the same ingestion phases, but the provider determines:

1. **Parse** (Phase 4): Tree-sitter parses source → AST
2. **Type Extract** (Phase 5-8): Language-specific rules extract types/interfaces
3. **Export Check** (Phase 6): Detect exported symbols vs internal
4. **Import Resolve** (Phase 7): Map imports to resolved file paths
5. **Named Bindings** (Phase 7): Extract `from X import {Y}` style bindings
6. **Symbol Index** (Phase 8): Build symbol index with references
7. **Graph Write** (Phase 10-12): Write nodes/edges to graph

### Vue SFC Support

Vue files (`.vue`) are handled by the `vueProvider` with special preprocessing:
- Extract `<script>` block → parse as TypeScript
- Extract `<template>` block → parse template expressions
- Extract `<style>` block → parse CSS selectors
- All blocks reference the same parent Vue file in the graph

## Group Service Architecture

The Group Service enables **cross-repository contract tracking** and **multi-repo queries**. It was added to support fork-merges and monorepo-adjacent workflows.

### Core Concepts

- **Group**: A named collection of repositories defined in `~/.gitnexus/groups/{name}/group.yaml`
- **Contract**: An API boundary (HTTP endpoint, gRPC method, topic, library) extracted from source
- **Cross-Link**: A matched provider ↔ consumer pair across repositories
- **Contract Registry**: Persisted JSON (`contracts.json`) with all contracts and cross-links

### Contract Types

| Type | Detection | Matching Strategy |
|------|-----------|-------------------|
| `http` | HTTP method + path pattern | Exact match on `METHOD::/path` |
| `grpc` | gRPC service + method | Package + method name normalization |
| `topic` | Message queue topic strings | Lowercase topic ID |
| `lib` | Exported function/class | Symbol name normalization |
| `custom` | User-defined via manifest | Manifest-based linking |

### Service Architecture

```
GroupService (src/core/group/service.ts)
├── groupList()       → List groups or return group config
├── groupSync()       → Extract contracts, build cross-links
├── groupContracts()  → Query contract registry
├── groupQuery()      → Multi-repo search with RRF fusion
└── groupStatus()     → Check staleness per repo
```

### Key Modules

| Module | Role |
|--------|------|
| `config-parser.ts` | Parse `group.yaml` into `GroupConfig` |
| `contract-extractor.ts` | Extract HTTP/gRPC/topic contracts from indexed repos |
| `matching.ts` | Match providers to consumers (exact, manifest, BM25, embedding) |
| `service-boundary-detector.ts` | Detect service boundaries in monorepos |
| `sync.ts` | Orchestrate full group sync: extract → match → persist |
| `storage.ts` | Read/write group configs and contract registry |

### GroupConfig Structure

```yaml
version: 1
name: "my-group"
description: "Cross-repo analysis group"
repos:
  /path/to/repo-a: "repo-a"
  /path/to/repo-b: "repo-b"
links:
  - from: "repo-a"
    to: "repo-b"
    type: "http"
    contract: "GET::/api/users"
    role: "consumer"  # or "provider"
detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.85
```

### Matching Pipeline

1. **Exact Match**: Normalize contract IDs and match directly
2. **Manifest Links**: Apply explicit `links` from `group.yaml`
3. **BM25 Fallback**: Keyword-based similarity matching
4. **Embedding Fallback**: Semantic vector similarity (requires `--embeddings`)

## Data Flow Analysis (Three-View: AST → CFG → DFG)

GitNexus implements a layered code-analysis model inspired by COMEX, building three interdependent views of every indexed function:

### AST (Abstract Syntax Tree) — Phase 4–8
- Produced by **tree-sitter** parsers for each supported language.
- Nodes represent syntax constructs (expressions, declarations, statements).
- Used as the raw material for both CFG and DFG extraction.
- Canonical path: `gitnexus/src/core/ingestion/parsers/`.

### CFG (Control Flow Graph) — Phase 12
- Built from the tree-sitter AST via `cfg-builder.ts`.
- Represents the **static control flow** of a function: which statements execute in sequence, which branches are taken, and where loops land.
- Core function: `buildCFG(tree, source, language, functionId?)` → `CFGResult`.

**CFG edge types (`CFG_EDGE` in the graph):**

| Edge type | Meaning |
|-----------|---------|
| `NEXT` | Sequential execution |
| `TRUE_BRANCH` | Taken when condition is true (if/ternary) |
| `FALSE_BRANCH` | Taken when condition is false |
| `LOOP_HEADER` | Self-loop: re-enters loop at condition |
| `BREAK` | Jumps to innermost loop header |
| `CONTINUE` | Jumps back to loop header |
| `SWITCH_CASE` | Reached from switch header |
| `SWITCH_DEFAULT` | Reached via default clause |
| `TRY_BODY` | Entry into try block |
| `CATCH` | Exception caught by handler |
| `THROW` | Exception propagation |
| `RETURN` | Function exit |

**CFG construction flow:**
```
Function source code
  → tree-sitter parses to Tree
    → buildCFG() walks AST recursively
      → emit one block per statement node
      → emit control-flow edges (NEXT, TRUE_BRANCH, …)
        → CFGResult { nodes[], edges[] }
          → writeCFGEdges() → CFG_EDGE graph edges
```

The walk is language-agnostic (same algorithm works for TypeScript, Python, Go, Rust, C, etc.) by matching against a set of standard tree-sitter node types.

### DFG (Data Flow Graph) — Phase 12 (dataflow processor)
- Built on top of the CFG using lattice-based data-flow analysis (`dfa-engine.ts`).
- Propagates **value facts** (constant, tainted, sanitized) along CFG paths.
- Taint analysis (`taint-engine.ts`) tracks SOURCE → SINK paths through the CFG.
- Edges written: `CFG_EDGE`, `DATA_FLOW`, `PROPAGATES`, `RETURNS`, `TAINTED`, `SANITIZES`, `SINK_REACHABLE`, `ALIASES`.

## Where to change what

| If you are changing… | Start in… |
|----------------------|-----------|
| CLI commands / flags | `gitnexus/src/cli/` (`index.ts`, per-command modules). |
| Parsing or graph construction | `gitnexus/src/core/ingestion/` (pipeline, processors, resolvers, type-extractors). |
| Language providers | `gitnexus/src/core/ingestion/languages/` (one file per language). |
| Graph schema / DB access | `gitnexus/src/core/lbug/` (`schema.ts`, `lbug-adapter.ts`), `gitnexus/src/mcp/core/lbug-adapter.ts` if MCP-specific. |
| MCP protocol, tools, resources | `gitnexus/src/mcp/server.ts`, `tools.ts`, `resources.ts`. |
| Group service / cross-repo | `gitnexus/src/core/group/` (config, contracts, matching, sync). |
| Search ranking | `gitnexus/src/core/search/` (BM25, hybrid fusion). |
| Embeddings | `gitnexus/src/core/embeddings/`, phases in `analyze.ts`. |
| Wiki generation | `gitnexus/src/core/wiki/`. |
| Web UI behavior | `gitnexus-web/src/` (components, workers, graph client). |
| CI | `.github/workflows/*.yml`, `.github/actions/setup-gitnexus/`. |

## Related docs

- [RUNBOOK.md](RUNBOOK.md) — operational commands and recovery.  
- [GUARDRAILS.md](GUARDRAILS.md) — safety boundaries for humans and agents.  
- [TESTING.md](TESTING.md) — how to run tests.  
- `AGENTS.md` / `CLAUDE.md` — agent workflows and tool usage expectations for **this** repo when indexed by GitNexus.
