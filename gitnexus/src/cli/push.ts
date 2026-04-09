/**
 * Push Command
 *
 * Pushes the local .gitnexus/ index to a remote endpoint.
 * Two transport modes are auto-detected from the URL:
 *
 *  git+lfs  — git@... / git://... / *.git
 *             Remote git repo stores each index in a named subdirectory:
 *               repos/
 *                 GitNexus/
 *                   lbug        ← binary stored in Git LFS
 *                   meta.json
 *
 *  http     — http:// / https:// URLs that are NOT *.git
 *             POSTs a multipart/form-data tar.gz bundle to an HTTP API.
 *
 * Usage:
 *   gitnexus push                         # push to default remote; index name = local repo dir name
 *   gitnexus push origin                  # push to named remote 'origin'
 *   gitnexus push origin --name MySlot   # override the slot name in the remote
 *   gitnexus push git@github.com:org/indexes.git   # push to a URL directly
 *
 * The <arg> to `push` is always a REMOTE NAME or URL, never an index slot name.
 * Use --name to override the slot name (defaults to the local git repo basename).
 */

import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { execFile } from 'child_process';
import { createInterface } from 'readline';
import { promisify } from 'util';
import { getStoragePaths, loadMeta, readRegistry } from '../storage/repo-manager.js';
import { getGitRoot } from '../storage/git.js';
import {
  detectTransport,
  injectToken,
  isUrl,
  loadRemotes,
  preferSshUrl,
  runGit,
  runGitProgress,
} from './remote-config.js';

const execFileAsync = promisify(execFile);

export interface PushOptions {
  token?: string;
  /** Override the index name (subdirectory in the remote repo). */
  name?: string;
  /** Use a named remote from ~/.gitnexus/config.json. */
  remote?: string;
  /** Path to git repo (default: cwd git root). */
  path?: string;
  /** Skip overwrite confirmation when remote index already exists. */
  force?: boolean;
}

// ── Git LFS transport ─────────────────────────────────────────────────────

const pushGitLfs = async (
  remoteUrl: string,
  indexName: string,
  storagePath: string,
  lbugPath: string,
  token?: string,
  force?: boolean,
): Promise<void> => {
  // Prefer SSH over HTTPS when SSH keys are available
  const effectiveUrl = await preferSshUrl(remoteUrl);
  const authUrl = injectToken(effectiveUrl, token);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-push-'));

  try {
    let isNewRepo = false;
    process.stderr.write('  [1/5] Connecting to remote...\n');
    try {
      await runGitProgress(
        ['clone', '--depth=1', '--filter=blob:none', '--no-checkout', '--progress', authUrl, '.'],
        tmpDir,
      );
    } catch {
      // Remote may be empty / not yet initialised
      await runGit(['init', '-b', 'main', '.'], tmpDir);
      await runGit(['remote', 'add', 'origin', authUrl], tmpDir);
      isNewRepo = true;
    }

    // Inherit user identity from global git config; fall back only if not set.
    const getGlobalGitConfig = async (key: string): Promise<string | null> => {
      try {
        const { stdout } = await execFileAsync('git', ['config', '--global', key]);
        return stdout.trim() || null;
      } catch {
        return null;
      }
    };
    const globalEmail = await getGlobalGitConfig('user.email');
    const globalName = await getGlobalGitConfig('user.name');
    if (globalEmail) {
      await runGit(['config', 'user.email', globalEmail], tmpDir);
    }
    if (globalName) {
      await runGit(['config', 'user.name', globalName], tmpDir);
    }

    try {
      await runGit(['lfs', 'install', '--local'], tmpDir);
    } catch {
      throw new Error('git-lfs is not installed. Install it: https://git-lfs.com');
    }

    // Detect existing dirPath for this indexName BEFORE touching the working tree.
    // (ls-tree reads from the git object db — no checkout needed.)
    process.stderr.write('  [2/5] Scanning remote layout...\n');
    let dirPath: string = `repos/${indexName}`; // default: repos/<name>/ prefix layout
    if (!isNewRepo) {
      let aborted = false;
      try {
        const { stdout: treeOut } = await execFileAsync(
          'git',
          ['ls-tree', '-r', '--name-only', 'HEAD'],
          { cwd: tmpDir },
        );
        const allFiles = treeOut
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const lbugMatch = allFiles.find(
          (f) => f === `${indexName}/lbug` || f.endsWith(`/${indexName}/lbug`),
        );
        if (lbugMatch) {
          dirPath = lbugMatch.slice(0, lbugMatch.length - '/lbug'.length);
          // Remote already has this index — confirm before overwriting
          if (!force) {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            const answer = await new Promise<string>((resolve) => {
              rl.question(
                `  ⚠️  Remote already contains index "${indexName}".\n\n  Overwrite it? [y/N] `,
                (ans) => {
                  rl.close();
                  resolve(ans.trim().toLowerCase());
                },
              );
            });
            if (answer !== 'y' && answer !== 'yes') {
              console.log('\n  Aborted.\n');
              process.exitCode = 1;
              aborted = true;
            } else {
              console.log();
            }
          }
        }
      } catch {
        // ls-tree failure (empty repo or no HEAD) — keep default
      }
      if (aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    }

    // Narrow the sparse-checkout to ONLY the target directory (+ root files like .gitattributes).
    // This keeps repos/GitNexus/ and other indexes completely absent from the index,
    // so they will never appear as deletions in our commit.
    if (!isNewRepo) {
      await runGit(['sparse-checkout', 'init', '--cone'], tmpDir);
      await runGit(['sparse-checkout', 'set', dirPath], tmpDir);
      await runGit(['checkout', 'HEAD'], tmpDir);
    }

    // Manage .gitattributes
    const attrsPath = path.join(tmpDir, '.gitattributes');
    const attrs = await fs.readFile(attrsPath, 'utf-8').catch(() => '');
    if (!attrs.includes('*/lbug')) {
      await fs.appendFile(attrsPath, '*/lbug filter=lfs diff=lfs merge=lfs -text\n');
    }

    // Copy index files into the resolved subdirectory.
    // Sanitize meta.json: replace the pusher's local repoPath with the canonical
    // default pull path (~/.gitnexus/indexes/<indexName>) so remote consumers
    // don't see private local paths and get a sensible default if pull.ts ever
    // reads the stored value directly.
    process.stderr.write('  [3/5] Copying index files...\n');
    const indexDir = path.join(tmpDir, dirPath);
    await fs.mkdir(indexDir, { recursive: true });
    await fs.copyFile(lbugPath, path.join(indexDir, 'lbug'));
    const metaRaw = await fs.readFile(path.join(storagePath, 'meta.json'), 'utf-8');
    const metaObj = JSON.parse(metaRaw);
    metaObj.repoPath = `~/.gitnexus/indexes/${indexName}`;
    await fs.writeFile(path.join(indexDir, 'meta.json'), JSON.stringify(metaObj, null, 2), 'utf-8');

    // Stage and commit
    process.stderr.write('  [4/5] Staging & committing...\n');
    await runGit(['add', '.gitattributes', `${dirPath}/`], tmpDir);
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: tmpDir,
    });
    if (!status.trim()) {
      console.log('  ℹ️  Remote index is already up to date.\n');
      return;
    }
    await runGit(['commit', '-m', `Update index: ${indexName}`], tmpDir);

    // Forward stderr to terminal so git-lfs transfer progress is visible
    process.stderr.write('  [5/5] Uploading (git-lfs)...\n');
    if (isNewRepo) {
      await runGitProgress(['push', '--progress', '-u', 'origin', 'HEAD:main'], tmpDir);
    } else {
      await runGitProgress(['push', '--progress', 'origin', 'HEAD'], tmpDir);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

// ── HTTP transport ────────────────────────────────────────────────────────

const pushHttp = async (
  remoteUrl: string,
  indexName: string,
  storagePath: string,
  _lbugPath: string,
  token?: string,
): Promise<void> => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-push-'));
  const tarPath = path.join(tmpDir, 'index.tar.gz');

  try {
    console.log('  📦 Packing index...');
    // Sanitize meta.json before packing: replace pusher's local path with default pull path
    const metaRaw = await fs.readFile(path.join(storagePath, 'meta.json'), 'utf-8');
    const metaObj = JSON.parse(metaRaw);
    metaObj.repoPath = `~/.gitnexus/indexes/${indexName}`;
    const sanitizedMetaPath = path.join(tmpDir, 'meta.json');
    await fs.writeFile(sanitizedMetaPath, JSON.stringify(metaObj, null, 2), 'utf-8');
    // Pack lbug from storagePath, meta.json from tmpDir (sanitized)
    await execFileAsync('tar', [
      '-czf',
      tarPath,
      '-C',
      storagePath,
      'lbug',
      '-C',
      tmpDir,
      'meta.json',
    ]);
    const stat = await fs.stat(tarPath);
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`  📦 Packed ${sizeMb} MB\n`);

    console.log('  ⬆️  Uploading...');

    const fileStat = await fs.stat(tarPath);
    const boundary = `----GitNexusBoundary${Date.now()}`;
    const prefix = Buffer.from(
      [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="name"\r\n\r\n`,
        `${indexName}\r\n`,
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="index"; filename="index.tar.gz"\r\n`,
        `Content-Type: application/gzip\r\n\r\n`,
      ].join(''),
      'utf-8',
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const totalSize = prefix.length + fileStat.size + suffix.length;

    // Stream file in 4 MB chunks — avoids loading the entire lbug into memory
    const CHUNK = 4 * 1024 * 1024;
    let uploaded = 0;
    const printProgress = (done: boolean): void => {
      const pct = Math.round((uploaded / totalSize) * 100);
      const mb = (uploaded / 1024 / 1024).toFixed(1);
      const total = (totalSize / 1024 / 1024).toFixed(1);
      const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
      process.stderr.write(`\r  [${bar}] ${pct}%  ${mb}/${total} MB${done ? '\n' : ''}`);
    };

    const bodyStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(prefix);
        uploaded += prefix.length;
        printProgress(false);

        const fh = await fs.open(tarPath, 'r');
        try {
          const buf = Buffer.alloc(CHUNK);
          while (true) {
            const { bytesRead } = await fh.read(buf, 0, CHUNK);
            if (bytesRead === 0) break;
            const chunk = Uint8Array.prototype.slice.call(buf, 0, bytesRead);
            controller.enqueue(chunk);
            uploaded += bytesRead;
            printProgress(false);
          }
        } finally {
          await fh.close();
        }

        controller.enqueue(suffix);
        uploaded += suffix.length;
        printProgress(true);
        controller.close();
      },
    });

    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(totalSize),
      'User-Agent': 'gitnexus-cli',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // Calculate timeout proportional to file size: at least 5 min, +1 min per 50 MB
    const timeoutMs = Math.max(300_000, Math.ceil(fileStat.size / (50 * 1024 * 1024)) * 60_000);

    const resp = await fetch(remoteUrl, {
      method: 'POST',
      headers,
      body: bodyStream,
      duplex: 'half',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${body}`);
    }

    const result = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    console.log(`  ✅ Pushed successfully${result?.url ? ` → ${String(result.url)}` : ''}\n`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

// ── Main command ──────────────────────────────────────────────────────────

export const pushCommand = async (nameOrUrl?: string, options?: PushOptions) => {
  console.log('\n  GitNexus Push\n');

  // ── Resolve source (storagePath + indexName) ────────────────────────────
  //
  // Priority for the positional <arg>:
  //  1. URL              → push current repo's index to that URL
  //  2. Configured remote name (e.g. "origin") → push current repo's index to that remote
  //  3. Repo name from global registry → find that repo's .gitnexus/ and push it
  //  4. (no arg)         → push current repo's index to the sole/default configured remote

  let repoPath: string | null = null;
  let storagePath: string;
  let lbugPath: string;
  let indexName: string;
  let remoteUrl: string;

  // Detect if arg is a URL or a configured remote name first
  const remotes = await loadRemotes();
  const remoteKeys = Object.keys(remotes);

  const argIsUrl = nameOrUrl ? isUrl(nameOrUrl) : false;
  const argIsRemoteName = nameOrUrl ? !!remotes[nameOrUrl] : false;

  // If arg is an index/repo name (not URL, not remote name), look it up in global registry
  const argIsRepoName = nameOrUrl && !argIsUrl && !argIsRemoteName;

  if (argIsRepoName) {
    // Find the repo in the global registry by name
    const registry = await readRegistry();
    const entry = registry.find((r) => r.name === nameOrUrl || path.basename(r.path) === nameOrUrl);
    if (!entry) {
      const known = registry.map((r) => r.name).join(', ') || '(none)';
      console.log(
        `  ✗ No indexed repo named "${nameOrUrl}" found in global registry.\n` +
          `    Known repos: ${known}\n` +
          `    Tip: run \'gitnexus list\' to see all indexed repos.\n`,
      );
      process.exitCode = 1;
      return;
    }
    repoPath = entry.path;
    ({ storagePath, lbugPath } = getStoragePaths(entry.path));
    indexName = options?.name ?? entry.name;
  } else {
    // Use current directory (or --path) as source
    if (options?.path) {
      repoPath = path.resolve(options.path);
    } else {
      const gitRoot = getGitRoot(process.cwd());
      if (!gitRoot) {
        console.log('  ✗ Not inside a git repository. Use --path, or specify a repo name.\n');
        process.exitCode = 1;
        return;
      }
      repoPath = gitRoot;
    }
    ({ storagePath, lbugPath } = getStoragePaths(repoPath));
    indexName = options?.name ?? path.basename(repoPath);
  }

  try {
    await fs.access(lbugPath);
  } catch {
    console.log('  ✗ No .gitnexus/ index found. Run `gitnexus analyze` first.\n');
    process.exitCode = 1;
    return;
  }

  // ── Resolve remote URL ─────────────────────────────────────────────────
  try {
    if (argIsUrl) {
      remoteUrl = nameOrUrl!;
    } else if (argIsRemoteName) {
      remoteUrl = remotes[nameOrUrl!].url;
    } else if (options?.remote) {
      const entry = remotes[options.remote];
      if (!entry) throw new Error(`Remote "${options.remote}" not found.`);
      remoteUrl = entry.url;
    } else if (remoteKeys.length === 0) {
      throw new Error('No remotes configured. Run: gitnexus remote add <name> <url>');
    } else if (remoteKeys.length === 1) {
      remoteUrl = remotes[remoteKeys[0]].url;
    } else {
      throw new Error(
        `Multiple remotes configured. Specify one: gitnexus push <remote-name>\n  Remotes: ${remoteKeys.join(', ')}`,
      );
    }
  } catch (err: unknown) {
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const meta = await loadMeta(storagePath);
  console.log(`  Repository : ${repoPath}`);
  console.log(`  Index name : ${indexName}`);
  console.log(`  Remote     : ${remoteUrl}`);
  if (meta?.stats) {
    const s = meta.stats;
    console.log(
      `  Stats      : ${s.nodes ?? 0} nodes · ${s.edges ?? 0} edges · ${s.embeddings ?? 0} embeddings`,
    );
  }
  console.log('');

  const transport = detectTransport(remoteUrl);

  try {
    if (transport === 'git-lfs') {
      console.log('  🔗 Transport: git+LFS\n');
      console.log('  ⬆️  Pushing...');
      await pushGitLfs(remoteUrl, indexName, storagePath, lbugPath, options?.token, options?.force);
      console.log('  ✅ Pushed successfully\n');
    } else {
      console.log('  🔗 Transport: HTTP\n');
      await pushHttp(remoteUrl, indexName, storagePath, lbugPath, options?.token);
    }
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException & { aborted?: boolean }).aborted)
      return;
    console.log(`  ✗ Push failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
};
