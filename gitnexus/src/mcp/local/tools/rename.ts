/**
 * Rename tool — multi-file coordinated rename using graph + text search.
 */

import fs from 'fs/promises';
import path from 'path';
import { logQueryError } from './shared.js';
import type { RepoHandle } from './shared.js';
import { contextTool } from './context.js';
import { isGitRepo } from '../../../storage/git.js';

/**
 * Rename tool — multi-file coordinated rename using graph + text search.
 * Graph refs are tagged "graph" (high confidence).
 * Additional refs found via text search are tagged "text_search" (lower confidence).
 */
export async function renameTool(
  repo: RepoHandle,
  params: {
    symbol_name?: string;
    symbol_uid?: string;
    new_name: string;
    file_path?: string;
    dry_run?: boolean;
  },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);

  const { new_name, file_path } = params;
  const dry_run = params.dry_run ?? true;

  if (!params.symbol_name && !params.symbol_uid) {
    return { error: 'Either symbol_name or symbol_uid is required.' };
  }

  /** Guard: ensure a file path resolves within the repo root (prevents path traversal) */
  const assertSafePath = (filePath: string): string => {
    const full = path.resolve(repo.repoPath, filePath);
    if (!full.startsWith(repo.repoPath + path.sep) && full !== repo.repoPath) {
      throw new Error(`Path traversal blocked: ${filePath}`);
    }
    return full;
  };

  // Step 1: Find the target symbol (reuse context's lookup)
  const lookupResult = await contextTool(
    repo,
    {
      name: params.symbol_name,
      uid: params.symbol_uid,
      file_path,
    },
    ensureInitialized,
  );

  if (lookupResult.status === 'ambiguous') {
    return lookupResult; // pass disambiguation through
  }
  if (lookupResult.error) {
    return lookupResult;
  }

  const sym = lookupResult.symbol;
  const oldName = sym.name;

  if (oldName === new_name) {
    return { error: 'New name is the same as the current name.' };
  }

  // Step 2: Collect edits from graph (high confidence)
  const changes = new Map<string, { file_path: string; edits: any[] }>();

  const addEdit = (
    filePath: string,
    line: number,
    oldText: string,
    newText: string,
    confidence: string,
  ) => {
    if (!changes.has(filePath)) {
      changes.set(filePath, { file_path: filePath, edits: [] });
    }
    changes.get(filePath)!.edits.push({ line, old_text: oldText, new_text: newText, confidence });
  };

  // The definition itself
  if (sym.filePath && sym.startLine) {
    try {
      const content = await fs.readFile(assertSafePath(sym.filePath), 'utf-8');
      const lines = content.split('\n');
      const lineIdx = sym.startLine - 1;
      if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].includes(oldName)) {
        const defRegex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        addEdit(
          sym.filePath,
          sym.startLine,
          lines[lineIdx].trim(),
          lines[lineIdx].replace(defRegex, new_name).trim(),
          'graph',
        );
      }
    } catch (e) {
      logQueryError('rename:read-definition', e);
    }
  }

  // All incoming refs from graph (callers, importers, etc.)
  const allIncoming = [
    ...(lookupResult.incoming.calls || []),
    ...(lookupResult.incoming.imports || []),
    ...(lookupResult.incoming.extends || []),
    ...(lookupResult.incoming.implements || []),
  ];

  let graphEdits = changes.size > 0 ? 1 : 0; // count definition edit

  for (const ref of allIncoming) {
    if (!ref.filePath) continue;
    try {
      const content = await fs.readFile(assertSafePath(ref.filePath), 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(oldName)) {
          addEdit(
            ref.filePath,
            i + 1,
            lines[i].trim(),
            lines[i]
              .replace(
                new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
                new_name,
              )
              .trim(),
            'graph',
          );
          graphEdits++;
          break; // one edit per file from graph refs
        }
      }
    } catch (e) {
      logQueryError('rename:read-ref', e);
    }
  }

  // Step 3: Text search for refs the graph might have missed
  let astSearchEdits = 0;
  const graphFiles = new Set(
    [sym.filePath, ...allIncoming.map((r: any) => r.filePath)].filter(Boolean),
  );

  // Simple text search across the repo for the old name (in files not already covered by graph)
  let textSearchSkipped = false;
  try {
    // If the repo path is not a local directory (e.g. remotely-pulled index), skip text search.
    await fs.access(repo.repoPath);
  } catch {
    textSearchSkipped = true;
  }

  if (!textSearchSkipped) {
    try {
      const { execFileSync } = await import('child_process');
      const rgArgs = [
        '-l',
        '--type-add',
        'code:*.{ts,tsx,js,jsx,py,go,rs,java,c,h,cpp,cc,cxx,hpp,hxx,hh,cs,php,swift}',
        '-t',
        'code',
        `\\b${oldName}\\b`,
        '.',
      ];
      const output = execFileSync('rg', rgArgs, {
        cwd: repo.repoPath,
        encoding: 'utf-8',
        timeout: 5000,
      });
      const files = output
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);

      for (const file of files) {
        const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
        if (graphFiles.has(normalizedFile)) continue; // already covered by graph

        try {
          const content = await fs.readFile(assertSafePath(normalizedFile), 'utf-8');
          const lines = content.split('\n');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              regex.lastIndex = 0;
              addEdit(
                normalizedFile,
                i + 1,
                lines[i].trim(),
                lines[i].replace(regex, new_name).trim(),
                'text_search',
              );
              astSearchEdits++;
            }
          }
        } catch (e) {
          logQueryError('rename:text-search-read', e);
        }
      }
    } catch (e) {
      logQueryError('rename:ripgrep', e);
    }
  } // end if (!textSearchSkipped)

  // Step 4: Apply or preview
  const allChanges = Array.from(changes.values());
  const totalEdits = allChanges.reduce((sum, c) => sum + c.edits.length, 0);

  if (!dry_run) {
    // Guard: cannot apply file edits without local source access.
    let sourceAccessible = true;
    try {
      await fs.access(repo.repoPath);
    } catch {
      sourceAccessible = false;
    }
    if (!sourceAccessible || !isGitRepo(repo.repoPath)) {
      return {
        error:
          'rename with dry_run=false requires local source files. ' +
          'This index was pulled from a remote and has no local source tree. ' +
          'Use dry_run=true to preview graph-based edits, then apply them manually.',
      };
    }
    // Apply edits to files
    for (const change of allChanges) {
      try {
        const fullPath = assertSafePath(change.file_path);
        let content = await fs.readFile(fullPath, 'utf-8');
        const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        content = content.replace(regex, new_name);
        await fs.writeFile(fullPath, content, 'utf-8');
      } catch (e) {
        logQueryError('rename:apply-edit', e);
      }
    }
  }

  return {
    status: 'success',
    old_name: oldName,
    new_name,
    files_affected: allChanges.length,
    total_edits: totalEdits,
    graph_edits: graphEdits,
    text_search_edits: astSearchEdits,
    ...(textSearchSkipped
      ? {
          text_search_note:
            'text_search skipped: source files not accessible (remote-pulled index). Graph-based edits are complete.',
        }
      : {}),
    changes: allChanges,
    applied: !dry_run,
  };
}
