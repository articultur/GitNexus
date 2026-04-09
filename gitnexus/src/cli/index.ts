#!/usr/bin/env node

// Heap re-spawn removed — only analyze.ts needs the 8GB heap (via its own ensureHeap()).
// Removing it from here improves MCP server startup time significantly.

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { createLazyAction } from './lazy-action.js';
import { registerGroupCommands } from './group.js';
import { registerRemoteCommands } from './remote.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');
const program = new Command();

program.name('gitnexus').description('GitNexus local CLI and MCP server').version(pkg.version);

program
  .command('setup')
  .description('One-time setup: configure MCP for Cursor, Claude Code, OpenCode, Codex')
  .action(createLazyAction(() => import('./setup.js'), 'setupCommand'));

program
  .command('analyze [path]')
  .description('Index a repository (full analysis)')
  .option('-f, --force', 'Force full re-index even if up to date')
  .option('--embeddings', 'Enable embedding generation for semantic search (off by default)')
  .option('--skills', 'Generate repo-specific skill files from detected communities')
  .option('--skip-agents-md', 'Skip updating the gitnexus section in AGENTS.md and CLAUDE.md')
  .option('--skip-git', 'Index a folder without requiring a .git directory')
  .option('-v, --verbose', 'Enable verbose ingestion warnings (default: false)')
  .addHelpText(
    'after',
    '\nEnvironment variables:\n  GITNEXUS_NO_GITIGNORE=1  Skip .gitignore parsing (still reads .gitnexusignore)',
  )
  .action(createLazyAction(() => import('./analyze.js'), 'analyzeCommand'));

program
  .command('index [path...]')
  .description(
    'Register an existing .gitnexus/ folder into the global registry (no re-analysis needed)',
  )
  .option('-f, --force', 'Register even if meta.json is missing (stats will be empty)')
  .option('--allow-non-git', 'Allow registering folders that are not Git repositories')
  .action(createLazyAction(() => import('./index-repo.js'), 'indexCommand'));

program
  .command('serve')
  .description('Start local HTTP server for web UI connection')
  .option('-p, --port <port>', 'Port number', '4747')
  .option('--host <host>', 'Bind address (default: 127.0.0.1, use 0.0.0.0 for remote access)')
  .action(createLazyAction(() => import('./serve.js'), 'serveCommand'));

program
  .command('mcp')
  .description('Start MCP server (stdio) — serves all indexed repos')
  .action(createLazyAction(() => import('./mcp.js'), 'mcpCommand'));

program
  .command('list')
  .description('List all indexed repositories')
  .action(createLazyAction(() => import('./list.js'), 'listCommand'));

program
  .command('status')
  .description('Show index status for current repo')
  .action(createLazyAction(() => import('./status.js'), 'statusCommand'));

program
  .command('clean [name]')
  .description('Delete GitNexus index for current repo, or for a named repo')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--all', 'Clean all indexed repos')
  .action(createLazyAction(() => import('./clean.js'), 'cleanCommand'));

program
  .command('wiki [path]')
  .description('Generate repository wiki from knowledge graph')
  .option('-f, --force', 'Force full regeneration even if up to date')
  .option('--provider <provider>', 'LLM provider: openai or cursor (default: openai)')
  .option('--model <model>', 'LLM model or Azure deployment name (default: minimax/minimax-m2.5)')
  .option(
    '--base-url <url>',
    'LLM API base URL. Azure v1: https://{resource}.openai.azure.com/openai/v1',
  )
  .option('--api-key <key>', 'LLM API key or Azure api-key (saved to ~/.gitnexus/config.json)')
  .option(
    '--api-version <version>',
    'Azure api-version query param, e.g. 2024-10-21 (legacy Azure API only)',
  )
  .option(
    '--reasoning-model',
    'Mark deployment as reasoning model (o1/o3/o4-mini) — strips temperature, uses max_completion_tokens',
  )
  .option('--no-reasoning-model', 'Disable reasoning model mode (overrides saved config)')
  .option('--concurrency <n>', 'Parallel LLM calls (default: 3)', '3')
  .option('--gist', 'Publish wiki as a public GitHub Gist after generation')
  .option('-v, --verbose', 'Enable verbose output (show LLM commands and responses)')
  .option('--review', 'Stop after grouping to review module structure before generating pages')
  .action(createLazyAction(() => import('./wiki.js'), 'wikiCommand'));

program
  .command('augment <pattern>')
  .description('Augment a search pattern with knowledge graph context (used by hooks)')
  .action(createLazyAction(() => import('./augment.js'), 'augmentCommand'));

// ─── Direct Tool Commands (no MCP overhead) ────────────────────────
// These invoke LocalBackend directly for use in eval, scripts, and CI.

program
  .command('detect-changes')
  .description('Detect execution flows affected by git changes (pre-commit review)')
  .option(
    '-s, --scope <scope>',
    'What to analyze: "unstaged" (default), "staged", "all", "compare", or "commit"',
    'unstaged',
  )
  .option(
    '--base-ref <ref>',
    'For "compare": base branch/ref to compare against. For "commit": the commit hash to analyze.',
  )
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('--detection', 'Enable bug detection rules on changed symbols (off by default)')
  .option('-f, --file <path>', 'Filter to a specific file path for drill-down analysis')
  .option('--precision <level>', 'Force precision level: normal, symbol-level, or file-level')
  .option('--normal-max <bytes>', 'Custom normal mode threshold in bytes (default: 524288)')
  .option('--symbol-max <bytes>', 'Custom symbol-level threshold in bytes (default: 2097152)')
  .action(createLazyAction(() => import('./tool.js'), 'detectChangesCommand'));

program
  .command('query <search_query>')
  .description('Search the knowledge graph for execution flows related to a concept')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'What you want to find')
  .option('-l, --limit <n>', 'Max processes to return (default: 5)')
  .option('--content', 'Include full symbol source code')
  .action(createLazyAction(() => import('./tool.js'), 'queryCommand'));

program
  .command('context [name]')
  .description('360-degree view of a code symbol: callers, callees, processes')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('--content', 'Include full symbol source code')
  .action(createLazyAction(() => import('./tool.js'), 'contextCommand'));

program
  .command('impact <target>')
  .description('Blast radius analysis: what breaks if you change a symbol')
  .option('-d, --direction <dir>', 'upstream (dependants) or downstream (dependencies)', 'upstream')
  .option('-r, --repo <name>', 'Target repository')
  .option('--depth <n>', 'Max relationship depth (default: 3)')
  .option('--include-tests', 'Include test files in results')
  .option('--detail <mode>', 'Output detail mode: auto, summary, or full', 'auto')
  .option('--snapshot-id <id>', 'Snapshot ID for pagination (from previous layered result)')
  .option('--page <json>', 'Pagination params as JSON: \'{"depth":1,"offset":0,"limit":100}\'')
  .action(createLazyAction(() => import('./tool.js'), 'impactCommand'));

program
  .command('cypher <query>')
  .description('Execute raw Cypher query against the knowledge graph')
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./tool.js'), 'cypherCommand'));

// ─── Eval Server (persistent daemon for SWE-bench) ─────────────────

program
  .command('eval-server')
  .description('Start lightweight HTTP server for fast tool calls during evaluation')
  .option('-p, --port <port>', 'Port number', '4848')
  .option('--idle-timeout <seconds>', 'Auto-shutdown after N seconds idle (0 = disabled)', '0')
  .action(createLazyAction(() => import('./eval-server.js'), 'evalServerCommand'));

program
  .command('use [name]')
  .description(
    'Set the default repository for query/context/impact/cypher. No arg shows current default.',
  )
  .option('--clear', 'Remove the default repository setting')
  .action(createLazyAction(() => import('./use.js'), 'useCommand'));

program
  .command('push [remote-name-or-url]')
  .description(
    'Push local index to a remote. Arg is a remote NAME (e.g. origin) or direct URL. Index slot name defaults to the local repo dir name; use --name to override.',
  )
  .option(
    '--name <name>',
    'Override the index slot name in the remote (default: local repo dir name)',
  )
  .option('--token <token>', 'Auth token (injected into HTTPS URL or sent as Bearer header)')
  .option('--path <path>', 'Path to the git repository (default: current directory)')
  .option('--force', 'Overwrite remote index without confirmation')
  .action(createLazyAction(() => import('./push.js'), 'pushCommand'));

program
  .command('pull <index-name>')
  .description(
    'Pull an index from a remote. Arg is the index slot NAME in the remote (e.g. GitNexus). Use --remote to specify which remote.',
  )
  .option('--remote <remote>', 'Use this named remote from config (e.g. origin)')
  .option('--name <name>', 'Override the local index name after download')
  .option('--token <token>', 'Auth token (injected into HTTPS URL or sent as Bearer header)')
  .option('-f, --force', 'Overwrite existing local index')
  .option('--path <path>', 'Path to the git repository (default: current directory)')
  .action(createLazyAction(() => import('./pull.js'), 'pullCommand'));

registerRemoteCommands(program);
registerGroupCommands(program);

program.parse(process.argv);
