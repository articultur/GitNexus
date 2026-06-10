/**
 * ArkTS `ScopeResolver` registered in `SCOPE_RESOLVERS`.
 *
 * ArkTS uses the TypeScript grammar after preprocessing (`struct` -> `class`),
 * so the resolver deliberately mirrors TypeScript's scope hooks while routing
 * import resolution through the ArkTS language id.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { arktsProvider } from '../arkts.js';
import { loadTsconfigPaths, type TsconfigPaths } from '../../language-config.js';
import { buildSuffixIndex, type SuffixIndex } from '../../import-resolvers/utils.js';
import {
  typescriptArityCompatibility,
  typescriptMergeBindings,
  resolveTsTarget,
  type TsResolveContext,
} from '../typescript/index.js';

interface ArktsResolutionConfig {
  readonly tsconfigPaths: TsconfigPaths | null;
}

function makeArktsResolveImportTarget(): ScopeResolver['resolveImportTarget'] {
  interface PassCache {
    readonly key: ReadonlySet<string>;
    readonly allFilePaths: Set<string>;
    readonly allFileList: readonly string[];
    readonly normalizedFileList: readonly string[];
    readonly suffixIndex: SuffixIndex;
    readonly resolveCache: Map<string, string | null>;
  }
  let cached: PassCache | null = null;

  return (targetRaw, fromFile, allFilePaths, resolutionConfig) => {
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

    const cfg = resolutionConfig as ArktsResolutionConfig | undefined;
    const ws: TsResolveContext = {
      fromFile,
      allFilePaths: cached.allFilePaths,
      allFileList: cached.allFileList,
      normalizedFileList: cached.normalizedFileList,
      index: cached.suffixIndex,
      resolveCache: cached.resolveCache,
      tsconfigPaths: cfg?.tsconfigPaths ?? null,
      language: SupportedLanguages.TypeScript,
    };
    return resolveTsTarget(targetRaw, ws);
  };
}

const arktsScopeResolver: ScopeResolver = {
  language: SupportedLanguages.ArkTS,
  languageProvider: arktsProvider,
  importEdgeReason: 'arkts-scope: import',

  resolveImportTarget: makeArktsResolveImportTarget(),

  loadResolutionConfig: async (repoPath: string) => ({
    tsconfigPaths: await loadTsconfigPaths(repoPath),
  }),

  mergeBindings: (existing, incoming) => [...typescriptMergeBindings([...existing, ...incoming])],

  arityCompatibility: (callsite, def) => typescriptArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => /^super(\s*\(|\s*\.|\s*\[|\s*$)/.test(text.trim()),

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,
  hoistTypeBindingsToModule: true,
};

export { arktsScopeResolver };
