import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';

export const arktsProvider = defineLanguage({
  id: SupportedLanguages.ArkTS,
  parseStrategy: 'standalone',
  extensions: ['.ets', '.arkts'],
  treeSitterQueries: '',
  typeConfig: {
    declarationNodeTypes: new Set(),
    extractDeclaration: () => null,
    extractParameter: () => null,
  },
  exportChecker: () => false,
  importResolver: () => null,
});
