import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { statSync } from 'fs';
import * as gitModule from '../../../src/storage/git.js';

vi.mock('child_process');
vi.mock('fs');

const mockExecSync = vi.mocked(execSync);
const mockStatSync = vi.mocked(statSync);

describe('storage/git', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isGitRepo', () => {
    it('returns true when inside a git work tree', () => {
      mockExecSync.mockReturnValue(Buffer.from('true'));
      expect(gitModule.isGitRepo('/repo')).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('git rev-parse --is-inside-work-tree', {
        cwd: '/repo',
        stdio: 'ignore',
      });
    });

    it('returns false when not inside a git repo', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not a git repo');
      });
      expect(gitModule.isGitRepo('/not-a-repo')).toBe(false);
    });
  });

  describe('getCurrentCommit', () => {
    it('returns the current commit hash trimmed', () => {
      mockExecSync.mockReturnValue(Buffer.from('abc123def456\n'));
      expect(gitModule.getCurrentCommit('/repo')).toBe('abc123def456');
      expect(mockExecSync).toHaveBeenCalledWith('git rev-parse HEAD', {
        cwd: '/repo',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    });

    it('returns empty string when git command fails', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('git failed');
      });
      expect(gitModule.getCurrentCommit('/repo')).toBe('');
    });
  });

  describe('getGitRoot', () => {
    it('returns resolved path of git toplevel', () => {
      mockExecSync.mockReturnValue(Buffer.from('/some/path\n'));
      // Note: path.resolve is used inside the module so we just verify the output
      expect(gitModule.getGitRoot('/repo/subdir')).toBe('/some/path');
    });

    it('returns null when git command fails', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('git failed');
      });
      expect(gitModule.getGitRoot('/repo')).toBe(null);
    });
  });

  describe('hasGitDir', () => {
    it('returns true when .git exists', () => {
      mockStatSync.mockReturnValue({} as any);
      expect(gitModule.hasGitDir('/repo')).toBe(true);
      expect(mockStatSync).toHaveBeenCalledWith('/repo/.git');
    });

    it('returns false when .git does not exist', () => {
      mockStatSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(gitModule.hasGitDir('/repo')).toBe(false);
    });
  });
});
