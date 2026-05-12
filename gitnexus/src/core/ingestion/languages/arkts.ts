import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as typescriptConfig } from '../type-extractors/typescript.js';
import { tsExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { arktsImportConfig } from '../import-resolvers/configs/arkts.js';
import { extractTsNamedBindings } from '../named-bindings/typescript.js';
import { ARKTS_QUERIES } from '../tree-sitter-queries.js';
import { preprocessArktsContent } from './arkts-preprocess.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { arktsCallConfig } from '../call-extractors/configs/arkts.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { arktsFieldConfig } from '../field-extractors/configs/arkts.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { arktsMethodConfig } from '../method-extractors/configs/arkts.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';

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
  preprocessSource: preprocessArktsContent,
  typeConfig: typescriptConfig,
  exportChecker: tsExportChecker,
  importResolver: createImportResolver(arktsImportConfig),
  namedBindingExtractor: extractTsNamedBindings,
  callExtractor: createCallExtractor(arktsCallConfig),
  fieldExtractor: createFieldExtractor(arktsFieldConfig),
  methodExtractor: createMethodExtractor(arktsMethodConfig),
  heritageExtractor: createHeritageExtractor(SupportedLanguages.ArkTS),
  builtInNames: BUILT_INS,
});
