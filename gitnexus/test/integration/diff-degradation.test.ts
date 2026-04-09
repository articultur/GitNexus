/**
 * Integration tests for diff degradation functionality
 *
 * Tests the full degradation flow with real git operations.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDiffWithDegradation,
  type DiffParseOptions,
} from '../../src/mcp/local/tools/git-diff-parser.js';
import { determinePrecision, DIFF_SIZE_THRESHOLDS } from '../../src/mcp/local/tools/shared.js';

describe('Diff Degradation Integration', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gitnexus-degradation-test-'));

    // Initialize a git repo
    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('parseDiffWithDegradation', () => {
    it('should return normal precision for small diff', async () => {
      // Create a small file
      const filePath = join(tempDir, 'small.ts');
      await writeFile(filePath, 'export function hello() { return "world"; }\n');
      execFileSync('git', ['add', '.'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: tempDir });

      // Modify the file
      await writeFile(filePath, 'export function hello() { return "changed"; }\n');

      const options: DiffParseOptions = {
        repoPath: tempDir,
        scope: 'unstaged',
      };

      const result = await parseDiffWithDegradation(options);

      expect(result.success).toBe(true);
      expect(result.precision).toBe('normal');
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toContain('small.ts');
      expect(result.files[0].hunks).toBeDefined();
      expect(result.files[0].hunks).toHaveLength(1);
    });

    it('should handle staged changes', async () => {
      // Stage the changes
      execFileSync('git', ['add', '.'], { cwd: tempDir });

      const options: DiffParseOptions = {
        repoPath: tempDir,
        scope: 'staged',
      };

      const result = await parseDiffWithDegradation(options);

      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(1);
    });

    it('should handle file filter', async () => {
      // Create multiple files
      await writeFile(join(tempDir, 'file1.ts'), 'export const a = 1;\n');
      await writeFile(join(tempDir, 'file2.ts'), 'export const b = 2;\n');
      execFileSync('git', ['add', '.'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'add files'], { cwd: tempDir });

      // Modify both files
      await writeFile(join(tempDir, 'file1.ts'), 'export const a = 10;\n');
      await writeFile(join(tempDir, 'file2.ts'), 'export const b = 20;\n');

      const options: DiffParseOptions = {
        repoPath: tempDir,
        scope: 'unstaged',
        fileFilter: 'file1.ts',
      };

      const result = await parseDiffWithDegradation(options);

      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toContain('file1.ts');
    });

    it('should handle deleted files', async () => {
      // Create and commit a file
      const filePath = join(tempDir, 'to-delete.ts');
      await writeFile(filePath, 'export const deleted = true;\n');
      execFileSync('git', ['add', '.'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'add file to delete'], { cwd: tempDir });

      // Delete the file
      execFileSync('git', ['rm', 'to-delete.ts'], { cwd: tempDir });

      const options: DiffParseOptions = {
        repoPath: tempDir,
        scope: 'staged',
      };

      const result = await parseDiffWithDegradation(options);

      expect(result.success).toBe(true);
      const deletedFile = result.files.find((f) => f.status === 'deleted');
      expect(deletedFile).toBeDefined();
      expect(deletedFile?.path).toContain('to-delete.ts');
    });

    it('should handle renamed files', async () => {
      // Create and commit a file
      await writeFile(join(tempDir, 'old-name.ts'), 'export const renamed = true;\n');
      execFileSync('git', ['add', '.'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'add file to rename'], { cwd: tempDir });

      // Rename the file
      execFileSync('git', ['mv', 'old-name.ts', 'new-name.ts'], { cwd: tempDir });

      const options: DiffParseOptions = {
        repoPath: tempDir,
        scope: 'staged',
      };

      const result = await parseDiffWithDegradation(options);

      expect(result.success).toBe(true);
      const renamedFile = result.files.find((f) => f.status === 'renamed');
      expect(renamedFile).toBeDefined();
      expect(renamedFile?.oldPath).toContain('old-name.ts');
      expect(renamedFile?.path).toContain('new-name.ts');
    });

    it('should handle compare scope', async () => {
      // Commit all changes first
      execFileSync('git', ['add', '.'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'before compare'], { cwd: tempDir });

      // Create new changes
      await writeFile(join(tempDir, 'compare-test.ts'), 'export const compare = true;\n');
      execFileSync('git', ['add', '.'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'compare commit'], { cwd: tempDir });

      const options: DiffParseOptions = {
        repoPath: tempDir,
        scope: 'compare',
        baseRef: 'HEAD~1',
      };

      const result = await parseDiffWithDegradation(options);

      expect(result.success).toBe(true);
      expect(result.files.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('determinePrecision with real diff sizes', () => {
    it('should correctly classify diff sizes', () => {
      // Test various diff sizes
      const smallDiff = 100 * 1024; // 100KB
      const mediumDiff = 1 * 1024 * 1024; // 1MB
      const largeDiff = 5 * 1024 * 1024; // 5MB

      expect(determinePrecision(smallDiff)).toBe('normal');
      expect(determinePrecision(mediumDiff)).toBe('symbol-level');
      expect(determinePrecision(largeDiff)).toBe('file-level');
    });

    it('should respect hysteresis at boundaries', () => {
      const normalMax = DIFF_SIZE_THRESHOLDS.NORMAL_MAX;
      const hysteresis = DIFF_SIZE_THRESHOLDS.HYSTERESIS;

      // Just below hysteresis threshold
      const justBelow = normalMax * hysteresis - 1;
      expect(determinePrecision(justBelow)).toBe('normal');

      // Just above hysteresis threshold
      const justAbove = normalMax * hysteresis + 1;
      expect(determinePrecision(justAbove)).toBe('symbol-level');
    });
  });
});
