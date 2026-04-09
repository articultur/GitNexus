/**
 * Clean Command
 *
 * Removes the .gitnexus index from the current repository.
 * Also unregisters it from the global registry.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createInterface } from 'readline';
import {
  findRepo,
  unregisterRepo,
  listRegisteredRepos,
  getStoragePaths,
} from '../storage/repo-manager.js';

const confirm = async (message: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${message} [y/N] `, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });
  return answer === 'y' || answer === 'yes';
};

const pickOne = async (label: string, choices: string[]): Promise<number | null> => {
  process.stderr.write(`\n  ${label}\n`);
  choices.forEach((c, i) => process.stderr.write(`    [${i + 1}] ${c}\n`));
  process.stderr.write('    [a] all of the above\n');
  process.stderr.write('\n  Select (ESC to cancel): ');

  const answer = await new Promise<string>((resolve) => {
    const { stdin } = process;
    const wasRaw = stdin.isRaw ?? false;
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    let buf = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 0x1b) {
          // ESC
          cleanup();
          resolve('\x1b');
          return;
        }
        if (code === 0x7f || code === 8) {
          // backspace
          buf = buf.slice(0, -1);
          process.stderr.write('\b \b');
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          process.stderr.write('\n');
          cleanup();
          resolve(buf.trim().toLowerCase());
          return;
        }
        if (code >= 0x20) {
          // printable
          buf += ch;
          process.stderr.write(ch);
        }
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.pause();
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
    };

    stdin.on('data', onData);
  });

  if (answer === '\x1b') return null; // ESC → cancelled
  if (answer === 'a') return -1; // all
  const n = parseInt(answer, 10);
  if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
  return null; // invalid
};

export const cleanCommand = async (name?: string, options?: { force?: boolean; all?: boolean }) => {
  // --all flag: clean all indexed repos
  if (options?.all) {
    const entries = await listRegisteredRepos();
    if (entries.length === 0) {
      console.log('No indexed repositories found.');
      return;
    }
    if (!options?.force) {
      console.log(`This will delete GitNexus indexes for ${entries.length} repo(s):`);
      for (const entry of entries) {
        console.log(`  - ${entry.name} (${entry.storagePath})`);
      }
      const ok = await confirm('\nDelete all?');
      if (!ok) {
        console.log('\n  Aborted.');
        return;
      }
      console.log();
    }
    for (const entry of entries) {
      try {
        await fs.rm(entry.storagePath, { recursive: true, force: true });
        await unregisterRepo(entry.path);
        console.log(`  Deleted: ${entry.name} (${entry.storagePath})`);
      } catch (err) {
        console.error(`  Failed to delete ${entry.name}:`, err);
      }
    }
    return;
  }

  // Named repo: collect ALL matching candidates (registry + default index path)
  if (name) {
    type Candidate = { label: string; storagePath: string; repoPath: string };
    const candidates: Candidate[] = [];

    // 1. Registry matches
    const entries = await listRegisteredRepos();
    for (const e of entries) {
      if (e.name === name || path.basename(e.path) === name) {
        candidates.push({ label: e.storagePath, storagePath: e.storagePath, repoPath: e.path });
      }
    }

    // 2. Default pull path (~/.gitnexus/indexes/<name>) — add only if not already in candidates
    const defaultRepoPath = path.join(os.homedir(), '.gitnexus', 'indexes', name);
    const { storagePath: defaultStorage } = getStoragePaths(defaultRepoPath);
    const alreadyListed = candidates.some((c) => c.storagePath === defaultStorage);
    if (!alreadyListed) {
      try {
        await fs.access(defaultStorage);
        candidates.push({
          label: defaultStorage,
          storagePath: defaultStorage,
          repoPath: defaultRepoPath,
        });
      } catch {
        /* not present */
      }
    }

    if (candidates.length === 0) {
      console.log(`  ✗ No index found for "${name}". Run \`gitnexus list\` to see indexed repos.`);
      process.exitCode = 1;
      return;
    }

    // Determine which candidates to delete
    let toDelete: Candidate[] = [];
    if (candidates.length === 1) {
      toDelete = candidates;
    } else {
      // Multiple locations — ask user to pick
      const idx = await pickOne(
        `Found ${candidates.length} indexes named "${name}". Which one to delete?`,
        candidates.map((c) => c.label),
      );
      if (idx === null) {
        console.log('\n  Aborted.');
        return;
      }
      toDelete = idx === -1 ? candidates : [candidates[idx]];
    }

    for (const c of toDelete) {
      if (!options?.force) {
        const ok = await confirm(`  ⚠️  Delete index "${name}" at ${c.storagePath}?`);
        if (!ok) {
          console.log('\n  Skipped.');
          continue;
        }
        console.log();
      }
      await fs.rm(c.storagePath, { recursive: true, force: true });
      await unregisterRepo(c.repoPath);
      console.log(`  Deleted: ${c.storagePath}`);
    }
    return;
  }

  // Default: clean current repo by cwd
  const cwd = process.cwd();
  const repo = await findRepo(cwd);

  if (!repo) {
    console.log('  No indexed repository found in this directory.');
    console.log('  Tip: use `gitnexus clean <name>` to delete a named index.');
    return;
  }

  const repoName = repo.repoPath.split(/[/\\]/).pop() || repo.repoPath;

  if (!options?.force) {
    const ok = await confirm(
      `  ⚠️  Delete GitNexus index for "${repoName}" at ${repo.storagePath}?`,
    );
    if (!ok) {
      console.log('\n  Aborted.');
      return;
    }
    console.log();
  }

  try {
    await fs.rm(repo.storagePath, { recursive: true, force: true });
    await unregisterRepo(repo.repoPath);
    console.log(`  Deleted: ${repo.storagePath}`);
  } catch (err) {
    console.error('  Failed to delete:', err);
  }
};
