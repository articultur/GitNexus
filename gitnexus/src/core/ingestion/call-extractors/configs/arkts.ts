/**
 * ArkTS call extraction config.
 *
 * ArkTS uses the TypeScript tree-sitter parser; AST nodes are the same as TS.
 * Minimal config — the generic path handles call_expression natively.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { CallExtractionConfig } from '../../call-types.js';

export const arktsCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.ArkTS,
};
