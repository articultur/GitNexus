/**
 * ArkTS import resolution config.
 *
 * ArkTS uses TypeScript-like import syntax with ESM style.
 * Standard resolution applies — same as TypeScript.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';

export const arktsImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.ArkTS,
  strategies: [createStandardStrategy(SupportedLanguages.ArkTS)],
};
