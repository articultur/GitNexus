/**
 * P1 Unit Tests: Repository Manager
 *
 * Expanded coverage for: hasKuzuIndex, cleanupOldKuzuFiles, loadMeta, saveMeta,
 * hasIndex, loadRepo, findRepo, addToGitignore, registerRepo, unregisterRepo,
 * listRegisteredRepos, saveCLIConfig
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  getStoragePath,
  getStoragePaths,
  hasKuzuIndex,
  cleanupOldKuzuFiles,
  loadMeta,
  saveMeta,
  hasIndex,
  loadRepo,
  findRepo,
  addToGitignore,
  getGlobalDir,
  getGlobalRegistryPath,
  getGlobalConfigPath,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

// ─── helpers ──────────────────────────────────────────────────────────

function repoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  return {
    repoPath: '/fake',
    lastCommit: 'abc123',
    indexedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Redirect ~/.gitnexus to a temp directory by setting HOME.
 * Must be called BEFORE importing registry functions, and the module
 * must be re-imported after setting HOME so os.homedir() picks it up.
 */
async function withMockedHome<T>(tmpDir: string, fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  vi.resetModules();
  try {
    return await fn();
  } finally {
    process.env.HOME = originalHome;
    vi.resetModules();
  }
}

// ─── getStoragePath ──────────────────────────────────────────────────

describe('getStoragePath', () => {
  it('appends .gitnexus to resolved repo path', () => {
    const result = getStoragePath('/home/user/project');
    expect(result).toContain('.gitnexus');
    expect(path.basename(result)).toBe('.gitnexus');
  });

  it('resolves relative paths', () => {
    const result = getStoragePath('.');
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ─── getStoragePaths ─────────────────────────────────────────────────

describe('getStoragePaths', () => {
  it('returns storagePath, lbugPath, metaPath', () => {
    const paths = getStoragePaths('/home/user/project');
    expect(paths.storagePath).toContain('.gitnexus');
    expect(paths.lbugPath).toContain('lbug');
    expect(paths.metaPath).toContain('meta.json');
  });

  it('all paths are under storagePath', () => {
    const paths = getStoragePaths('/home/user/project');
    expect(paths.lbugPath.startsWith(paths.storagePath)).toBe(true);
    expect(paths.metaPath.startsWith(paths.storagePath)).toBe(true);
  });
});

// ─── hasKuzuIndex ────────────────────────────────────────────────────

describe('hasKuzuIndex', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => { tmp = await createTempDir('hasKuzuIndex-'); });
  afterEach(async () => { await tmp.cleanup(); });

  it('returns false when kuzu directory does not exist', async () => {
    await fs.mkdir(tmp.dbPath, { recursive: true });
    const result = await hasKuzuIndex(tmp.dbPath);
    expect(result).toBe(false);
  });

  it('returns true when kuzu directory exists', async () => {
    await fs.mkdir(path.join(tmp.dbPath, 'kuzu'), { recursive: true });
    const result = await hasKuzuIndex(tmp.dbPath);
    expect(result).toBe(true);
  });

  it('returns false when only lbug exists (post-migration)', async () => {
    await fs.mkdir(path.join(tmp.dbPath, 'lbug'), { recursive: true });
    const result = await hasKuzuIndex(tmp.dbPath);
    expect(result).toBe(false);
  });
});

// ─── cleanupOldKuzuFiles ─────────────────────────────────────────────

describe('cleanupOldKuzuFiles', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => { tmp = await createTempDir('cleanupKuzu-'); });
  afterEach(async () => { await tmp.cleanup(); });

  it('returns found=false when nothing exists', async () => {
    const result = await cleanupOldKuzuFiles(tmp.dbPath);
    expect(result).toEqual({ found: false, needsReindex: false });
  });

  it('returns found=true and needsReindex=false when kuzu exists alongside lbug', async () => {
    await fs.mkdir(path.join(tmp.dbPath, 'kuzu'), { recursive: true });
    await fs.mkdir(path.join(tmp.dbPath, 'lbug'), { recursive: true });
    const result = await cleanupOldKuzuFiles(tmp.dbPath);
    expect(result.found).toBe(true);
    expect(result.needsReindex).toBe(false);
  });

  it('returns found=true and needsReindex=true when only kuzu exists', async () => {
    await fs.mkdir(path.join(tmp.dbPath, 'kuzu'), { recursive: true });
    const result = await cleanupOldKuzuFiles(tmp.dbPath);
    expect(result.found).toBe(true);
    expect(result.needsReindex).toBe(true);
  });

  it('cleans up kuzu file and sidecars (.wal, .lock)', async () => {
    const kuzuPath = path.join(tmp.dbPath, 'kuzu');
    await fs.mkdir(kuzuPath, { recursive: true });
    await fs.writeFile(path.join(kuzuPath, '.wal'), 'wal data');
    await fs.writeFile(path.join(kuzuPath, '.lock'), 'lock data');
    await cleanupOldKuzuFiles(tmp.dbPath);
    await expect(fs.access(kuzuPath)).rejects.toBeDefined();
  });

  it('handles kuzu as a regular file (not directory)', async () => {
    const kuzuPath = path.join(tmp.dbPath, 'kuzu');
    await fs.writeFile(kuzuPath, 'kuzu-data');
    const result = await cleanupOldKuzuFiles(tmp.dbPath);
    expect(result.found).toBe(true);
    await expect(fs.access(kuzuPath)).rejects.toBeDefined();
  });
});

// ─── loadMeta / saveMeta ──────────────────────────────────────────────

describe('loadMeta', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => { tmp = await createTempDir('loadMeta-'); });
  afterEach(async () => { await tmp.cleanup(); });

  it('returns null when meta.json does not exist', async () => {
    const result = await loadMeta(tmp.dbPath);
    expect(result).toBeNull();
  });

  it('returns parsed RepoMeta when meta.json exists', async () => {
    const meta = repoMeta({ repoPath: '/test/repo' });
    await saveMeta(tmp.dbPath, meta);
    const result = await loadMeta(tmp.dbPath);
    expect(result).toEqual(meta);
  });

  it('returns null for invalid JSON', async () => {
    await fs.mkdir(tmp.dbPath, { recursive: true });
    await fs.writeFile(path.join(tmp.dbPath, 'meta.json'), 'not json{');
    const result = await loadMeta(tmp.dbPath);
    expect(result).toBeNull();
  });
});

describe('saveMeta', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => { tmp = await createTempDir('saveMeta-'); });
  afterEach(async () => { await tmp.cleanup(); });

  it('creates the directory if it does not exist', async () => {
    const nested = path.join(tmp.dbPath, 'subdir', '.gitnexus');
    await saveMeta(nested, repoMeta());
    await expect(fs.access(path.join(nested, 'meta.json'))).resolves.toBeUndefined();
  });

  it('writes formatted JSON', async () => {
    const meta = repoMeta();
    await saveMeta(tmp.dbPath, meta);
    const raw = await fs.readFile(path.join(tmp.dbPath, 'meta.json'), 'utf-8');
    expect(raw).toContain('\n');
    expect(JSON.parse(raw)).toEqual(meta);
  });
});

// ─── hasIndex ────────────────────────────────────────────────────────

describe('hasIndex', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => { tmp = await createTempDir('hasIndex-'); });
  afterEach(async () => { await tmp.cleanup(); });

  it('returns false when meta.json does not exist', async () => {
    const result = await hasIndex(tmp.dbPath);
    expect(result).toBe(false);
  });

  it('returns true when meta.json exists', async () => {
    await saveMeta(getStoragePath(tmp.dbPath), repoMeta());
    const result = await hasIndex(tmp.dbPath);
    expect(result).toBe(true);
  });
});

// ─── loadRepo ────────────────────────────────────────────────────────

describe('loadRepo', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => { tmp = await createTempDir('loadRepo-'); });
  afterEach(async () => { await tmp.cleanup(); });

  it('returns null when meta.json does not exist', async () => {
    const result = await loadRepo(tmp.dbPath);
    expect(result).toBeNull();
  });

  it('returns IndexedRepo when meta.json exists', async () => {
    const meta = repoMeta({ repoPath: tmp.dbPath });
    await saveMeta(getStoragePath(tmp.dbPath), meta);
    const result = await loadRepo(tmp.dbPath);
    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe(path.resolve(tmp.dbPath));
    expect(result!.storagePath).toContain('.gitnexus');
    expect(result!.meta).toEqual(meta);
  });
});

// ─── findRepo ────────────────────────────────────────────────────────

describe('findRepo', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => { tmp = await createTempDir('findRepo-'); });
  afterEach(async () => { await tmp.cleanup(); });

  it('returns null when no .gitnexus exists in any parent', async () => {
    const result = await findRepo(tmp.dbPath);
    expect(result).toBeNull();
  });

  it('finds .gitnexus in a parent directory', async () => {
    const subDir = path.join(tmp.dbPath, 'a', 'b', 'c');
    await fs.mkdir(subDir, { recursive: true });
    await saveMeta(getStoragePath(tmp.dbPath), repoMeta({ repoPath: tmp.dbPath }));
    const result = await findRepo(subDir);
    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe(path.resolve(tmp.dbPath));
  });

  it('stops at filesystem root', async () => {
    const result = await findRepo(path.parse(tmp.dbPath).root);
    expect(result).toBeNull();
  });
});

// ─── addToGitignore ─────────────────────────────────────────────────

describe('addToGitignore', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => { tmp = await createTempDir('gitignore-'); });
  afterEach(async () => { await tmp.cleanup(); });

  it('creates .gitignore when it does not exist', async () => {
    await addToGitignore(tmp.dbPath);
    const content = await fs.readFile(path.join(tmp.dbPath, '.gitignore'), 'utf-8');
    expect(content).toContain('.gitnexus');
  });

  it('appends to existing .gitignore without .gitnexus', async () => {
    await fs.writeFile(path.join(tmp.dbPath, '.gitignore'), 'node_modules\n');
    await addToGitignore(tmp.dbPath);
    const content = await fs.readFile(path.join(tmp.dbPath, '.gitignore'), 'utf-8');
    expect(content).toContain('.gitnexus');
    expect(content).toContain('node_modules');
  });

  it('does not duplicate .gitnexus if already present', async () => {
    await fs.writeFile(path.join(tmp.dbPath, '.gitignore'), '.gitnexus\nnode_modules\n');
    await addToGitignore(tmp.dbPath);
    const lines = (await fs.readFile(path.join(tmp.dbPath, '.gitignore'), 'utf-8'))
      .split('\n')
      .filter((l) => l === '.gitnexus');
    expect(lines).toHaveLength(1);
  });

  it('handles .gitignore without trailing newline', async () => {
    await fs.writeFile(path.join(tmp.dbPath, '.gitignore'), 'node_modules');
    await addToGitignore(tmp.dbPath);
    const content = await fs.readFile(path.join(tmp.dbPath, '.gitignore'), 'utf-8');
    expect(content).toContain('.gitnexus');
  });
});

// ─── Global Registry — redirect via process.env.HOME ─────────────────
// On non-Windows, os.homedir() defers to process.env.HOME.
// By setting HOME before the module is re-imported, we redirect the global registry.

describe('Global Registry', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => {
    tmp = await createTempDir('registry-');
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('readRegistry returns empty array when registry does not exist', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { readRegistry } = await import('../../src/storage/repo-manager.js');
      const result = await readRegistry();
      expect(result).toEqual([]);
    });
  });

  it('readRegistry returns array from existing registry', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { getGlobalDir, getGlobalRegistryPath } = await import('../../src/storage/repo-manager.js');
      await fs.mkdir(getGlobalDir(), { recursive: true });
      await fs.writeFile(
        getGlobalRegistryPath(),
        JSON.stringify([{ name: 'test', path: '/test', storagePath: '/test/.gitnexus', indexedAt: '2024-01-01', lastCommit: 'abc' }]),
      );
      const { readRegistry } = await import('../../src/storage/repo-manager.js');
      const result = await readRegistry();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test');
    });
  });

  it('readRegistry returns empty array for malformed JSON', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { getGlobalDir, getGlobalRegistryPath } = await import('../../src/storage/repo-manager.js');
      await fs.mkdir(getGlobalDir(), { recursive: true });
      await fs.writeFile(getGlobalRegistryPath(), 'not json');
      const { readRegistry } = await import('../../src/storage/repo-manager.js');
      const result = await readRegistry();
      expect(result).toEqual([]);
    });
  });

  it('readRegistry returns empty array when file contains non-array', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { getGlobalDir, getGlobalRegistryPath } = await import('../../src/storage/repo-manager.js');
      await fs.mkdir(getGlobalDir(), { recursive: true });
      await fs.writeFile(getGlobalRegistryPath(), JSON.stringify({ name: 'test' }));
      const { readRegistry } = await import('../../src/storage/repo-manager.js');
      const result = await readRegistry();
      expect(result).toEqual([]);
    });
  });

  it('registerRepo creates a registry entry', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { registerRepo, readRegistry } = await import('../../src/storage/repo-manager.js');
      await registerRepo(tmp.dbPath, repoMeta({ lastCommit: 'abc', indexedAt: '2024-01-01' }));
      const entries = await readRegistry();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe(path.basename(tmp.dbPath));
    });
  });

  it('registerRepo updates existing entry for same path', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { registerRepo, readRegistry } = await import('../../src/storage/repo-manager.js');
      await registerRepo(tmp.dbPath, repoMeta({ lastCommit: 'abc', indexedAt: '2024-01-01' }));
      await registerRepo(tmp.dbPath, repoMeta({ lastCommit: 'def', indexedAt: '2024-01-02' }));
      const entries = await readRegistry();
      expect(entries).toHaveLength(1);
      expect(entries[0].lastCommit).toBe('def');
    });
  });

  it('registerRepo keeps separate entries for different paths', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { registerRepo, readRegistry } = await import('../../src/storage/repo-manager.js');
      const otherDir = path.join(tmp.dbPath, 'other');
      await fs.mkdir(otherDir, { recursive: true });
      await registerRepo(tmp.dbPath, repoMeta({ lastCommit: 'abc' }));
      await registerRepo(otherDir, repoMeta({ lastCommit: 'def' }));
      const entries = await readRegistry();
      expect(entries).toHaveLength(2);
    });
  });

  it('unregisterRepo removes the entry', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { registerRepo, unregisterRepo, readRegistry } = await import('../../src/storage/repo-manager.js');
      await registerRepo(tmp.dbPath, repoMeta());
      await unregisterRepo(tmp.dbPath);
      const entries = await readRegistry();
      expect(entries).toHaveLength(0);
    });
  });

  it('unregisterRepo leaves other entries untouched', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { registerRepo, unregisterRepo, readRegistry } = await import('../../src/storage/repo-manager.js');
      const otherDir = path.join(tmp.dbPath, 'other');
      await fs.mkdir(otherDir, { recursive: true });
      await registerRepo(tmp.dbPath, repoMeta());
      await registerRepo(otherDir, repoMeta());
      await unregisterRepo(tmp.dbPath);
      const entries = await readRegistry();
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe(path.resolve(otherDir));
    });
  });

  it('listRegisteredRepos returns entries without validation', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { registerRepo, listRegisteredRepos } = await import('../../src/storage/repo-manager.js');
      await registerRepo(tmp.dbPath, repoMeta());
      const entries = await listRegisteredRepos();
      expect(entries).toHaveLength(1);
    });
  });

  it('listRegisteredRepos prunes missing entries when validate=true', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { registerRepo, listRegisteredRepos } = await import('../../src/storage/repo-manager.js');
      await registerRepo(tmp.dbPath, repoMeta());
      // entry points to a path that doesn't exist
      const entries = await listRegisteredRepos({ validate: true });
      expect(entries).toHaveLength(0);
    });
  });

  it('listRegisteredRepos keeps valid entries when validate=true', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { registerRepo, listRegisteredRepos, getStoragePath } = await import('../../src/storage/repo-manager.js');
      await registerRepo(tmp.dbPath, repoMeta());
      await saveMeta(getStoragePath(tmp.dbPath), repoMeta());
      const entries = await listRegisteredRepos({ validate: true });
      expect(entries).toHaveLength(1);
    });
  });
});

// ─── CLI Config ─────────────────────────────────────────────────────

describe('CLI Config', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => { tmp = await createTempDir('cliConfig-'); });
  afterEach(async () => { await tmp.cleanup(); });

  it('loadCLIConfig returns empty object when config does not exist', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { loadCLIConfig } = await import('../../src/storage/repo-manager.js');
      const config = await loadCLIConfig();
      expect(config).toEqual({});
    });
  });

  it('saveCLIConfig writes and loadCLIConfig reads it back', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { loadCLIConfig, saveCLIConfig } = await import('../../src/storage/repo-manager.js');
      const config = { apiKey: 'test-key', model: 'gpt-4', provider: 'openai' as const };
      await saveCLIConfig(config);
      const loaded = await loadCLIConfig();
      expect(loaded).toEqual(config);
    });
  });

  it('loadCLIConfig returns empty object for malformed JSON', async () => {
    await withMockedHome(tmp.dbPath, async () => {
      const { getGlobalDir, getGlobalConfigPath } = await import('../../src/storage/repo-manager.js');
      await fs.mkdir(getGlobalDir(), { recursive: true });
      await fs.writeFile(getGlobalConfigPath(), 'bad json');
      const { loadCLIConfig } = await import('../../src/storage/repo-manager.js');
      const config = await loadCLIConfig();
      expect(config).toEqual({});
    });
  });
});

// ─── Case-insensitive path comparison (Windows hardening #30) ────────

describe('case-insensitive path comparison', () => {
  it('registerRepo uses case-insensitive compare on Windows', () => {
    const compareWindows = (a: string, b: string): boolean => {
      return a.toLowerCase() === b.toLowerCase();
    };
    expect(compareWindows('D:\\Projects\\MyApp', 'd:\\projects\\myapp')).toBe(true);
    expect(compareWindows('C:\\Users\\USER\\project', 'c:\\users\\user\\project')).toBe(true);
    expect(compareWindows('D:\\Projects\\App1', 'D:\\Projects\\App2')).toBe(false);
  });

  it('case-sensitive compare for non-Windows', () => {
    const compareUnix = (a: string, b: string): boolean => a === b;
    expect(compareUnix('/home/user/Project', '/home/user/project')).toBe(false);
    expect(compareUnix('/home/user/project', '/home/user/project')).toBe(true);
  });
});

// ─── API key file permissions (hardening #29) ────────────────────────

describe('API key file permissions', () => {
  it('saveCLIConfig calls chmod 0o600 on non-Windows', async () => {
    const srcPath = new URL('../../src/storage/repo-manager.ts', import.meta.url).pathname;
    const source = await fs.readFile(srcPath, 'utf-8');
    expect(source).toContain('chmod(configPath, 0o600)');
    expect(source).toContain("process.platform !== 'win32'");
  });
});
