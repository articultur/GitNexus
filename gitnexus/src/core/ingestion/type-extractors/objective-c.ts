import type { LanguageTypeConfig } from './types.js';
import { typeConfig as cCppTypeConfig } from './c-cpp.js';
import { objcTaintConfig } from './taint.js';

/**
 * Objective-C type extractor config.
 * Reuses C/C++ declaration and pending-assignment extraction while overriding
 * taint patterns with Objective-C-specific source/sink selector rules.
 */
export const typeConfig: LanguageTypeConfig = {
  ...cCppTypeConfig,
  taintConfig: objcTaintConfig,
};
