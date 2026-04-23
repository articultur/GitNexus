/**
 * Objective-C import resolution config.
 *
 * ObjC uses #import (and #include) which is C-preprocessor level.
 * Standard resolution applies — #import "Foo.h" resolves to the file.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';

export const objcImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.ObjectiveC,
  strategies: [createStandardStrategy(SupportedLanguages.ObjectiveC)],
};
