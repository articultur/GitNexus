// gitnexus/src/cli/group.ts
import { createRequire } from 'node:module';
import type { Command } from 'commander';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

export function registerGroupCommands(program: Command): void {
  const group = program
    .command('group')
    .description('Manage repository groups for cross-index impact analysis')
    .addHelpText(
      'after',
      `
Groups allow cross-repo impact analysis by linking multiple indexed repositories.
Each group has a group.yaml config that maps repo paths to registry names.

Examples:
  $ gitnexus group create my-project
  $ gitnexus group add my-project backend/api api-service
  $ gitnexus group sync my-project
  $ gitnexus group query my-project "user authentication"

Config location: ~/.gitnexus/groups/<name>/group.yaml
`,
    );

  group
    .command('create <name>')
    .description('Create a new group with template group.yaml')
    .option('--force', 'Overwrite existing group')
    .addHelpText(
      'after',
      `
Example:
  $ gitnexus group create my-project
  Created group "my-project" at /Users/you/.gitnexus/groups/my-project
  Edit group.yaml to add repos, then run: gitnexus group sync my-project
`,
    )
    .action(async (name: string, opts: { force?: boolean }) => {
      const { createGroupDir, getDefaultGitnexusDir } = await import('../core/group/storage.js');
      const dir = await createGroupDir(getDefaultGitnexusDir(), name, opts.force);
      console.log(`Created group "${name}" at ${dir}`);
      console.log('Edit group.yaml to add repos, then run: gitnexus group sync ' + name);
    });

  group
    .command('add <group> <groupPath> <registryName>')
    .description(
      'Add a repo to a group. <groupPath> = hierarchy path (e.g. hr/hiring/backend), <registryName> = name from registry',
    )
    .addHelpText(
      'after',
      `
Arguments:
  group        Group name (e.g. my-project)
  groupPath    Hierarchical path within the group (e.g. backend/api, frontend/web)
  registryName Name of the indexed repo in the global registry

Example:
  $ gitnexus group add my-project backend/api api-service
  Added api-service as "backend/api" to group "my-project"
  Run: gitnexus group sync my-project
`,
    )
    .action(async (groupName: string, groupPath: string, registryName: string) => {
      const { getGroupDir, getDefaultGitnexusDir } = await import('../core/group/storage.js');
      const { loadGroupConfig } = await import('../core/group/config-parser.js');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const groupDir = getGroupDir(getDefaultGitnexusDir(), groupName);
      const config = await loadGroupConfig(groupDir);
      config.repos[groupPath] = registryName;

      await fs.writeFile(path.join(groupDir, 'group.yaml'), yaml.dump(config), 'utf-8');
      console.log(`Added ${registryName} as "${groupPath}" to group "${groupName}"`);
      console.log(`Run: gitnexus group sync ${groupName}`);
    });

  group
    .command('remove <group> <path>')
    .description('Remove a repo from a group')
    .addHelpText(
      'after',
      `
Example:
  $ gitnexus group remove my-project backend/api
  Removed "backend/api" from group "my-project"
`,
    )
    .action(async (groupName: string, repoPath: string) => {
      const { getGroupDir, getDefaultGitnexusDir } = await import('../core/group/storage.js');
      const { loadGroupConfig } = await import('../core/group/config-parser.js');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const groupDir = getGroupDir(getDefaultGitnexusDir(), groupName);
      const config = await loadGroupConfig(groupDir);
      if (!(repoPath in config.repos)) {
        console.error(`Repo path "${repoPath}" not found in group "${groupName}"`);
        process.exitCode = 1;
        return;
      }
      delete config.repos[repoPath];
      await fs.writeFile(path.join(groupDir, 'group.yaml'), yaml.dump(config), 'utf-8');
      console.log(`Removed "${repoPath}" from group "${groupName}"`);
    });

  group
    .command('list [name]')
    .description('List all groups or details of one')
    .addHelpText(
      'after',
      `
Examples:
  $ gitnexus group list           # list all groups
  $ gitnexus group list my-project  # show group details

Output shows repos mapping and manifest links if configured.
`,
    )
    .action(async (name?: string) => {
      const { listGroups, getDefaultGitnexusDir, getGroupDir } =
        await import('../core/group/storage.js');
      if (!name) {
        const groups = await listGroups();
        if (groups.length === 0) {
          console.log('No groups configured. Create one with: gitnexus group create <name>');
          return;
        }
        console.log('Groups:');
        groups.forEach((g) => console.log(`  ${g}`));
        return;
      }
      const { loadGroupConfig } = await import('../core/group/config-parser.js');
      const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
      const config = await loadGroupConfig(groupDir);
      console.log(`Group: ${config.name}`);
      if (config.description) console.log(`Description: ${config.description}`);
      console.log(`\nRepos (${Object.keys(config.repos).length}):`);
      for (const [p, id] of Object.entries(config.repos)) {
        console.log(`  ${p} -> ${id}`);
      }
      if (config.links.length > 0) {
        console.log(`\nManifest links (${config.links.length}):`);
        for (const link of config.links) {
          console.log(`  ${link.from} -> ${link.to} [${link.type}: ${link.contract}]`);
        }
      }
    });

  group
    .command('status <name>')
    .description('Check staleness of group and repos')
    .addHelpText(
      'after',
      `
Example:
  $ gitnexus group status my-project

Shows:
  - Last sync timestamp
  - Per-repo index staleness (commits behind)
  - Contract registry staleness
  - Missing repos from last sync
`,
    )
    .action(async (name: string) => {
      const { readContractRegistry, getGroupDir, getDefaultGitnexusDir } =
        await import('../core/group/storage.js');
      const { LocalBackend } = await import('../mcp/local/local-backend.js');

      const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
      const registry = await readContractRegistry(groupDir);

      console.log(
        `Group: ${name}${registry ? ` (last sync: ${registry.generatedAt})` : ' (never synced)'}\n`,
      );

      const backend = new LocalBackend();
      try {
        await backend.init();
        const raw = await backend.getGroupService().groupStatus({ name });
        const st = raw as {
          repos?: Record<
            string,
            {
              indexStale: boolean;
              contractsStale: boolean;
              missing: boolean;
              commitsBehind?: number;
            }
          >;
          missingRepos?: string[];
        };

        console.log('  Repo index / contracts staleness:');
        for (const [repoPath, row] of Object.entries(st.repos || {})) {
          if (row.missing) {
            console.log(`  ${repoPath.padEnd(25)} MISSING   (not in registry or unreadable)`);
            continue;
          }
          const idx = row.indexStale
            ? `STALE     (${row.commitsBehind ?? '?'} commits behind)`
            : 'OK        ';
          const ctr = row.contractsStale ? ' CONTRACTS_STALE' : '';
          console.log(`  ${repoPath.padEnd(25)} ${idx}${ctr}`);
        }
        if ((st.missingRepos || []).length > 0) {
          console.log(`\n  Last sync missing repos: ${st.missingRepos!.join(', ')}`);
        }
      } finally {
        await backend.dispose().catch(() => {});
      }
    });

  group
    .command('sync <name>')
    .description('Sync Contract Registry — extract contracts and build cross-links')
    .option('--skip-embeddings', 'Exact + BM25 only (no embedding fallback)')
    .option('--exact-only', 'Exact match only')
    .option('--allow-stale', 'Skip stale index warnings')
    .option('--verbose', 'Show each cross-link detail')
    .option('--json', 'JSON output')
    .addHelpText(
      'after',
      `
Example:
  $ gitnexus group sync my-project
  $ gitnexus group sync my-project --verbose

This command:
  1. Extracts HTTP contracts from each repo's index
  2. Matches contracts across repos (exact + fuzzy matching)
  3. Builds cross-links for cross-repo impact analysis
  4. Writes contracts.json to the group directory

Matching cascade: exact → BM25 → embedding (if --embeddings enabled)
`,
    )
    .action(async (name: string, opts: Record<string, boolean | undefined>) => {
      const { getGroupDir, getDefaultGitnexusDir } = await import('../core/group/storage.js');
      const { loadGroupConfig } = await import('../core/group/config-parser.js');
      const { syncGroup } = await import('../core/group/sync.js');

      const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
      const config = await loadGroupConfig(groupDir);

      console.log(`Syncing group "${name}" (${Object.keys(config.repos).length} repos)...\n`);

      const result = await syncGroup(config, {
        groupDir,
        allowStale: Boolean(opts.allowStale),
        verbose: Boolean(opts.verbose),
        skipEmbeddings: Boolean(opts.skipEmbeddings),
        exactOnly: Boolean(opts.exactOnly),
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nMatching cascade:`);
        const exactLinks = result.crossLinks.filter((l) => l.matchType === 'exact');
        console.log(`  exact:     ${exactLinks.length} cross-links (confidence 1.0)`);
        console.log(`  unmatched: ${result.unmatched.length} contracts`);
        console.log(
          `\nWrote contracts.json (${result.contracts.length} contracts, ${result.crossLinks.length} cross-links)`,
        );
      }
    });

  group
    .command('query <name> <query>')
    .description('Search execution flows across all repos in a group')
    .option('--subgroup <path>', 'Limit search scope')
    .option('--limit <n>', 'Max merged results', '5')
    .option('--json', 'JSON output')
    .addHelpText(
      'after',
      `
Examples:
  $ gitnexus group query my-project "user authentication"
  $ gitnexus group query my-project "payment flow" --subgroup backend
  $ gitnexus group query my-project "API handler" --limit 10 --json

Results are merged using Reciprocal Rank Fusion (RRF) from all repos.
Use --subgroup to limit search to a specific path prefix.
`,
    )
    .action(
      async (
        name: string,
        queryText: string,
        opts: Record<string, string | boolean | undefined>,
      ) => {
        const { LocalBackend } = await import('../mcp/local/local-backend.js');

        const limit = parseInt(String(opts.limit ?? '5'), 10) || 5;
        const subgroup = opts.subgroup as string | undefined;
        const backend = new LocalBackend();
        try {
          await backend.init();

          console.log(`Searching "${queryText}" across group "${name}"...\n`);

          const raw = await backend.getGroupService().groupQuery({
            name,
            query: queryText,
            limit,
            subgroup,
          });
          const merged = raw as {
            results: Array<Record<string, unknown>>;
            per_repo: Array<{ repo: string; count: number }>;
          };

          if (opts.json) {
            console.log(JSON.stringify(raw, null, 2));
          } else {
            console.log(`Results (top ${merged.results.length}):\n`);
            for (const p of merged.results) {
              const label = (p.summary || p.heuristicLabel || p.name || 'unnamed') as string;
              console.log(`  [${p._repo}] ${label} (rrf: ${(p._rrf_score as number).toFixed(4)})`);
            }
            if (merged.results.length === 0) {
              console.log('  No matching execution flows found.');
            }
          }
        } finally {
          await backend.dispose().catch(() => {});
        }
      },
    );

  group
    .command('contracts <name>')
    .description('Inspect Contract Registry')
    .option('--type <type>', 'Filter by contract type')
    .option('--repo <repo>', 'Filter by repo')
    .option('--unmatched', 'Show only unmatched contracts')
    .option('--json', 'JSON output')
    .addHelpText(
      'after',
      `
Examples:
  $ gitnexus group contracts my-project
  $ gitnexus group contracts my-project --type http
  $ gitnexus group contracts my-project --unmatched
  $ gitnexus group contracts my-project --repo backend/api --json

Output shows:
  - Contracts: role, contractId, repo, symbol name
  - Cross-links: from/to repo, match type, confidence
`,
    )
    .action(async (name: string, opts: Record<string, string | boolean | undefined>) => {
      const { LocalBackend } = await import('../mcp/local/local-backend.js');

      const backend = new LocalBackend();
      try {
        await backend.init();
        const raw = await backend.getGroupService().groupContracts({
          name,
          type: opts.type as string | undefined,
          repo: opts.repo as string | undefined,
          unmatchedOnly: Boolean(opts.unmatched),
        });

        if (raw && typeof raw === 'object' && 'error' in raw) {
          console.error(String((raw as { error: string }).error));
          process.exitCode = 1;
          return;
        }

        const { contracts, crossLinks } = raw as {
          contracts: Array<{
            role: string;
            contractId: string;
            repo: string;
            symbolRef: { name: string };
          }>;
          crossLinks: Array<{
            from: { repo: string };
            to: { repo: string };
            matchType: string;
            confidence: number;
            contractId: string;
          }>;
        };

        if (opts.json) {
          console.log(JSON.stringify({ contracts, crossLinks }, null, 2));
        } else {
          console.log(`Contracts (${contracts.length}):`);
          for (const c of contracts) {
            console.log(`  [${c.role}] ${c.contractId}  (${c.repo})  ${c.symbolRef.name}`);
          }
          console.log(`\nCross-links (${crossLinks.length}):`);
          for (const l of crossLinks) {
            console.log(
              `  ${l.from.repo} -> ${l.to.repo}  [${l.matchType}, conf=${l.confidence}]  ${l.contractId}`,
            );
          }
        }
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
}
