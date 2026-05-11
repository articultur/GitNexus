/**
 * `gitnexus use <name>` — Set the default repository for query/context/impact/cypher.
 *
 * When multiple repositories are indexed, every tool command requires --repo <name>.
 * Running `gitnexus use GitNexus` saves a defaultRepo to ~/.gitnexus/config.json so
 * subsequent commands work without the flag.
 *
 * Usage:
 *   gitnexus use GitNexus          # set default repo
 *   gitnexus use                   # show current default
 *   gitnexus use --clear           # remove the default
 */

import { listRegisteredRepos, loadCLIConfig, saveCLIConfig } from '../storage/repo-manager.js';

export interface UseOptions {
  clear?: boolean;
}

export const useCommand = async (name?: string, options?: UseOptions): Promise<void> => {
  const config = await loadCLIConfig();

  // --clear: remove default
  if (options?.clear) {
    if (!config.defaultRepo) {
      console.log('  No default repository is set.\n');
      return;
    }
    const prev = config.defaultRepo;
    delete config.defaultRepo;
    await saveCLIConfig(config);
    console.log(`  ✅ Cleared default repository (was: ${prev})\n`);
    return;
  }

  // No name: show current default
  if (!name) {
    if (config.defaultRepo) {
      console.log(`  Default repository: ${config.defaultRepo}\n`);
    } else {
      const repos = await listRegisteredRepos({ validate: false });
      const names = repos.map((r) => r.name);
      console.log('  No default repository set.\n');
      if (names.length > 0) {
        console.log(`  Available: ${names.join(', ')}`);
        console.log(`  Run: gitnexus use <name>\n`);
      }
    }
    return;
  }

  // Validate the name exists in the registry
  const repos = await listRegisteredRepos({ validate: false });
  const match = repos.find((r) => r.name.toLowerCase() === name.toLowerCase() || r.name === name);

  if (!match) {
    const names = repos.map((r) => r.name);
    if (names.length === 0) {
      console.log(`  ✗ No indexed repositories found. Run: gitnexus analyze\n`);
    } else {
      console.log(`  ✗ Repository "${name}" not found.\n`);
      console.log(`  Available: ${names.join(', ')}\n`);
    }
    process.exitCode = 1;
    return;
  }

  config.defaultRepo = match.name;
  await saveCLIConfig(config);
  console.log(`  ✅ Default repository set to: ${match.name}\n`);
  console.log(
    `  Commands like query/context/impact/cypher will now use "${match.name}" by default.\n`,
  );
  console.log(`  You can still override per-command with --repo <name>.\n`);
};
