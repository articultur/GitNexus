/**
 * Taint Analysis Configuration Registry.
 *
 * Re-exports taint configurations from the main taint.ts module.
 * Provides a centralized access point for language-specific taint configs.
 */

// Re-export from main taint module
export {
  TAINT_CONFIGS,
  type TaintConfig,
  type TaintPattern,
  type TaintAnnotation,
  type TaintResult,
} from '../../type-extractors/taint.js';

/**
 * Language tiers for taint analysis accuracy.
 */
export const LANGUAGE_TIERS = {
  /** Full support: TypeScript, JavaScript, Python, Java, C#, Go, Rust, C, C++ */
  FULL: new Set([
    'typescript', 'javascript', 'python', 'java', 'csharp',
    'go', 'rust', 'c', 'cpp',
  ]),
  /** Limited support: Swift, Dart, Ruby, PHP (dynamic features limit precision) */
  LIMITED: new Set(['swift', 'dart', 'ruby', 'php']),
  /** Basic support: Objective-C, COBOL (legacy, limited patterns) */
  BASIC: new Set(['objectivec', 'cobol']),
} as const;

/**
 * Check if a language has full taint analysis support.
 */
export function isFullSupport(language: string): boolean {
  return LANGUAGE_TIERS.FULL.has(language.toLowerCase());
}

/**
 * Check if a language has limited taint analysis support.
 */
export function isLimitedSupport(language: string): boolean {
  return LANGUAGE_TIERS.LIMITED.has(language.toLowerCase());
}

/**
 * Check if a language is supported at all.
 */
export function isSupported(language: string): boolean {
  const lang = language.toLowerCase();
  return LANGUAGE_TIERS.FULL.has(lang) ||
         LANGUAGE_TIERS.LIMITED.has(lang) ||
         LANGUAGE_TIERS.BASIC.has(lang);
}
