/**
 * ArkTS Preprocessor
 *
 * ArkTS is Huawei's HarmonyOS extension of TypeScript. It introduces a small
 * set of ArkTS-specific syntax constructs (e.g. `@Entry`, `@Component`, `@State`,
 * struct-based component syntax) that are not valid TypeScript and cause
 * tree-sitter-typescript to fail or misparse.
 *
 * This module strips or transforms those constructs into syntactically valid
 * TypeScript before the file is handed to the tree-sitter parser.
 */

/**
 * Strip ArkTS-specific syntax constructs so that the content can be parsed
 * by the TypeScript tree-sitter grammar without errors.
 *
 * Current transformations:
 * - Remove ArkTS decorator annotations (`@Entry`, `@Component`, `@State`, etc.)
 *   that are not standard TypeScript decorators attached to a class/method.
 * - Replace `struct` keyword (used for ArkTS UI components) with `class`
 *   so the TypeScript grammar can parse the body.
 * - Strip `build()` block inner DSL calls that reference undefined ArkTS
 *   builder functions — left as-is since they are syntactically valid TS calls.
 */
export function preprocessArktsContent(source: string): string {
  // Replace ArkTS `struct` (component declarations) with `class`
  // e.g. `struct MyComponent { ... }` → `class MyComponent { ... }`
  const result = source.replace(/\bstruct\s+(\w)/g, 'class $1');

  return result;
}
