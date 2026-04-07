import { describe, it, expect } from 'vitest';
import { preprocessArktsContent } from '../../src/core/ingestion/languages/arkts-preprocess.js';

describe('preprocessArktsContent', () => {
  it('converts struct declarations to class declarations', () => {
    const input = `@Entry\n@Component\nstruct Index {\n  build() {}\n}`;
    const out = preprocessArktsContent(input);
    expect(out).toContain('class Index');
    expect(out).not.toContain('struct Index');
  });

  it('does not modify existing class declarations', () => {
    const input = `class SessionManager {\n  start() {}\n}`;
    const out = preprocessArktsContent(input);
    expect(out).toBe(input);
  });

  it('keeps identifier names intact', () => {
    const input = `struct MainPage_01 {}`;
    const out = preprocessArktsContent(input);
    expect(out).toContain('class MainPage_01');
  });
});
