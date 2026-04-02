/**
 * ArkTS source normalization helpers.
 *
 * Phase A compatibility uses TypeScript grammar to parse `.ets` files.
 * ArkTS `struct` declarations are not valid TypeScript, so we normalize them
 * to `class` for parsing only. This does not mutate source files.
 */

/**
 * Normalize ArkTS-only syntax into TypeScript-compatible syntax.
 *
 * Current transforms:
 * - `struct Name` -> `class Name`
 */
export const preprocessArktsContent = (content: string): string => {
  return content.replace(/\bstruct\s+([A-Za-z_$][\w$]*)\b/g, 'class $1');
};
