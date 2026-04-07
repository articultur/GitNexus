import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import * as repoManager from '../../../src/storage/repo-manager.js';

// Mock only fs/promises — path and os use native Node.js which is harder to intercept cleanly
vi.mock('fs/promises');

const mockFs = vi.mocked(fs);

describe('storage/repo-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset process.platform for each test
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  describe('getStoragePath', () => {
    it('returns resolved repo path joined with .gitnexus', () => {
      const result = repoManager.getStoragePath('/my/repo');
      expect(result).toContain('.gitnexus');
    });
  });

  describe('getStoragePaths', () => {
    it('returns storagePath, lbugPath, and metaPath', () => {
      const paths = repoManager.getStoragePaths('/my/repo');
      expect(paths.storagePath).toContain('.gitnexus');
      expect(paths.lbugPath).toContain('lbug');
      expect(paths.metaPath).toContain('meta.json');
    });
  });

  describe('hasKuzuIndex', () => {
    it('returns true when kuzu directory exists', async () => {
      mockFs.stat.mockResolvedValue({} as any);
      const result = await repoManager.hasKuzuIndex('/my/repo/.gitnexus');
      expect(mockFs.stat).toHaveBeenCalledWith(expect.stringContaining('kuzu'));
      expect(result).toBe(true);
    });

    it('returns false when kuzu directory does not exist', async () => {
      mockFs.stat.mockRejectedValue(new Error('not found'));
      const result = await repoManager.hasKuzuIndex('/my/repo/.gitnexus');
      expect(result).toBe(false);
    });
  });

  describe('cleanupOldKuzuFiles', () => {
    it('deletes old kuzu files and returns found=true, needsReindex=false when lbug exists', async () => {
      mockFs.stat
        .mockResolvedValueOnce({} as any) // kuzu exists
        .mockResolvedValueOnce({} as any); // lbug also exists
      mockFs.unlink.mockResolvedValue(undefined as any);
      mockFs.rm.mockResolvedValue(undefined as any);

      const result = await repoManager.cleanupOldKuzuFiles('/my/repo/.gitnexus');
      expect(result).toEqual({ found: true, needsReindex: false });
      expect(mockFs.unlink).toHaveBeenCalledTimes(3); // '', '.wal', '.lock'
    });

    it('returns needsReindex=true when lbug is missing after kuzu cleanup', async () => {
      mockFs.stat
        .mockResolvedValueOnce({} as any) // kuzu exists
        .mockRejectedValueOnce(new Error('not found')); // lbug missing
      mockFs.unlink.mockResolvedValue(undefined as any);
      mockFs.rm.mockResolvedValue(undefined as any);

      const result = await repoManager.cleanupOldKuzuFiles('/my/repo/.gitnexus');
      expect(result).toEqual({ found: true, needsReindex: true });
    });

    it('returns found=false when kuzu does not exist', async () => {
      mockFs.stat.mockRejectedValue(new Error('not found'));
      const result = await repoManager.cleanupOldKuzuFiles('/my/repo/.gitnexus');
      expect(result).toEqual({ found: false, needsReindex: false });
    });

    it('falls back to rm when unlink fails (directory case)', async () => {
      mockFs.stat
        .mockResolvedValueOnce({} as any)
        .mockResolvedValueOnce({} as any);
      mockFs.unlink.mockRejectedValue(new Error('not a file'));
      mockFs.rm.mockResolvedValue(undefined as any);

      await repoManager.cleanupOldKuzuFiles('/my/repo/.gitnexus');
      expect(mockFs.rm).toHaveBeenCalled();
    });
  });

  describe('loadMeta', () => {
    it('returns parsed meta.json when it exists', async () => {
      const meta = { repoPath: '/repo', lastCommit: 'abc', indexedAt: '2024-01-01' };
      mockFs.readFile.mockResolvedValue(JSON.stringify(meta));
      const result = await repoManager.loadMeta('/repo/.gitnexus');
      expect(result).toEqual(meta);
    });

    it('returns null when meta.json does not exist', async () => {
      mockFs.readFile.mockRejectedValue(new Error('not found'));
      const result = await repoManager.loadMeta('/repo/.gitnexus');
      expect(result).toBeNull();
    });

    it('returns null when meta.json has invalid JSON', async () => {
      mockFs.readFile.mockResolvedValue('not json{');
      const result = await repoManager.loadMeta('/repo/.gitnexus');
      expect(result).toBeNull();
    });
  });

  describe('saveMeta', () => {
    it('writes formatted JSON to meta.json', async () => {
      const meta = { repoPath: '/repo', lastCommit: 'abc', indexedAt: '2024-01-01' };
      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      await repoManager.saveMeta('/repo/.gitnexus', meta);

      expect(mockFs.mkdir).toHaveBeenCalledWith(expect.stringContaining('.gitnexus'), { recursive: true });
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('meta.json'),
        JSON.stringify(meta, null, 2),
        'utf-8',
      );
    });
  });

  describe('hasIndex', () => {
    it('returns true when meta.json is accessible', async () => {
      mockFs.access.mockResolvedValue(undefined as any);
      const result = await repoManager.hasIndex('/repo');
      expect(result).toBe(true);
    });

    it('returns false when meta.json is not accessible', async () => {
      mockFs.access.mockRejectedValue(new Error('not found'));
      const result = await repoManager.hasIndex('/repo');
      expect(result).toBe(false);
    });
  });

  describe('loadRepo', () => {
    it('returns IndexedRepo when meta exists', async () => {
      const meta = { repoPath: '/repo', lastCommit: 'abc', indexedAt: '2024-01-01' };
      mockFs.readFile.mockResolvedValue(JSON.stringify(meta));
      const result = await repoManager.loadRepo('/repo');
      expect(result).not.toBeNull();
      expect(result!.meta).toEqual(meta);
    });

    it('returns null when meta does not exist', async () => {
      mockFs.readFile.mockRejectedValue(new Error('not found'));
      const result = await repoManager.loadRepo('/repo');
      expect(result).toBeNull();
    });
  });

  describe('findRepo', () => {
    it('returns IndexedRepo when found by walking up directories', async () => {
      const meta = { repoPath: '/repo', lastCommit: 'abc', indexedAt: '2024-01-01' };
      mockFs.readFile
        .mockRejectedValueOnce(new Error('not found')) // /a/b
        .mockResolvedValueOnce(JSON.stringify(meta)); // /a

      const result = await repoManager.findRepo('/a/b');
      expect(result).not.toBeNull();
      expect(result!.meta).toEqual(meta);
    });

    it('returns null when no repo found on path', async () => {
      mockFs.readFile.mockRejectedValue(new Error('not found'));
      const result = await repoManager.findRepo('/a/b/c');
      expect(result).toBeNull();
    });
  });

  describe('addToGitignore', () => {
    it('appends GITNEXUS_DIR when not present', async () => {
      mockFs.readFile.mockResolvedValue('node_modules/');
      mockFs.writeFile.mockResolvedValue(undefined as any);

      await repoManager.addToGitignore('/repo');

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/repo/.gitignore',
        expect.stringContaining('.gitnexus'),
        'utf-8',
      );
    });

    it('does nothing when GITNEXUS_DIR already present', async () => {
      mockFs.readFile.mockResolvedValue('node_modules/\n.gitnexus\n');

      await repoManager.addToGitignore('/repo');

      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('creates .gitignore when it does not exist', async () => {
      mockFs.readFile.mockRejectedValue(new Error('not found'));
      mockFs.writeFile.mockResolvedValue(undefined as any);

      await repoManager.addToGitignore('/repo');

      expect(mockFs.writeFile).toHaveBeenCalledWith('/repo/.gitignore', '.gitnexus\n', 'utf-8');
    });
  });

  describe('getGlobalDir', () => {
    it('returns path containing .gitnexus in home directory', () => {
      const result = repoManager.getGlobalDir();
      expect(result).toContain('.gitnexus');
    });
  });

  describe('getGlobalRegistryPath', () => {
    it('returns path ending with registry.json', () => {
      const result = repoManager.getGlobalRegistryPath();
      expect(result).toContain('registry.json');
    });
  });

  describe('readRegistry', () => {
    it('returns parsed array from registry.json', async () => {
      const entries = [{ name: 'repo', path: '/repo', storagePath: '/repo/.gitnexus', indexedAt: '2024', lastCommit: 'a' }];
      mockFs.readFile.mockResolvedValue(JSON.stringify(entries));
      const result = await repoManager.readRegistry();
      expect(result).toEqual(entries);
    });

    it('returns empty array when file not found', async () => {
      mockFs.readFile.mockRejectedValue(new Error('not found'));
      const result = await repoManager.readRegistry();
      expect(result).toEqual([]);
    });

    it('returns empty array when JSON is not an array', async () => {
      mockFs.readFile.mockResolvedValue('{"not": "array"}');
      const result = await repoManager.readRegistry();
      expect(result).toEqual([]);
    });
  });

  describe('registerRepo', () => {
    it('adds new repo to empty registry', async () => {
      mockFs.readFile.mockResolvedValue('[]');
      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      const meta = { repoPath: '/repo', lastCommit: 'abc123', indexedAt: '2024-01-01' };
      await repoManager.registerRepo('/repo', meta);

      expect(mockFs.writeFile).toHaveBeenCalled();
      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written).toContainEqual(expect.objectContaining({ name: 'repo', path: '/repo' }));
    });

    it('updates existing repo entry', async () => {
      const existing = [{ name: 'repo', path: '/repo', storagePath: '/repo/.gitnexus', indexedAt: '2023', lastCommit: 'old' }];
      mockFs.readFile.mockResolvedValue(JSON.stringify(existing));
      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      const meta = { repoPath: '/repo', lastCommit: 'newcommit', indexedAt: '2024-01-01' };
      await repoManager.registerRepo('/repo', meta);

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written[0].lastCommit).toBe('newcommit');
      expect(written.length).toBe(1);
    });
  });

  describe('unregisterRepo', () => {
    it('removes repo from registry', async () => {
      const entries = [
        { name: 'repo1', path: '/repo1', storagePath: '/repo1/.gitnexus', indexedAt: '2024', lastCommit: 'a' },
        { name: 'repo2', path: '/repo2', storagePath: '/repo2/.gitnexus', indexedAt: '2024', lastCommit: 'b' },
      ];
      mockFs.readFile.mockResolvedValue(JSON.stringify(entries));
      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      await repoManager.unregisterRepo('/repo1');

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written.length).toBe(1);
      expect(written[0].name).toBe('repo2');
    });
  });

  describe('listRegisteredRepos', () => {
    it('returns all entries without validation', async () => {
      const entries = [{ name: 'repo', path: '/repo', storagePath: '/repo/.gitnexus', indexedAt: '2024', lastCommit: 'a' }];
      mockFs.readFile.mockResolvedValue(JSON.stringify(entries));
      const result = await repoManager.listRegisteredRepos();
      expect(result).toEqual(entries);
    });

    it('validates and prunes missing repos when validate=true', async () => {
      const entries = [
        { name: 'repo1', path: '/repo1', storagePath: '/repo1/.gitnexus', indexedAt: '2024', lastCommit: 'a' },
        { name: 'repo2', path: '/repo2', storagePath: '/repo2/.gitnexus', indexedAt: '2024', lastCommit: 'b' },
      ];
      mockFs.readFile.mockResolvedValue(JSON.stringify(entries));
      mockFs.access
        .mockResolvedValueOnce(undefined as any)
        .mockRejectedValueOnce(new Error('not found'));
      mockFs.mkdir.mockResolvedValue(undefined as any);
      mockFs.writeFile.mockResolvedValue(undefined as any);

      const result = await repoManager.listRegisteredRepos({ validate: true });

      expect(result.length).toBe(1);
      expect(result[0].name).toBe('repo1');
    });
  });

  describe('CLI Config', () => {
    describe('getGlobalConfigPath', () => {
      it('returns path ending with config.json', () => {
        expect(repoManager.getGlobalConfigPath()).toContain('config.json');
      });
    });

    describe('loadCLIConfig', () => {
      it('returns parsed config', async () => {
        mockFs.readFile.mockResolvedValue(JSON.stringify({ model: 'gpt-4' }));
        const result = await repoManager.loadCLIConfig();
        expect(result).toEqual({ model: 'gpt-4' });
      });

      it('returns empty object when file not found', async () => {
        mockFs.readFile.mockRejectedValue(new Error('not found'));
        const result = await repoManager.loadCLIConfig();
        expect(result).toEqual({});
      });
    });

    describe('saveCLIConfig', () => {
      it('writes config with mkdir', async () => {
        mockFs.mkdir.mockResolvedValue(undefined as any);
        mockFs.writeFile.mockResolvedValue(undefined as any);
        mockFs.chmod.mockResolvedValue(undefined as any);

        await repoManager.saveCLIConfig({ apiKey: 'secret' });

        expect(mockFs.mkdir).toHaveBeenCalled();
        expect(mockFs.writeFile).toHaveBeenCalled();
        expect(mockFs.chmod).toHaveBeenCalledWith(expect.stringContaining('config.json'), 0o600);
      });

      it('skips chmod on Windows', async () => {
        mockFs.mkdir.mockResolvedValue(undefined as any);
        mockFs.writeFile.mockResolvedValue(undefined as any);
        mockFs.chmod.mockRejectedValue(new Error('not supported'));

        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        await repoManager.saveCLIConfig({ apiKey: 'secret' });
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

        expect(mockFs.chmod).not.toHaveBeenCalled();
      });
    });
  });
});
