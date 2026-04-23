/**
 * ArkTS field extraction config.
 *
 * ArkTS uses the TypeScript tree-sitter parser; AST nodes are the same as TS.
 * Reuses the TypeScript field extraction patterns.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { typescriptConfig } from './typescript-javascript.js';

export const arktsFieldConfig: FieldExtractionConfig = {
  ...typescriptConfig,
  language: SupportedLanguages.ArkTS,
};
