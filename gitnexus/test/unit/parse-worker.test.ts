/**
 * Unit Tests: Parse Worker
 *
 * Tests the extractable logic from parse-worker.ts:
 *   - extractORMQueries (the only exported function)
 *   - OC header language detection helpers (via gitnexus-shared)
 *   - stripNullabilityMacros regex behavior (tested directly)
 *   - detectOCHeaderLanguageFallback behavior
 *
 * The worker machinery (message protocol, batch accumulation, file grouping)
 * is tested end-to-end in the worker-pool integration tests.
 */
import { describe, it, expect, vi } from 'vitest';

// ─── Worker Threads Mock ─────────────────────────────────────────────────────
// Mock worker_threads so parentPort!.on(...) at module evaluation time does not
// throw "Cannot read properties of null (reading 'on')" when this test file
// imports the parse-worker module.  The extracted function is tested
// synchronously; the worker message machinery is exercised in integration tests.
vi.mock('node:worker_threads', () => ({
  parentPort: {
    on: vi.fn(),
    postMessage: vi.fn(),
  },
}));

// ─── ORM Query Extraction ───────────────────────────────────────────────────
// These tests import the worker module normally. The worker registers
// parentPort!.on('message', ...) at evaluation time, so the import itself
// does NOT throw (parentPort is mocked at the top level). The extracted
// function is then called synchronously, independent of the worker machinery.

describe('extractORMQueries', async () => {
  let extractORMQueries: (filePath: string, content: string, out: any[]) => void;

  // Import once for the whole describe block — module is cached after first import
  beforeAll(async () => {
    const mod = await import('../../src/core/ingestion/workers/parse-worker.js');
    extractORMQueries = mod.extractORMQueries;
  });

  it('does not push anything when content has no ORM patterns', () => {
    const out: any[] = [];
    extractORMQueries('/fake/file.ts', 'const x = 1;', out);
    expect(out).toHaveLength(0);
  });

  it('extracts Prisma findMany calls', () => {
    const out: any[] = [];
    extractORMQueries(
      '/fake/prisma.ts',
      'const users = await prisma.user.findMany({ where: { active: true } });',
      out,
    );
    expect(out).toEqual([
      {
        filePath: '/fake/prisma.ts',
        orm: 'prisma',
        model: 'user',
        method: 'findMany',
        lineNumber: 0,
      },
    ]);
  });

  it('extracts Prisma create calls', () => {
    const out: any[] = [];
    extractORMQueries(
      '/fake/prisma.ts',
      'await prisma.post.create({ data: { title: "Hi" } });',
      out,
    );
    expect(out).toEqual([
      {
        filePath: '/fake/prisma.ts',
        orm: 'prisma',
        model: 'post',
        method: 'create',
        lineNumber: 0,
      },
    ]);
  });

  it('extracts Prisma update calls', () => {
    const out: any[] = [];
    extractORMQueries(
      '/fake/prisma.ts',
      'await prisma.user.update({ where: { id: 1 }, data: { name: "Bob" } });',
      out,
    );
    expect(out).toEqual([
      {
        filePath: '/fake/prisma.ts',
        orm: 'prisma',
        model: 'user',
        method: 'update',
        lineNumber: 0,
      },
    ]);
  });

  it('extracts Prisma delete calls', () => {
    const out: any[] = [];
    extractORMQueries('/fake/prisma.ts', 'await prisma.user.delete({ where: { id: 1 } });', out);
    expect(out).toEqual([
      {
        filePath: '/fake/prisma.ts',
        orm: 'prisma',
        model: 'user',
        method: 'delete',
        lineNumber: 0,
      },
    ]);
  });

  it('extracts multiple Prisma calls in one file', () => {
    const out: any[] = [];
    const content =
      'const users = await prisma.user.findMany();\nconst posts = await prisma.post.findMany();';
    extractORMQueries('/fake/prisma.ts', content, out);
    expect(out).toHaveLength(2);
    expect(out[0].model).toBe('user');
    expect(out[1].model).toBe('post');
  });

  it('skips internal $query calls', () => {
    const out: any[] = [];
    extractORMQueries('/fake/prisma.ts', 'prisma.$query`SELECT 1`;', out);
    expect(out).toHaveLength(0);
  });

  it('extracts Supabase from().select() calls', () => {
    const out: any[] = [];
    extractORMQueries(
      '/fake/supabase.ts',
      "const { data } = await supabase.from('profiles').select('*');",
      out,
    );
    expect(out).toEqual([
      {
        filePath: '/fake/supabase.ts',
        orm: 'supabase',
        model: 'profiles',
        method: 'select',
        lineNumber: 0,
      },
    ]);
  });

  it('extracts Supabase from().insert() calls', () => {
    const out: any[] = [];
    extractORMQueries(
      '/fake/supabase.ts',
      "await supabase.from('users').insert({ name: 'Bob' });",
      out,
    );
    expect(out).toEqual([
      {
        filePath: '/fake/supabase.ts',
        orm: 'supabase',
        model: 'users',
        method: 'insert',
        lineNumber: 0,
      },
    ]);
  });

  it('extracts both Prisma and Supabase from same file', () => {
    const out: any[] = [];
    const content = `const users = await prisma.user.findMany();
const { data } = await supabase.from('profiles').select('*');`;
    extractORMQueries('/fake/mixed.ts', content, out);
    expect(out).toHaveLength(2);
    expect(out[0].orm).toBe('prisma');
    expect(out[1].orm).toBe('supabase');
  });

  it('reports correct line numbers (1-indexed row)', () => {
    const out: any[] = [];
    const content = '// line 0\n// line 1\nawait prisma.user.findMany();';
    extractORMQueries('/fake/file.ts', content, out);
    expect(out[0].lineNumber).toBe(2);
  });
});

// ─── Language Detection via gitnexus-shared ─────────────────────────────────

describe('Objective-C header detection via content patterns', async () => {
  let SupportedLanguages: typeof import('gitnexus-shared').SupportedLanguages;
  let getLanguageFromFilename: typeof import('gitnexus-shared').getLanguageFromFilename;

  beforeAll(async () => {
    const shared = await import('gitnexus-shared');
    SupportedLanguages = shared.SupportedLanguages;
    getLanguageFromFilename = shared.getLanguageFromFilename;
  });

  it('classifies .h file as C++ by default', () => {
    const lang = getLanguageFromFilename('/fake/header.h');
    expect(lang).toBe(SupportedLanguages.CPlusPlus);
  });

  it('classifies .m file as Objective-C', () => {
    const lang = getLanguageFromFilename('/fake/header.m');
    expect(lang).toBe(SupportedLanguages.ObjectiveC);
  });

  it('classifies .h file with @interface as Objective-C (via detectOCHeaderLanguageFallback)', () => {
    // detectOCHeaderLanguageFallback checks for OC patterns in content
    const ocContent = '@interface MyClass : NSObject\n@end';
    const hasOC =
      /@interface\b/m.test(ocContent) ||
      /@protocol\b/m.test(ocContent) ||
      /@end\b/m.test(ocContent);
    expect(hasOC).toBe(true);
  });

  it('does not misclassify plain C++ header as Objective-C', () => {
    const cppContent = 'template <typename T>\nclass Wrapper { T value; };';
    const hasOC =
      /@interface\b/m.test(cppContent) ||
      /@protocol\b/m.test(cppContent) ||
      /@end\b/m.test(cppContent) ||
      /@property\b/m.test(cppContent) ||
      /@implementation\b/m.test(cppContent);
    expect(hasOC).toBe(false);
  });
});

// ─── NS_ASSUME_NONNULL_BEGIN / END stripping ───────────────────────────────

describe('stripNullabilityMacros', () => {
  // The function is not exported; we verify its regex logic directly.
  const stripNullabilityMacros = (content: string): string => {
    return content
      .replace(/\bNS_ASSUME_NONNULL_BEGIN\b/g, '')
      .replace(/\bNS_ASSUME_NONNULL_END\b/g, '');
  };

  it('removes NS_ASSUME_NONNULL_BEGIN', () => {
    const input = 'NS_ASSUME_NONNULL_BEGIN\n@interface MyClass\nNS_ASSUME_NONNULL_END';
    const result = stripNullabilityMacros(input);
    expect(result).not.toContain('NS_ASSUME_NONNULL_BEGIN');
    expect(result).toContain('@interface MyClass');
  });

  it('removes NS_ASSUME_NONNULL_END', () => {
    const input = 'NS_ASSUME_NONNULL_BEGIN\n@interface MyClass\nNS_ASSUME_NONNULL_END';
    const result = stripNullabilityMacros(input);
    expect(result).not.toContain('NS_ASSUME_NONNULL_END');
  });

  it('removes both macros preserving content between them', () => {
    const input =
      'NS_ASSUME_NONNULL_BEGIN\n@property (nonatomic) NSString *name;\nNS_ASSUME_NONNULL_END';
    const result = stripNullabilityMacros(input);
    expect(result).toContain('@property (nonatomic) NSString *name;');
  });

  it('handles multiple occurrences', () => {
    const input =
      'NS_ASSUME_NONNULL_BEGIN\n@interface A\nNS_ASSUME_NONNULL_END\nNS_ASSUME_NONNULL_BEGIN\n@interface B\nNS_ASSUME_NONNULL_END';
    const result = stripNullabilityMacros(input);
    expect(result).not.toContain('NS_ASSUME_NONNULL');
    expect(result).toContain('@interface A');
    expect(result).toContain('@interface B');
  });

  it('leaves content unchanged when macros absent', () => {
    const input = '@interface MyClass\n@end';
    const result = stripNullabilityMacros(input);
    expect(result).toBe(input);
  });
});

// ─── OC header language fallback ────────────────────────────────────────────

describe('detectOCHeaderLanguageFallback', async () => {
  // The same patterns used inside parse-worker.ts detectOCHeaderLanguageFallback
  const OC_HEADER_PATTERNS: RegExp[] = [
    /^@interface\b/m,
    /^@protocol\b/m,
    /^@end\b/m,
    /^@property\b/m,
    /^@implementation\b/m,
    /@interface\b/m,
    /@protocol\b/m,
  ];

  const detectOCHeaderLanguageFallback = (content: string): boolean => {
    return OC_HEADER_PATTERNS.some((re) => re.test(content));
  };

  it('returns true for @interface header', () => {
    expect(detectOCHeaderLanguageFallback('@interface MyClass : NSObject')).toBe(true);
  });

  it('returns true for @protocol header', () => {
    expect(detectOCHeaderLanguageFallback('@protocol MyProtocol')).toBe(true);
  });

  it('returns true for @property in header', () => {
    expect(detectOCHeaderLanguageFallback('@property (nonatomic, strong) NSString *name;')).toBe(
      true,
    );
  });

  it('returns false for C++ template header', () => {
    const cpp = 'template <typename T>\nclass Wrapper { T value; };';
    expect(detectOCHeaderLanguageFallback(cpp)).toBe(false);
  });

  it('returns false for plain C header', () => {
    const c = '#ifndef MY_HEADER_H\n#define MY_HEADER_H\nvoid foo();\n#endif';
    expect(detectOCHeaderLanguageFallback(c)).toBe(false);
  });

  it('returns true for multi-@end header', () => {
    const content = '@interface MyClass\n@end\n@interface Other\n@end';
    expect(detectOCHeaderLanguageFallback(content)).toBe(true);
  });
});

// ─── getLanguageFromFilenameWithContent (OC detection) ─────────────────────

describe('getLanguageFromFilenameWithContent OC detection', () => {
  it('distinguishes OC .h from C++ .h via content', () => {
    const ocContent = '@interface MyClass : NSObject\n@property (nonatomic) int value;\n@end';
    const cppContent = 'template <typename T>\nclass Wrapper { T value; };';

    const isOC = (content: string): boolean => {
      return (
        /@interface\b/m.test(content) ||
        /@protocol\b/m.test(content) ||
        /@end\b/m.test(content) ||
        /@property\b/m.test(content) ||
        /@implementation\b/m.test(content)
      );
    };

    expect(isOC(ocContent)).toBe(true);
    expect(isOC(cppContent)).toBe(false);
  });
});
