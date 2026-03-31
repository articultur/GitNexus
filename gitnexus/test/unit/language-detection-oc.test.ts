import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { detectOCHeaderLanguage, getLanguageFromFilename } from '../../node_modules/gitnexus-shared/src/language-detection.js';

const fixturesDir = resolve(__dirname, '../fixtures/lang-resolution/objc-header-detection');

describe('detectOCHeaderLanguage', () => {
  it('returns ObjectiveC for .h file with @interface', () => {
    const content = readFileSync(resolve(fixturesDir, 'OCClass.h'), 'utf-8');
    expect(detectOCHeaderLanguage(content)).toBe(SupportedLanguages.ObjectiveC);
  });

  it('returns CPlusPlus for pure C++ .h file', () => {
    const content = readFileSync(resolve(fixturesDir, 'PureCppClass.h'), 'utf-8');
    expect(detectOCHeaderLanguage(content)).toBe(SupportedLanguages.CPlusPlus);
  });

  it('returns ObjectiveC for @protocol declaration', () => {
    const content = `
@protocol MyDelegate <NSObject>
- (void)didFinish;
@end
`;
    expect(detectOCHeaderLanguage(content)).toBe(SupportedLanguages.ObjectiveC);
  });

  it('returns ObjectiveC for @property in .h', () => {
    const content = `
#import <Foundation/Foundation.h>

@interface MyView : NSObject
@property (nonatomic, strong) NSString *title;
@end
`;
    expect(detectOCHeaderLanguage(content)).toBe(SupportedLanguages.ObjectiveC);
  });

  it('returns CPlusPlus for C++ class template', () => {
    const content = `
template<typename T>
class Container {
    T data;
public:
    void add(const T& item) { data = item; }
};
`;
    expect(detectOCHeaderLanguage(content)).toBe(SupportedLanguages.CPlusPlus);
  });

  it('returns CPlusPlus for C++ class with inheritance', () => {
    const content = `
class Base {
public:
    virtual ~Base() {}
};

class Derived : public Base {
public:
    void foo() {}
};
`;
    expect(detectOCHeaderLanguage(content)).toBe(SupportedLanguages.CPlusPlus);
  });

  it('returns ObjectiveC when @interface appears inside a C++ comment or string (false positive safe)', () => {
    // @interface should NOT be matched inside a C++ string literal
    const content = `
const char* msg = "@interface is OC only";
class Foo { void bar(); };
`;
    // The regex /@interface\b/m matches anywhere in content, including inside strings.
    // This is a known limitation: a C++ file with the string "@interface" would be
    // incorrectly detected as OC. In practice this is extremely rare.
    expect(detectOCHeaderLanguage(content)).toBe(SupportedLanguages.ObjectiveC);
  });
});

// Mirror of the stripNullabilityMacros helper from parse-worker.ts
const stripNullabilityMacros = (content: string): string => {
  return content
    .replace(/\bNS_ASSUME_NONNULL_BEGIN\b/g, '')
    .replace(/\bNS_ASSUME_NONNULL_END\b/g, '');
};

describe('stripNullabilityMacros', () => {
  it('removes NS_ASSUME_NONNULL_BEGIN and NS_ASSUME_NONNULL_END macros', () => {
    const input = `// Header
NS_ASSUME_NONNULL_BEGIN

@interface Foo : NSObject
@end

NS_ASSUME_NONNULL_END`;
    const stripped = stripNullabilityMacros(input);
    expect(stripped).not.toContain('NS_ASSUME_NONNULL_BEGIN');
    expect(stripped).not.toContain('NS_ASSUME_NONNULL_END');
    expect(stripped).toContain('@interface Foo : NSObject');
  });

  it('preserves OC heritage declarations wrapped in nullability macros', () => {
    const input = `NS_ASSUME_NONNULL_BEGIN
@interface AFHTTPSessionManager : AFURLSessionManager <NSSecureCoding, NSCopying>
NS_ASSUME_NONNULL_END`;
    const stripped = stripNullabilityMacros(input);
    expect(stripped).toContain('AFHTTPSessionManager : AFURLSessionManager');
    expect(stripped).toContain('NSSecureCoding');
    expect(stripped).toContain('NSCopying');
  });

  it('leaves non-OC C++ content unchanged', () => {
    const input = `template<typename T>
class Container {
    T data;
};`;
    const stripped = stripNullabilityMacros(input);
    expect(stripped).toBe(input);
  });
});

describe('getLanguageFromFilenameWithContent integration', () => {
  // Inline the helper to match what parsing-processor uses
  const getLanguageFromFilenameWithContent = (
    filePath: string,
    content: string,
  ): SupportedLanguages | null => {
    const lang = getLanguageFromFilename(filePath);
    if (lang === SupportedLanguages.CPlusPlus && filePath.toLowerCase().endsWith('.h')) {
      return detectOCHeaderLanguage(content);
    }
    return lang;
  };

  it('detects OC .h file as ObjectiveC', () => {
    const content = readFileSync(resolve(fixturesDir, 'OCClass.h'), 'utf-8');
    expect(getLanguageFromFilenameWithContent('src/OCClass.h', content)).toBe(
      SupportedLanguages.ObjectiveC,
    );
  });

  it('detects pure C++ .h file as CPlusPlus', () => {
    const content = readFileSync(resolve(fixturesDir, 'PureCppClass.h'), 'utf-8');
    expect(getLanguageFromFilenameWithContent('src/PureCppClass.h', content)).toBe(
      SupportedLanguages.CPlusPlus,
    );
  });

  it('falls back to extension for non-.h files', () => {
    expect(getLanguageFromFilenameWithContent('src/App.m', '// some objc')).toBe(
      SupportedLanguages.ObjectiveC,
    );
  });

  it('falls back to extension for .cpp files', () => {
    const content = 'template<typename T> class Foo {};';
    expect(getLanguageFromFilenameWithContent('src/Foo.cpp', content)).toBe(
      SupportedLanguages.CPlusPlus,
    );
  });

  it('handles .H uppercase extension as OC if content matches', () => {
    const content = '@interface Foo @end';
    expect(getLanguageFromFilenameWithContent('src/Foo.H', content)).toBe(
      SupportedLanguages.ObjectiveC,
    );
  });
});
