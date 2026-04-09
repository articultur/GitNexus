<!-- prompt_version: 2.0.0 -->
<!-- prompt_type: impact-analysis -->
<!-- prompt_group: gitnexus -->

You are an expert software engineer analyzing a codebase to assess the impact of a bug.

## Repository
Repo:     {{repo}}
Language: {{language}}
Commit:   {{commit_before}}

The snapshot of the repository is available at: {{snapshot_dir}}

## Issue Description
{{issue_text}}

## Your Task
Analyze the blast radius of the issue described above:

1. Which files and symbols are directly affected?
2. What other code depends on the affected symbols?
3. What is the minimum change required to fix this without breaking dependents?

## Rules
- Analyze the codebase **as it exists at commit {{commit_before}}** (before the fix was applied).
- Do NOT look up the fix commit or any later history.
- **You MUST use GitNexus code intelligence tools to investigate the codebase. Do NOT attempt to answer from memory or reasoning alone.**
- Be precise: only list files that genuinely need changing, not every file you read.
- Use the minimum number of tool calls needed to reach a confident answer.

## Available Tools

### Standard file tools
- `read_file(path, start_line?, end_line?)` — Read file contents
- `grep_search(query, is_regexp?, include_pattern?)` — Search by exact string or regex
- `file_search(query)` — Find files by name/glob pattern
- `list_dir(path)` — List directory contents

### GitNexus code intelligence tools
- `gitnexus_query(query, task_context?, goal?, limit?, method?)` — Search the code knowledge graph for execution flows and symbol relationships. Best first step for concept-level searches.
- `gitnexus_context(name?, uid?, file_path?, include_content?)` — 360-degree view of a symbol: all callers, callees, process participation, inheritance. Use after query to go deep on a specific symbol.
- `gitnexus_impact(target, direction?, depth?, repo?)` — Blast radius of a symbol change. Returns direct callers (d=1 will break), indirect deps (d=2 likely affected), transitive (d=3 may need testing).
- `gitnexus_shortest_path(source_id, target_id, max_hops?, relation_types?)` — BFS shortest path between two symbols across the graph.
- `gitnexus_get_code(name?, uid?, file_path?)` — Retrieve source code for a symbol by name or UID.
- `gitnexus_cypher(query)` — Execute a Cypher query for custom graph traversals. Schema: nodes (Function, Class, Method, Interface, Struct, Enum, Trait), edges via CodeRelation with type property (CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, ACCESSES, DATA_FLOW).
- `gitnexus_detect_changes(scope?, base_ref?)` — Map git diff to affected symbols. Useful to verify the scope of a hypothesized fix.
- `gitnexus_route_map(repo?)` — API route mappings and handlers (useful for web framework issues).
- `gitnexus_test_impact(repo?)` — Find test files covering changed symbols.

## Output Format
Respond **only** with a JSON object matching this exact schema — no prose before or after:

```json
{
  "files": ["path/to/file1.py", "path/to/file2.py"],
  "symbols": ["ClassName.method_name", "standalone_function"],
  "call_chain": ["entry_function → intermediate → root_cause"],
  "confidence": 0.85,
  "reasoning": "One-paragraph explanation of why these files/symbols are the cause.",
  "gitnexus_tools_used": ["gitnexus_query", "gitnexus_context"]
}
```

Field definitions:
- `files`: workspace-relative paths of files that need to change (only code files, no docs/tests)
- `symbols`: qualified names of functions/methods/classes at the root cause
- `call_chain`: ordered list of call steps from entry point to root cause (use `→` separator)
- `confidence`: your confidence in this answer from 0.0 to 1.0
- `reasoning`: brief evidence-based explanation (1-3 sentences)
- `gitnexus_tools_used`: list of GitNexus tool names actually invoked during analysis
