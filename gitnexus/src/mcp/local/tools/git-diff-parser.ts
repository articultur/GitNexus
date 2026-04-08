/**
 * Git diff parser — parses git diff -U0 output into structured hunk data.
 *
 * Used by detect_changes and other tools that need line-level change information.
 */

import { execFileSync } from 'node:child_process';

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Represents a parsed git diff for a single file.
 */
export interface DiffHunk {
  filePath: string;
  oldFile?: string; // for renames - original file path
  newFile?: string; // for renames - new file path
  changeType: 'modified' | 'added' | 'deleted' | 'renamed';
  hunks: Array<{
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    lines: Array<{
      type: 'added' | 'removed' | 'context';
      content: string;
      lineNumber: number;
    }>;
  }>;
}

/**
 * Internal hunk type for parsing.
 */
interface InternalHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  lines: Array<{
    type: 'added' | 'removed' | 'context';
    content: string;
    lineNumber: number;
  }>;
}

/**
 * Internal representation during parsing.
 */
interface ParsedFile {
  filePath: string;
  oldFile?: string;
  newFile?: string;
  changeType: 'modified' | 'added' | 'deleted' | 'renamed';
  hunks: InternalHunk[];
  currentHunk: InternalHunk | null;
  // Running counters for line position tracking
  _oldLinePos: number;
  _newLinePos: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse git diff output into structured DiffHunk objects.
 *
 * Supports unified diff format with -U0 (no context lines).
 * Handles:
 * - File headers (diff --git, ---, +++)
 * - Hunk headers (@@ -a,b +c,d @@)
 * - Added (+), removed (-), and context ( ) lines
 * - Binary files, renames, deletions
 *
 * @param diffOutput - The raw output from `git diff`
 * @returns Array of DiffHunk objects, one per changed file
 */
export function parseGitDiff(diffOutput: string): DiffHunk[] {
  if (!diffOutput || !diffOutput.trim()) {
    return [];
  }

  const files: DiffHunk[] = [];
  let current: ParsedFile | null = null;

  const lines = diffOutput.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of a new file diff
    if (line.startsWith('diff --git ')) {
      // Save previous file
      if (current) {
        finalizeHunk(current);
        files.push(current);
      }

      // Parse file paths from "diff --git a/path b/path"
      const match = line.match(/^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/);
      if (match) {
        current = {
          filePath: match[2], // Default to new file path
          changeType: 'modified',
          hunks: [],
          currentHunk: null,
          _oldLinePos: 0,
          _newLinePos: 0,
        };
      }
      continue;
    }

    // Old file path (---)
    if (line.startsWith('--- ')) {
      if (!current) continue;

      const oldPath = line.slice(4).trim();
      if (oldPath === '/dev/null') {
        current.changeType = 'added';
      } else {
        // Strip "a/" prefix if present
        current.oldFile = oldPath.startsWith('a/') ? oldPath.slice(2) : oldPath;
      }
      continue;
    }

    // New file path (+++)
    if (line.startsWith('+++ ')) {
      if (!current) continue;

      const newPath = line.slice(4).trim();
      if (newPath === '/dev/null') {
        current.changeType = 'deleted';
      } else {
        // Strip "b/" prefix if present
        current.newFile = newPath.startsWith('b/') ? newPath.slice(2) : newPath;
        current.filePath = current.newFile;
      }
      continue;
    }

    // Rename detection from git diff -M output
    // "rename from old/path" and "rename to new/path"
    if (line.startsWith('rename from ')) {
      if (current) {
        current.oldFile = line.slice(12).trim();
        current.changeType = 'renamed';
      }
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (current) {
        current.newFile = line.slice(10).trim();
        current.filePath = current.newFile;
        current.changeType = 'renamed';
      }
      continue;
    }

    // Handle binary files
    if (line.startsWith('Binary files ') || line === 'Binary file ') {
      // Binary files don't have hunks, just mark as modified
      if (current) {
        current.changeType = 'modified';
      }
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@ [section]
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (current) {
        finalizeHunk(current);

        const oldStart = parseInt(hunkMatch[1], 10);
        const oldCount = parseInt(hunkMatch[2] || '1', 10);
        const newStart = parseInt(hunkMatch[3], 10);
        const newCount = parseInt(hunkMatch[4] || '1', 10);

        current.currentHunk = {
          oldStart,
          oldEnd: oldCount > 0 ? oldStart + oldCount - 1 : oldStart,
          newStart,
          newEnd: newCount > 0 ? newStart + newCount - 1 : newStart,
          lines: [],
        };
        // Reset running counters for the new hunk
        // oldLinePos tracks position in old file (removed + context lines)
        // newLinePos tracks position in new file (added + context lines)
        current._oldLinePos = 0;
        current._newLinePos = 0;
      }
      continue;
    }

    // Content lines (only process if we have an active hunk)
    if (current?.currentHunk) {
      if (line.startsWith('+')) {
        // Added line: exists in new file only
        current.currentHunk.lines.push({
          type: 'added',
          content: line.slice(1),
          lineNumber: current.currentHunk.newStart + current._newLinePos,
        });
        current._newLinePos++;
      } else if (line.startsWith('-')) {
        // Removed line: exists in old file only
        current.currentHunk.lines.push({
          type: 'removed',
          content: line.slice(1),
          lineNumber: current.currentHunk.oldStart + current._oldLinePos,
        });
        current._oldLinePos++;
      } else if (line.startsWith(' ') || line === '') {
        // Context line: exists in both old and new files
        current.currentHunk.lines.push({
          type: 'context',
          content: line.startsWith(' ') ? line.slice(1) : '',
          lineNumber: current.currentHunk.newStart + current._newLinePos,
        });
        current._oldLinePos++;
        current._newLinePos++;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" - skip these markers
        continue;
      }
    }
  }

  // Don't forget the last file
  if (current) {
    finalizeHunk(current);
    files.push(current);
  }

  return files;
}

/**
 * Execute git diff and return raw output.
 *
 * @param repoPath - Path to the git repository
 * @param scope - What changes to include:
 *   - 'unstaged': Changes in working tree not yet staged
 *   - 'staged': Changes staged for commit
 *   - 'all': All changes (unstaged + staged)
 *   - 'compare': Compare working tree against a base ref
 * @param baseRef - Required when scope is 'compare'. The git ref to compare against.
 * @returns Raw git diff output as string
 */
export async function getGitDiff(
  repoPath: string,
  scope: 'unstaged' | 'staged' | 'all' | 'compare',
  baseRef?: string,
): Promise<string> {
  let args: string[];

  switch (scope) {
    case 'unstaged':
      // Use -U0 for zero context lines to get minimal hunks
      args = ['diff', '-U0'];
      break;
    case 'staged':
      args = ['diff', '-U0', '--staged'];
      break;
    case 'all':
      args = ['diff', '-U0', 'HEAD'];
      break;
    case 'compare':
      if (!baseRef) {
        throw new Error('baseRef is required for "compare" scope');
      }
      args = ['diff', '-U0', baseRef];
      break;
    default:
      throw new Error(`Invalid scope: ${scope}`);
  }

  // Add -M to detect renames
  args.push('-M');

  try {
    const output = execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output;
  } catch (err: any) {
    // Git diff returns exit code 1 when there are differences but also on errors
    // We need to check if it's actually an error or just normal output
    if (err.status === 1 && err.stdout) {
      return err.stdout;
    }
    throw new Error(`Git diff failed: ${err.message}`);
  }
}

/**
 * Execute git diff and return parsed hunks.
 *
 * This is a convenience function that combines getGitDiff and parseGitDiff.
 *
 * @param repoPath - Path to the git repository
 * @param scope - What changes to include (see getGitDiff)
 * @param baseRef - Required when scope is 'compare'
 * @returns Array of DiffHunk objects
 */
export async function getDiffHunks(
  repoPath: string,
  scope: 'unstaged' | 'staged' | 'all' | 'compare',
  baseRef?: string,
): Promise<DiffHunk[]> {
  const diffOutput = await getGitDiff(repoPath, scope, baseRef);
  return parseGitDiff(diffOutput);
}

/**
 * Check if a line range overlaps with a hunk.
 *
 * Useful for determining if a symbol's line range is affected by changes.
 *
 * @param startLine - Start line number (1-indexed, inclusive)
 * @param endLine - End line number (1-indexed, inclusive)
 * @param hunk - The hunk to check against
 * @returns true if the line range overlaps with the hunk's affected lines
 */
export function lineRangeOverlapsHunk(
  startLine: number,
  endLine: number,
  hunk: DiffHunk['hunks'][0],
): boolean {
  // Check overlap with the new file's line range (lines that exist after the change)
  // A range [a, b] overlaps with [c, d] if a <= d && b >= c
  const overlapsNew = startLine <= hunk.newEnd && endLine >= hunk.newStart;

  // For deletions, also check the old line range
  // This helps catch cases where lines were deleted within the symbol
  const overlapsOld = startLine <= hunk.oldEnd && endLine >= hunk.oldStart;

  // Also check if any added/removed lines fall within the range
  const hasLineInRange = hunk.lines.some((line) => {
    if (line.type === 'context') return false;
    return line.lineNumber >= startLine && line.lineNumber <= endLine;
  });

  return overlapsNew || overlapsOld || hasLineInRange;
}

/**
 * Get a summary of changes for files affected by a diff.
 *
 * @param hunks - Array of DiffHunk objects
 * @returns Summary of changes per file
 */
export function summarizeDiffHunks(hunks: DiffHunk[]): Array<{
  filePath: string;
  changeType: DiffHunk['changeType'];
  addedLines: number;
  removedLines: number;
  hunkCount: number;
}> {
  return hunks.map((hunk) => ({
    filePath: hunk.filePath,
    changeType: hunk.changeType,
    addedLines: hunk.hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === 'added').length,
      0,
    ),
    removedLines: hunk.hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === 'removed').length,
      0,
    ),
    hunkCount: hunk.hunks.length,
  }));
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Finalize the current hunk in a parsed file.
 */
function finalizeHunk(file: ParsedFile): void {
  if (file.currentHunk) {
    file.hunks.push(file.currentHunk);
    file.currentHunk = null;
  }
}

/**
 * Get the list of changed file paths from a diff.
 *
 * @param hunks - Array of DiffHunk objects
 * @returns Array of unique file paths that were changed
 */
export function getChangedFiles(hunks: DiffHunk[]): string[] {
  return Array.from(new Set(hunks.map((h) => h.filePath)));
}

/**
 * Get lines changed for a specific file.
 *
 * @param hunks - Array of DiffHunk objects
 * @param filePath - The file path to filter by
 * @returns Array of line numbers that were added or removed, sorted
 */
export function getChangedLines(hunks: DiffHunk[], filePath: string): number[] {
  const fileHunk = hunks.find((h) => h.filePath === filePath);
  if (!fileHunk) return [];

  const lines = new Set<number>();
  for (const hunk of fileHunk.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'added' || line.type === 'removed') {
        lines.add(line.lineNumber);
      }
    }
  }

  return Array.from(lines).sort((a, b) => a - b);
}
