/**
 * Remote command group — managed remote index repositories.
 *
 * Subcommands:
 *   gitnexus remote add <name> <url>     Add a remote
 *   gitnexus remote remove <name>        Remove a remote
 *   gitnexus remote list                 List configured remotes (with index names if git+LFS)
 *   gitnexus remote ls [name]            List available indexes on a remote
 *
 * Remotes are stored in ~/.gitnexus/config.json under the "remotes" key.
 */

import type { Command } from 'commander';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  detectTransport,
  injectToken,
  loadRemotes,
  saveRemote,
  deleteRemote,
  runGit,
} from './remote-config.js';

const execFileAsync = promisify(execFile);

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * For a git+LFS remote: clone with no-checkout and discover indexes recursively.
 * Each directory that contains both `lbug` and `meta.json` is one index.
 * Handles any nesting depth (e.g. root-level `GitNexus/lbug` or nested
 * `repos/GitNexus/lbug`).
 */
const listGitLfsIndexes = async (
  remoteUrl: string,
  token?: string,
): Promise<Array<{ name: string; dirPath: string; meta: Record<string, unknown> | null }>> => {
  const authUrl = injectToken(remoteUrl, token);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-ls-'));

  try {
    await runGit(
      ['clone', '--depth=1', '--filter=blob:none', '--no-checkout', authUrl, '.'],
      tmpDir,
    );

    // Recursively list all files — handles any subdirectory nesting
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
        cwd: tmpDir,
      }));
    } catch {
      // Empty repo or HEAD not set
      return [];
    }

    const allFiles = new Set(
      stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );

    // Find all `lbug` paths → their parent dir is an index directory
    const lbugPaths = [...allFiles].filter((f) => f === 'lbug' || f.endsWith('/lbug'));

    const results: Array<{ name: string; dirPath: string; meta: Record<string, unknown> | null }> =
      [];

    for (const lp of lbugPaths) {
      // dirPath: e.g. "repos/GitNexus" from "repos/GitNexus/lbug", or "" from "lbug"
      const dirPath = lp.endsWith('/lbug') ? lp.slice(0, -'/lbug'.length) : '';
      const metaGitPath = dirPath ? `${dirPath}/meta.json` : 'meta.json';

      if (!allFiles.has(metaGitPath)) continue; // no meta.json sibling → not a gitnexus index

      const indexName = dirPath
        ? path.basename(dirPath)
        : path.basename(remoteUrl.replace(/\.git$/, ''));

      let meta: Record<string, unknown> | null = null;
      try {
        const { stdout: raw } = await execFileAsync('git', ['show', `HEAD:${metaGitPath}`], {
          cwd: tmpDir,
        });
        meta = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Not valid JSON — skip
      }

      if (meta !== null) results.push({ name: indexName, dirPath, meta });
    }

    return results;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

// ── Subcommand handlers ───────────────────────────────────────────────────

const handleAdd = async (name: string, url: string) => {
  if (!url.startsWith('http') && !url.startsWith('git@') && !url.startsWith('git://')) {
    console.log(
      `  ✗ "${url}" does not look like a valid URL.\n` +
        '    Examples:\n' +
        '      git@github.com:org/indexes.git\n' +
        '      https://github.com/org/indexes.git\n' +
        '      https://api.example.com/indexes\n',
    );
    process.exitCode = 1;
    return;
  }

  await saveRemote(name, { url });
  console.log(`  ✅ Remote "${name}" added → ${url}\n`);
};

const handleRemove = async (name: string) => {
  const removed = await deleteRemote(name);
  if (removed) {
    console.log(`  ✅ Remote "${name}" removed.\n`);
  } else {
    console.log(`  ✗ Remote "${name}" not found.\n`);
    process.exitCode = 1;
  }
};

const handleList = async () => {
  const remotes = await loadRemotes();
  const keys = Object.keys(remotes);
  if (keys.length === 0) {
    console.log('  No remotes configured.\n');
    console.log('  Add one with: gitnexus remote add <name> <url>\n');
    return;
  }
  console.log('');
  for (const name of keys) {
    const transport = detectTransport(remotes[name].url);
    console.log(`  ${name}  ${remotes[name].url}  [${transport}]`);
  }
  console.log('');
};

const handleLs = async (remoteName?: string, token?: string) => {
  const remotes = await loadRemotes();
  const keys = Object.keys(remotes);

  // Determine which remotes to list
  let targets: Array<{ name: string; url: string }>;
  if (remoteName) {
    const entry = remotes[remoteName];
    if (!entry) {
      console.log(
        `  ✗ Remote "${remoteName}" not found.\n` +
          `    Configured: ${keys.join(', ') || '(none)'}\n`,
      );
      process.exitCode = 1;
      return;
    }
    targets = [{ name: remoteName, url: entry.url }];
  } else if (keys.length === 1) {
    targets = [{ name: keys[0], url: remotes[keys[0]].url }];
  } else if (keys.length > 1) {
    console.log(
      `  Multiple remotes. Specify one: gitnexus remote ls <name>\n` +
        `  Remotes: ${keys.join(', ')}\n`,
    );
    process.exitCode = 1;
    return;
  } else {
    console.log('  No remotes configured. Run: gitnexus remote add <name> <url>\n');
    process.exitCode = 1;
    return;
  }

  for (const target of targets) {
    const transport = detectTransport(target.url);
    console.log(`\n  Remote: ${target.name}  (${target.url})\n`);

    if (transport !== 'git-lfs') {
      console.log('  ℹ️  HTTP remotes do not support listing.\n');
      continue;
    }

    console.log('  Fetching index list...\n');
    try {
      const indexes = await listGitLfsIndexes(target.url, token);
      if (indexes.length === 0) {
        console.log('  (no indexes found)\n');
        console.log('  If this repo already has indexes, they may be in a subdirectory.\n');
        console.log('  Expected structure: <name>/lbug + <name>/meta.json (any depth)\n');
      } else {
        for (const { name, dirPath, meta } of indexes) {
          const stats = meta?.stats as Record<string, number> | undefined;
          const nodes = stats?.nodes ?? '?';
          const edges = stats?.edges ?? '?';
          const embeddings = stats?.embeddings ?? 0;
          const indexedAt = meta?.indexedAt
            ? new Date(meta.indexedAt as string).toLocaleDateString()
            : '';
          const embStr = embeddings > 0 ? `  ${embeddings} embeddings` : '';
          const pathHint = dirPath ? `  (${dirPath})` : '';
          console.log(
            `  📦 ${name.padEnd(30)} ${String(nodes).padStart(6)} symbols  ${String(edges).padStart(7)} relations${embStr}  ${indexedAt}${pathHint}`,
          );
        }
        console.log('');
        console.log(`  Pull with: gitnexus pull <name> --remote ${targets[0].name}\n`);
      }
    } catch (err: unknown) {
      console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  }
};

// ── Commander registration ────────────────────────────────────────────────

export function registerRemoteCommands(program: Command): void {
  const remote = program
    .command('remote')
    .description('Manage remote index repositories stored in ~/.gitnexus/config.json')
    .addHelpText(
      'after',
      `
Examples:
  $ gitnexus remote add origin git@github.com:org/indexes.git
  $ gitnexus remote add backup https://api.example.com/indexes
  $ gitnexus remote list
  $ gitnexus remote ls origin

Transport types:
  git+LFS  — Git repositories (*.git, git@..., git://...)
            Stores indexes as subdirectories with LFS-tracked lbug files
  HTTP     — REST API endpoints (https://... without .git extension)
            POST/GET tar.gz bundles to/from the endpoint

Config location: ~/.gitnexus/config.json (remotes key)
`,
    );

  remote
    .command('add <name> <url>')
    .description('Add a named remote (git+LFS or HTTP)')
    .addHelpText(
      'after',
      `
Examples:
  $ gitnexus remote add origin git@github.com:org/indexes.git
  $ gitnexus remote add backup https://api.example.com/indexes

The URL format determines the transport:
  - git@... / git://... / *.git → git+LFS transport
  - https://... (no .git)       → HTTP transport
`,
    )
    .action(async (name: string, url: string) => {
      console.log('\n  GitNexus Remote\n');
      await handleAdd(name, url);
    });

  remote
    .command('remove <name>')
    .description('Remove a configured remote')
    .addHelpText(
      'after',
      `
Example:
  $ gitnexus remote remove origin
`,
    )
    .action(async (name: string) => {
      console.log('\n  GitNexus Remote\n');
      await handleRemove(name);
    });

  remote
    .command('list')
    .description('List all configured remotes')
    .addHelpText(
      'after',
      `
Example:
  $ gitnexus remote list
  origin  git@github.com:org/indexes.git  [git-lfs]
  backup  https://api.example.com/indexes  [http]
`,
    )
    .action(async () => {
      console.log('\n  GitNexus Remotes\n');
      await handleList();
    });

  remote
    .command('ls [name]')
    .description('List available indexes on a remote git repository')
    .option('--token <token>', 'Bearer / HTTPS token for authentication')
    .addHelpText(
      'after',
      `
Examples:
  $ gitnexus remote ls              # list indexes on default remote
  $ gitnexus remote ls origin       # list indexes on named remote
  $ gitnexus remote ls origin --token ghp_xxx

Note: Only git+LFS remotes support listing. HTTP remotes will show a notice.

Output format:
  📦 IndexName    1234 symbols  5678 relations  2026-04-09
`,
    )
    .action(async (name: string | undefined, opts: { token?: string }) => {
      console.log('\n  GitNexus Remote Indexes\n');
      await handleLs(name, opts.token);
    });
}
