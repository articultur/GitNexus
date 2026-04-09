/**
 * Shared utilities for push/pull/remote commands.
 *
 * Remote stores a list of named git/http endpoints in ~/.gitnexus/config.json
 * under the "remotes" key:
 *
 *   {
 *     "remotes": {
 *       "origin": { "url": "git@github.com:org/indexes.git" },
 *       "backup": { "url": "https://api.example.com/indexes" }
 *     }
 *   }
 *
 * The remote git repo layout (for git+LFS transport) is:
 *
 *   <remote-repo>/
 *     GitNexus/
 *       lbug          ← binary file stored in Git LFS
 *       meta.json     ← regular git object (small JSON)
 *     bundle2h_integration/
 *       lbug
 *       meta.json
 *     ...
 */

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { loadCLIConfig, saveCLIConfig } from '../storage/repo-manager.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

// ── Transport detection ───────────────────────────────────────────────────

/** True if the string looks like a remote URL (not a bare name). */
export const isUrl = (s: string): boolean =>
  s.startsWith('http://') ||
  s.startsWith('https://') ||
  s.startsWith('git@') ||
  s.startsWith('git://') ||
  s.endsWith('.git');

/** Detect whether to use git+LFS or HTTP transport. */
export const detectTransport = (url: string): 'git-lfs' | 'http' => {
  if (url.startsWith('git@') || url.startsWith('git://') || url.endsWith('.git')) return 'git-lfs';
  return 'http';
};

/**
 * Returns true if the user has at least one SSH key available
 * (either via ssh-agent or as a key file in ~/.ssh/).
 */
const hasSshKey = async (): Promise<boolean> => {
  // Check ssh-agent first
  try {
    const { stdout } = await execFileAsync('ssh-add', ['-l']);
    if (stdout.trim() && !stdout.includes('no identities')) return true;
  } catch {
    // exit 1 means no identities; exit 2 means agent not running — fall through
  }
  // Check common key file locations
  const sshDir = path.join(os.homedir(), '.ssh');
  const keyFiles = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];
  for (const f of keyFiles) {
    try {
      await fs.access(path.join(sshDir, f));
      return true;
    } catch {
      // not found
    }
  }
  return false;
};

/**
 * Convert an HTTPS git URL to its SSH equivalent if SSH keys are available.
 *
 *   https://HOST/ORG/REPO.git  →  git@HOST:ORG/REPO.git
 *
 * Returns the original URL unchanged when:
 *  - It is already an SSH URL
 *  - No SSH keys are detected
 *  - The URL cannot be parsed
 */
export const preferSshUrl = async (url: string): Promise<string> => {
  if (!url.startsWith('https://')) return url; // already SSH or plain http
  if (!url.endsWith('.git')) return url; // not a git remote — keep as-is
  if (!(await hasSshKey())) return url; // no SSH keys available
  try {
    const u = new URL(url);
    // Build git@HOST:PATH (drop leading slash from pathname)
    const sshUrl = `git@${u.hostname}:${u.pathname.slice(1)}`;
    return sshUrl;
  } catch {
    return url;
  }
};

/**
 * Inject a Bearer token into an HTTPS URL.
 * For SSH URLs (git@...) this is a no-op — SSH key auth applies.
 */
export const injectToken = (url: string, token?: string): string => {
  if (!token || url.startsWith('git@')) return url;
  try {
    const u = new URL(url);
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return url;
  }
};

// ── Remote config helpers ─────────────────────────────────────────────────

export interface RemoteEntry {
  url: string;
}

export const loadRemotes = async (): Promise<Record<string, RemoteEntry>> => {
  const config = await loadCLIConfig();
  return (config.remotes as Record<string, RemoteEntry> | undefined) ?? {};
};

export const saveRemote = async (name: string, entry: RemoteEntry): Promise<void> => {
  const config = await loadCLIConfig();
  const remotes = (config.remotes as Record<string, RemoteEntry> | undefined) ?? {};
  remotes[name] = entry;
  await saveCLIConfig({ ...config, remotes } as Parameters<typeof saveCLIConfig>[0]);
};

export const deleteRemote = async (name: string): Promise<boolean> => {
  const config = await loadCLIConfig();
  const remotes = (config.remotes as Record<string, RemoteEntry> | undefined) ?? {};
  if (!(name in remotes)) return false;
  delete remotes[name];
  await saveCLIConfig({ ...config, remotes } as Parameters<typeof saveCLIConfig>[0]);
  return true;
};

/**
 * Resolve a name-or-URL to a `{ url, indexName }` pair.
 *
 * - If the arg is a URL → `{ url, indexName: null }` (HTTP one-shot, no subdirectory routing)
 * - Otherwise         → look up configured remote, return `{ url, indexName: arg }`
 *
 * @param nameOrUrl  The CLI argument (repo name or raw URL)
 * @param remoteName Explicit `--remote` option value
 */
export const resolveRemote = async (
  nameOrUrl: string,
  remoteName?: string,
): Promise<{ url: string; indexName: string | null }> => {
  if (isUrl(nameOrUrl)) {
    return { url: nameOrUrl, indexName: null };
  }

  const remotes = await loadRemotes();
  const keys = Object.keys(remotes);

  if (remoteName) {
    const entry = remotes[remoteName];
    if (!entry) {
      throw new Error(
        `Remote "${remoteName}" not found. Run: gitnexus remote add ${remoteName} <url>`,
      );
    }
    return { url: entry.url, indexName: nameOrUrl };
  }

  if (keys.length === 0) {
    throw new Error('No remotes configured. Run: gitnexus remote add <name> <url>');
  }
  if (keys.length === 1) {
    return { url: remotes[keys[0]].url, indexName: nameOrUrl };
  }
  throw new Error(
    `Multiple remotes configured. Specify one with --remote <name>.\n  Remotes: ${keys.join(', ')}`,
  );
};

// ── Git helpers ───────────────────────────────────────────────────────────

/** Run a git command in a directory. Resolves on exit 0, rejects otherwise. */
export const runGit = (
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    proc.stderr.on('data', (c: Buffer) => stderr.push(c));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `git ${args[0]} failed (exit ${code})\n${Buffer.concat(stderr).toString().trim()}`,
          ),
        );
    });
  });

/** Run a git command and return stdout as a string. */
export const runGitOutput = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
};

// ── Custom progress bar renderer ─────────────────────────────────────────

const sizeToMB = (value: number, unit: string): number => {
  const u = unit.toUpperCase().replace('IB', 'B'); // GiB→GB, MiB→MB, KiB→KB
  switch (u) {
    case 'B':
      return value / (1024 * 1024);
    case 'KB':
      return value / 1024;
    case 'MB':
      return value;
    case 'GB':
      return value * 1024;
    default:
      return value;
  }
};

const renderProgressBar = (pct: number, currentMB?: number, totalMB?: number): string => {
  const WIDTH = 20;
  const filled = Math.min(WIDTH, Math.round((pct / 100) * WIDTH));
  const bar = '[' + '█'.repeat(filled) + '░'.repeat(WIDTH - filled) + ']';
  let line = `  ${bar} ${String(pct).padStart(3)}%`;
  if (currentMB !== undefined && totalMB !== undefined && totalMB > 0) {
    const fmt = (mb: number) =>
      mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
    line += `  ${fmt(currentMB)}/${fmt(totalMB)}`;
  }
  return line;
};

const parseGitProgressLine = (
  line: string,
): { pct: number; currentMB?: number; totalMB?: number } | null => {
  // Matches: "Downloading LFS objects:  62% (1/1), 145.3 MB | 9 MB/s"
  // Matches: "Receiving objects:  62% (100/161), 145.00 KiB | 5.00 MiB/s"
  // Matches: "Resolving deltas: 100% (50/50), done."
  const m = line.match(
    /[\w][\w\s\-/]+:\s+(\d+)%(?:\s+\(\d+\/\d+\))?(?:,\s+([\d.]+)\s*(GiB|MiB|KiB|GB|MB|KB|B))?/,
  );
  if (!m) return null;
  const pct = parseInt(m[1], 10);
  if (m[2] && m[3]) {
    const currentMB = sizeToMB(parseFloat(m[2]), m[3]);
    const totalMB = pct > 0 ? currentMB / (pct / 100) : 0;
    return { pct, currentMB, totalMB };
  }
  return { pct };
};

/**
 * Run a git command and render a custom progress bar by parsing git/lfs stderr output.
 * Renders: [████████████░░░░░░░░]  62%  145.3/234.0 MB
 */
export const runGitProgress = (
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    let hasProgress = false;

    const handleChunk = (chunk: Buffer) => {
      buf += chunk.toString().replace(/\r\n/g, '\n');
      const parts = buf.split('\r');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (!line) continue;
        const parsed = parseGitProgressLine(line);
        if (parsed !== null) {
          hasProgress = true;
          process.stderr.write(
            '\r\x1b[2K' + renderProgressBar(parsed.pct, parsed.currentMB, parsed.totalMB),
          );
        }
      }
    };

    proc.stderr!.on('data', handleChunk);

    proc.on('close', (code) => {
      // flush any remaining buffer
      if (buf.trim()) {
        const parsed = parseGitProgressLine(buf.trim());
        if (parsed !== null) {
          hasProgress = true;
          process.stderr.write(
            '\r\x1b[2K' + renderProgressBar(parsed.pct, parsed.currentMB, parsed.totalMB),
          );
        }
      }
      if (hasProgress) process.stderr.write('\n');
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} failed (exit ${code})`));
    });
  });
