import { describe, it, expect } from 'vitest';
import { preprocessObjcContent } from '../../src/core/ingestion/languages/objc-preprocess.js';

describe('preprocessObjcContent', () => {
  it('strips NS_ASSUME_NONNULL_BEGIN', () => {
    const input = 'NS_ASSUME_NONNULL_BEGIN\n@interface Foo\n@end';
    expect(preprocessObjcContent(input)).not.toContain('NS_ASSUME_NONNULL_BEGIN');
    expect(preprocessObjcContent(input)).toContain('@interface Foo');
  });

  it('strips NS_ASSUME_NONNULL_END', () => {
    const input = '@interface Foo\n@end\nNS_ASSUME_NONNULL_END';
    expect(preprocessObjcContent(input)).not.toContain('NS_ASSUME_NONNULL_END');
    expect(preprocessObjcContent(input)).toContain('@end');
  });

  it('strips both macros from a realistic ObjC header', () => {
    const input = `
NS_ASSUME_NONNULL_BEGIN

@interface MyClass : NSObject
- (void)doSomething;
@end

NS_ASSUME_NONNULL_END
`.trim();
    const result = preprocessObjcContent(input);
    expect(result).not.toContain('NS_ASSUME_NONNULL_BEGIN');
    expect(result).not.toContain('NS_ASSUME_NONNULL_END');
    expect(result).toContain('@interface MyClass');
    expect(result).toContain('- (void)doSomething;');
  });

  it('leaves content unchanged when no macros present', () => {
    const input = '@interface Foo\n- (void)bar;\n@end';
    expect(preprocessObjcContent(input)).toBe(input);
  });

  it('handles multiple occurrences', () => {
    const input =
      'NS_ASSUME_NONNULL_BEGIN @interface A @end NS_ASSUME_NONNULL_END\n' +
      'NS_ASSUME_NONNULL_BEGIN @interface B @end NS_ASSUME_NONNULL_END';
    const result = preprocessObjcContent(input);
    expect(result).not.toContain('NS_ASSUME_NONNULL_BEGIN');
    expect(result).not.toContain('NS_ASSUME_NONNULL_END');
    expect(result).toContain('@interface A');
    expect(result).toContain('@interface B');
  });
});
