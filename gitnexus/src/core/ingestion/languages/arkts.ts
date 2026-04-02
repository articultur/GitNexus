/**
 * ArkTS language provider.
 *
 * Phase A support aliases ArkTS to the TypeScript extraction stack so `.ets`
 * files can be indexed end-to-end. ArkTS-specific semantic tuning is handled
 * in a later hardening phase.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as typescriptConfig } from '../type-extractors/typescript.js';
import { tsExportChecker } from '../export-detection.js';
import { resolveTypescriptImport } from '../import-resolvers/standard.js';
import { extractTsNamedBindings } from '../named-bindings/typescript.js';
import { ARKTS_QUERIES } from '../tree-sitter-queries.js';
import { typescriptFieldExtractor } from '../field-extractors/typescript.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'console',
  'log',
  'warn',
  'error',
  'info',
  'debug',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'JSON',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Map',
  'Set',
  'Promise',
  'Math',
  'Date',
  'RegExp',
  'Error',
]);

export const arktsProvider = defineLanguage({
  id: SupportedLanguages.ArkTS,
  extensions: ['.ets'],
  treeSitterQueries: ARKTS_QUERIES,
  typeConfig: typescriptConfig,
  exportChecker: tsExportChecker,
  importResolver: resolveTypescriptImport,
  namedBindingExtractor: extractTsNamedBindings,
  fieldExtractor: typescriptFieldExtractor,
  builtInNames: BUILT_INS,
});
