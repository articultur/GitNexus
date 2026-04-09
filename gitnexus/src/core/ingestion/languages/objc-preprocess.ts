/**
 * Objective-C source normalization helpers.
 *
 * Strips Apple nullability annotation macros that confuse tree-sitter-objc.
 * These macros wrap OC headers but are not valid preprocessor directives in the grammar.
 * We remove the tokens only, not the content between them (unlike #if/#endif pairs).
 */

/**
 * Strip NS_ASSUME_NONNULL_BEGIN / NS_ASSUME_NONNULL_END macros from ObjC source.
 * These are not actual preprocessor directives and break tree-sitter-objc parsing.
 */
export const preprocessObjcContent = (content: string): string => {
  return content
    .replace(/\bNS_ASSUME_NONNULL_BEGIN\b/g, '')
    .replace(/\bNS_ASSUME_NONNULL_END\b/g, '');
};
