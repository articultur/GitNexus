import type { LanguageTypeConfig } from './types.js';
import { typeConfig as cCppTypeConfig } from './c-cpp.js';

/**
 * Objective-C type extractor config.
 * Reuses C/C++ declaration and pending-assignment extraction.
 */
export const typeConfig: LanguageTypeConfig = {
  ...cCppTypeConfig,
};
