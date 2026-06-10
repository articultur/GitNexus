/**
 * Objective-C `ScopeResolver` registered in `SCOPE_RESOLVERS`.
 *
 * This is intentionally conservative: Objective-C imports resolve like
 * C-family includes, class/interface ownership uses the shared owner pass, and
 * `self`/`super` receiver dispatch stays scoped to the enclosing class.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { objectiveCProvider } from '../objective-c.js';
import { resolveImportPath } from '../../import-resolvers/standard.js';
import { buildSuffixIndex, type SuffixIndex } from '../../import-resolvers/utils.js';
import { cArityCompatibility } from '../c/arity.js';
import { cMergeBindings } from '../c/merge-bindings.js';
import { scanHeaderFiles } from '../c/header-scan.js';

function makeObjcResolveImportTarget(): ScopeResolver['resolveImportTarget'] {
  interface PassCache {
    readonly key: ReadonlySet<string>;
    readonly allFilePaths: Set<string>;
    readonly allFileList: readonly string[];
    readonly normalizedFileList: readonly string[];
    readonly suffixIndex: SuffixIndex;
    readonly resolveCache: Map<string, string | null>;
  }
  let cached: PassCache | null = null;

  return (targetRaw, fromFile, allFilePaths) => {
    if (cached === null || cached.key !== allFilePaths) {
      const allFileList = Array.from(allFilePaths);
      const normalizedFileList = allFileList.map((f) => f.toLowerCase());
      cached = {
        key: allFilePaths,
        allFilePaths: new Set(allFilePaths),
        allFileList,
        normalizedFileList,
        suffixIndex: buildSuffixIndex(normalizedFileList, allFileList),
        resolveCache: new Map(),
      };
    }

    return resolveImportPath(
      fromFile,
      targetRaw,
      cached.allFilePaths,
      cached.allFileList as string[],
      cached.normalizedFileList as string[],
      cached.resolveCache,
      SupportedLanguages.ObjectiveC,
      null,
      cached.suffixIndex,
    );
  };
}

const objectiveCScopeResolver: ScopeResolver = {
  language: SupportedLanguages.ObjectiveC,
  languageProvider: objectiveCProvider,
  importEdgeReason: 'objc-scope: import',

  loadResolutionConfig: (repoPath: string) => scanHeaderFiles(repoPath),

  resolveImportTarget: makeObjcResolveImportTarget(),

  mergeBindings: (existing, incoming, scopeId) => cMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, def) => cArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => text.trim() === 'super',

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,
  allowGlobalFreeCallFallback: true,
  resolveThisViaEnclosingClass: true,

  emitPostResolutionEdges(graph, parsedFiles, _nodeLookup, _indexes, ctx) {
    const headers = ctx.resolutionConfig as ReadonlySet<string> | undefined;
    const allFilePaths = new Set(parsedFiles.map((f) => f.filePath));
    if (headers !== undefined) {
      for (const header of headers) allFilePaths.add(header);
    }

    for (const parsedFile of parsedFiles) {
      const content = ctx.fileContents.get(parsedFile.filePath);
      if (content === undefined) continue;
      const sourceFileId = generateId('File', parsedFile.filePath);
      if (!graph.getNode(sourceFileId)) continue;

      for (const targetRaw of extractLocalObjcImports(content)) {
        const resolved = objectiveCScopeResolver.resolveImportTarget(
          targetRaw,
          parsedFile.filePath,
          allFilePaths,
          ctx.resolutionConfig,
        );
        if (typeof resolved !== 'string') continue;

        const targetFileId = generateId('File', resolved);
        if (!graph.getNode(targetFileId)) continue;

        graph.addRelationship({
          id: generateId('IMPORTS', `${sourceFileId}->${targetFileId}:objc-post:${targetRaw}`),
          sourceId: sourceFileId,
          targetId: targetFileId,
          type: 'IMPORTS',
          confidence: 1.0,
          reason: 'objc-scope: import',
        });
      }
    }
  },
};

export { objectiveCScopeResolver };

function extractLocalObjcImports(content: string): string[] {
  const out: string[] = [];
  const importRe = /^\s*#\s*import\s+"([^"]+)"/gm;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(content)) !== null) {
    out.push(match[1]);
  }
  return out;
}
