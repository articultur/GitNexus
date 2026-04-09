import { describe, it, expect } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { prepareParseContent } from '../../src/core/ingestion/parse-content.js';

describe('prepareParseContent', () => {
  it('returns null for a Vue file without a script block', () => {
    const result = prepareParseContent(
      SupportedLanguages.Vue,
      '<template><div>Hello</div></template>',
    );
    expect(result).toBeNull();
  });

  it('extracts the Vue script block and preserves setup metadata', () => {
    const result = prepareParseContent(
      SupportedLanguages.Vue,
      `<template><div /></template>

<script setup lang="ts">
const count = 1;
</script>
`,
    );
    expect(result).not.toBeNull();
    expect(result?.parseContent).toContain('const count = 1;');
    expect(result?.isVueSetup).toBe(true);
    expect(result?.lineOffset).toBeGreaterThan(0);
  });

  it('applies Objective-C preprocessing', () => {
    const result = prepareParseContent(
      SupportedLanguages.ObjectiveC,
      'NS_ASSUME_NONNULL_BEGIN\n@interface Foo\n@end\nNS_ASSUME_NONNULL_END',
    );
    expect(result?.parseContent).not.toContain('NS_ASSUME_NONNULL');
    expect(result?.parseContent).toContain('@interface Foo');
  });

  it('applies ArkTS preprocessing', () => {
    const result = prepareParseContent(
      SupportedLanguages.ArkTS,
      'struct AppState { count: number }',
    );
    expect(result?.parseContent).toContain('class AppState');
  });

  it('leaves regular files unchanged', () => {
    const content = 'export function main() { return 1; }';
    const result = prepareParseContent(SupportedLanguages.TypeScript, content);
    expect(result).toEqual({ parseContent: content, lineOffset: 0, isVueSetup: false });
  });
});
