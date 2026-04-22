import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';

export const objectiveCProvider = defineLanguage({
  id: SupportedLanguages.ObjectiveC,
  parseStrategy: 'standalone',
  extensions: ['.m', '.mm'],
  treeSitterQueries: '',
  typeConfig: {
    declarationNodeTypes: new Set(),
    extractDeclaration: () => null,
    extractParameter: () => null,
  },
  exportChecker: () => false,
  importResolver: () => null,
});
