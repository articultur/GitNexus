/**
 * Pull Command
 *
 * Pulls a named index from a remote endpoint into the local .gitnexus/.
 * Two transport modes are auto-detected from the remote URL:
 *
 *  git+lfs  — git@... / git://... / *.git
 *             Sparse-clones the remote git repo and downloads only the
 *             named subdirectory (<name>/lbug via LFS + <name>/meta.json).
 *
 *  http     — http:// / https:// URLs that are NOT *.git
 *             GETs a tar.gz bundle and extracts it into .gitnexus/.
 *
 * Usage:
 *   gitnexus remote add origin git@github.com:org/indexes.git
 *   gitnexus pull GitNexus                        # pulls GitNexus slot from default remote
 *   gitnexus pull bundle2h_integration --remote backup  # pull from specific remote
 *
 * The <arg> is always the INDEX SLOT NAME in the remote (the subdirectory name).
 * Use --remote to select which configured remote to pull from.
 */

import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { execFile } from 'child_process';
import { createInterface } from 'readline';
import { promisify } from 'util';
import {
  getStoragePaths,
  loadMeta,
  registerRepo,
  addToGitignore,
} from '../storage/repo-manager.js';
import {
  detectTransport,
  injectToken,
  preferSshUrl,
  resolveRemote,
  runGit,
  runGitProgress,
} from './remote-config.js';

const execFileAsync = promisify(execFile);

export interface PullOptions {
  token?: string;
  /** Explicit index name (for URL-based pulls where name isn't embedded in URL). */
  name?: string;
  /** Use a named remote from ~/.gitnexus/config.json. */
  remote?: string;
  /** Overwrite existing local index. */
  force?: boolean;
  /** Path to git repo (default: cwd git root). */
  path?: string;
}

// ── Git LFS transport ─────────────────────────────────────────────────────

const pullGitLfs = async (
  remoteUrl: string,
  indexName: string,
  storagePath: string,
  token?: string,
): Promise<void> => {
  // Prefer SSH over HTTPS when SSH keys are available
  const effectiveUrl = await preferSshUrl(remoteUrl);
  const authUrl = injectToken(effectiveUrl, token);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-pull-'));

  try {
    // [1/4] Sparse clone — download object metadata only (no LFS blobs yet)
    process.stderr.write('  [1/4] Connecting to remote...\n');
    await runGitProgress(
      ['clone', '--depth=1', '--filter=blob:none', '--no-checkout', '--progress', authUrl, '.'],
      tmpDir,
    );

    // [2/4] Recursively scan the remote tree to find the dirPath for this indexName.
    // The remote may use a prefix layout like repos/<indexName>/lbug.
    process.stderr.write('  [2/4] Locating index...\n');
    let dirPath: string = indexName; // default: no prefix
    try {
      const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
        cwd: tmpDir,
      });
      const allFiles = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      // Find all paths that end with /<indexName>/lbug OR equal <indexName>/lbug
      const lbugMatch = allFiles.find(
        (f) => f === `${indexName}/lbug` || f.endsWith(`/${indexName}/lbug`),
      );
      if (lbugMatch) {
        // dirPath is everything before /lbug
        dirPath = lbugMatch.slice(0, lbugMatch.length - '/lbug'.length);
      } else {
        throw new Error(
          `Index "${indexName}" not found in remote. Run \`gitnexus remote ls\` to see available indexes.`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('not found in remote')) throw err;
      // If ls-tree fails (unlikely), fall back to indexName directly
    }

    // [3/4] Enable sparse checkout scoped to the discovered subdirectory
    process.stderr.write('  [3/4] Preparing sparse checkout...\n');
    await runGit(['sparse-checkout', 'init', '--cone'], tmpDir);
    await runGit(['sparse-checkout', 'set', dirPath], tmpDir);
    await runGit(['checkout', 'HEAD'], tmpDir);

    // Verify the subdirectory exists on disk
    const indexDir = path.join(tmpDir, dirPath);
    try {
      await fs.access(indexDir);
    } catch {
      throw new Error(
        `Index "${indexName}" not found in remote after checkout. Run \`gitnexus remote ls\` to see available indexes.`,
      );
    }

    // [4/4] Pull the actual LFS binary for lbug
    process.stderr.write('  [4/4] Downloading index (git-lfs)...\n');
    await runGitProgress(['lfs', 'pull', '--include', `${dirPath}/lbug`], tmpDir);

    // Copy files to storagePath
    await fs.mkdir(storagePath, { recursive: true });
    await fs.copyFile(path.join(indexDir, 'lbug'), path.join(storagePath, 'lbug'));
    await fs.copyFile(path.join(indexDir, 'meta.json'), path.join(storagePath, 'meta.json'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

// ── HTTP transport ────────────────────────────────────────────────────────

const pullHttp = async (remoteUrl: string, storagePath: string, token?: string): Promise<void> => {
  const headers: Record<string, string> = { 'User-Agent': 'gitnexus-cli' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  console.log('  ⬇️  Downloading...');

  let resp: Response;
  try {
    resp = await fetch(remoteUrl, { headers, signal: AbortSignal.timeout(300_000) });
  } catch (err: unknown) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body}`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-pull-'));
  const tarPath = path.join(tmpDir, 'index.tar.gz');

  try {
    const arrayBuf = await resp.arrayBuffer();
    await fs.writeFile(tarPath, Buffer.from(arrayBuf));

    const sizeMb = (arrayBuf.byteLength / 1024 / 1024).toFixed(1);
    console.log(`  ⬇️  Downloaded ${sizeMb} MB\n`);

    // Validate archive
    const { stdout: listing } = await execFileAsync('tar', ['-tzf', tarPath]);
    const files = listing
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const hasLbug = files.some((f) => f === 'lbug' || f.endsWith('/lbug'));
    const hasMeta = files.some((f) => f === 'meta.json' || f.endsWith('/meta.json'));

    if (!hasLbug || !hasMeta) {
      throw new Error('Archive is missing required files (lbug and/or meta.json).');
    }

    console.log('  📥 Extracting...');
    await fs.mkdir(storagePath, { recursive: true });
    await execFileAsync('tar', ['-xzf', tarPath, '-C', storagePath]);
    console.log('  📥 Extracted\n');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

// ── Main command ──────────────────────────────────────────────────────────

export const pullCommand = async (nameOrUrl: string, options?: PullOptions) => {
  console.log('\n  GitNexus Pull\n');

  // Resolve local storage path.
  // Priority: --path > ~/.gitnexus/indexes/<indexName>
  // Always use the named indexes directory so multiple pulled indexes coexist
  // without overwriting each other (avoids the "second pull clobbers first" bug
  // when the git-root heuristic would point them both to the same .gitnexus/).
  let repoPath: string;
  if (options?.path) {
    repoPath = path.resolve(options.path);
    // Create the directory if it doesn't exist (e.g. pulling without cloning source first)
    await fs.mkdir(repoPath, { recursive: true });
  } else {
    const indexSlot = options?.name ?? nameOrUrl;
    repoPath = path.join(os.homedir(), '.gitnexus', 'indexes', indexSlot);
    await fs.mkdir(repoPath, { recursive: true });
  }

  const { storagePath, lbugPath } = getStoragePaths(repoPath);

  // Check for existing index
  let hasExisting = false;
  try {
    await fs.access(lbugPath);
    hasExisting = true;
  } catch {}

  if (hasExisting && !options?.force) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `  ⚠️  An index already exists at:\n  ${storagePath}\n\n  Overwrite it? [y/N] `,
        (ans) => {
          rl.close();
          resolve(ans.trim().toLowerCase());
        },
      );
    });
    if (answer !== 'y' && answer !== 'yes') {
      console.log('\n  Aborted.\n');
      process.exitCode = 1;
      return;
    }
    console.log();
  }

  // Resolve remote URL + index name
  let remoteUrl: string;
  let indexName: string | null;

  try {
    const resolved = await resolveRemote(nameOrUrl, options?.remote);
    remoteUrl = resolved.url;
    // For URL-based pulls, --name provides the index name; for name-based pulls it's the arg itself
    indexName = options?.name ?? resolved.indexName;
  } catch (err: unknown) {
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const transport = detectTransport(remoteUrl);

  // For git+LFS transport, we MUST have an index name (subdirectory)
  if (transport === 'git-lfs' && !indexName) {
    console.log(
      '  ✗ An index name is required for git+LFS transport.\n' +
        '    Use: gitnexus pull <name> --remote <remote>\n' +
        '      or: gitnexus pull <git-url> --name <name>\n',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`  Repository : ${repoPath}`);
  if (indexName) console.log(`  Index name : ${indexName}`);
  console.log(`  Remote     : ${remoteUrl}`);
  if (hasExisting) console.log('  ⚠️  Overwriting existing index (--force)');
  console.log('');

  try {
    if (transport === 'git-lfs') {
      console.log('  🔗 Transport: git+LFS\n');
      console.log('  ⬇️  Pulling from remote...');
      await pullGitLfs(remoteUrl, indexName as string, storagePath, options?.token);
      console.log('  ✅ Downloaded\n');
    } else {
      console.log('  🔗 Transport: HTTP\n');
      await pullHttp(remoteUrl, storagePath, options?.token);
    }
  } catch (err: unknown) {
    console.log(`  ✗ Pull failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  // Verify lbug was written
  try {
    await fs.access(lbugPath);
  } catch {
    console.log('  ✗ lbug file not found after extraction — archive may be malformed.\n');
    process.exitCode = 1;
    return;
  }

  // Load meta, override repoPath for cross-machine compatibility, register
  const meta = await loadMeta(storagePath);
  if (!meta) {
    console.log('  ✗ Could not read meta.json after extraction.\n');
    process.exitCode = 1;
    return;
  }

  meta.repoPath = repoPath;
  await registerRepo(repoPath, meta);
  // addToGitignore is best-effort: silently skip if the directory has no .git or doesn't exist
  try {
    await addToGitignore(repoPath);
  } catch {
    // Not a git repo or no write permission — index is still usable
  }

  // Print stats
  const s = meta.stats;
  if (s) {
    console.log(`  ✅ Pull complete\n`);
    console.log(`     Symbols    : ${s.nodes ?? 0}`);
    console.log(`     Relations  : ${s.edges ?? 0}`);
    if (s.embeddings && s.embeddings > 0) console.log(`     Embeddings : ${s.embeddings}`);
    if (meta.indexedAt) {
      console.log(`     Indexed at : ${new Date(meta.indexedAt).toLocaleString()}`);
    }
  } else {
    console.log('  ✅ Pull complete\n');
  }
  console.log('');
};
