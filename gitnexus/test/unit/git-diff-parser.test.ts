/**
 * Unit tests for git-diff-parser module.
 */

import { describe, it, expect } from 'vitest';
import {
  parseGitDiff,
  lineRangeOverlapsHunk,
  type DiffHunk,
} from '../../src/mcp/local/tools/git-diff-parser.js';

describe('parseGitDiff', () => {
  describe('empty input', () => {
    it('returns empty array for empty string', () => {
      expect(parseGitDiff('')).toEqual([]);
    });

    it('returns empty array for whitespace only', () => {
      expect(parseGitDiff('   \n  ')).toEqual([]);
    });
  });

  describe('file header parsing', () => {
    it('parses simple file modification', () => {
      const diff = `diff --git a/src/file.ts b/src/file.ts
index 1234567..abcdefg 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -10,5 +10,6 @@ function test() {
 const x = 1;
+const y = 2;
 return x;
}`;
      const result = parseGitDiff(diff);

      expect(result.length).toBe(1);
      expect(result[0].filePath).toBe('src/file.ts');
      expect(result[0].changeType).toBe('modified');
    });

    it('parses file addition', () => {
      const diff = `diff --git a/new-file.ts b/new-file.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,5 @@
+function newFunc() {
+  return true;
+}`;
      const result = parseGitDiff(diff);

      expect(result.length).toBe(1);
      expect(result[0].filePath).toBe('new-file.ts');
      expect(result[0].changeType).toBe('added');
    });

    it('parses file deletion', () => {
      const diff = `diff --git a/old-file.ts b/old-file.ts
deleted file mode 100644
index 1234567..0000000
--- a/old-file.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-function oldFunc() {
-  return false;
-}`;
      const result = parseGitDiff(diff);

      expect(result.length).toBe(1);
      expect(result[0].filePath).toBe('old-file.ts');
      expect(result[0].changeType).toBe('deleted');
    });

    it('parses file rename', () => {
      const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 100%
rename from old-name.ts
rename to new-name.ts`;
      const result = parseGitDiff(diff);

      expect(result.length).toBe(1);
      expect(result[0].changeType).toBe('renamed');
      expect(result[0].oldFile).toBe('old-name.ts');
      expect(result[0].newFile).toBe('new-name.ts');
    });
  });

  describe('hunk parsing', () => {
    it('parses single hunk with added lines', () => {
      const diff = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -5,3 +5,4 @@ function test() {
   const a = 1;
   const b = 2;
+  const c = 3;
 }`;
      const result = parseGitDiff(diff);

      expect(result[0].hunks.length).toBe(1);
      expect(result[0].hunks[0].oldStart).toBe(5);
      expect(result[0].hunks[0].newStart).toBe(5);
    });

    it('parses single hunk with removed lines', () => {
      const diff = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -10,4 +10,3 @@ function test() {
   const a = 1;
-  const b = 2;
   const c = 3;
 }`;
      const result = parseGitDiff(diff);

      expect(result[0].hunks.length).toBe(1);
      const hunk = result[0].hunks[0];
      const removedLines = hunk.lines.filter((l) => l.type === 'removed');
      expect(removedLines.length).toBe(1);
    });

    it('parses multiple hunks', () => {
      const diff = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -10,3 +10,4 @@ function test() {
   const a = 1;
+  const b = 2;
 }
@@ -50,3 +51,4 @@ function other() {
   const x = 1;
+  const y = 2;
 }`;
      const result = parseGitDiff(diff);

      expect(result[0].hunks.length).toBe(2);
      expect(result[0].hunks[0].oldStart).toBe(10);
      expect(result[0].hunks[1].oldStart).toBe(50);
    });

    it('parses hunk header with line counts', () => {
      const diff = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -10,5 +10,8 @@ function test() {`;
      const result = parseGitDiff(diff);

      expect(result[0].hunks[0].oldStart).toBe(10);
      expect(result[0].hunks[0].oldEnd).toBe(14); // start + count - 1
      expect(result[0].hunks[0].newStart).toBe(10);
      expect(result[0].hunks[0].newEnd).toBe(17);
    });
  });

  describe('line tracking', () => {
    it('tracks line types correctly', () => {
      const diff = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,5 +1,6 @@
 line1
-line2
+line2modified
+line3
 line4
 line5`;
      const result = parseGitDiff(diff);

      const hunk = result[0].hunks[0];
      const addedLines = hunk.lines.filter((l) => l.type === 'added');
      const removedLines = hunk.lines.filter((l) => l.type === 'removed');

      expect(addedLines.length).toBe(2);
      expect(removedLines.length).toBe(1);
    });
  });

  describe('multiple files', () => {
    it('parses multiple file diffs', () => {
      const diff = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,3 +1,4 @@
 a
+b
 c
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -10,3 +10,4 @@
 x
+y
 z`;
      const result = parseGitDiff(diff);

      expect(result.length).toBe(2);
      expect(result[0].filePath).toBe('file1.ts');
      expect(result[1].filePath).toBe('file2.ts');
    });
  });

  describe('edge cases', () => {
    it('handles binary files', () => {
      const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`;
      const result = parseGitDiff(diff);

      expect(result.length).toBe(1);
      expect(result[0].filePath).toBe('image.png');
      expect(result[0].hunks.length).toBe(0);
    });

    it('handles paths with spaces', () => {
      const diff = `diff --git "a/src/my file.ts" "b/src/my file.ts"
--- "a/src/my file.ts"
+++ "b/src/my file.ts"
@@ -1,1 +1,2 @@
 test
+more`;
      const result = parseGitDiff(diff);

      expect(result.length).toBe(1);
      expect(result[0].filePath).toContain('my file.ts');
    });

    it('handles Windows paths', () => {
      const diff = `diff --git a/src\\file.ts b/src\\file.ts
--- a/src\\file.ts
+++ b/src\\file.ts
@@ -1,1 +1,2 @@
 test
+more`;
      const result = parseGitDiff(diff);

      expect(result.length).toBe(1);
    });
  });
});

describe('lineRangeOverlapsHunk', () => {
  it('returns true when range is inside hunk', () => {
    const hunk: DiffHunk['hunks'][0] = {
      oldStart: 10,
      oldEnd: 20,
      newStart: 10,
      newEnd: 20,
      lines: [],
    };

    expect(lineRangeOverlapsHunk(15, 18, hunk)).toBe(true);
  });

  it('returns true when range starts inside hunk', () => {
    const hunk: DiffHunk['hunks'][0] = {
      oldStart: 10,
      oldEnd: 20,
      newStart: 10,
      newEnd: 20,
      lines: [],
    };

    expect(lineRangeOverlapsHunk(15, 25, hunk)).toBe(true);
  });

  it('returns true when range ends inside hunk', () => {
    const hunk: DiffHunk['hunks'][0] = {
      oldStart: 10,
      oldEnd: 20,
      newStart: 10,
      newEnd: 20,
      lines: [],
    };

    expect(lineRangeOverlapsHunk(5, 15, hunk)).toBe(true);
  });

  it('returns true when range completely contains hunk', () => {
    const hunk: DiffHunk['hunks'][0] = {
      oldStart: 10,
      oldEnd: 20,
      newStart: 10,
      newEnd: 20,
      lines: [],
    };

    expect(lineRangeOverlapsHunk(5, 25, hunk)).toBe(true);
  });

  it('returns false when range is before hunk', () => {
    const hunk: DiffHunk['hunks'][0] = {
      oldStart: 10,
      oldEnd: 20,
      newStart: 10,
      newEnd: 20,
      lines: [],
    };

    expect(lineRangeOverlapsHunk(1, 5, hunk)).toBe(false);
  });

  it('returns false when range is after hunk', () => {
    const hunk: DiffHunk['hunks'][0] = {
      oldStart: 10,
      oldEnd: 20,
      newStart: 10,
      newEnd: 20,
      lines: [],
    };

    expect(lineRangeOverlapsHunk(25, 30, hunk)).toBe(false);
  });

  it('handles single line ranges', () => {
    const hunk: DiffHunk['hunks'][0] = {
      oldStart: 10,
      oldEnd: 20,
      newStart: 10,
      newEnd: 20,
      lines: [],
    };

    expect(lineRangeOverlapsHunk(15, 15, hunk)).toBe(true);
    expect(lineRangeOverlapsHunk(5, 5, hunk)).toBe(false);
  });

  it('handles hunk with single line', () => {
    const hunk: DiffHunk['hunks'][0] = {
      oldStart: 10,
      oldEnd: 10,
      newStart: 10,
      newEnd: 10,
      lines: [],
    };

    expect(lineRangeOverlapsHunk(10, 10, hunk)).toBe(true);
    expect(lineRangeOverlapsHunk(9, 11, hunk)).toBe(true);
  });
});
